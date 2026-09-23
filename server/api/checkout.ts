/**
 * JafariPay — Public checkout API (no auth required)
 *
 * GET  /checkout/:id         — public payment intent info (for the checkout page)
 * POST /checkout/:id/verify  — submit tx hash for backend verification
 */

import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/schema.js';
import { generateId } from '../lib/ids.js';
import { verifyPayment, PI_SETTLEMENT_GRACE_S } from '../blockchain/arc-provider.js';
import { enqueueWebhookDeliveries } from '../webhooks/delivery.js';
import { formatBaseUnitsToDecimal } from '../lib/money.js';

const router = Router();

// ── GET /checkout/:id ─────────────────────────────────────────────────────
router.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const pi = db.prepare(
    `SELECT pi.id, pi.status, pi.amount_decimal AS amount, pi.amount_base_units,
            pi.currency, pi.network, pi.chain_id, pi.usdc_address,
            pi.settlement_address, pi.expires_at, pi.created_at,
            pi.order_id, pi.description,
            m.name AS merchant_name
     FROM payment_intents pi
     JOIN merchants m ON m.id = pi.merchant_id
     WHERE pi.id = ?`
  ).get(req.params.id) as Record<string, unknown> | null;

  if (!pi) { res.status(404).json({ error: 'Payment intent not found' }); return; }

  // Don't expose private merchant fields
  res.json(pi);
});

