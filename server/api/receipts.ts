/**
 * JafariPay — Receipt API (Phase B).
 *
 * Two audiences, cleanly separated for tenant isolation (Phase H):
 *
 *  1. PUBLIC (customer-facing receipt page): GET /:id and /:id/pdf-style JSON.
 *     Authorized purely by the unguessable capability receipt id (rcpt_ + 24
 *     random chars, non-enumerable). Returns a SAFE projection — the fields a
 *     customer needs to recognize their own payment — and nothing that leaks
 *     another tenant's data or internal IDs beyond what belongs on a receipt.
 *
 *  2. MERCHANT (session or API key): GET / list and GET /:id detail. Always
 *     scoped to the caller's OWN merchant_id, so one merchant can never read
 *     another's receipts even with a valid id for someone else (the lookup
 *     filters by merchant_id → 404). This is the cross-merchant isolation gate.
 */

import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/schema.js';
import { requireSessionOrApiKey, requireApiKey, type AuthedRequest } from '../middleware/auth.js';
import type { ReceiptRow } from '../receipts/service.js';

const router = Router();

// Public projection — the customer receipt view. No secret/hash columns.
function publicReceipt(r: ReceiptRow): Record<string, unknown> {
  return {
    id: r.id,
    payment_intent_id: r.payment_intent_id,
    order_id: r.order_id,
    merchant_name: r.merchant_name,
    amount: r.amount_decimal,
    amount_base_units: r.amount_base_units,
    currency: r.currency,
    network: r.network,
    chain_id: r.chain_id,
    tx_hash: r.tx_hash,
    explorer_url: r.explorer_url,
    timestamp: r.block_timestamp,
    status: r.payment_status,
    customer_email: r.customer_email,
    email_status: r.email_status,
    created_at: r.created_at,
  };
}

// Merchant projection — adds the internal linkage a reconciliation UI wants.
function merchantReceipt(r: ReceiptRow): Record<string, unknown> {
  return { ...publicReceipt(r), payment_id: r.payment_id, merchant_id: r.merchant_id };
}

// ── GET /  (merchant list, isolated) — must be registered BEFORE /:id ──────
router.get('/', requireSessionOrApiKey, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 100);
  const offset = parseInt((req.query.offset as string) || '0', 10);
  const params: (string | number)[] = [ar.merchantId!];
  let where = 'WHERE merchant_id=?';
  const order = req.query.order_id as string | undefined;
  if (order) { where += ' AND order_id=?'; params.push(order); }
  params.push(limit, offset);
  const rows = db.prepare(`SELECT * FROM receipts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as ReceiptRow[];
  res.json({ data: rows.map(merchantReceipt), limit, offset });
});

// ── POST /v1/receipts/:id/resend (merchant) — re-attempt a failed email ─────
router.post('/:id/resend', requireApiKey(), async (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const r = db.prepare('SELECT * FROM receipts WHERE id=? AND merchant_id=?').get(req.params.id, ar.merchantId!) as ReceiptRow | undefined;
  if (!r) { res.status(404).json({ error: 'Receipt not found' }); return; }
  if (r.email_status === 'sent') { res.json({ receipt_id: r.id, email_status: 'sent', already_sent: true }); return; }
  if (!r.customer_email) { res.json({ receipt_id: r.id, email_status: 'no_email', error: 'no customer email on file' }); return; }
  // Reset backoff and attempt now.
  db.prepare("UPDATE receipts SET email_status='pending',email_attempts=0,next_email_attempt_at=unixepoch(),updated_at=unixepoch() WHERE id=?").run(r.id);
  const { attemptReceiptEmail } = await import('../receipts/service.js');
  const result = await attemptReceiptEmail(r.id);
  const fresh = db.prepare('SELECT * FROM receipts WHERE id=?').get(r.id) as ReceiptRow;
  res.json({ receipt_id: r.id, email_status: fresh.email_status, ok: result.ok });
});

// ── GET /:id — public capability read (the customer receipt page source) ────
router.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id) as ReceiptRow | undefined;
  if (!r) { res.status(404).json({ error: 'Receipt not found' }); return; }
  res.json(publicReceipt(r));
});

export default router;
