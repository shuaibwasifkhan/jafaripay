/**
 * JafariPay — Customer receipt service (Phase B).
 *
 * A receipt is created ONLY from a successfully VERIFIED + CREDITED payment
 * (payments row), never from intent creation. The pipeline is:
 *
 *   Payment verified → credited (payment_intents.status='succeeded')
 *     → generateReceiptForPayment()  (idempotent, UNIQUE(payment_id))
 *     → attemptReceiptEmail()        (best-effort; failure is isolated)
 *
 * ISOLATION CONTRACT (non-negotiable, enforced here):
 *   • generateReceiptForPayment() and attemptReceiptEmail() NEVER throw into a
 *     money path and NEVER mutate payment_intents/payments. They only write the
 *     receipts table. A receipt/email error can therefore never change whether a
 *     payment succeeded.
 *   • Email status lives on the receipt row only (pending/sent/failed/skipped/
 *     no_email). 'failed' email → payment still 'succeeded'.
 */

import { getDb } from '../db/schema.js';
import { generateReceiptId } from '../lib/ids.js';
import { formatBaseUnitsToDecimal } from '../lib/money.js';
import { getEmailTransport, isValidEmail, normalizeEmail, type EmailMessage } from '../email/transport.js';

const EMAIL_MAX_ATTEMPTS = 4;
const EMAIL_RETRY_DELAYS_S = [30, 120, 600, 3600];

export interface ReceiptRow {
  id: string;
  payment_id: string;
  payment_intent_id: string;
  merchant_id: string;
  customer_email: string | null;
  merchant_name: string;
  order_id: string | null;
  amount_decimal: string;
  amount_base_units: string;
  currency: string;
  network: string;
  chain_id: number;
  tx_hash: string;
  explorer_url: string;
  block_timestamp: number;
  payment_status: string;
  email_status: string;
  email_attempts: number;
  last_email_error: string | null;
  next_email_attempt_at: number;
  emailed_at: number | null;
  created_at: number;
  updated_at: number;
}

