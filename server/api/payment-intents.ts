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
import { issueReceiptForPayment } from '../receipts/service.js';
import { isValidEmail, normalizeEmail } from '../email/transport.js';
import {
  isCctpSource, arcDestinationForEnvironment, NOT_A_CCTP_SOURCE, CCTP_REGISTRY,
  ARC_MAINNET_SLUG, ARC_TESTNET_SLUG,
} from '../db/cctp.js';
import { loadCrossChainStatus } from '../blockchain/cctp-status.js';
import { describeCrossChainFees } from '../lib/fees.js';
import { applyForwardingQuote, ForwardingFeeError, type ApplyForwardingQuote } from '../blockchain/cctp-forwarding-fee.js';
import type { FetchLike } from '../blockchain/cctp-attestation.js';

const router = Router();
const CHECKOUT_BASE = process.env.CHECKOUT_BASE_URL || 'https://jafari.co.in';
const PI_EXPIRY_S = 60 * 60; // 1 hour

// ── STEP 5N — SERVER-AUTHORITATIVE FORWARDING QUOTE (HTTP integration) ─────
// The Circle Forwarding fee F is DYNAMIC and can only be sourced from Circle
// immediately before the payment; it is NEVER a client-chosen number. The
// module `applyForwardingQuote` (implemented + unit-tested in Step 5) turns
// Circle's live Standard(2000) quote into the server-approved F and persists it
// into payment_intents.forwarding_max_fee_base_units — the ONLY place that column
// is ever written. The intent-creation INSERT below never reads any client fee
// field, so a browser-supplied forwarding_max_fee_base_units can never reach the
// DB (proven by P3-10 / P3-11). The production `fetch` + registry resolver sit
// behind a restorable seam so this wiring is unit-testable without live Circle
// I/O (mirrors the `spyOn` discipline the same-chain route tests use). A quote
// failure leaves the intent a DIRECT (F=0) route instead of 500-ing a valid
// payment — it never silently authorizes an arbitrary client fee.
let forwardingQuoteImpl: ApplyForwardingQuote = applyForwardingQuote;
/** Test seam. Pass null to restore the real Circle-backed quote. */
export function setForwardingQuoteForTest(fn: ApplyForwardingQuote | null): void {
  forwardingQuoteImpl = fn ?? applyForwardingQuote;
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** Resolve a source slug to its Circle CCTP domain + environment class, from the registry. */
function registryResolveSource(sourceSlug: string): { sourceDomain: number; isTestnet: boolean } {
  const cfg = CCTP_REGISTRY[sourceSlug];
  if (!cfg || cfg.supportedAsSource !== true) {
    throw new ForwardingFeeError(`resolveSource: "${sourceSlug}" is not a registered CCTP cross-chain source`);
  }
  return { sourceDomain: cfg.cctpDomain, isTestnet: cfg.isTestnet };
}

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

  // Optional customer receipt destination. Accepts a top-level `receipt_email`
  // (or `customer.email` for a future object-shaped API). It is stored verbatim
  // (normalized) and NEVER participates in the money/verification gate. Absent →
  // NULL, so every existing integration is unaffected. An explicitly-supplied
  // but malformed address is refused up front (400 invalid_email) rather than
  // persisted — this is the "invalid email" guard for the receipt pipeline.
  const rawEmail = (req.body as { receipt_email?: unknown; customer?: { email?: unknown } });
  const emailCandidate = typeof rawEmail.receipt_email === 'string'
    ? rawEmail.receipt_email
    : (rawEmail.customer && typeof (rawEmail.customer as { email?: unknown }).email === 'string'
        ? (rawEmail.customer as { email: string }).email : undefined);
  let customerEmail: string | null = null;
  if (emailCandidate !== undefined && emailCandidate !== null && emailCandidate !== '') {
    if (!isValidEmail(emailCandidate)) {
      res.status(400).json({ error: 'receipt_email is not a valid email address', code: 'invalid_email' }); return;
    }
    customerEmail = normalizeEmail(emailCandidate);
  }

  if (!amount) { res.status(400).json({ error: 'amount is required' }); return; }
  if (currency !== 'USDC') { res.status(400).json({ error: 'Only USDC is supported' }); return; }

  let amountBaseUnits: bigint;
  try { amountBaseUnits = validatePositiveAmount(amount); }
  catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid amount' }); return; }

  // Optional network selector. When omitted, preserve today's exact
  // environment-derived default (live -> arc_mainnet, test -> arc_testnet).
  // `network` is the single documented slug-based selector; we deliberately do
  // NOT add a second chain_id-based way to choose a network.
  const requestedNetwork = (req.body as { network?: unknown }).network;
  const crossChainRequested = (req.body as { cross_chain?: unknown }).cross_chain === true;
  let network: string;
  if (requestedNetwork === undefined || requestedNetwork === null || requestedNetwork === '') {
    if (crossChainRequested) {
      res.status(400).json({ error: 'network (the customer source chain) is required when cross_chain is true', code: 'invalid_network' }); return;
    }
    network = env === 'live' ? 'arc_mainnet' : 'arc_testnet';
  } else if (typeof requestedNetwork === 'string') {
    network = requestedNetwork.trim();
  } else {
    res.status(400).json({ error: 'network must be a string slug', code: 'invalid_network' }); return;
  }

  // Resolve + validate the selected network against the registry. network_configs
  // is the source of truth for chain_id / usdc_address and the testnet/live class
  // (is_testnet, Phase 1). Unknown or disabled rows are not selectable.
  type NetRow = { chain_id: number; usdc_address: string; is_enabled: number; is_testnet: number };
  const netConfig = db.prepare('SELECT chain_id,usdc_address,is_enabled,is_testnet FROM network_configs WHERE network=?').get(network) as NetRow | null;
  if (!netConfig || netConfig.is_enabled !== 1) {
    res.status(400).json({ error: `Network "${network}" is unknown or disabled`, code: 'invalid_network' }); return;
  }

  // Environment-class enforcement: a live key may only create mainnet-class
  // intents; a test key only testnet-class intents. No override is possible.
  const expectedIsTestnet = env === 'test' ? 1 : 0;
  if (netConfig.is_testnet !== expectedIsTestnet) {
    res.status(400).json({
      error: `Network "${network}" is ${netConfig.is_testnet ? 'testnet' : 'mainnet'}-class and does not match API key environment "${env}"`,
      code: 'environment_network_mismatch',
    }); return;
  }

  // ── CCTP PHASE 3: cross-chain source/settlement resolution. When cross_chain
  // is requested, the intent's network/chain_id/usdc_address describe the SOURCE
  // (the chain the customer pays on, where the burn is detected in PHASE 5), while
  // settlement is pinned to the merchant's ONE Arc wallet. The merchant does NOT
  // configure a per-source settlement wallet. Same-chain (cross_chain absent/
  // false) is byte-identical to today: source/settlement columns stay NULL and
  // the legacy network columns are the whole story. zkSync Era / Celo (and any
  // non-CCTP chain) get a machine-readable unsupported error — never a silent
  // non-Circle fallback.
  let isCrossChain = false;
  let settlementNetwork = network;
  let settlementChainId = netConfig.chain_id;
  let sourceNetwork: string | null = null;
  let sourceChainId: number | null = null;
  let destinationDomain: number | null = null;
  if (crossChainRequested) {
    if (network === ARC_MAINNET_SLUG || network === ARC_TESTNET_SLUG) {
      res.status(400).json({ error: `Network "${network}" is the Arc settlement destination (same-chain), not a cross-chain source`, code: 'cross_chain.source_is_destination' }); return;
    }
    if (NOT_A_CCTP_SOURCE.includes(network) || !isCctpSource(network)) {
      const supportedSources = Object.values(CCTP_REGISTRY).filter((c) => c.supportedAsSource && !c.isTestnet).map((c) => c.slug);
      res.status(400).json({
        error: `Network "${network}" is not a Circle CCTP cross-chain source; it may still be used for same-chain settlement. Supported cross-chain sources: ${supportedSources.join(', ')}.`,
        code: 'cross_chain.unsupported_source',
        supported_sources: supportedSources,
      }); return;
    }
    const dest = arcDestinationForEnvironment(env);
    const destConfig = db.prepare('SELECT chain_id,is_enabled FROM network_configs WHERE network=?').get(dest.slug) as { chain_id: number; is_enabled: number } | null;
    if (!destConfig || destConfig.is_enabled !== 1) {
      res.status(500).json({ error: `Arc destination "${dest.slug}" is not configured/enabled`, code: 'cross_chain.destination_unavailable' }); return;
    }
    isCrossChain = true;
    settlementNetwork = dest.slug;
    settlementChainId = destConfig.chain_id;
    destinationDomain = dest.domain;
    sourceNetwork = network;
    sourceChainId = netConfig.chain_id;
  }

  // Settlement wallet must belong to this merchant, be active, and live on the
  // settlement network — Arc for cross-chain (the merchant's ONE destination
  // wallet), the payment network for same-chain. The customer can never move it.
  type SwRow = { id: string; address: string; network: string };
  let sw: SwRow | null = null;
  if (settlement_wallet_id) {
    sw = db.prepare('SELECT id,address,network FROM settlement_wallets WHERE id=? AND merchant_id=? AND network=? AND is_active=1')
      .get(settlement_wallet_id, merchantId, settlementNetwork) as SwRow | null;
    if (!sw) { res.status(400).json({ error: isCrossChain ? 'Arc settlement wallet not found for this merchant on the settlement network' : 'Settlement wallet not found or wrong network' }); return; }
  } else {
    sw = db.prepare('SELECT id,address,network FROM settlement_wallets WHERE merchant_id=? AND network=? AND is_active=1 LIMIT 1')
      .get(merchantId, settlementNetwork) as SwRow | null;
    if (!sw) { res.status(400).json({ error: isCrossChain ? 'No Arc settlement wallet configured. Add one in the dashboard.' : 'No settlement wallet configured. Add one in the dashboard.', code: 'setup.no_settlement_wallet' }); return; }
  }

  const id = generatePaymentIntentId();
  const expiresAt = Math.floor(Date.now() / 1000) + PI_EXPIRY_S;
  // Preserve original input string for display (e.g. "1.00" not "1.000000")
  const amountDecimal = amount.trim();

  db.prepare(`INSERT INTO payment_intents(id,merchant_id,project_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,currency,order_id,description,metadata,environment,expires_at,customer_email,source_network,source_chain_id,settlement_network,settlement_chain_id,is_cross_chain) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, merchantId, projectId, sw.id, sw.address, network, netConfig.chain_id, netConfig.usdc_address, amountDecimal, amountBaseUnits.toString(), currency, order_id || null, description || '', JSON.stringify(metadata), env, expiresAt, customerEmail,
      sourceNetwork, sourceChainId, isCrossChain ? settlementNetwork : null, isCrossChain ? settlementChainId : null, isCrossChain ? 1 : 0);

  db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,to_status) VALUES(?,?,?,?)').run(generateId('pe'), id, 'payment.created', 'requires_payment');

  // STEP 5N — SERVER-AUTHORITATIVE FORWARDING QUOTE (cross-chain only).
  // The intent row now legitimately exists, so we can derive the DYNAMIC Circle
  // Forwarding fee F and persist it into forwarding_max_fee_base_units via the
  // existing, unit-tested applyForwardingQuote. This is the ONLY place F is set;
  // no client field is ever read here. Fail-safe: a Circle/RPC error leaves F at
  // its 0 default so the intent is still created and simply resolves to a DIRECT
  // (non-forwarding) checkout route — a failed quote NEVER authorizes an
  // arbitrary client fee and NEVER 500s an otherwise-valid payment.
  if (isCrossChain) {
    try {
      await forwardingQuoteImpl({
        paymentIntentId: id,
        fetchImpl: defaultFetch,
        resolveSource: registryResolveSource,
      });
    } catch { /* fail-safe: stay DIRECT (forwarding_max_fee_base_units remains 0) */ }
  }

  const responseBody = {
    id, status: 'requires_payment', amount: amountDecimal, amount_base_units: amountBaseUnits.toString(),
    currency, network, chain_id: netConfig.chain_id, usdc_address: netConfig.usdc_address,
    order_id: order_id || null, description: description || '',
    settlement_address: sw.address, checkout_url: `${CHECKOUT_BASE}/checkout/${id}`,
    expires_at: expiresAt, created_at: Math.floor(Date.now() / 1000),
    cross_chain: isCrossChain,
    ...(isCrossChain ? { source_network: sourceNetwork, source_chain_id: sourceChainId, settlement_network: settlementNetwork, settlement_chain_id: settlementChainId, cctp_destination_domain: destinationDomain } : {}),
    // PHASE 14 (additive): the merchant sees the exact fee/net breakdown at the
    // moment of creation — Standard CCTP is 1:1, so net_amount equals the amount.
    ...(isCrossChain ? { fees: describeCrossChainFees({ amountBaseUnits: amountBaseUnits.toString(), feeBaseUnits: '0' }) } : {}),
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
  // PHASE 13 (additive): surface the cross-chain journey only for a cross-chain
  // intent that actually has a transfer row; a same-chain intent keeps its exact
  // prior shape (no `cross_chain` key at all).
  const crossChain = (pi.is_cross_chain === 1) ? loadCrossChainStatus(req.params.id as string) : null;
  res.json({ ...pi, checkout_url: `${CHECKOUT_BASE}/checkout/${req.params.id}`, payment: payment || null, ...(crossChain ? { cross_chain: crossChain } : {}) });
});

// Public (checkout page) — no auth, limited fields
router.get('/:id/public', (req: Request, res: Response) => {
  const db = getDb();
  const pi = db.prepare(`SELECT pi.id,pi.status,pi.amount_decimal,pi.amount_base_units,pi.currency,pi.network,pi.chain_id,pi.usdc_address,pi.settlement_address,pi.is_cross_chain,pi.source_network,pi.source_chain_id,pi.settlement_network,pi.settlement_chain_id,pi.description,pi.order_id,pi.expires_at,pi.created_at,m.name AS merchant_name FROM payment_intents pi JOIN merchants m ON m.id=pi.merchant_id WHERE pi.id=?`).get(req.params.id) as Record<string, unknown> | null;
  if (!pi) { res.status(404).json({ error: 'Payment intent not found' }); return; }
  // PHASE 13 (additive): let the checkout page show cross-chain progress. Only
  // public facts are exposed (no attestation signature / internal bookkeeping).
  const crossChain = (pi.is_cross_chain === 1) ? loadCrossChainStatus(req.params.id as string) : null;
  res.json({ ...pi, ...(crossChain ? { cross_chain: crossChain } : {}) });
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
  const { tx_hash, chain_id } = req.body as { tx_hash: string; chain_id?: number };
  if (!tx_hash) { res.status(400).json({ error: 'tx_hash is required' }); return; }

  type PiFullRow = { id: string; status: string; network: string; settlement_address: string; amount_base_units: string; usdc_address: string; chain_id: number; amount_decimal: string; environment: string; merchant_id: string; expires_at: number; is_cross_chain: number };
  const pi = db.prepare('SELECT * FROM payment_intents WHERE id=? AND merchant_id=?').get(req.params.id, ar.merchantId!) as PiFullRow | null;
  if (!pi) { res.status(404).json({ error: 'Payment intent not found' }); return; }

  // CCTP PHASE 3 SAFETY GUARD: a cross-chain intent must NEVER be credited
  // through the same-chain verify path (that would pay out before the funds
  // arrive on Arc). Cross-chain settlement is verified only after the Arc-side
  // mint is confirmed (PHASE 8). Fail closed here rather than risk early credit.
  if (pi.is_cross_chain === 1) {
    res.status(400).json({ error: 'Cross-chain intent: settlement is credited only after Arc destination verification, not via same-chain verify.', code: 'cross_chain.wrong_verify_endpoint' }); return;
  }

  // chain_id is REQUIRED and must equal the PI's pinned chain_id. The persisted
  // PI row is the source of truth (verification below uses ONLY the PI snapshot,
  // never the client value); a missing/mismatched chain_id is rejected BEFORE
  // the intent is transitioned to processing or any verification is attempted.
  if (chain_id === undefined || chain_id === null || (chain_id as unknown) === '') {
    res.status(400).json({ error: 'chain_id is required', code: 'wrong_network' }); return;
  }
  if (Number(chain_id) !== Number(pi.chain_id)) {
    res.status(400).json({
      error: `Chain ID mismatch: payment intent requires chain ${pi.chain_id} (${pi.network}), got ${chain_id}`,
      code: 'wrong_network',
    }); return;
  }

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
  // Generate the customer receipt AFTER the payment is confirmed succeeded.
  // Isolated: a receipt/email error can never un-succeed the payment (the row is
  // already committed and this call is guaranteed non-throwing).
  const receipt = await issueReceiptForPayment(paymentId!);
  res.json({ status: 'succeeded', payment: paymentRow, receipt_id: receipt?.id ?? null });
});

export default router;