// ── POST /checkout/:id/verify ─────────────────────────────────────────────
// Called by the checkout frontend after the customer's transaction is onchain.
// We do full independent blockchain verification here.
router.post('/:id/verify', async (req: Request, res: Response) => {
  const db = getDb();
  const { tx_hash, chain_id } = req.body as { tx_hash: string; chain_id?: number };

  if (!tx_hash) { res.status(400).json({ error: 'tx_hash is required' }); return; }

  // Validate tx_hash format — must be 0x + 64 hex chars
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) {
    res.status(400).json({ error: 'tx_hash must be a valid 32-byte hex hash (0x + 64 hex characters)' }); return;
  }

  type PiRow = {
    id: string; status: string; network: string; settlement_address: string;
    amount_base_units: string; usdc_address: string; chain_id: number;
    amount_decimal: string; environment: string; merchant_id: string;
    expires_at: number;
  };
  const pi = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(req.params.id) as PiRow | null;
  if (!pi) { res.status(404).json({ error: 'Payment intent not found' }); return; }

  // Validate chain_id matches the PI's expected network — SECURITY CRITICAL
  // A tx from a different chain must never credit this payment intent
  if (chain_id !== undefined && Number(chain_id) !== Number(pi.chain_id)) {
    res.status(400).json({
      error: `Chain ID mismatch: payment intent requires chain ${pi.chain_id} (${pi.network}), got ${chain_id}`,
      code: 'wrong_network',
    }); return;
  }

  // Already succeeded — idempotent
  if (pi.status === 'succeeded') {
    const payment = db.prepare('SELECT * FROM payments WHERE payment_intent_id = ?').get(pi.id);
    res.json({ status: 'succeeded', payment }); return;
  }

  // Expiry check — grace-aware. A genuinely settled payment landing shortly
  // after expiry can still be verified and credited within the grace window.
  const nowS = Math.floor(Date.now() / 1000);
  const withinGrace = pi.expires_at + PI_SETTLEMENT_GRACE_S >= nowS;
  // Past the grace window: no longer creditable — settle as expired.
  if (!withinGrace) {
    if (pi.status !== 'expired') {
      db.prepare("UPDATE payment_intents SET status='expired',updated_at=unixepoch() WHERE id=?").run(pi.id);
    }
    res.status(400).json({ status: 'expired', error: 'Payment intent has expired' }); return;
  }

  // Within grace: accept requires_payment / processing, and re-open an
  // expired PI so a genuinely settled payment can still be verified.
  // succeeded is handled above; cancelled/failed remain terminal and are rejected.
  if (!['requires_payment', 'processing', 'expired'].includes(pi.status)) {
    res.status(400).json({ error: `Payment intent is in "${pi.status}" state` }); return;
  }

  // Mark as processing (from requires_payment OR within-grace expired)
  db.prepare("UPDATE payment_intents SET status='processing',updated_at=unixepoch() WHERE id=? AND status IN ('requires_payment','expired')").run(pi.id);
  enqueueWebhookDeliveries(pi.id, 'payment.processing', { payment_intent_id: pi.id }, pi.environment as 'test' | 'live');

  // Blockchain verification
  const result = await verifyPayment({
    txHash: tx_hash,
    network: pi.network,
    paymentIntentId: pi.id,
    settlementAddress: pi.settlement_address,
    expectedAmountBaseUnits: pi.amount_base_units,
    usdcAddress: pi.usdc_address,
  });

  if (!result.success) {
    // Tx not found yet — return processing so client keeps polling
    if (result.failureReason?.toLowerCase().includes('not found') ||
        result.failureReason?.toLowerCase().includes('pending')) {
      res.json({ status: 'processing', message: 'Transaction not yet confirmed' }); return;
    }
    // Hard failure
    db.prepare("UPDATE payment_intents SET status='failed',updated_at=unixepoch() WHERE id=?").run(pi.id);
    db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,from_status,to_status,data) VALUES(?,?,?,?,?,?)')
      .run(generateId('pe'), pi.id, 'payment.failed', 'processing', 'failed', JSON.stringify({ reason: result.failureReason }));
    enqueueWebhookDeliveries(pi.id, 'payment.failed', { payment_intent_id: pi.id, reason: result.failureReason }, pi.environment as 'test' | 'live');
    res.status(422).json({ status: 'failed', error: result.failureReason }); return;
  }

  // Atomic credit
  const paymentId = generateId('pay');
  let alreadySucceeded = false;

  db.transaction(() => {
    type StatusRow = { status: string };
    const fresh = db.prepare('SELECT status FROM payment_intents WHERE id=?').get(pi.id) as StatusRow;
    if (fresh.status === 'succeeded') { alreadySucceeded = true; return; }

    const amountFmt = formatBaseUnitsToDecimal(BigInt(result.amountBaseUnits!));

    db.prepare(
      'INSERT OR IGNORE INTO blockchain_transactions(id,tx_hash,network,chain_id,block_number,block_timestamp,from_address,to_address,usdc_address,amount,log_index,raw_receipt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(generateId('btx'), result.txHash!, pi.network, pi.chain_id, result.blockNumber!, result.blockTimestamp!, result.sender!, result.recipient!, pi.usdc_address, result.amountBaseUnits!, result.logIndex ?? 0, '{}');

    db.prepare(
      'INSERT INTO payments(id,payment_intent_id,merchant_id,tx_hash,network,chain_id,sender_address,recipient_address,amount_base_units,amount_decimal,block_number,block_timestamp) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(paymentId, pi.id, pi.merchant_id, result.txHash!, pi.network, pi.chain_id, result.sender!, result.recipient!, result.amountBaseUnits!, amountFmt, result.blockNumber!, result.blockTimestamp!);

    db.prepare('UPDATE blockchain_transactions SET payment_id=? WHERE tx_hash=? AND network=?').run(paymentId, result.txHash!, pi.network);
    db.prepare("UPDATE payment_intents SET status='succeeded',updated_at=unixepoch() WHERE id=?").run(pi.id);
    db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,from_status,to_status) VALUES(?,?,?,?,?)')
      .run(generateId('pe'), pi.id, 'payment.succeeded', 'processing', 'succeeded');
  })();

  if (alreadySucceeded) {
    const payment = db.prepare('SELECT * FROM payments WHERE payment_intent_id=?').get(pi.id);
    res.json({ status: 'succeeded', payment }); return;
  }

  const paymentRow = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId) as Record<string, unknown>;
  enqueueWebhookDeliveries(pi.id, 'payment.succeeded', { payment_intent_id: pi.id, payment: paymentRow }, pi.environment as 'test' | 'live');
  res.json({ status: 'succeeded', payment: paymentRow });
});

export default router;
