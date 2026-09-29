/**
 * JafariPay — MASTER PHASE B (Customer Receipts) tests.
 *
 * Mandated coverage (from the spec), all executed against the REAL route
 * handlers + the REAL verifyPayment pipeline (blockchain mocked at exactly one
 * boundary — ArcProvider.getTransactionReceipt — like phase3-api.test.ts):
 *
 *   1. a receipt is created only from a VERIFIED + SUCCEEDED payment
 *   2. successful payment → receipt (with receipt_id surfaced on the response)
 *   3. duplicate prevention — one receipt per payment (UNIQUE(payment_id))
 *   4. email failure NEVER changes payment status (isolation contract)
 *   5. missing email → receipt still created, email_status='no_email'
 *   6. invalid email → rejected up front (400 invalid_email), money untouched
 *   7. retry behaviour (backoff + worker tick + terminal 'failed')
 *   8. receipt access control (public capability read vs merchant endpoints)
 *   9. cross-merchant isolation (list + resend are merchant-scoped)
 *  10. network-aware explorer links (built from the registry; disabled → '')
 *
 * Only inert local fixture networks are used. NO real network is enabled or
 * contacted. NO real email is sent (the default transport is the dev sink).
 */
import { test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_master_receipts_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'master-receipts-test-secret';
process.env.EMAIL_TRANSPORT = 'dev'; // deterministic in-memory sink, no network

// Bun test isolates each file's module registry, and every proven API suite
// (phase3/5/6, provider-hardening) imports these WITHOUT a cache-buster so the
// ArcProvider prototype spy below is the SAME instance the route handlers use.
const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');
const checkoutRouter = (await import('./api/checkout.ts')).default;
const intentsRouter = (await import('./api/payment-intents.ts')).default;
const receiptsRouter = (await import('./api/receipts.ts')).default;
const receiptsService = await import('./receipts/service.ts');
const emailTransport = await import('./email/transport.ts');

const USDC = '0x3600000000000000000000000000000000000000';
const SETTLEMENT = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

const hashApiKey = (key: string) =>
  createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

let seq = 0;
// Namespaced 64-hex tx hashes. All API suites share ONE sqlite DB (schema.ts is
// imported without a cache-buster), so a hash reused across files would trip
// verifyPayment's UNIQUE(tx_hash,network) replay protection. The 0x52 ("R") high
// byte keeps these in a region disjoint from phase3 (0x0..seq) and the repeat-
// pattern suites.
const HASH_BASE = BigInt('0x52' + '0'.repeat(60));
function txHash(): string { seq++; return '0x' + (HASH_BASE + BigInt(seq)).toString(16).padStart(64, '0'); }

function mockValidReceipt(amountBaseUnits = 1_000_000n, contract = USDC, to = SETTLEMENT) {
  const topics = encodeEventTopics({
    abi: [TRANSFER], eventName: 'Transfer',
    args: { from: SENDER as `0x${string}`, to: to as `0x${string}` },
  });
  const data = encodeAbiParameters([{ type: 'uint256' }], [amountBaseUnits]);
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockImplementation(((requested: string) => ({
    txHash: requested, status: 'success' as const, blockNumber: 100n,
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)), from: SENDER, to: contract,
    logs: [{ address: contract.toLowerCase(), topics: topics as string[], data, logIndex: 0 }],
  })) as never);
}

function insertWallet(id: string, merchantId: string, address: string, network: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run(id, merchantId, address.toLowerCase(), network);
}
function insertApiKey(id: string, merchantId: string, key: string): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)'
  ).run(id, merchantId, null, 'mr', key.slice(0, 8), hashApiKey(key), key.slice(0, 12), 1, 'test');
}

