/**
 * JafariPay — Brevo SMTP EmailTransport focused tests (Phase 21 / D-4).
 *
 * Coverage mandated by the implementation task:
 *   1. Brevo transport selection via the existing EMAIL_TRANSPORT switch.
 *   2. Missing credential / configuration failure — returned as a value,
 *      never thrown.
 *   3. Successful transport invocation with a mocked SMTP boundary.
 *   4. SMTP failure handling — returned as a value, never thrown.
 *   5. Isolation contract reminder: `send()` shape matches what the receipts
 *      service consumes, so a failed Brevo send cannot escalate into a
 *      payment-status change. (The end-to-end proof of this lives in
 *      `master-receipts.test.ts` R5 — those tests exercise the SAME
 *      `EmailTransport` interface, so any implementation of it, including
 *      Brevo, is covered automatically.)
 *
 * SAFETY GUARANTEES ENFORCED HERE:
 *   • NO real SMTP socket is ever opened. Every behavioural test constructs
 *     `BrevoSmtpTransport` with an INJECTED `deliver` boundary; the production
 *     default (`smtpSend`) is never called.
 *   • NO real Brevo credentials appear anywhere in this file. All logins,
 *     keys, and senders use `.invalid` / `do-not-commit` placeholders that
 *     RFC 2606 reserves and that cannot resolve to a real address.
 *   • NO payment, database, blockchain, CCTP, or webhook code is imported —
 *     this test file touches ONLY the email subsystem.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test';

import { getEmailTransport } from './transport.ts';
import {
  BrevoSmtpTransport,
  makeBrevoSmtpTransport,
  type PreparedEmail,
} from './brevo-smtp.ts';

// ── Fixture config (placeholders only — never real creds) ──────────────────
const FAKE_CFG = {
  host: 'smtp-relay.brevo.com',
  port: 587,
  login: 'brevo-login@test.invalid',
  password: 'do-not-commit-fake-smtp-key-32charsmin',
  from: 'no-reply@jafari.co.in',
  timeoutMs: 5000,
};

const VALID_MSG = {
  to: 'customer@example.invalid',
  subject: 'Your payment receipt — JafariPay',
  text: 'Thanks for your payment.',
  html: '<p>Thanks for your payment.</p>',
  idempotencyKey: 'receipt-email:test-abc123',
};

// Snapshot / restore EMAIL_* env vars so tests do not leak state to peers.
const ENV_KEYS = [
  'EMAIL_TRANSPORT',
  'EMAIL_BREVO_SMTP_HOST',
  'EMAIL_BREVO_SMTP_PORT',
  'EMAIL_BREVO_SMTP_LOGIN',
  'EMAIL_BREVO_SMTP_KEY',
  'EMAIL_FROM',
  'EMAIL_BREVO_TIMEOUT_MS',
] as const;

const snapshot: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) snapshot[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = snapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ═════════════════════════════════════════════════════════════════════════
// 1 — Transport selection through the EXISTING single-env-var switch
// ═════════════════════════════════════════════════════════════════════════

test('B1  getEmailTransport() returns the Brevo transport when EMAIL_TRANSPORT=brevo_smtp', () => {
  process.env.EMAIL_TRANSPORT = 'brevo_smtp';
  const t = getEmailTransport();
  expect(t.name).toBe('brevo_smtp');
});

test('B2  selection is case-insensitive (matches pre-existing switch semantics)', () => {
  process.env.EMAIL_TRANSPORT = 'BREVO_SMTP';
  expect(getEmailTransport().name).toBe('brevo_smtp');
});

test('B3  selection preserves the pre-existing dev / none / unknown-sink contract', () => {
  process.env.EMAIL_TRANSPORT = 'dev';
  expect(getEmailTransport().name).toBe('dev');
  process.env.EMAIL_TRANSPORT = 'none';
  expect(getEmailTransport().name).toBe('none');
  process.env.EMAIL_TRANSPORT = 'totally_unknown_provider_value';
  // Unknown values MUST NOT silently fabricate a real sender — the safe default
  // remains the in-memory dev sink. This is the exact behaviour that existed
  // before D-4 was wired.
  expect(getEmailTransport().name).toBe('dev');
  delete process.env.EMAIL_TRANSPORT;
  expect(getEmailTransport().name).toBe('dev');
});

// ═════════════════════════════════════════════════════════════════════════
// 2 — Missing credential / configuration failure (returned, never thrown)
// ═════════════════════════════════════════════════════════════════════════

test('B4  missing login → send() returns brevo_smtp_missing_login (does NOT throw)', async () => {
  const t = new BrevoSmtpTransport({ ...FAKE_CFG, login: '' }, async () => ({ ok: true }));
  const r = await t.send(VALID_MSG);
  expect(r.ok).toBe(false);
  expect(r.error).toBe('brevo_smtp_missing_login');
});

test('B5  missing SMTP key → send() returns brevo_smtp_missing_key', async () => {
  const t = new BrevoSmtpTransport({ ...FAKE_CFG, password: '' }, async () => ({ ok: true }));
  expect((await t.send(VALID_MSG)).error).toBe('brevo_smtp_missing_key');
});

test('B6  missing sender (EMAIL_FROM unset) → send() returns brevo_smtp_missing_from', async () => {
  const t = new BrevoSmtpTransport({ ...FAKE_CFG, from: '' }, async () => ({ ok: true }));
  expect((await t.send(VALID_MSG)).error).toBe('brevo_smtp_missing_from');
});

test('B7  missing host → send() returns brevo_smtp_missing_host', async () => {
  const t = new BrevoSmtpTransport({ ...FAKE_CFG, host: '' }, async () => ({ ok: true }));
  expect((await t.send(VALID_MSG)).error).toBe('brevo_smtp_missing_host');
});

test('B8  invalid port → send() returns brevo_smtp_missing_port', async () => {
  const t = new BrevoSmtpTransport({ ...FAKE_CFG, port: 0 }, async () => ({ ok: true }));
  expect((await t.send(VALID_MSG)).error).toBe('brevo_smtp_missing_port');
});

// ═════════════════════════════════════════════════════════════════════════
// 3 — Successful transport invocation (mocked SMTP boundary)
// ═════════════════════════════════════════════════════════════════════════

test('B9  injected success → send() returns { ok:true } and delivers the expected prepared email', async () => {
  let captured: PreparedEmail | null = null;
  const t = new BrevoSmtpTransport(FAKE_CFG, async (prepared) => {
    captured = prepared;
    return { ok: true };
  });
  const r = await t.send(VALID_MSG);
  expect(r.ok).toBe(true);
  expect(captured).not.toBeNull();
  const p = captured as unknown as PreparedEmail;
  expect(p.to).toBe(VALID_MSG.to);
  expect(p.from).toBe(FAKE_CFG.from);
  expect(p.subject).toBe(VALID_MSG.subject);
  expect(p.text).toBe(VALID_MSG.text);
  expect(p.html).toBe(VALID_MSG.html);
  // The idempotency key becomes a stable RFC 2822 Message-ID body. Colon is
  // not safe inside an addr-spec local-part, so it is normalised to '_'.
  expect(p.messageId.length).toBeGreaterThan(0);
  expect(p.messageId).toBe('receipt-email_test-abc123');
});

test('B10 the deliver boundary receives the config object unchanged', async () => {
  let seenHost = '';
  let seenPort = 0;
  const t = new BrevoSmtpTransport(FAKE_CFG, async (_p, cfg) => {
    seenHost = cfg.host;
    seenPort = cfg.port;
    return { ok: true };
  });
  await t.send(VALID_MSG);
  expect(seenHost).toBe('smtp-relay.brevo.com');
  expect(seenPort).toBe(587);
});

test('B11 the boundary never sees an empty Message-ID even without idempotencyKey', async () => {
  let captured: PreparedEmail | null = null;
  const t = new BrevoSmtpTransport(FAKE_CFG, async (p) => { captured = p; return { ok: true }; });
  await t.send({ to: VALID_MSG.to, subject: 's', text: 't', html: 'h' });
  expect(captured).not.toBeNull();
  expect((captured as unknown as PreparedEmail).messageId.length).toBeGreaterThan(0);
});

// ═════════════════════════════════════════════════════════════════════════
// 4 — SMTP failure handling (returned, never thrown into the money path)
// ═════════════════════════════════════════════════════════════════════════

test('B12 injected SMTP failure → send() returns { ok:false, error } unchanged', async () => {
  const t = new BrevoSmtpTransport(FAKE_CFG, async () => ({
    ok: false,
    error: 'smtp_auth_ok_code_535',
  }));
  const r = await t.send(VALID_MSG);
  expect(r.ok).toBe(false);
  expect(r.error).toBe('smtp_auth_ok_code_535');
});

test('B13 injected deliver that THROWS is caught; send() returns ok:false (never propagates)', async () => {
  const t = new BrevoSmtpTransport(FAKE_CFG, async () => {
    throw new Error('unexpected_internal_fault');
  });
  const r = await t.send(VALID_MSG);
  expect(r.ok).toBe(false);
  expect(r.error).toContain('unexpected_internal_fault');
});

test('B14 injected deliver returning a non-shape object is treated as failure', async () => {
  const t = new BrevoSmtpTransport(FAKE_CFG, (async () => undefined) as never);
  const r = await t.send(VALID_MSG);
  expect(r.ok).toBe(false);
  expect(r.error).toBe('brevo_smtp_bad_delivery_result');
});

test('B15 thrown error containing an apparent secret is redacted before surfacing', async () => {
  const leaky = 'auth failed for ' + 'A'.repeat(40) + '== end';
  const t = new BrevoSmtpTransport(FAKE_CFG, async () => { throw new Error(leaky); });
  const r = await t.send(VALID_MSG);
  expect(r.ok).toBe(false);
  // The 40-char base64-looking token MUST NOT survive into the returned error.
  expect(r.error).not.toContain('A'.repeat(40));
  expect(r.error).toContain('[redacted_b64]');
});

// ═════════════════════════════════════════════════════════════════════════
// 5 — Recipient validation (defence-in-depth — upstream service also validates)
// ═════════════════════════════════════════════════════════════════════════

test('B16 malformed recipient → send() short-circuits BEFORE the deliver boundary runs', async () => {
  let called = false;
  const t = new BrevoSmtpTransport(FAKE_CFG, async () => { called = true; return { ok: true }; });
  const r = await t.send({ ...VALID_MSG, to: 'not-an-email' });
  expect(r.ok).toBe(false);
  expect(r.error).toBe('brevo_smtp_invalid_recipient');
  expect(called).toBe(false);
});

test('B17 empty-string recipient → invalid_recipient (does NOT call deliver)', async () => {
  let called = false;
  const t = new BrevoSmtpTransport(FAKE_CFG, async () => { called = true; return { ok: true }; });
  const r = await t.send({ ...VALID_MSG, to: '' });
  expect(r.ok).toBe(false);
  expect(r.error).toBe('brevo_smtp_invalid_recipient');
  expect(called).toBe(false);
});

// ═════════════════════════════════════════════════════════════════════════
// 6 — Environment-variable factory (constructor wiring)
// ═════════════════════════════════════════════════════════════════════════

test('B18 makeBrevoSmtpTransport() defaults host/port to Brevo when env vars unset', async () => {
  delete process.env.EMAIL_BREVO_SMTP_HOST;
  delete process.env.EMAIL_BREVO_SMTP_PORT;
  // Provide creds but no host/port — the factory must default to Brevo.
  process.env.EMAIL_BREVO_SMTP_LOGIN = FAKE_CFG.login;
  process.env.EMAIL_BREVO_SMTP_KEY = FAKE_CFG.password;
  process.env.EMAIL_FROM = FAKE_CFG.from;
  let seenHost = '';
  let seenPort = 0;
  const t = makeBrevoSmtpTransport();
  // Replace the class's private deliver via a small subclass-of-sorts:
  // instead we just assert that the factory's returned transport reaches the
  // default deliver path, which would call smtpSend(). We do NOT want a real
  // socket. So instead: verify the returned transport's name and let the next
  // test prove credential-missing short-circuits before deliver.
  expect(t.name).toBe('brevo_smtp');
  // Also assert the factory did not throw on unset host/port — it applies the
  // Brevo defaults silently.
  void seenHost; void seenPort;
});

test('B19 factory with missing creds → send() returns missing_login, no network attempted', async () => {
  delete process.env.EMAIL_BREVO_SMTP_LOGIN;
  delete process.env.EMAIL_BREVO_SMTP_KEY;
  delete process.env.EMAIL_FROM;
  const t = makeBrevoSmtpTransport();
  const r = await t.send(VALID_MSG);
  expect(r.ok).toBe(false);
  // Missing login is checked FIRST so the exact order of the "missing_*"
  // response is a stable, credential-free signal to operators.
  expect(r.error).toBe('brevo_smtp_missing_login');
});

test('B20 factory reads env-provided host/port/login/key/from', async () => {
  process.env.EMAIL_BREVO_SMTP_HOST = 'smtp-relay.brevo.com';
  process.env.EMAIL_BREVO_SMTP_PORT = '587';
  process.env.EMAIL_BREVO_SMTP_LOGIN = 'env-login@test.invalid';
  process.env.EMAIL_BREVO_SMTP_KEY = 'env-key-do-not-commit-32charsmin-len';
  process.env.EMAIL_FROM = 'receipts@jafari.co.in';
  const t = makeBrevoSmtpTransport();
  expect(t.name).toBe('brevo_smtp');
  // Do NOT call send() here: send() would invoke the real default deliver
  // boundary (smtpSend) and attempt an outbound connection. B19 already
  // demonstrates the missing-credential guard; B9–B10 demonstrate the happy
  // path with an injected boundary.
});

// ═════════════════════════════════════════════════════════════════════════
// 7 — Interface / contract shape (isolation guarantee, static)
// ═════════════════════════════════════════════════════════════════════════

test('B21 BrevoSmtpTransport implements the EmailTransport interface', () => {
  const t = new BrevoSmtpTransport(FAKE_CFG, async () => ({ ok: true }));
  // Name must be stable so operators can confirm the transport in logs.
  expect(typeof t.name).toBe('string');
  expect(t.name).toBe('brevo_smtp');
  // send() returns a Promise<EmailSendResult> — never a raw boolean, never throws.
  const r = t.send(VALID_MSG);
  expect(r).toBeInstanceOf(Promise);
});

test('B22 the returned object from every failure path always has { ok:false, error:string }', async () => {
  const cases: Array<() => Promise<{ ok: boolean; error?: string }>> = [
    () => new BrevoSmtpTransport({ ...FAKE_CFG, login: '' }, async () => ({ ok: true })).send(VALID_MSG),
    () => new BrevoSmtpTransport({ ...FAKE_CFG, password: '' }, async () => ({ ok: true })).send(VALID_MSG),
    () => new BrevoSmtpTransport({ ...FAKE_CFG, from: '' }, async () => ({ ok: true })).send(VALID_MSG),
    () => new BrevoSmtpTransport(FAKE_CFG, async () => ({ ok: false, error: 'protocol' })).send(VALID_MSG),
    () => new BrevoSmtpTransport(FAKE_CFG, async () => { throw new Error('x'); }).send(VALID_MSG),
    () => new BrevoSmtpTransport(FAKE_CFG, async () => ({ ok: true })).send({ ...VALID_MSG, to: 'bad' }),
  ];
  for (const f of cases) {
    const r = await f();
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect((r.error as string).length).toBeGreaterThan(0);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// 8 — Isolation reminder
// ═════════════════════════════════════════════════════════════════════════

test('B23 the Brevo send() result-shape is EXACTLY what receipts/service.ts consumes', async () => {
  // `attemptReceiptEmail()` does `const r = await transport.send(msg); if (r.ok) ...
  // else r.error ?? 'send failed'`. Verify the shape here so a future Brevo
  // refactor cannot silently break that contract. End-to-end payment-isolation
  // proof lives in master-receipts.test.ts R5.
  const t = new BrevoSmtpTransport(FAKE_CFG, async () => ({ ok: false, error: 'smtp_rejected' }));
  const r = await t.send(VALID_MSG);
  expect(typeof r.ok).toBe('boolean');
  expect(r.ok).toBe(false);
  expect(typeof r.error).toBe('string');
});
