/**
 * JafariPay — Payment Intents API
 */

import { Router, type Request, type Response } from 'express';
import { createHash } from 'crypto';
import { requireApiKey, type AuthedRequest } from '../middleware/auth.js';
import { getDb } from '../db/schema.js';
import { generatePaymentIntentId, generateId } from '../lib/ids.js';
import { validatePositiveAmount, formatBaseUnitsToDecimal } from '../lib/money.js';
import { verifyPayment, PI_SETTLEMENT_GRACE_S } from '../blockchain/arc-provider.js';
import { enqueueWebhookDeliveries } from '../webhooks/delivery.js';

const router = Router();
const CHECKOUT_BASE = process.env.CHECKOUT_BASE_URL || 'https://pay.jafaripay.com';
const PI_EXPIRY_S = 60 * 60; // 1 hour

function hashRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

// ── POST /v1/payment-intents ──────────────────────────────────────────────

router.post('/', requireApiKey({ requireSecret: true }), async (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const merchantId = ar.merchantId!;
  const env = ar.apiKeyContext!.environment;
  const projectId = ar.apiKeyContext?.projectId || null;

  const idempKey = req.headers['idempotency-key'] as string | undefined;
  if (idempKey) {
    type IkRow = { response_body: string; response_status: number; request_hash: string };
    const existing = db.prepare('SELECT response_body,response_status,request_hash FROM idempotency_keys WHERE merchant_id=? AND key=?').get(merchantId, idempKey) as IkRow | null;
    if (existing) {
      if (existing.request_hash !== hashRequest(req.body)) {
        res.status(409).json({ error: 'Idempotency key reused with different request', code: 'idempotency.conflict' }); return;
      }
      res.status(existing.response_status).json(JSON.parse(existing.response_body)); return;
    }
  }

  const { amount, currency = 'USDC', order_id, description, metadata = {}, settlement_wallet_id } = req.body as {
    amount: string; currency?: string; order_id?: string; description?: string;
    metadata?: Record<string, unknown>; settlement_wallet_id?: string;
  };

  if (!amount) { res.status(400).json({ error: 'amount is required' }); return; }
  if (currency !== 'USDC') { res.status(400).json({ error: 'Only USDC is supported' }); return; }

  let amountBaseUnits: bigint;
  try { amountBaseUnits = validatePositiveAmount(amount); }
  catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid amount' }); return; }

  const network = env === 'live' ? 'arc_mainnet' : 'arc_testnet';

  type SwRow = { id: string; address: string; network: string };
  let sw: SwRow | null = null;
  if (settlement_wallet_id) {
    sw = db.prepare('SELECT id,address,network FROM settlement_wallets WHERE id=? AND merchant_id=? AND network=? AND is_active=1')
      .get(settlement_wallet_id, merchantId, network) as SwRow | null;
    if (!sw) { res.status(400).json({ error: 'Settlement wallet not found or wrong network' }); return; }
  } else {
    sw = db.prepare('SELECT id,address,network FROM settlement_wallets WHERE merchant_id=? AND network=? AND is_active=1 LIMIT 1')
      .get(merchantId, network) as SwRow | null;
    if (!sw) { res.status(400).json({ error: 'No settlement wallet configured. Add one in the dashboard.', code: 'setup.no_settlement_wallet' }); return; }
  }

  type NetRow = { chain_id: number; usdc_address: string };
  const netConfig = db.prepare('SELECT chain_id,usdc_address FROM network_configs WHERE network=?').get(network) as NetRow | null;
  if (!netConfig) { res.status(500).json({ error: 'Network not configured' }); return; }

  const id = generatePaymentIntentId();
  const expiresAt = Math.floor(Date.now() / 1000) + PI_EXPIRY_S;
  // Preserve original input string for display (e.g. "1.00" not "1.000000")
  const amountDecimal = amount.trim();

  db.prepare(`INSERT INTO payment_intents(id,merchant_id,project_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,currency,order_id,description,metadata,environment,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, merchantId, projectId, sw.id, sw.address, network, netConfig.chain_id, netConfig.usdc_address, amountDecimal, amountBaseUnits.toString(), currency, order_id || null, description || '', JSON.stringify(metadata), env, expiresAt);

  db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,to_status) VALUES(?,?,?,?)').run(generateId('pe'), id, 'payment.created', 'requires_payment');

  const responseBody = {
    id, status: 'requires_payment', amount: amountDecimal, amount_base_units: amountBaseUnits.toString(),
    currency, network, chain_id: netConfig.chain_id, usdc_address: netConfig.usdc_address,
    order_id: order_id || null, description: description || '',
    settlement_address: sw.address, checkout_url: `${CHECKOUT_BASE}/checkout/${id}`,
    expires_at: expiresAt, created_at: Math.floor(Date.now() / 1000),
  };

  enqueueWebhookDeliveries(id, 'payment.created', responseBody as unknown as Record<string, unknown>, env);

  if (idempKey) {
    db.prepare('INSERT OR REPLACE INTO idempotency_keys(id,merchant_id,key,request_hash,response_body,response_status,resource_id,resource_type) VALUES(?,?,?,?,?,?,?,?)')
      .run(generateId('idem'), merchantId, idempKey, hashRequest(req.body), JSON.stringify(responseBody), 201, id, 'payment_intent');
  }

  res.status(201).json(responseBody);
});

// ── GET /v1/payment-intents (list) ───────────────────────────────────────

router.get('/', requireApiKey(), (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const { limit = '20', offset = '0', status } = req.query as Record<string, string>;
  const lim = Math.min(parseInt(limit, 10) || 20, 100);
  const off = parseInt(offset, 10) || 0;
  let sql = 'SELECT * FROM payment_intents WHERE merchant_id=?';
  const params: (string | number)[] = [ar.merchantId!];
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(lim, off);
  const data = db.prepare(sql).all(...params);
  const total = (db.prepare('SELECT COUNT(*) as c FROM payment_intents WHERE merchant_id=?' + (status ? ' AND status=?' : '')).get(...params.slice(0, status ? 2 : 1)) as { c: number }).c;
  res.json({ data, total, limit: lim, offset: off });
});

// ── GET /v1/payment-intents/:id ───────────────────────────────────────────

router.get('/:id', requireApiKey(), (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const pi = db.prepare('SELECT * FROM payment_intents WHERE id=? AND merchant_id=?').get(req.params.id, ar.merchantId!) as Record<string, unknown> | null;
  if (!pi) { res.status(404).json({ error: 'Payment intent not found' }); return; }
  const payment = db.prepare('SELECT * FROM payments WHERE payment_intent_id=?').get(req.params.id);
  res.json({ ...pi, checkout_url: `${CHECKOUT_BASE}/checkout/${req.params.id}`, payment: payment || null });
});

// Public (checkout page) — no auth, limited fields
router.get('/:id/public', (req: Request, res: Response) => {
  const db = getDb();
  const pi = db.prepare(`SELECT pi.id,pi.status,pi.amount_decimal,pi.amount_base_units,pi.currency,pi.network,pi.chain_id,pi.usdc_address,pi.settlement_address,pi.description,pi.order_id,pi.expires_at,pi.created_at,m.name AS merchant_name FROM payment_intents pi JOIN merchants m ON m.id=pi.merchant_id WHERE pi.id=?`).get(req.params.id) as Record<string, unknown> | null;
  if (!pi) { res.status(404).json({ error: 'Payment intent not found' }); return; }
  res.json(pi);
});

// ── POST /v1/payment-intents/:id/cancel ──────────────────────────────────

router.post('/:id/cancel', requireApiKey({ requireSecret: true }), (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  type PiRow = { id: string; status: string; environment: string };
  const pi = db.prepare('SELECT id,status,environment FROM payment_intents WHERE id=? AND merchant_id=?').get(req.params.id, ar.merchantId!) as PiRow | null;
  if (!pi) { res.status(404).json({ error: 'Payment intent not found' }); return; }
  if (!['requires_payment','processing'].includes(pi.status)) { res.status(400).json({ error: `Cannot cancel in "${pi.status}" state` }); return; }
  db.prepare("UPDATE payment_intents SET status='cancelled',updated_at=unixepoch() WHERE id=?").run(req.params.id);
  db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,from_status,to_status) VALUES(?,?,?,?,?)').run(generateId('pe'), req.params.id, 'payment.cancelled', pi.status, 'cancelled');
  res.json({ id: req.params.id, status: 'cancelled' });
});

// ── POST /v1/payment-intents/:id/verify ──────────────────────────────────

router.post('/:id/verify', requireApiKey(), async (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const { tx_hash } = req.body as { tx_hash: string };
  if (!tx_hash) { res.status(400).json({ error: 'tx_hash is required' }); return; }

  type PiFullRow = { id: string; status: string; network: string; settlement_address: string; amount_base_units: string; usdc_address: string; chain_id: number; amount_decimal: string; environment: string; merchant_id: string; expires_at: number };
  const pi = db.prepare('SELECT * FROM payment_intents WHERE id=? AND merchant_id=?').get(req.params.id, ar.merchantId!) as PiFullRow | null;
  if (!pi) { res.status(404).json({ error: 'Payment intent not found' }); return; }

  if (pi.status === 'succeeded') {
    res.json({ status: 'succeeded', payment: db.prepare('SELECT * FROM payments WHERE payment_intent_id=?').get(pi.id) }); return;
  }
  // Grace-aware: an expired PI may still be verified within the settlement grace
  // window so a genuinely settled payment can be credited. cancelled/failed stay terminal.
  const withinGrace = pi.expires_at + PI_SETTLEMENT_GRACE_S >= Math.floor(Date.now() / 1000);
  if (!(['requires_payment', 'processing'].includes(pi.status) || (pi.status === 'expired' && withinGrace))) {
    res.status(400).json({ error: `Payment intent is in "${pi.status}" state` }); return;
  }

  db.prepare("UPDATE payment_intents SET status='processing',updated_at=unixepoch() WHERE id=? AND status!='succeeded'").run(pi.id);
  enqueueWebhookDeliveries(pi.id, 'payment.processing', { payment_intent_id: pi.id }, pi.environment as 'test' | 'live');

  let result: Awaited<ReturnType<typeof verifyPayment>>;
  try {
    result = await verifyPayment({
      txHash: tx_hash, network: pi.network, paymentIntentId: pi.id,
      settlementAddress: pi.settlement_address, expectedAmountBaseUnits: pi.amount_base_units,
      usdcAddress: pi.usdc_address,
    });
  } catch {
    // RPC error — reset to requires_payment so customer can retry
    db.prepare("UPDATE payment_intents SET status='requires_payment',updated_at=unixepoch() WHERE id=? AND status='processing'").run(pi.id);
    res.status(503).json({ error: 'Blockchain RPC error — please retry', retryable: true }); return;
  }

  if (!result.success) {
    const isRetryable = result.failureReason?.includes('not found');
    const newStatus = isRetryable ? 'requires_payment' : 'failed';
    db.prepare("UPDATE payment_intents SET status=?,updated_at=unixepoch() WHERE id=?").run(newStatus, pi.id);
    if (newStatus === 'failed') {
      db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,from_status,to_status,data) VALUES(?,?,?,?,?,?)').run(generateId('pe'), pi.id, 'payment.failed', 'processing', 'failed', JSON.stringify({ reason: result.failureReason }));
      enqueueWebhookDeliveries(pi.id, 'payment.failed', { payment_intent_id: pi.id, reason: result.failureReason }, pi.environment as 'test' | 'live');
    }
    res.status(422).json({ status: newStatus, error: result.failureReason }); return;
  }

  // Atomic credit with DB transaction
  let paymentId: string | null = null;
  let alreadySucceeded = false;

  db.transaction(() => {
    type StatusRow = { status: string };
    const fresh = db.prepare("SELECT status FROM payment_intents WHERE id=?").get(pi.id) as StatusRow;
    if (fresh.status === 'succeeded') { alreadySucceeded = true; return; }

    paymentId = generateId('pay');
    const amountFmt = formatBaseUnitsToDecimal(BigInt(result.amountBaseUnits!));

    db.prepare('INSERT OR IGNORE INTO blockchain_transactions(id,tx_hash,network,chain_id,block_number,block_timestamp,from_address,to_address,usdc_address,amount,log_index,raw_receipt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
      generateId('btx'), result.txHash!, pi.network, pi.chain_id,
      result.blockNumber!, result.blockTimestamp!, result.sender!, result.recipient!,
      pi.usdc_address, result.amountBaseUnits!, result.logIndex ?? 0, '{}'
    );
    db.prepare('INSERT INTO payments(id,payment_intent_id,merchant_id,tx_hash,network,chain_id,sender_address,recipient_address,amount_base_units,amount_decimal,block_number,block_timestamp) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
      paymentId, pi.id, pi.merchant_id, result.txHash!, pi.network, pi.chain_id,
      result.sender!, result.recipient!, result.amountBaseUnits!, amountFmt,
      result.blockNumber!, result.blockTimestamp!
    );
    db.prepare('UPDATE blockchain_transactions SET payment_id=? WHERE tx_hash=? AND network=?').run(paymentId, result.txHash!, pi.network);
    db.prepare("UPDATE payment_intents SET status='succeeded',updated_at=unixepoch() WHERE id=?").run(pi.id);
    db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,from_status,to_status) VALUES(?,?,?,?,?)').run(generateId('pe'), pi.id, 'payment.succeeded', 'processing', 'succeeded');
  })();

  if (alreadySucceeded) {
    res.json({ status: 'succeeded', payment: db.prepare('SELECT * FROM payments WHERE payment_intent_id=?').get(pi.id) }); return;
  }

  const paymentRow = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId!) as Record<string, unknown>;
  enqueueWebhookDeliveries(pi.id, 'payment.succeeded', { payment_intent_id: pi.id, payment: paymentRow }, pi.environment as 'test' | 'live');
  res.json({ status: 'succeeded', payment: paymentRow });
});

export default router;