async function createIntent(auth: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/v1/payment-intents`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function checkoutVerify(piId: string, hash: string, chainId: number, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/checkout/${piId}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx_hash: hash, chain_id: chainId, ...extra }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function apiGet(path: string, auth?: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function apiPost(path: string, body: Record<string, unknown>, auth?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

// Helper: create + verify a succeeded payment, returning the intent id, the
// payment row and the created receipt row.
async function payAndVerify(auth: string, email?: string) {
  const created = await createIntent(auth, email ? { amount: '1.00', receipt_email: email } : { amount: '1.00' });
  const pi = String(created.body.id);
  const chain = Number(created.body.chain_id);
  mockValidReceipt();
  const v = await checkoutVerify(pi, txHash(), chain);
  const payment = getDb().prepare('SELECT * FROM payments WHERE payment_intent_id=?').get(pi) as Record<string, unknown>;
  const receipt = getDb().prepare('SELECT * FROM receipts WHERE payment_intent_id=?').get(pi) as Record<string, unknown> | undefined;
  return { pi, verify: v, payment, receipt };
}

// Mints a bare (unpaid) payment_intent row for the fabricated-payment unit
// tests (R3 / R16), so they never collide with the UNIQUE(payment_intent_id)
// index on the payments table.
function mintBareIntent(id: string): string {
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,currency,description,metadata,environment,expires_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, 'merch_mrA', 'sw_mrA', SETTLEMENT.toLowerCase(), 'arc_testnet', 5042002, USDC, '1.00', '1000000', 'USDC', '', '{}', 'test', Math.floor(Date.now() / 1000) + 3600);
  return id;
}

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_mrA', 'Merchant A');
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_mrB', 'Merchant B');
  // arc_testnet (chain 5042002) is seeded by migrate() with explorer_base
  // https://explorer.testnet.arc.io — the primary fixture network here.
  insertWallet('sw_mrA', 'merch_mrA', SETTLEMENT, 'arc_testnet');
  insertWallet('sw_mrB', 'merch_mrB', SETTLEMENT, 'arc_testnet');
  insertApiKey('ak_mrA', 'merch_mrA', 'sk_test_mrA');
  insertApiKey('ak_mrB', 'merch_mrB', 'sk_test_mrB');

  app = express();
  app.use(express.json());
  app.use('/checkout', checkoutRouter);
  app.use('/v1/payment-intents', intentsRouter);
  app.use('/v1/receipts', receiptsRouter);
  app.use('/api/receipts', receiptsRouter); // public capability read
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(() => {
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockRestore();
  delete process.env.EMAIL_DEV_FAIL;
  process.env.EMAIL_TRANSPORT = 'dev';
});

afterAll(() => {
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* Windows handle may linger */ }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1 & 2 — a receipt is created only from a SUCCEEDED payment, and the success
//         response surfaces its id.
// ═══════════════════════════════════════════════════════════════════════════

test('R1: intent creation alone does NOT mint a receipt (verification-gated)', async () => {
  const created = await createIntent('sk_test_mrA', { amount: '1.00', receipt_email: 'buyer@a.com' });
  expect(created.status).toBe(201);
  const pi = String(created.body.id);
  expect(getDb().prepare('SELECT id FROM receipts WHERE payment_intent_id=?').get(pi)).toBeNull();
});

test('R2: verified + succeeded payment → receipt, and receipt_id is returned', async () => {
  const { verify, receipt } = await payAndVerify('sk_test_mrA', 'buyer@a.com');
  expect(verify.status).toBe(200);
  expect(verify.body.status).toBe('succeeded');
  expect(typeof verify.body.receipt_id).toBe('string');
  expect(String(verify.body.receipt_id).startsWith('rcpt_')).toBe(true);
  expect(receipt).toBeTruthy();
  expect(receipt!.payment_status).toBe('succeeded');
  expect(receipt!.customer_email).toBe('buyer@a.com');
});

test('R3: generateReceiptForPayment refuses a payment that is not succeeded', () => {
  // A fabricated non-succeeded payment row must never yield a receipt.
  const db = getDb();
  const piId = mintBareIntent('pi_r3');
  db.prepare(
    `INSERT INTO payments(id,payment_intent_id,merchant_id,tx_hash,network,chain_id,sender_address,recipient_address,amount_base_units,amount_decimal,block_number,block_timestamp,status)
     VALUES('pay_fake_ns',?,'merch_mrA','0xdeadbeef','arc_testnet',5042002,?,?, '1000000','1.00',100,?, 'pending')`
  ).run(piId, SENDER, SETTLEMENT, Math.floor(Date.now() / 1000));
  expect(receiptsService.generateReceiptForPayment('pay_fake_ns')).toBeNull();
  db.prepare("DELETE FROM payments WHERE id='pay_fake_ns'").run();
  db.prepare("DELETE FROM payment_intents WHERE id='pi_r3'").run();
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — duplicate prevention (UNIQUE(payment_id))
// ═══════════════════════════════════════════════════════════════════════════

test('R4: calling generateReceiptForPayment twice returns the SAME receipt (idempotent)', async () => {
  const { payment, receipt } = await payAndVerify('sk_test_mrA', 'dup@a.com');
  const first = receiptsService.generateReceiptForPayment(String(payment.id));
  const second = receiptsService.generateReceiptForPayment(String(payment.id));
  expect(first!.id).toBe(second!.id);
  expect(first!.id).toBe(String(receipt!.id));
  const count = (getDb().prepare('SELECT COUNT(*) c FROM receipts WHERE payment_id=?').get(payment.id) as { c: number }).c;
  expect(count).toBe(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — email failure NEVER changes payment status (isolation contract)
// ═══════════════════════════════════════════════════════════════════════════

test('R5: forced email failure keeps payment succeeded; only email_status reflects it', async () => {
  process.env.EMAIL_DEV_FAIL = '1';
  const { verify, payment, receipt } = await payAndVerify('sk_test_mrA', 'fail@a.com');
  expect(verify.body.status).toBe('succeeded');
  expect((payment.status as string)).toBe('succeeded');
  // intent also stays succeeded — an email error cannot roll it back
  const pi = getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(String(payment.payment_intent_id)) as { status: string };
  expect(pi.status).toBe('succeeded');
  // the failure is recorded ONLY on the receipt
  expect(receipt!.email_status).toBe('pending'); // first attempt failed → backoff pending
  expect(Number(receipt!.email_attempts)).toBe(1);
  expect(receipt!.last_email_error).toBeTruthy();
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — missing email
// ═══════════════════════════════════════════════════════════════════════════

test('R6: no receipt_email → receipt still created with email_status=no_email', async () => {
  const { verify, receipt } = await payAndVerify('sk_test_mrA');
  expect(verify.body.status).toBe('succeeded');
  expect(receipt).toBeTruthy();
  expect(receipt!.customer_email).toBeNull();
  expect(receipt!.email_status).toBe('no_email');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — invalid email rejected up front, money path untouched
// ═══════════════════════════════════════════════════════════════════════════

test('R7a: invalid receipt_email at intent creation → 400 invalid_email, nothing persisted', async () => {
  const created = await createIntent('sk_test_mrA', { amount: '1.00', receipt_email: 'not-an-email' });
  expect(created.status).toBe(400);
  expect(created.body.code).toBe('invalid_email');
});

test('R7b: invalid receipt_email at verify → 400 BEFORE the money path; PI untouched', async () => {
  const created = await createIntent('sk_test_mrA', { amount: '1.00' });
  const pi = String(created.body.id);
  const chain = Number(created.body.chain_id);
  const r = await checkoutVerify(pi, txHash(), chain, { receipt_email: 'bad@@x' });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('invalid_email');
  expect((getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(pi) as { status: string }).status).toBe('requires_payment');
  expect(getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi)).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 — retry behaviour (backoff → worker tick → terminal 'failed')
// ═══════════════════════════════════════════════════════════════════════════

test('R8: email retries with backoff and becomes terminal failed after max attempts', async () => {
  const { receipt } = await payAndVerify('sk_test_mrA', 'retry@a.com'); // succeeds, email sent OK
  const rid = String(receipt!.id);
  // Reset to a fresh pending state and force failures to walk the retry ladder.
  getDb().prepare("UPDATE receipts SET email_status='pending',email_attempts=0,next_email_attempt_at=unixepoch() WHERE id=?").run(rid);
  process.env.EMAIL_DEV_FAIL = '1';
  await receiptsService.attemptReceiptEmail(rid); // → attempts 1, pending
  let row = getDb().prepare('SELECT * FROM receipts WHERE id=?').get(rid) as Record<string, unknown>;
  expect(row.email_status).toBe('pending'); expect(Number(row.email_attempts)).toBe(1);
  await receiptsService.attemptReceiptEmail(rid); // 2
  await receiptsService.attemptReceiptEmail(rid); // 3
  row = getDb().prepare('SELECT * FROM receipts WHERE id=?').get(rid) as Record<string, unknown>;
  expect(row.email_status).toBe('pending'); expect(Number(row.email_attempts)).toBe(3);
  await receiptsService.attemptReceiptEmail(rid); // 4 == EMAIL_MAX_ATTEMPTS → failed
  row = getDb().prepare('SELECT * FROM receipts WHERE id=?').get(rid) as Record<string, unknown>;
  expect(row.email_status).toBe('failed'); expect(Number(row.email_attempts)).toBe(4);
});

test('R9: processPendingReceiptEmails picks up due pending receipts', async () => {
  const { receipt } = await payAndVerify('sk_test_mrA', 'worker@a.com');
  const rid = String(receipt!.id);
  process.env.EMAIL_DEV_FAIL = '1';
  getDb().prepare("UPDATE receipts SET email_status='pending',email_attempts=0,next_email_attempt_at=unixepoch()-10 WHERE id=?").run(rid);
  await receiptsService.processPendingReceiptEmails();
  const row = getDb().prepare('SELECT * FROM receipts WHERE id=?').get(rid) as Record<string, unknown>;
  expect(Number(row.email_attempts)).toBe(1); // worker advanced the attempt
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 — access control: public capability read vs merchant endpoints
// ═══════════════════════════════════════════════════════════════════════════

test('R10: public GET /api/receipts/:id returns the safe projection (no merchant_id leak)', async () => {
  const { receipt } = await payAndVerify('sk_test_mrA', 'public@a.com');
  const rid = String(receipt!.id);
  const r = await apiGet(`/api/receipts/${rid}`);
  expect(r.status).toBe(200);
  expect(r.body.id).toBe(rid);
  expect(r.body.customer_email).toBe('public@a.com');
  expect(r.body.merchant_name).toBe('Merchant A');
  // The PUBLIC projection deliberately omits internal linkage fields.
  expect(r.body.merchant_id).toBeUndefined();
  expect(r.body.payment_id).toBeUndefined();
});

test('R11: unknown receipt id → 404 (non-enumerable capability)', async () => {
  const r = await apiGet('/api/receipts/rcpt_does_not_exist_000000');
  expect(r.status).toBe(404);
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 — cross-merchant isolation
// ═══════════════════════════════════════════════════════════════════════════

test('R12: merchant list is scoped to the caller (A never sees B)', async () => {
  await payAndVerify('sk_test_mrA', 'a-iso@a.com');
  await payAndVerify('sk_test_mrB', 'b-iso@b.com');
  const listA = await apiGet('/v1/receipts', 'sk_test_mrA');
  expect(listA.status).toBe(200);
  const rowsA = listA.body.data as Array<Record<string, unknown>>;
  expect(rowsA.length).toBeGreaterThan(0);
  expect(rowsA.every((r) => r.merchant_id === 'merch_mrA')).toBe(true);
  expect(rowsA.some((r) => r.customer_email === 'b-iso@b.com')).toBe(false);
});

test('R13: merchant B cannot resend merchant A\'s receipt (404 via merchant-scoped lookup)', async () => {
  const { receipt } = await payAndVerify('sk_test_mrA', 'resend@a.com');
  const rid = String(receipt!.id);
  const r = await apiPost(`/v1/receipts/${rid}/resend`, {}, 'sk_test_mrB');
  expect(r.status).toBe(404);
});

test('R14: merchant A CAN resend own receipt; already-sent is idempotent', async () => {
  const { receipt } = await payAndVerify('sk_test_mrA', 'resend2@a.com'); // sent OK on verify
  const rid = String(receipt!.id);
  const r = await apiPost(`/v1/receipts/${rid}/resend`, {}, 'sk_test_mrA');
  expect(r.status).toBe(200);
  expect(r.body.already_sent).toBe(true); // it was already 'sent', no re-email
});

// ═══════════════════════════════════════════════════════════════════════════
// 10 — network-aware explorer links
// ═══════════════════════════════════════════════════════════════════════════

test('R15: explorer_url is built from the registry for the payment network', async () => {
  const { receipt } = await payAndVerify('sk_test_mrA', 'explorer@a.com');
  const hash = String(receipt!.tx_hash);
  expect(receipt!.network).toBe('arc_testnet');
  expect(receipt!.explorer_url).toBe(`https://explorer.testnet.arc.io/tx/${hash}`);
});

