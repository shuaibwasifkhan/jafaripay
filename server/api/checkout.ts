/**
 * JafariPay — Public checkout API (no auth required)
 *
 * GET  /checkout/:id         — public payment intent info (for the checkout page)
 * POST /checkout/:id/verify  — submit tx hash for backend verification
 */

import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/schema.js';
import { cctpSourceRoutePlan } from '../db/cctp.js';
import { CCTP_FORWARD_HOOK_DATA, FORWARDING_FINALITY_STANDARD } from '../blockchain/cctp-forwarding-fee.js';
import { describeCrossChainFees } from '../lib/fees.js';
import { generateId } from '../lib/ids.js';
import { verifyPayment, PI_SETTLEMENT_GRACE_S } from '../blockchain/arc-provider.js';
import { detectSourceBurn } from '../blockchain/cctp-source.js';
import { enqueueWebhookDeliveries } from '../webhooks/delivery.js';
import { formatBaseUnitsToDecimal } from '../lib/money.js';
import { issueReceiptForPayment, generateReceiptForPayment, attemptReceiptEmail } from '../receipts/service.js';
import { isValidEmail, normalizeEmail } from '../email/transport.js';

const router = Router();

// ── STEP 5N — CROSS-CHAIN SOURCE-BURN DETECTION (HTTP integration) ─────────
// A cross-chain intent can NOT be verified with the same-chain verifyPayment()
// path — its transaction is a CCTP DepositForBurn on the SOURCE chain and Arc
// settlement happens asynchronously (attestation, then Circle forwarding for an
// F>0 intent). We hand the submitted tx to the existing, unit-tested
// detectSourceBurn(), the single production site that validates the burn against
// the server-approved M + F / maxFee = F invariants, applies the source-finality
// gate, and records the cross_chain_transfers row the reconciliation worker then
// drives to settlement + merchant credit. The route duplicates NONE of that
// worker logic — it only returns 'processing'. The module is read through a
// restorable seam so this wiring is unit-testable without a live source chain
// (mirrors the `spyOn` discipline the same-chain route tests already use).
let detectSourceBurnImpl: typeof detectSourceBurn = detectSourceBurn;
/** Test seam. Pass null to restore the real registry-backed detector. */
export function setSourceBurnDetectionForTest(fn: typeof detectSourceBurn | null): void {
  detectSourceBurnImpl = fn ?? detectSourceBurn;
}

// ── GET /checkout/:id ─────────────────────────────────────────────────────
router.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const pi = db.prepare(
    `SELECT pi.id, pi.status, pi.amount_decimal AS amount, pi.amount_base_units,
            pi.currency, pi.network, pi.chain_id, pi.usdc_address,
            pi.settlement_address, pi.expires_at, pi.created_at,
            pi.order_id, pi.description,
            pi.is_cross_chain, pi.source_network, pi.settlement_network, pi.settlement_chain_id,
            pi.forwarding_max_fee_base_units,
            m.name AS merchant_name
     FROM payment_intents pi
     JOIN merchants m ON m.id = pi.merchant_id
     WHERE pi.id = ?`
  ).get(req.params.id) as Record<string, unknown> | null;

  if (!pi) { res.status(404).json({ error: 'Payment intent not found' }); return; }

  // Don't expose private merchant fields
  //
  // CCTP PHASE 4: for a cross-chain intent, attach the SERVER-AUTHORITATIVE
  // source-leg route plan. The checkout UI is forbidden from deriving any of
  // these — it relays exactly what the registry pins, so a compromised/curious
  // client can never move the mint recipient off the merchant's Arc wallet or
  // retarget the destination domain/contract. Same-chain intents are unchanged.
  if (pi.is_cross_chain === 1) {
    const sourceSlug = String(pi.network);
    const mintRecipient = String(pi.settlement_address);
    const burnToken = String(pi.usdc_address);
    const plan = cctpSourceRoutePlan({ sourceSlug, mintRecipientAddress: mintRecipient, burnTokenAddress: burnToken });
    pi.cross_chain = true;

    // STEP 5 — CIRCLE FORWARDING. F is the SERVER-approved fee persisted by
    // applyForwardingQuote into payment_intents.forwarding_max_fee_base_units; a
    // browser can NEVER set it (ownership proven in cctp-intents.test.ts). F > 0
    // upgrades the otherwise-STANDARD route to a Forwarding route: the source must
    // burn the GROSS M + F with the `cctp-forward` hook at STANDARD finality (>=
    // 2000, matching our un-weakenable attestation gate) and Circle mints M on Arc.
    // F = 0 keeps the EXACT pre-existing DIRECT plan (max_fee '0', finality 0, no
    // hook) — forwarding is strictly additive and never forced on any payment.
    const feeRaw = pi.forwarding_max_fee_base_units == null ? '0' : String(pi.forwarding_max_fee_base_units);
    let fee = 0n;
    try {
      fee = BigInt(feeRaw);
    } catch {
      fee = 0n; // fail-safe to the DIRECT route; a garbage fee never enables forwarding
    }
    if (fee > 0n) {
      plan.max_fee = fee.toString();                 // source burn carries maxFee = F
      plan.min_finality_threshold = FORWARDING_FINALITY_STANDARD; // 2000 (Standard)
      plan.hook_data = CCTP_FORWARD_HOOK_DATA;        // server-authored cctp-forward hook
    }
    pi.forwarding = fee > 0n;
    pi.cctp_source_route = plan;
    // PHASE 14: expose the fee model so the customer sees, before paying, that a
    // Standard CCTP transfer is 1:1 — the merchant receives exactly this amount
    // and JafariPay levies no hidden deduction on the transfer principal.
    // For a Forwarding route the Circle fee F is passed through so the display
    // reflects that Circle (not JafariPay) deducts it and the merchant still nets M.
    pi.fees = describeCrossChainFees({ amountBaseUnits: String(pi.amount_base_units), feeBaseUnits: fee > 0n ? feeRaw : '0' });
  } else {
    pi.cross_chain = false;
  }

  res.json(pi);
});

