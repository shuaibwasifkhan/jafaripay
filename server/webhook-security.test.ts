/**
 * JafariPay — MASTER PHASE L: Webhook signing security test matrix (25 cases).
 *
 * Covers the H-1 fix end to end:
 *   - deliveries are signed with the RAW merchant secret (recovered from an
 *     AES-256-GCM ciphertext at rest), NEVER with the internal secret_hash;
 *   - signature = HMAC_SHA256(`${t}.${rawBody}`, whsec_...) — exactly what the
 *     published reference verifier checks against the raw request body;
 *   - the plaintext secret is revealed once (create/rotate), is never returned
 *     by GET/list, never logged, and never stored in plaintext;
 *   - rotation invalidates the old credential; legacy endpoints without a
 *     recoverable secret fail CLOSED (no send, no payment mutation);
 *   - replay/window/unicode/whitespace/tamper behavior + merchant isolation
 *     + authorization on every management surface.
 */
import { test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import express from 'express';

const TMP_DB = join(import.meta.dir, '..', 'data', `_webhooksec_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
// Set BEFORE importing siwe (it captures SESSION_SECRET at module load).
process.env.SESSION_SECRET = 'webhooksec-test-session-secret-0123456789';
process.env.API_KEY_HMAC_SECRET = 'webhooksec-test-apikey-secret-0123456789';
process.env.WEBHOOK_HMAC_SECRET = 'webhooksec-test-whhmac-secret-0123456789';
process.env.WEBHOOK_SIGNING_ENC_KEY = 'webhooksec-test-enckey-secret-0123456789';

const { migrate, getDb } = await import('./db/schema.ts');
const { createSession } = await import('./auth/siwe.ts');
const { signWebhookPayload, verifyWebhookSignature, generateAndHashWebhookSecret, enqueueWebhookDeliveries, processPendingDeliveries } = await import('./webhooks/delivery.ts');
const { encryptSecret, decryptSecret } = await import('./lib/crypto.ts');
const webhooksRouter = (await import('./api/webhooks.ts')).default;
const deliveriesRouter = (await import('./api/webhook-deliveries.ts')).default;

const USDC = '0x3600000000000000000000000000000000000000';
let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let tokenA = '';
let tokenB = '';
type Captured = { url: string; headers: Record<string, string>; body: string };
let fetchCalls: Captured[] = [];
let fetchStatus = 200;

const nowS = () => Math.floor(Date.now() / 1000);
// Bind the REAL fetch now: tests spy on globalThis.fetch to capture delivery
// worker requests, and the test HTTP client below must keep using the real one.
const realFetch = globalThis.fetch;

function mockFetch() {
  fetchCalls = [];
  fetchStatus = 200;
  spyOn(globalThis, 'fetch').mockImplementation(((url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    fetchCalls.push({ url: String(url), headers: init?.headers ?? {}, body: init?.body ?? '' });
    return Promise.resolve(new Response('ok', { status: fetchStatus }));
  }) as never);
}

async function req(method: string, path: string, body?: unknown, token?: string) {
  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

function insertMerchant(id: string) {
  getDb().prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run(id, id);
}
function insertIntent(id: string, merchantId: string, status = 'requires_payment') {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run(`sw_${id}`, merchantId, `0x${'ab'.repeat(20)}`, 'arc_testnet');
  db.prepare(
    'INSERT OR REPLACE INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,environment,expires_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, merchantId, `sw_${id}`, `0x${'ab'.repeat(20)}`, 'arc_testnet', 5042002, USDC, '1.000000', '1000000', 'test', nowS() + 3600, status);
}
function insertDelivery(id: string, endpointId: string, intentId: string, payload: string, status = 'pending', attempts = 0) {
  getDb().prepare(
    'INSERT INTO webhook_deliveries(id,webhook_endpoint_id,payment_intent_id,event_type,payload,status,attempts,next_attempt_at) VALUES(?,?,?,?,?,?,?,unixepoch()-60)'
  ).run(id, endpointId, intentId, 'payment.succeeded', payload, status, attempts);
}
function endpointRow(id: string) {
  return getDb().prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(id) as Record<string, unknown>;
}

beforeAll(() => {
  migrate();
  insertMerchant('merch_wsA');
  insertMerchant('merch_wsB');
  tokenA = createSession('merch_wsA', '0x00000000000000000000000000000000000000a1');
  tokenB = createSession('merch_wsB', '0x00000000000000000000000000000000000000b1');
  app = express();
  app.use(express.json());
  app.use('/webhook-endpoints', webhooksRouter);
  app.use('/webhook-deliveries', deliveriesRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(() => {
  spyOn(globalThis, 'fetch').mockRestore();
});

afterAll(() => {
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* Windows handle may linger */ }
  }
});

// ═══ Signature scheme (pure crypto) ═══════════════════════════════════════

test('W1: valid signature over the exact raw body verifies with the merchant secret', () => {
  const secret = 'whsec_' + 'a1'.repeat(32);
  const body = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', data: { x: 1 } });
  const header = signWebhookPayload(secret, body, nowS());
  expect(verifyWebhookSignature(secret, body, header)).toBe(true);
});

test('W2: invalid / empty / garbage signature is rejected', () => {
  const secret = 'whsec_' + 'a1'.repeat(32);
  const body = '{"a":1}';
  const good = signWebhookPayload(secret, body, nowS());
  const badV1 = good.replace(/v1=[0-9a-f]{2}/, 'v1=ff').replace(/^t=(\d+)/, (_m, t) => `t=${t}`);
  expect(verifyWebhookSignature(secret, body, badV1)).toBe(false);
  expect(verifyWebhookSignature(secret, body, '')).toBe(false);
  expect(verifyWebhookSignature(secret, body, 't=,v1=')).toBe(false);
});

test('W3: wrong secret is rejected', () => {
  const body = '{"a":1}';
  const header = signWebhookPayload('whsec_' + 'a1'.repeat(32), body, nowS());
  expect(verifyWebhookSignature('whsec_' + 'b2'.repeat(32), body, header)).toBe(false);
});

test('W4: modified body (one byte) is rejected', () => {
  const secret = 'whsec_' + 'c3'.repeat(32);
  const body = '{"amount":"25.00","order":"A"}';
  const header = signWebhookPayload(secret, body, nowS());
  expect(verifyWebhookSignature(secret, '{"amount":"25.01","order":"A"}', header)).toBe(false);
  expect(verifyWebhookSignature(secret, body + ' ', header)).toBe(false);
});

test('W5: tampered timestamp (changed t, unchanged v1) is rejected', () => {
  const secret = 'whsec_' + 'd4'.repeat(32);
  const body = '{"a":1}';
  const header = signWebhookPayload(secret, body, nowS());
  const tampered = header.replace(/^t=(\d+)/, (_m, t: string) => `t=${Number(t) + 60}`);
  expect(verifyWebhookSignature(secret, body, tampered)).toBe(false);
});

test('W6: stale timestamp (valid signature, outside window) is rejected', () => {
  const secret = 'whsec_' + 'e5'.repeat(32);
  const body = '{"a":1}';
  const stale = nowS() - 400;
  const header = signWebhookPayload(secret, body, stale);
  expect(verifyWebhookSignature(secret, body, header, 300)).toBe(false);
  expect(verifyWebhookSignature(secret, body, header, 600)).toBe(true); // window is explicit
});

test('W7: far-future timestamp is rejected', () => {
  const secret = 'whsec_' + 'f6'.repeat(32);
  const body = '{"a":1}';
  const header = signWebhookPayload(secret, body, nowS() + 600);
  expect(verifyWebhookSignature(secret, body, header)).toBe(false);
});

test('W8: malformed header shapes are rejected without throwing', () => {
  const secret = 'whsec_' + '07'.repeat(32);
  const body = '{"a":1}';
  for (const bad of ['garbage', 't=abc,v1=00', 'v1=0123', 't=0,v1=0123', 't=x', 't=1,v1=zz', 't=99999999999,v1=ab']) {
    expect(verifyWebhookSignature(secret, body, bad)).toBe(false);
  }
});

test('W9: replayed delivery — a correctly-signed event fails once outside the replay window', () => {
  const secret = 'whsec_' + '18'.repeat(32);
  const body = '{"id":"evt_replay","type":"payment.succeeded"}';
  const ts = nowS() - 290;
  const header = signWebhookPayload(secret, body, ts);
  expect(verifyWebhookSignature(secret, body, header)).toBe(true);   // inside window: must dedupe by event id
  expect(verifyWebhookSignature(secret, body, signWebhookPayload(secret, body, nowS() - 310))).toBe(false); // after: fails
});

test('W10: merchant A can verify its own payload; merchant B cannot', () => {
  const secretA = generateAndHashWebhookSecret();
  const secretB = generateAndHashWebhookSecret();
  const body = '{"data":"merchant A event"}';
  const header = signWebhookPayload(secretA.secret, body, nowS());
  expect(verifyWebhookSignature(secretA.secret, body, header)).toBe(true);
  expect(verifyWebhookSignature(secretB.secret, body, header)).toBe(false);
});

// ═══ At-rest envelope encryption ══════════════════════════════════════════

test('W11: encrypt → decrypt round-trips the raw secret exactly', () => {
  const secret = 'whsec_' + '9f'.repeat(32);
  const blob = encryptSecret(secret);
  expect(blob.startsWith('v1.')).toBe(true);
  expect(blob).not.toContain(secret);
  expect(decryptSecret(blob)).toBe(secret);
});

test('W12: decryptSecret is null-safe on missing/garbage/wrong-version input', () => {
  expect(decryptSecret(null)).toBeNull();
  expect(decryptSecret(undefined)).toBeNull();
  expect(decryptSecret('')).toBeNull();
  expect(decryptSecret('not-an-envelope')).toBeNull();
  expect(decryptSecret('v2.YWJj.YWJj.YWJj')).toBeNull();
  expect(decryptSecret('v1.!!!.###.$$$')).toBeNull();
});

test('W13: tampered ciphertext is rejected by GCM auth (decrypt → null, never garbage)', () => {
  const blob = encryptSecret('whsec_secret_under_test');
  const [v, iv, tag, ct] = blob.split('.');
  const buf = Buffer.from(ct, 'base64');
  buf[0] ^= 0xff;
  expect(decryptSecret(`${v}.${iv}.${tag}.${buf.toString('base64')}`)).toBeNull();
  const tagBuf = Buffer.from(tag, 'base64');
  tagBuf[0] ^= 0xff;
  expect(decryptSecret(`${v}.${iv}.${tagBuf.toString('base64')}.${ct}`)).toBeNull();
});

test('W14: generated secret material — raw ≠ hash ≠ ciphertext, unique, decryptable', () => {
  const g1 = generateAndHashWebhookSecret();
  const g2 = generateAndHashWebhookSecret();
  expect(g1.secret.startsWith('whsec_')).toBe(true);
  expect(g1.secret.length).toBe('whsec_'.length + 64); // 32 random bytes
  expect(g1.hash).not.toBe(g1.secret);
  expect(g1.ciphertext).not.toContain(g1.secret);
  expect(g1.preview).toBe(g1.secret.slice(-4));
  expect(decryptSecret(g1.ciphertext)).toBe(g1.secret);
  expect(g1.secret).not.toBe(g2.secret);
});

test('W15: length-mismatched / odd signatures never throw (constant-time path is guarded)', () => {
  const secret = 'whsec_' + '2a'.repeat(32);
  const body = '{"a":1}';
  const ts = nowS();
  expect(verifyWebhookSignature(secret, body, `t=${ts},v1=ab`)).toBe(false);            // too short
  expect(verifyWebhookSignature(secret, body, `t=${ts},v1=${'0'.repeat(128)}`)).toBe(false); // too long
  expect(verifyWebhookSignature(secret, body, `t=${ts},v1=zz`)).toBe(false);            // invalid hex
});

test('W16: signature is whitespace-sensitive over the raw body', () => {
  const secret = 'whsec_' + '3b'.repeat(32);
  const exact = '{"id": 1}';
  const header = signWebhookPayload(secret, exact, nowS());
  expect(verifyWebhookSignature(secret, exact, header)).toBe(true);
  expect(verifyWebhookSignature(secret, '{"id":1}', header)).toBe(false);       // space removed
  expect(verifyWebhookSignature(secret, '{"id": 1}\n', header)).toBe(false);    // trailing newline
});

test('W17: unicode payloads verify byte-exactly; a normalization variant is rejected', () => {
  const secret = 'whsec_' + '4c'.repeat(32);
  const body = JSON.stringify({ memo: '\u00dcn\u00efc\u00f8d\u00e9 \u2615 \u65e5\u672c\u8a9e' });
  const header = signWebhookPayload(secret, body, nowS());
  expect(verifyWebhookSignature(secret, body, header)).toBe(true);
  // NFC -> NFD changes the underlying bytes (precomposed é becomes e +
  // combining accent). A merchant that re-normalizes the body before verifying
  // breaks the signature - verification MUST use the exact raw bytes.
  const variant = body.normalize('NFD');
  expect(variant).not.toBe(body);
  expect(verifyWebhookSignature(secret, variant, header)).toBe(false);
});

// ═══ HTTP lifecycle: reveal-once, at-rest, rotation, fail-closed ═══════════

async function createEndpointViaApi(token: string) {
  const r = await req('POST', '/webhook-endpoints', { url: 'https://hook.example.com/wh', events: ['payment.succeeded'] }, token);
  expect(r.status).toBe(201);
  return r;
}

test('W18: create reveals the secret exactly once; GET list never returns it', async () => {
  const created = await createEndpointViaApi(tokenA);
  const secret = String(created.body.secret);
  const id = String(created.body.id);
  expect(secret.startsWith('whsec_')).toBe(true);
  try {
    const list = await req('GET', '/webhook-endpoints', undefined, tokenA);
    expect(list.status).toBe(200);
    const rows = list.body.data as Array<Record<string, unknown>>;
    const mine = rows.filter((x) => x.id === id);
    expect(mine.length).toBe(1);
    expect('secret' in mine[0]).toBe(false);
    expect('secret_ciphertext' in mine[0]).toBe(false);
    expect('secret_hash' in mine[0]).toBe(false);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    const single = await req('GET', `/webhook-endpoints/${id}`, undefined, tokenA);
    expect([404, 405, 400]).toContain(single.status); // no GET /:id surface exists
  } finally {
    await req('DELETE', `/webhook-endpoints/${id}`, undefined, tokenA);
  }
});

test('W19: at rest the DB stores ciphertext only — decryptable, no plaintext anywhere in the row', async () => {
  const created = await createEndpointViaApi(tokenA);
  const secret = String(created.body.secret);
  const id = String(created.body.id);
  try {
    const row = endpointRow(id);
    expect(typeof row.secret_ciphertext).toBe('string');
    expect(decryptSecret(row.secret_ciphertext as string)).toBe(secret);
    expect(JSON.stringify(row)).not.toContain(secret); // plaintext NOT persisted
    expect(row.secret_hash).not.toBe(secret);
  } finally {
    await req('DELETE', `/webhook-endpoints/${id}`, undefined, tokenA);
  }
});

test('W20: rotation — new delivery is signed with the new secret; the old secret no longer verifies', async () => {
  const created = await createEndpointViaApi(tokenA);
  const id = String(created.body.id);
  const oldSecret = String(created.body.secret);
  const rotated = await req('POST', `/webhook-endpoints/${id}/rotate-secret`, undefined, tokenA);
  expect(rotated.status).toBe(200);
  const newSecret = String(rotated.body.secret);
  expect(newSecret).not.toBe(oldSecret);
  expect(newSecret.startsWith('whsec_')).toBe(true);
  try {
    insertIntent('pi_ws20', 'merch_wsA');
    enqueueWebhookDeliveries('pi_ws20', 'payment.succeeded', { id: 'pi_ws20' }, 'test');
    mockFetch();
    await processPendingDeliveries();
    const mine = fetchCalls.filter((c) => c.url === 'https://hook.example.com/wh');
    expect(mine.length).toBeGreaterThanOrEqual(1);
    const cap = mine[mine.length - 1];
    const sig = cap.headers['X-JafariPay-Signature'];
    expect(sig).toBeTruthy();
    expect(verifyWebhookSignature(newSecret, cap.body, sig)).toBe(true);     // new accepted
    expect(verifyWebhookSignature(oldSecret, cap.body, sig)).toBe(false);    // old rejected
    expect(cap.body).not.toContain(newSecret);
    expect(endpointRow(id).secret_ciphertext).not.toBe(created.body.secret_ciphertext);
    getDb().prepare("DELETE FROM webhook_deliveries WHERE payment_intent_id='pi_ws20'").run();
    getDb().prepare("DELETE FROM payment_intents WHERE id='pi_ws20'").run();
    getDb().prepare("DELETE FROM settlement_wallets WHERE id='sw_pi_ws20'").run();
  } finally {
    await req('DELETE', `/webhook-endpoints/${id}`, undefined, tokenA);
  }
});

test('W21 (H-1 regression): deliveries are signed with the RAW secret, never the secret_hash', async () => {
  const created = await createEndpointViaApi(tokenA);
  const id = String(created.body.id);
  const rawSecret = String(created.body.secret);
  const secretHash = String(endpointRow(id).secret_hash);
  expect(secretHash).not.toBe(rawSecret);
  try {
    insertIntent('pi_ws21', 'merch_wsA');
    enqueueWebhookDeliveries('pi_ws21', 'payment.succeeded', { id: 'pi_ws21' }, 'test');
    mockFetch();
    await processPendingDeliveries();
    const cap = fetchCalls[fetchCalls.length - 1];
    expect(cap).toBeTruthy();
    const sig = cap.headers['X-JafariPay-Signature'];
    expect(verifyWebhookSignature(secretHash, cap.body, sig)).toBe(false);  // ← old broken H-1 behavior would verify here
    expect(verifyWebhookSignature(rawSecret, cap.body, sig)).toBe(true);    // ← merchant-facing contract
    getDb().prepare("DELETE FROM webhook_deliveries WHERE payment_intent_id='pi_ws21'").run();
    getDb().prepare("DELETE FROM payment_intents WHERE id='pi_ws21'").run();
    getDb().prepare("DELETE FROM settlement_wallets WHERE id='sw_pi_ws21'").run();
  } finally {
    await req('DELETE', `/webhook-endpoints/${id}`, undefined, tokenA);
  }
});

test('W22: legacy endpoint without ciphertext fails CLOSED — no send, no payment mutation, clear error', () => {
  const db = getDb();
  db.prepare('INSERT INTO webhook_endpoints(id,merchant_id,url,secret_hash,secret_preview,environment) VALUES(?,?,?,?,?,?)')
    .run('wsec_legacy', 'merch_wsA', 'https://hook.example.com/legacy', 'deadbeefhash', 'abcd', 'test');
  insertIntent('pi_ws22', 'merch_wsA', 'succeeded');
  insertDelivery('wd_ws22', 'wsec_legacy', 'pi_ws22', '{"id":"evt_legacy"}');
  mockFetch();
  return processPendingDeliveries().then(() => {
    const row = db.prepare('SELECT status,last_error,attempts FROM webhook_deliveries WHERE id=?').get('wd_ws22') as { status: string; last_error: string; attempts: number };
    expect(row.status).toBe('failed');
    expect(row.last_error).toContain('signing_secret_unavailable');
    expect(row.attempts).toBe(1);
    expect(fetchCalls.length).toBe(0); // never sent unsigned / with a forged key
    const intent = db.prepare('SELECT status FROM payment_intents WHERE id=?').get('pi_ws22') as { status: string };
    expect(intent.status).toBe('succeeded'); // untouched by the failed delivery
    db.prepare("DELETE FROM webhook_deliveries WHERE id='wd_ws22'").run();
    db.prepare("DELETE FROM payment_intents WHERE id='pi_ws22'").run();
    db.prepare("DELETE FROM settlement_wallets WHERE id='sw_pi_ws22'").run();
    db.prepare("DELETE FROM webhook_endpoints WHERE id='wsec_legacy'").run();
  });
});

test('W23: retries keep identical signing semantics — every attempt verifiable with the same secret', async () => {
  const created = await createEndpointViaApi(tokenA);
  const id = String(created.body.id);
  const secret = String(created.body.secret);
  try {
    insertIntent('pi_ws23', 'merch_wsA');
    insertDelivery('wd_ws23', id, 'pi_ws23', '{"id":"evt_retry","type":"payment.succeeded"}');
    mockFetch();
    fetchStatus = 500; // first attempt fails → backoff
    await processPendingDeliveries();
    let row = getDb().prepare('SELECT status,attempts FROM webhook_deliveries WHERE id=?').get('wd_ws23') as { status: string; attempts: number };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    const firstSig = fetchCalls[0].headers['X-JafariPay-Signature'];
    expect(verifyWebhookSignature(secret, fetchCalls[0].body, firstSig)).toBe(true);
    // simulate backoff elapsing, retry with a NEW timestamp but the SAME secret
    getDb().prepare('UPDATE webhook_deliveries SET next_attempt_at=unixepoch()-60 WHERE id=?').run('wd_ws23');
    fetchStatus = 200;
    await processPendingDeliveries();
    row = getDb().prepare('SELECT status,attempts FROM webhook_deliveries WHERE id=?').get('wd_ws23') as { status: string; attempts: number };
    expect(row.status).toBe('delivered');
    expect(row.attempts).toBe(2);
    expect(verifyWebhookSignature(secret, fetchCalls[1].body, fetchCalls[1].headers['X-JafariPay-Signature'])).toBe(true);
    getDb().prepare("DELETE FROM webhook_deliveries WHERE id='wd_ws23'").run();
    getDb().prepare("DELETE FROM payment_intents WHERE id='pi_ws23'").run();
    getDb().prepare("DELETE FROM settlement_wallets WHERE id='sw_pi_ws23'").run();
  } finally {
    await req('DELETE', `/webhook-endpoints/${id}`, undefined, tokenA);
  }
});

test('W24: management is session-gated + merchant-scoped (enumeration-safe 404s, no existence leaks)', async () => {
  const created = await createEndpointViaApi(tokenA);
  const id = String(created.body.id);
  insertIntent('pi_ws24', 'merch_wsA');
  insertDelivery('wd_ws24', id, 'pi_ws24', '{"id":"evt_auth"}');
  try {
    // no session → 401 on every management surface
    for (const [m, p] of [['GET', '/webhook-endpoints'], ['POST', '/webhook-endpoints'], ['GET', '/webhook-deliveries']] as const) {
      const r = await req(m, p, m === 'POST' ? { url: 'https://hook.example.com/x' } : undefined);
      expect(r.status).toBe(401);
    }
    expect((await req('POST', `/webhook-endpoints/${id}/rotate-secret`)).status).toBe(401);
    expect((await req('DELETE', `/webhook-endpoints/${id}`)).status).toBe(401);
    expect((await req('POST', '/webhook-deliveries/wd_ws24/retry')).status).toBe(401);
    // other merchant → generic 404 (same response as nonexistent — no enumeration)
    const asB = await req('POST', `/webhook-endpoints/${id}/rotate-secret`, undefined, tokenB);
    expect(asB.status).toBe(404);
    const retryB = await req('POST', '/webhook-deliveries/wd_ws24/retry', undefined, tokenB);
    expect(retryB.status).toBe(404);
    const nonexistent = await req('POST', `/webhook-endpoints/whe_does_not_exist/rotate-secret`, undefined, tokenB);
    expect(nonexistent.status).toBe(404);
    expect(JSON.stringify(nonexistent.body)).toBe(JSON.stringify(asB.body));
    // SSRF: private URLs rejected at creation
    const ssrf = await req('POST', '/webhook-endpoints', { url: 'https://127.0.0.1:8080/wh' }, tokenA);
    expect(ssrf.status).toBe(400);
  } finally {
    getDb().prepare("DELETE FROM webhook_deliveries WHERE id='wd_ws24'").run();
    getDb().prepare("DELETE FROM payment_intents WHERE id='pi_ws24'").run();
    getDb().prepare("DELETE FROM settlement_wallets WHERE id='sw_pi_ws24'").run();
    await req('DELETE', `/webhook-endpoints/${id}`, undefined, tokenA);
  }
});

test('W25: the plaintext secret never appears in logs during create, storage, or delivery', async () => {
  const logs: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const spies = methods.map((m) => spyOn(console, m).mockImplementation(((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  }) as never));
  let created: { status: number; body: Record<string, unknown> };
  try {
    created = await createEndpointViaApi(tokenA);
    insertIntent('pi_ws25', 'merch_wsA');
    enqueueWebhookDeliveries('pi_ws25', 'payment.succeeded', { id: 'pi_ws25' }, 'test');
    mockFetch();
    await processPendingDeliveries();
    await req('POST', `/webhook-endpoints/${created.body.id}/rotate-secret`, undefined, tokenA);
  } finally {
    for (const s of spies) s.mockRestore();
  }
  const secret = String(created!.body.secret);
  expect(secret.startsWith('whsec_')).toBe(true);
  expect(logs.join('\n')).not.toContain(secret);
  expect(logs.some((l) => l.includes('v1.') && l.includes(secret))).toBe(false);
  getDb().prepare("DELETE FROM webhook_deliveries WHERE payment_intent_id='pi_ws25'").run();
  getDb().prepare("DELETE FROM payment_intents WHERE id='pi_ws25'").run();
  getDb().prepare("DELETE FROM settlement_wallets WHERE id='sw_pi_ws25'").run();
  await req('DELETE', `/webhook-endpoints/${created!.body.id}`, undefined, tokenA);
});