test('R16: a disabled network yields an empty explorer link (never a fabricated host)', () => {
  const db = getDb();
  // Inert disabled fixture with an explorer_base that must NOT be used.
  db.prepare(
    'INSERT OR REPLACE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_testnet,required_confirmations,is_enabled) VALUES(?,?,?,?,?,?,6,1,0,0)'
  ).run('nc_mr_off', 'mr_disabled', 910099, 'http://127.0.0.1:1/', 'https://disabled.ex', USDC);
  const piId = mintBareIntent('pi_r16');
  db.prepare(
    `INSERT INTO payments(id,payment_intent_id,merchant_id,tx_hash,network,chain_id,sender_address,recipient_address,amount_base_units,amount_decimal,block_number,block_timestamp,status)
     VALUES('pay_mr_off',?,'merch_mrA','0xfeedface','mr_disabled',910099,?,?, '1000000','1.00',1,?, 'succeeded')`
  ).run(piId, SENDER, SETTLEMENT, Math.floor(Date.now() / 1000));
  const rec = receiptsService.generateReceiptForPayment('pay_mr_off');
  expect(rec).toBeTruthy();
  expect(rec!.explorer_url).toBe('');
  db.prepare("DELETE FROM receipts WHERE payment_id='pay_mr_off'").run();
  db.prepare("DELETE FROM payments WHERE id='pay_mr_off'").run();
  db.prepare("DELETE FROM payment_intents WHERE id='pi_r16'").run();
  db.prepare("DELETE FROM network_configs WHERE id='nc_mr_off'").run();
});