// ── POST /checkout/:id/verify ─────────────────────────────────────────────
// Called by the checkout frontend after the customer's transaction is onchain.
// We do full independent blockchain verification here.
router.post('/:id/verify', async (req: Request, res: Response) => {
  const db = getDb();
  const { tx_hash, chain_id, receipt_email } = req.body as { tx_hash: string; chain_id?: number; receipt_email?: string };

  if (!tx_hash) { res.status(400).json({ error: 'tx_hash is required' }); return; }

  // Validate tx_hash format — must be 0x + 64 hex chars
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) {
    res.status(400).json({ error: 'tx_hash must be a valid 32-byte hex hash (0x + 64 hex characters)' }); return;
  }

  // Optional customer email supplied at pay time (the hosted checkout lets the
  // customer ask for a receipt). Validated strictly; an invalid one is refused
  // BEFORE the money path runs, so a bad address can never poison a credit.
  let emailInput: string | null = null;
  if (typeof receipt_email === 'string' && receipt_email !== '') {
    if (!isValidEmail(receipt_email)) { res.status(400).json({ error: 'receipt_email is not valid', code: 'invalid_email' }); return; }
    emailInput = normalizeEmail(receipt_email);
  }

  type PiRow = {
    id: string; status: string; network: string; settlement_address: string;
    amount_base_units: string; usdc_address: string; chain_id: number;
    amount_decimal: string; environment: string; merchant_id: string;
    expires_at: number; is_cross_chain: number;
  };
  const pi = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(req.params.id) as PiRow | null;
  if (!pi) { res.status(404).json({ error: 'Payment intent not found' }); return; }

  // Validate chain_id — REQUIRED and must equal the PI's pinned chain_id.
  // SECURITY: the persisted PI chain_id is the source of truth; the client-
  // supplied chain_id is only an assertion that must match it. It never
  // selects the verification target, and a mismatch/absence is rejected BEFORE
  // any blockchain verification is attempted.
  if (chain_id === undefined || chain_id === null || (chain_id as unknown) === '') {
    res.status(400).json({ error: 'chain_id is required', code: 'wrong_network' }); return;
  }
  if (Number(chain_id) !== Number(pi.chain_id)) {
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

  // ── CROSS-CHAIN (CCTP Forwarding) branch. NEVER runs the same-chain
  // verifyPayment() money path. Delegates to the existing detectSourceBurn(),
  // which owns the cross-chain state machine (payable gate, source-finality
  // gate, M + F / maxFee = F burn validation, the cross_chain_transfers row and
  // the intent→'processing' transition). The route just maps the result to HTTP
  // and lets the reconciliation worker finish attestation → forwarding →
  // destination verification → settlement → merchant credit.
  if (pi.is_cross_chain === 1) {
    const burn = await detectSourceBurnImpl({ paymentIntentId: pi.id, sourceTxHash: tx_hash });
    if (burn.ok) {
      res.json({ status: 'processing', transfer_id: burn.transferId, state: burn.state }); return;
    }
    if (burn.retryable) {
      // Not mined yet / source block not final / transient RPC — the burn can
      // still land, so keep the customer polling instead of failing hard.
      res.json({ status: 'processing', message: burn.reason }); return;
    }
    // Hard rejection: this tx can never satisfy this intent (invalid/non-CCTP
    // burn, amount ≠ M + F, wrong mint recipient, replay, non-payable intent, …).
    res.status(422).json({ error: burn.reason, code: burn.code }); return;
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

  // Blockchain verification.
  // SECURITY/RELIABILITY: verifyPayment THROWS on an RPC/transport failure or a
  // chain-id mismatch (it fails closed rather than returning a benign result).
  // Mirror the API-key path (POST /v1/payment-intents/:id/verify): catch that
  // here so a transient infrastructure error is a clean, retryable 503 JSON —
  // never an unhandled throw (Express 5 default error → opaque HTML 500) that
  // leaves the intent stuck in 'processing' until the reconciliation reset.
  let result: Awaited<ReturnType<typeof verifyPayment>>;
  try {
    result = await verifyPayment({
      txHash: tx_hash,
      network: pi.network,
      paymentIntentId: pi.id,
      settlementAddress: pi.settlement_address,
      expectedAmountBaseUnits: pi.amount_base_units,
      usdcAddress: pi.usdc_address,
    });
  } catch {
    // RPC error — reset to requires_payment so the customer can safely retry.
    db.prepare("UPDATE payment_intents SET status='requires_payment',updated_at=unixepoch() WHERE id=? AND status='processing'").run(pi.id);
    res.status(503).json({ error: 'Blockchain RPC error — please retry', retryable: true }); return;
  }

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
  // Persist the pay-time email (only if the merchant didn't already set one) then
  // generate + send the receipt. Isolated: neither can ever change 'succeeded'.
  if (emailInput) {
    db.prepare("UPDATE payment_intents SET customer_email=COALESCE(customer_email,?),updated_at=unixepoch() WHERE id=?").run(emailInput, pi.id);
  }
  const receipt = await issueReceiptForPayment(paymentId);
  res.json({ status: 'succeeded', payment: paymentRow, receipt_id: receipt?.id ?? null });
});

// ── POST /checkout/:id/receipt ────────────────────────────────────────────
// Let a customer attach/repair their email on an ALREADY-SUCCEEDED payment and
// (re)send the receipt. Capability-gated: only a payment that already reached
// 'succeeded' has a receipt; the unguessable intent id is the access token, so
// this cannot enumerate or touch anyone else's payments. Never alters money.
router.post('/:id/receipt', async (req: Request, res: Response) => {
  const db = getDb();
  const { email } = req.body as { email?: string };
  if (typeof email !== 'string' || !isValidEmail(email)) {
    res.status(400).json({ error: 'a valid email is required', code: 'invalid_email' }); return;
  }
  const norm = normalizeEmail(email);

  const pi = db.prepare('SELECT id, merchant_id, customer_email FROM payment_intents WHERE id = ?').get(req.params.id) as { id: string; merchant_id: string; customer_email: string | null } | null;
  if (!pi) { res.status(404).json({ error: 'Payment intent not found' }); return; }

  const payment = db.prepare("SELECT id FROM payments WHERE payment_intent_id = ? AND status='succeeded'").get(pi.id) as { id: string } | null;
  if (!payment) { res.status(409).json({ error: 'Payment has not succeeded yet', code: 'not_succeeded' }); return; }

  db.prepare('UPDATE payment_intents SET customer_email=?,updated_at=unixepoch() WHERE id=?').run(norm, pi.id);

  // Ensure a receipt exists for the succeeded payment, point it at the new
  // address, and (re)attempt delivery. Existing 'sent' receipts are left alone.
  let receipt = generateReceiptForPayment(payment.id);
  if (receipt && receipt.email_status !== 'sent') {
    db.prepare("UPDATE receipts SET customer_email=?,email_status='pending',email_attempts=0,next_email_attempt_at=unixepoch(),updated_at=unixepoch() WHERE id=?").run(norm, receipt.id);
    receipt = (db.prepare('SELECT * FROM receipts WHERE id=?').get(receipt.id) as typeof receipt) ?? receipt;
    await attemptReceiptEmail(receipt!.id);
    receipt = db.prepare('SELECT * FROM receipts WHERE id=?').get(receipt!.id) as typeof receipt;
  }
  res.json({ receipt_id: receipt?.id ?? null, email_status: receipt?.email_status ?? 'no_email' });
});

export default router;