// Network-aware explorer link, built from the SAME registry the checkout and the
// money verifier use (network_configs.explorer_base + '/tx/<hash>'). A disabled
// or unknown network yields an empty link — we never fabricate a wrong explorer
// host (which would be a phishing/SSRF-adjacent risk in an emailed receipt).
function buildExplorerUrl(network: string, txHash: string): string {
  const row = getDb()
    .prepare('SELECT explorer_base, is_enabled FROM network_configs WHERE network = ?')
    .get(network) as { explorer_base: string; is_enabled: number } | undefined;
  if (!row || row.is_enabled !== 1) return '';
  const base = String(row.explorer_base || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return '';
  return `${base}/tx/${txHash}`;
}

/**
 * Idempotently create the receipt for a SUCCEEDED payment. If a receipt already
 * exists for the payment (UNIQUE(payment_id) — duplicate-receipt prevention) it
 * is returned unchanged. Returns null when the payment is not found / not
 * credited. Safe to call from any success path; never throws on expected races.
 */
export function generateReceiptForPayment(paymentId: string): ReceiptRow | null {
  const db = getDb();

  const existing = db.prepare('SELECT * FROM receipts WHERE payment_id = ?').get(paymentId) as ReceiptRow | undefined;
  if (existing) return existing;

  type PayRow = {
    payment_id: string; payment_intent_id: string; merchant_id: string; tx_hash: string;
    network: string; chain_id: number; amount_base_units: string; amount_decimal: string;
    block_timestamp: number; status: string;
  };
  const pay = db.prepare(
    `SELECT p.id AS payment_id, p.payment_intent_id, p.merchant_id, p.tx_hash, p.network,
            p.chain_id, p.amount_base_units, p.amount_decimal, p.block_timestamp, p.status
     FROM payments p WHERE p.id = ?`
  ).get(paymentId) as PayRow | undefined;
  if (!pay) return null;

  // A receipt reflects a SUCCEEDED payment only. Defensive: the callers invoke
  // this immediately after crediting, but never mint a receipt for a non-
  // succeeded payment row.
  if (pay.status !== 'succeeded') return null;

  type PiRow = { customer_email: string | null; order_id: string | null; currency: string };
  const pi = db.prepare('SELECT customer_email, order_id, currency FROM payment_intents WHERE id = ?')
    .get(pay.payment_intent_id) as PiRow | undefined;

  const merchantName = (db.prepare('SELECT name FROM merchants WHERE id = ?').get(pay.merchant_id) as { name: string } | undefined)?.name ?? '';

  const rawEmail = pi?.customer_email ?? null;
  // Only a genuinely valid stored address is emailed; anything else becomes the
  // no-email path so an invalid value can never reach a transport.
  const email = rawEmail && isValidEmail(rawEmail) ? normalizeEmail(rawEmail) : null;
  const emailStatus = email ? 'pending' : 'no_email';

  const id = generateReceiptId();
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare(
      `INSERT INTO receipts(id,payment_id,payment_intent_id,merchant_id,customer_email,merchant_name,order_id,
        amount_decimal,amount_base_units,currency,network,chain_id,tx_hash,explorer_url,block_timestamp,
        payment_status,email_status,email_attempts,next_email_attempt_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, pay.payment_id, pay.payment_intent_id, pay.merchant_id, email, merchantName, pi?.order_id ?? null,
      pay.amount_decimal, pay.amount_base_units, pi?.currency ?? 'USDC', pay.network, pay.chain_id, pay.tx_hash,
      buildExplorerUrl(pay.network, pay.tx_hash), pay.block_timestamp,
      'succeeded', emailStatus, 0, now, now, now
    );
  } catch (err) {
    // UNIQUE(payment_id) race — another concurrent success already created it.
    // Return the winner; never surface an error to the money path.
    const conc = db.prepare('SELECT * FROM receipts WHERE payment_id = ?').get(paymentId) as ReceiptRow | undefined;
    if (conc) return conc;
    throw err;
  }

  return db.prepare('SELECT * FROM receipts WHERE id = ?').get(id) as ReceiptRow;
}

function renderReceiptEmail(r: ReceiptRow): EmailMessage {
  const amount = safeAmount(r);
  const subject = `Your payment receipt — ${r.merchant_name || 'JafariPay'} ${amount} ${r.currency}`;
  const link = r.explorer_url || '(blockchain transaction)';
  const support = r.merchant_name ? `Reply to this email or contact ${r.merchant_name} for help.` : 'Contact the merchant for help.';
  const text =
`Thanks for your payment!

Merchant:     ${r.merchant_name || '—'}
Amount:       ${amount} ${r.currency}
Network:      ${r.network}
Date:         ${new Date(r.block_timestamp * 1000).toISOString()}
Status:       ${r.payment_status.toUpperCase()}
Order ref:    ${r.order_id || '—'}
Receipt ID:   ${r.id}
Transaction:  ${r.tx_hash}
Explorer:     ${link}

${support}
This receipt was issued after JafariPay independently verified your USDC
transfer on-chain. JafariPay never holds your funds.`;

  // Every merchant-supplied value entering this HTML context is escaped
  // (merchant_name via escapeHtml below; every table row via rowHtml; the
  // explorer href via escapeAttr). The text/plain part and Subject header need
  // no escaping — they carry no markup context.
  const html =
`<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#0f172a">
  <h2 style="margin:0 0 4px">${escapeHtml(r.merchant_name || 'Your payment')}</h2>
  <p style="margin:0 0 20px;color:#64748b">Receipt ${r.id}</p>
  <div style="font-size:28px;font-weight:700">${amount} ${r.currency}</div>
  <p style="color:#16a34a;font-weight:600;margin:2px 0 20px">Payment ${r.payment_status.toUpperCase()}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    ${rowHtml('Network', r.network)}
    ${rowHtml('Date', new Date(r.block_timestamp * 1000).toISOString())}
    ${rowHtml('Order ref', r.order_id || '—')}
    ${rowHtml('Payment intent', r.payment_intent_id)}
    ${rowHtml('Transaction', r.tx_hash)}
  </table>
  <p style="margin-top:18px"><a href="${escapeAttr(link)}" style="color:#166534;font-weight:600;text-decoration:none">View on explorer →</a></p>
  <p style="color:#94a3b8;font-size:12px;margin-top:24px">${escapeHtml(support)}<br>JafariPay is non-custodial — your USDC went directly to the merchant.</p>
</div>`;

  return { to: r.customer_email!, subject, text, html, idempotencyKey: `receipt-email:${r.id}` };
}

function safeAmount(r: ReceiptRow): string {
  try {
    return formatBaseUnitsToDecimal(BigInt(r.amount_base_units));
  } catch {
    return r.amount_decimal;
  }
}
function rowHtml(label: string, value: string): string {
  return `<tr><td style="padding:6px 0;color:#64748b;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:6px 0;text-align:right;font-family:ui-monospace,monospace;word-break:break-all">${escapeHtml(value)}</td></tr>`;
}
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function escapeAttr(s: string): string {
  // Never let a non-http(s) (e.g. javascript:) URL become an anchor href.
  return /^https?:\/\//i.test(s) ? escapeHtml(s) : '#';
}

/**
 * Best-effort: send (or attempt) the receipt email and record the outcome on the
 * receipt row. NEVER throws into a caller and NEVER touches payments/
 * payment_intents — a failure is written to email_status only.
 */
export async function attemptReceiptEmail(receiptId: string): Promise<{ ok: boolean; status: string }> {
  const db = getDb();
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId) as ReceiptRow | undefined;
  if (!r) return { ok: false, status: 'missing' };

  // Already sent — idempotent, do not re-email on a duplicate verify call.
  if (r.email_status === 'sent') return { ok: true, status: 'sent' };
  // Nothing to send to.
  if (!r.customer_email || !isValidEmail(r.customer_email)) {
    db.prepare("UPDATE receipts SET email_status='no_email',updated_at=unixepoch() WHERE id=?").run(receiptId);
    return { ok: true, status: 'no_email' };
  }

  const transport = getEmailTransport();
  let result;
  try {
    result = await transport.send(renderReceiptEmail(r));
  } catch (err) {
    // A transport that throws is still just an email failure — never propagate.
    result = { ok: false, error: String(err) };
  }

  const now = Math.floor(Date.now() / 1000);
  if (result.ok) {
    db.prepare("UPDATE receipts SET email_status='sent',emailed_at=?,last_email_error=NULL,updated_at=unixepoch() WHERE id=?")
      .run(now, receiptId);
    return { ok: true, status: 'sent' };
  }

  const attempts = r.email_attempts + 1;
  const finalStatus = attempts >= EMAIL_MAX_ATTEMPTS ? 'failed' : 'pending';
  const delay = EMAIL_RETRY_DELAYS_S[Math.min(attempts - 1, EMAIL_RETRY_DELAYS_S.length - 1)] ?? 3600;
  db.prepare(
    "UPDATE receipts SET email_status=?,email_attempts=?,last_email_error=?,next_email_attempt_at=?,updated_at=unixepoch() WHERE id=?"
  ).run(finalStatus, attempts, result.error ?? 'send failed', now + (finalStatus === 'pending' ? delay : 0), receiptId);
  return { ok: false, status: finalStatus };
}

/** Convenience used by the verify success paths: create + email, fully isolated. */
export async function issueReceiptForPayment(paymentId: string): Promise<ReceiptRow | null> {
  let receipt: ReceiptRow | null;
  try {
    receipt = generateReceiptForPayment(paymentId);
  } catch (err) {
    console.error('[Receipt] generation failed (payment unaffected):', err);
    return null;
  }
  if (!receipt) return null;
  if (receipt.email_status === 'pending') {
    try {
      await attemptReceiptEmail(receipt.id);
    } catch (err) {
      console.error('[Receipt] email attempt failed (payment unaffected):', err);
    }
  }
  return db_reselect(receipt.id);
}

function db_reselect(id: string): ReceiptRow | null {
  return (getDb().prepare('SELECT * FROM receipts WHERE id = ?').get(id) as ReceiptRow | undefined) ?? null;
}

/**
 * Worker tick (Phase B retry): attempt every receipt whose email is still
 * 'pending' and past its next_attempt_at. Mirrors the webhook retry discipline.
 */
export async function processPendingReceiptEmails(): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  type Row = { id: string };
  const due = db.prepare(
    "SELECT id FROM receipts WHERE email_status='pending' AND next_email_attempt_at <= ? ORDER BY next_email_attempt_at LIMIT 20"
  ).all(now) as Row[];
  for (const d of due) {
    await attemptReceiptEmail(d.id);
  }
}