// ═══════════════════════════════════════════════════════════════════════════
// email validation unit checks
// ═══════════════════════════════════════════════════════════════════════════

test('R17: isValidEmail accepts normal, rejects malformed/oversized; normalizeEmail lowercases', () => {
  expect(emailTransport.isValidEmail('a@b.com')).toBe(true);
  expect(emailTransport.isValidEmail('A@B.COM')).toBe(true);
  expect(emailTransport.isValidEmail('no-at-sign')).toBe(false);
  expect(emailTransport.isValidEmail('two@@at.com')).toBe(false);
  expect(emailTransport.isValidEmail('x'.repeat(250) + '@y.com')).toBe(false);
  expect(emailTransport.normalizeEmail('  Mixed@Case.COM  ')).toBe('mixed@case.com');
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE M — targeted tests for the two audited defects (audit-only phase:
// these are the ONLY new tests, each pinned to a concrete finding).
// ═══════════════════════════════════════════════════════════════════════════

test('M1: checkout verify — a THROWN RPC error yields retryable 503 JSON and resets processing→requires_payment', async () => {
  // verifyPayment fails CLOSED: chain verification / transport failures THROW
  // rather than return a benign result. The public money-path endpoint must not
  // let that become an unhandled Express 5 error (opaque 500, intent stuck in
  // 'processing') — it mirrors the API-key path's 503 + status reset.
  const created = await createIntent('sk_test_mrA', { amount: '1.00' });
  const pi = String(created.body.id);
  const chain = Number(created.body.chain_id);
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockImplementation((() => {
    throw new Error('[RPC] Chain verification failed for "arc_testnet": eth_chainId request failed');
  }) as never);
  const v = await checkoutVerify(pi, txHash(), chain);
  expect(v.status).toBe(503);
  expect(v.body.retryable).toBe(true);
  expect(String(v.body.error)).toContain('RPC error');
  const row = getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(pi) as { status: string };
  expect(row.status).toBe('requires_payment'); // never left stuck in 'processing'
});

test('M2: receipt email HTML-escapes the merchant-controlled name (no markup injection into the customer email)', async () => {
  // merchant_name originates from the merchants table (merchant-editable) and is
  // snapshotted into the receipt at generation time. Every other field in the
  // HTML part already went through escapeHtml/rowHtml/escapeAttr; the <h2> name
  // must follow the same discipline.
  const db = getDb();
  db.prepare("UPDATE merchants SET name=? WHERE id='merch_mrA'").run('Mallory <img src=x onerror=alert(1)>');
  try {
    const { receipt } = await payAndVerify('sk_test_mrA', 'escape@m2.com');
    expect(receipt).toBeTruthy();
    const msg = emailTransport.getDevTransport().sent.at(-1);
    expect(msg).toBeTruthy();
    expect(msg!.to).toBe('escape@m2.com');
    expect(msg!.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(msg!.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  } finally {
    db.prepare("UPDATE merchants SET name='Merchant A' WHERE id='merch_mrA'").run();
  }
});
