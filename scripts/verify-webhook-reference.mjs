#!/usr/bin/env node
/**
 * JafariPay — standalone webhook signature VERIFIER (developer reference)
 *
 * This file is intentionally ZERO-dependency and contains NO JafariPay internals.
 * Copy it into your own server. It verifies a JafariPay webhook delivery against
 * the EXACT raw request body using only Node's built-in crypto:
 *
 *   signature = HMAC_SHA256(raw_webhook_body, merchant_webhook_secret)
 *   header    = `X-JafariPay-Signature: t=<unix_ts>,v1=<hex hmac over "<t>.<rawBody>">`
 *
 * Rules baked in here (all of them matter):
 *   1. Verify against the RAW bytes received — never a re-serialized JSON object
 *      (re-`JSON.stringify` can reorder keys / change whitespace and breaks HMAC).
 *   2. Reject timestamps outside a freshness window (replay protection).
 *   3. Compare with a constant-time function (timing-attack resistance).
 *   4. Never echo the secret; verification returns a boolean only.
 *
 * Usage (Express):
 *   import { verifyWebhookSignature } from './verify-webhook-reference.mjs';
 *   app.post('/webhooks/jafaripay', express.raw({ type: 'application/json' }), (req, res) => {
 *     const ok = verifyWebhookSignature({
 *       rawBody: req.body.toString('utf8'),
 *       signatureHeader: req.header('X-JafariPay-Signature'),
 *       secret: process.env.JAFARIPAY_WEBHOOK_SECRET,
 *     });
 *     if (!ok) return res.status(400).send('invalid signature');
 *     const event = JSON.parse(req.body.toString('utf8'));
 *     // ... idempotent handling keyed on event.id ...
 *     res.sendStatus(200);
 *   });
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * @param {object}  p
 * @param {string}  p.rawBody         Exact bytes received on the wire (UTF-8).
 * @param {string}  p.signatureHeader Value of the `X-JafariPay-Signature` header.
 * @param {string}  p.secret          The `whsec_...` shown once at endpoint create/rotate.
 * @param {number} [p.maxAgeSec=300]  Freshness window (± seconds).
 * @param {number} [p.nowSec]         Override clock (tests). Defaults to wall clock.
 * @returns {boolean} true ONLY if the header is well-formed, fresh, and matches.
 */
export function verifyWebhookSignature({ rawBody, signatureHeader, secret, maxAgeSec = 300, nowSec }) {
  if (typeof rawBody !== 'string' || typeof signatureHeader !== 'string' || typeof secret !== 'string') return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return i === -1 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
    })
  );
  const t = Number.parseInt(parts.t, 10);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || typeof v1 !== 'string' || v1.length === 0) return false;

  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > maxAgeSec) return false; // replay / stale-window guard

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(v1, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(a, b);
}

// ── Self-test: `node scripts/verify-webhook-reference.mjs --selftest` ──────
// Proves the verifier accepts a correctly-signed raw body and rejects every
// common tamper vector — WITHOUT importing any JafariPay code.
if (process.argv[2] === '--selftest') {
  const secret = 'whsec_' + 'ab'.repeat(32);
  const body = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', memo: 'Ünïcødé ☕' });
  const ts = Math.floor(Date.now() / 1000);
  const sign = (t, raw) => 't=' + t + ',v1=' + createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');

  const cases = [
    ['valid',               verifyWebhookSignature({ rawBody: body, signatureHeader: sign(ts, body), secret }), true],
    ['wrong secret',        verifyWebhookSignature({ rawBody: body, signatureHeader: sign(ts, body), secret: 'whsec_x' }), false],
    ['tampered body',       verifyWebhookSignature({ rawBody: body + ' ', signatureHeader: sign(ts, body), secret }), false],
    ['tampered timestamp',  verifyWebhookSignature({ rawBody: body, signatureHeader: sign(ts, body).replace('t=' + ts, 't=' + (ts + 6)), secret }), false],
    ['stale timestamp',     verifyWebhookSignature({ rawBody: body, signatureHeader: sign(ts - 400, body), secret }), false],
    ['empty header',        verifyWebhookSignature({ rawBody: body, signatureHeader: '', secret }), false],
    ['short signature',     verifyWebhookSignature({ rawBody: body, signatureHeader: 't=' + ts + ',v1=ab', secret }), false],
  ];

  let failed = 0;
  for (const [name, got, want] of cases) {
    const pass = got === want;
    if (!pass) failed++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} (got ${got}, want ${want})`);
  }
  console.log(failed === 0 ? '\nAll reference-verifier self-tests passed.' : `\n${failed} self-test(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}
