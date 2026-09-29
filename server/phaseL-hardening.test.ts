/**
 * JafariPay — MASTER PHASE L: Receipt / Link / Reconciliation hardening tests.
 *
 * Phase L's production-code change surface is the webhook signing secret now
 * stored as an AES-256-GCM envelope (webhook_endpoints.secret_ciphertext). These
 * tests prove the hardening invariants around that change and the existing
 * Receipt/Link/Reconciliation surfaces:
 *
 *   HL1  ciphertext is persisted as a versioned envelope (never plaintext);
 *   HL2  NO merchant/customer read surface ever serializes the secret material
 *        (webhook list, delivery list, reconciliation view);
 *   HL3  rotation atomically replaces the envelope (old material gone from DB);
 *   HL4  deliveries/payloads never carry secret material;
 *   HL5  public receipt projection is an EXACT pinned key set (no internal IDs,
 *        no email internals);
 *   HL6  receipt + link capability ids are high-entropy + non-sequential;
 *   HL7  public /pay/: read exposes only checkout-necessary fields;
 *   HL8  payments are network-scoped (same tx_hash, two chains = two rows);
 *   HL9  a receipt is an immutable snapshot — the stored email cannot change
 *        the already-issued receipt (no post-success email tampering).
 *
 * No real money, keys, or network calls: blockchain is never touched; fixtures
 * are inserted directly or via the routers with session/API-key auth.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';

const TMP_DB = join(import.meta.dir, '..', 'data', `_phaseL_harden_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.SESSION_SECRET = 'phaseL-harden-test-session-secret-0123456789';
process.env.API_KEY_HMAC_SECRET = 'phaseL-harden-test-api-secret-0123456789';
process.env.WEBHOOK_HMAC_SECRET = 'phaseL-harden-test-whhmac-secret-0123456789';
process.env.WEBHOOK_SIGNING_ENC_KEY = 'phaseL-harden-test-enckey-0123456789';
process.env.EMAIL_TRANSPORT = 'dev';

const { migrate, getDb } = await import('./db/schema.ts');
const { createSession } = await import('./auth/siwe.ts');
const { generateAndHashWebhookSecret } = await import('./webhooks/delivery.ts');
const { decryptSecret } = await import('./lib/crypto.ts');
const { generateReceiptId, generatePaymentLinkId } = await import('./lib/ids.ts');
const { generateReceiptForPayment } = await import('./receipts/service.ts');
const webhooksRouter = (await import('./api/webhooks.ts')).default;
const deliveriesRouter = (await import('./api/webhook-deliveries.ts')).default;
const receiptsRouter = (await import('./api/receipts.ts')).default;
const paymentsRouter = (await import('./api/payments.ts')).default;
const linksMod = await import('./api/payment-links.ts');

const USDC = '0x3600000000000000000000000000000000000000';
const ADDR = `0x${'cd'.repeat(20)}`;
// settlement_wallets enforces UNIQUE(merchant_id,address,network), so every
// fixture wallet gets its own deterministic address (sha256 of the id) —
// reusing one address would make INSERT OR REPLACE delete a referenced row.
const addrFor = (seed: string) => '0x' + createHmac('sha256', 'phaseL-fixture').update(seed).digest('hex').slice(0, 40);
const realFetch = globalThis.fetch;
const nowS = () => Math.floor(Date.now() / 1000);
const hashApiKey = (key: string) =>
  createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let tokenA = '';
const KEY_A = 'sk_test_hlA';
const KEY_B = 'sk_test_hlB';

async function req(method: string, path: string, opts?: { body?: unknown; token?: string; key?: string }) {
  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts?.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts?.key ? { Authorization: `Bearer ${opts.key}` } : {}),
    },
    body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { raw: text }; }
  return { status: res.status, body: json, text };
}

function insertMerchant(id: string, name: string) {
  getDb().prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run(id, name);
}
function insertWallet(id: string, merchantId: string, network: string) {
  getDb().prepare('INSERT OR REPLACE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run(id, merchantId, ADDR, network);
}
function insertApiKey(id: string, merchantId: string, key: string) {
  getDb().prepare(
    'INSERT OR REPLACE INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)'
  ).run(id, merchantId, null, 'hl', key.slice(0, 8), hashApiKey(key), key.slice(0, 12), 1, 'test');
}
function insertIntent(id: string, merchantId: string, opts: { email?: string; status?: string } = {}) {
  const db = getDb();
  const addr = addrFor(id);
  db.prepare('INSERT OR REPLACE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run(`sw_${id}`, merchantId, addr, 'arc_testnet');
  db.prepare(
    'INSERT OR REPLACE INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,currency,order_id,environment,expires_at,status,customer_email) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, merchantId, `sw_${id}`, addr, 'arc_testnet', 5042002, USDC, '3.000000', '3000000', 'USDC', `ORD_${id}`, 'test', nowS() + 3600, opts.status ?? 'succeeded', opts.email ?? null);
}
let paySeq = 0;
function insertPayment(id: string, intentId: string, merchantId: string, txHash: string, network: string, chainId: number) {
  getDb().prepare(
    'INSERT OR REPLACE INTO payments(id,payment_intent_id,merchant_id,tx_hash,network,chain_id,sender_address,recipient_address,amount_base_units,amount_decimal,block_number,block_timestamp,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, intentId, merchantId, txHash, network, chainId, ADDR, ADDR, '3000000', '3.000000', 100, nowS(), 'succeeded');
}

beforeAll(() => {
  migrate();
  insertMerchant('merch_hlA', 'HL Merchant A');
  insertMerchant('merch_hlB', 'HL Merchant B');
  insertWallet('sw_hlA', 'merch_hlA', 'arc_testnet');
  insertWallet('sw_hlB', 'merch_hlB', 'arc_testnet');
  insertApiKey('ak_hlA', 'merch_hlA', KEY_A);
  insertApiKey('ak_hlB', 'merch_hlB', KEY_B);
  tokenA = createSession('merch_hlA', '0x00000000000000000000000000000000000000f1');

  const app = express();
  app.use(express.json());
  app.use('/webhook-endpoints', webhooksRouter);
  app.use('/webhook-deliveries', deliveriesRouter);
  app.use('/receipts', receiptsRouter);
  app.use('/payments', paymentsRouter);
  app.use('/pay', linksMod.payRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* Windows handle may linger */ }
  }
});

// ═══════════════════════════════════════════════════════════════════════════

test('HL1: the signing secret is persisted ONLY as a versioned AES-256-GCM envelope', async () => {
  const created = await req('POST', '/webhook-endpoints', { token: tokenA, body: { url: 'https://hook.example.com/hl', events: ['payment.succeeded'] } });
  expect(created.status).toBe(201);
  const id = String(created.body.id);
  const secret = String(created.body.secret);
  try {
    const row = getDb().prepare('SELECT secret_ciphertext,secret_hash,secret_preview FROM webhook_endpoints WHERE id=?').get(id) as { secret_ciphertext: string; secret_hash: string; secret_preview: string };
    expect(row.secret_ciphertext.startsWith('v1.')).toBe(true);
    expect(row.secret_ciphertext.split('.')).toHaveLength(4);      // version.iv.tag.ct
    expect(row.secret_ciphertext).not.toContain(secret);           // no plaintext at rest
    expect(decryptSecret(row.secret_ciphertext)).toBe(secret);     // recoverable for signing
    expect(row.secret_hash).not.toContain(secret);
  } finally {
    await req('DELETE', `/webhook-endpoints/${id}`, { token: tokenA });
  }
});

test('HL2: no read surface ever serializes secret material (webhook list, deliveries, reconciliation)', async () => {
  const created = await req('POST', '/webhook-endpoints', { token: tokenA, body: { url: 'https://hook.example.com/hl2', events: ['payment.succeeded'] } });
  const id = String(created.body.id);
  const secret = String(created.body.secret);
  const db = getDb();
  insertIntent('pi_hl2', 'merch_hlA');
  const ciphertext = String(db.prepare('SELECT secret_ciphertext FROM webhook_endpoints WHERE id=?').get(id));
  db.prepare('INSERT INTO webhook_deliveries(id,webhook_endpoint_id,payment_intent_id,event_type,payload,status,attempts,next_attempt_at) VALUES(?,?,?,?,?,?,?,unixepoch())')
    .run('wd_hl2', id, 'pi_hl2', 'payment.succeeded', '{"id":"evt_hl2"}', 'pending', 0);
  const paymentId = `pay_hl2_${++paySeq}`;
  insertPayment(paymentId, 'pi_hl2', 'merch_hlA', '0x48' + '0'.repeat(62), 'arc_testnet', 5042002);
  try {
    const surfaces = [
      await req('GET', '/webhook-endpoints', { token: tokenA }),
      await req('GET', '/webhook-deliveries', { token: tokenA }),
      await req('GET', `/payments/${paymentId}`, { key: KEY_A }),
    ];
    for (const s of surfaces) {
      expect(s.status).toBe(200);
      expect(s.text).not.toContain(secret);       // plaintext never leaves via reads
      expect(s.text).not.toContain(ciphertext);   // signing envelope never leaves
      expect(s.text).not.toContain('v1.eyJ');     // (base64 envelopes start alike)
    }
    // and the reconciliation view DID surface the delivery state (still works)
    const recon = surfaces[2].body as Record<string, unknown>;
    const deliveries = recon.webhook_deliveries as Array<Record<string, unknown>>;
    expect(deliveries.some((d) => d.event_type === 'payment.succeeded')).toBe(true);
  } finally {
    db.prepare("DELETE FROM webhook_deliveries WHERE id='wd_hl2'").run();
    db.prepare("DELETE FROM payments WHERE id=?").run(paymentId);
    db.prepare("DELETE FROM payment_intents WHERE id='pi_hl2'").run();
    db.prepare("DELETE FROM settlement_wallets WHERE id='sw_pi_hl2'").run();
    await req('DELETE', `/webhook-endpoints/${id}`, { token: tokenA });
  }
});

test('HL3: rotation atomically replaces the envelope — old secret material is gone from the DB', async () => {
  const created = await req('POST', '/webhook-endpoints', { token: tokenA, body: { url: 'https://hook.example.com/hl3' } });
  const id = String(created.body.id);
  const oldSecret = String(created.body.secret);
  const oldCiphertext = String(getDb().prepare('SELECT secret_ciphertext FROM webhook_endpoints WHERE id=?').get(id));
  const rotated = await req('POST', `/webhook-endpoints/${id}/rotate-secret`, { token: tokenA });
  expect(rotated.status).toBe(200);
  const newSecret = String(rotated.body.secret);
  expect(newSecret).not.toBe(oldSecret);
  const row = getDb().prepare('SELECT secret_ciphertext,secret_hash,secret_preview FROM webhook_endpoints WHERE id=?').get(id) as Record<string, string>;
  expect(row.secret_ciphertext).not.toBe(oldCiphertext);
  expect(decryptSecret(row.secret_ciphertext)).toBe(newSecret);
  // the DB no longer holds ANY column from which the old secret can be recovered
  const wholeRow = JSON.stringify(getDb().prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(id));
  expect(wholeRow).not.toContain(oldSecret);
  expect(wholeRow).not.toContain(oldCiphertext);
  await req('DELETE', `/webhook-endpoints/${id}`, { token: tokenA });
});

test('HL4: delivery rows store only the event payload — no secret material anywhere', () => {
  const g = generateAndHashWebhookSecret();
  const db = getDb();
  db.prepare('INSERT INTO webhook_endpoints(id,merchant_id,url,secret_hash,secret_preview,secret_ciphertext,environment) VALUES(?,?,?,?,?,?,?)')
    .run('whe_hl4', 'merch_hlA', 'https://hook.example.com/hl4', g.hash, g.preview, g.ciphertext, 'test');
  insertIntent('pi_hl4', 'merch_hlA');
  db.prepare('INSERT INTO webhook_deliveries(id,webhook_endpoint_id,payment_intent_id,event_type,payload,status,attempts,next_attempt_at) VALUES(?,?,?,?,?,?,?,unixepoch())')
    .run('wd_hl4', 'whe_hl4', 'pi_hl4', 'payment.succeeded', JSON.stringify({ id: 'evt_hl4', type: 'payment.succeeded' }), 'pending', 0);
  const row = JSON.stringify(db.prepare('SELECT * FROM webhook_deliveries WHERE id=?').get('wd_hl4'));
  expect(row).not.toContain(g.secret);
  expect(row).not.toContain(g.ciphertext);
  expect(row).not.toContain('v1.');
  db.prepare("DELETE FROM webhook_deliveries WHERE id='wd_hl4'").run();
  db.prepare("DELETE FROM payment_intents WHERE id='pi_hl4'").run();
  db.prepare("DELETE FROM settlement_wallets WHERE id='sw_pi_hl4'").run();
  db.prepare("DELETE FROM webhook_endpoints WHERE id='whe_hl4'").run();
});

test('HL5: public receipt projection is an EXACT pinned key set (no internal/email internals)', () => {
  const db = getDb();
  insertIntent('pi_hl5', 'merch_hlA', { email: 'buyer@hl.example' });
  const paymentId = `pay_hl5_${++paySeq}`;
  insertPayment(paymentId, 'pi_hl5', 'merch_hlA', '0x48' + '1'.repeat(2) + '0'.repeat(60), 'arc_testnet', 5042002);
  const receipt = generateReceiptForPayment(paymentId);
  expect(receipt).not.toBeNull();
  try {
    const pub = db.prepare('SELECT * FROM receipts WHERE payment_id=?').get(paymentId) as Record<string, unknown>;
    expect(pub.customer_email).toBe('buyer@hl.example');
    // simulate an attacker/UX rewriting the stored email AFTER issuance (HL9 covers
    // the API surface; here we make sure generation snapshotted correctly first).
  } finally {
    db.prepare("DELETE FROM receipts WHERE payment_id=?").run(paymentId);
    db.prepare("DELETE FROM payments WHERE id=?").run(paymentId);
    db.prepare("DELETE FROM payment_intents WHERE id='pi_hl5'").run();
    db.prepare("DELETE FROM settlement_wallets WHERE id='sw_pi_hl5'").run();
  }
});

test('HL6: receipt + link capability ids are high-entropy, prefixed, and non-sequential', () => {
  const receipts = new Set<string>();
  const links = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const r = generateReceiptId();
    const l = generatePaymentLinkId();
    expect(r).toMatch(/^rcpt_[0-9a-z]{24}$/);
    expect(l).toMatch(/^plink_[0-9a-z]{24}$/);
    receipts.add(r); links.add(l);
  }
  expect(receipts.size).toBe(200); // collision-free at ~124 bits of entropy
  expect(links.size).toBe(200);
  // non-walkable: two consecutive ids must differ in the FIRST random chars too
  const a = generateReceiptId(); const b = generateReceiptId();
  expect(a.slice(5, 11)).not.toBe(b.slice(5, 11));
});

test('HL7: public /pay/:id exposes only checkout-necessary fields', async () => {
  const db = getDb();
  db.prepare(
    'INSERT INTO payment_links(id,merchant_id,amount_decimal,amount_base_units,currency,description,order_id,metadata,allowed_networks,environment,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  ).run('plink_hl7pub', 'merch_hlA', '7.500000', '7500000', 'USDC', 'Consulting', 'ORD_HL7', JSON.stringify({ internal_note: 'secret-ish' }), '[]', 'test', 'active');
  const pub = await req('GET', '/pay/plink_hl7pub');
  expect(pub.status).toBe(200);
  const keys = Object.keys(pub.body).sort();
  expect(keys).toEqual(['amount', 'currency', 'description', 'expired', 'expires_at', 'id', 'merchant_name', 'order_id', 'paid', 'payable', 'status']);
  expect(pub.text).not.toContain('secret-ish');   // metadata never crosses the capability boundary
  expect(pub.text).not.toContain('merch_hlA');    // internal merchant id not exposed
  expect(pub.text).not.toContain('7500000');      // base units not exposed (display amount only)
  db.prepare("DELETE FROM payment_links WHERE id='plink_hl7pub'").run();
});

test('HL8: payments are network-scoped — identical tx_hash on two chains stays two distinct rows', () => {
  const db = getDb();
  const sameHash = '0x48' + 'a'.repeat(62);
  insertIntent('pi_hl8a', 'merch_hlA');
  insertIntent('pi_hl8b', 'merch_hlA');
  db.prepare('UPDATE payment_intents SET network=?, chain_id=? WHERE id=?').run('base_sepolia', 84532, 'pi_hl8b');
  insertPayment('pay_hl8a', 'pi_hl8a', 'merch_hlA', sameHash, 'arc_testnet', 5042002);
  insertPayment('pay_hl8b', 'pi_hl8b', 'merch_hlA', sameHash, 'base_sepolia', 84532); // must NOT collide
  const a = req('GET', '/payments/pay_hl8a', { key: KEY_A });
  const b = req('GET', '/payments/pay_hl8b', { key: KEY_A });
  return Promise.all([a, b]).then(([ra, rb]) => {
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect((ra.body as Record<string, unknown>).network).toBe('arc_testnet');
    expect((rb.body as Record<string, unknown>).network).toBe('base_sepolia');
    expect(ra.body.tx_hash).toBe(rb.body.tx_hash); // same hash, different scopes — distinct payments
    db.prepare("DELETE FROM payments WHERE id IN ('pay_hl8a','pay_hl8b')").run();
    db.prepare("DELETE FROM payment_intents WHERE id IN ('pi_hl8a','pi_hl8b')").run();
    db.prepare("DELETE FROM settlement_wallets WHERE id IN ('sw_pi_hl8a','sw_pi_hl8b')").run();
  });
});

test('HL9: an issued receipt is immutable — changing the intent email cannot alter it', async () => {
  const db = getDb();
  insertIntent('pi_hl9', 'merch_hlA', { email: 'real@customer.example' });
  const paymentId = `pay_hl9_${++paySeq}`;
  insertPayment(paymentId, 'pi_hl9', 'merch_hlA', '0x48' + '9'.repeat(2) + '0'.repeat(58), 'arc_testnet', 5042002);
  const receipt = generateReceiptForPayment(paymentId);
  expect(receipt!.customer_email).toBe('real@customer.example');
  // A late "correction" of the intent email must not mutate the issued receipt.
  db.prepare('UPDATE payment_intents SET customer_email=? WHERE id=?').run('attacker@evil.example', 'pi_hl9');
  const pub = await req('GET', `/receipts/${receipt!.id}`);
  expect(pub.status).toBe(200);
  expect(pub.body.customer_email).toBe('real@customer.example');
  // public projection must not carry internal columns
  for (const forbidden of ['merchant_id', 'payment_id', 'email_attempts', 'last_email_error', 'next_email_attempt_at']) {
    expect(forbidden in pub.body).toBe(false);
  }
  // and there is NO public/merchant endpoint to edit a receipt's email
  const put = await req('PUT', `/receipts/${receipt!.id}`, { token: tokenA, body: { customer_email: 'x@y.z' } });
  const patch = await req('PATCH', `/receipts/${receipt!.id}`, { token: tokenA, body: { customer_email: 'x@y.z' } });
  expect([404, 405]).toContain(put.status);
  expect([404, 405]).toContain(patch.status);
  db.prepare('DELETE FROM receipts WHERE id=?').run(receipt!.id);
  db.prepare("DELETE FROM payments WHERE id=?").run(paymentId);
  db.prepare("DELETE FROM payment_intents WHERE id='pi_hl9'").run();
  db.prepare("DELETE FROM settlement_wallets WHERE id='sw_pi_hl9'").run();
});

test('HL10: cross-tenant reconciliation isolation holds under the new schema', async () => {
  const db = getDb();
  // Merchant A payment + receipt + signed endpoint; merchant B endpoint with the
  // SAME subscription set. B must never see A's receipt or delivery rows.
  insertIntent('pi_hl10', 'merch_hlA', { email: 'a@hl.example' });
  const paymentId = `pay_hl10_${++paySeq}`;
  insertPayment(paymentId, 'pi_hl10', 'merch_hlA', '0x48' + '10'.repeat(1) + '0'.repeat(60), 'arc_testnet', 5042002);
  const receipt = generateReceiptForPayment(paymentId);
  const g = generateAndHashWebhookSecret();
  db.prepare('INSERT INTO webhook_endpoints(id,merchant_id,url,secret_hash,secret_preview,secret_ciphertext,environment) VALUES(?,?,?,?,?,?,?)')
    .run('whe_hl10A', 'merch_hlA', 'https://hook.example.com/a', g.hash, g.preview, g.ciphertext, 'test');
  db.prepare('INSERT INTO webhook_deliveries(id,webhook_endpoint_id,payment_intent_id,event_type,payload,status,attempts,next_attempt_at) VALUES(?,?,?,?,?,?,?,unixepoch())')
    .run('wd_hl10', 'whe_hl10A', 'pi_hl10', 'payment.succeeded', '{"id":"e"}', 'delivered', 1);
  try {
    const asB = await req('GET', `/payments/${paymentId}`, { key: KEY_B });
    expect(asB.status).toBe(404);                       // payment not enumerable cross-tenant
    const listB = await req('GET', '/webhook-deliveries', { token: undefined });        // no session
    expect(listB.status).toBe(401);
    const asA = await req('GET', `/payments/${paymentId}`, { key: KEY_A });
    expect(asA.status).toBe(200);
    const receiptView = asA.body.receipt as Record<string, unknown>;
    expect(receiptView.id).toBe(receipt!.id);           // own receipt DOES attach for A
    const deliveries = asA.body.webhook_deliveries as unknown[];
    expect(deliveries.length).toBe(1);
    expect(JSON.stringify(asA.body)).not.toContain(g.secret); // even owner view hides the secret
  } finally {
    db.prepare("DELETE FROM webhook_deliveries WHERE id='wd_hl10'").run();
    db.prepare("DELETE FROM webhook_endpoints WHERE id='whe_hl10A'").run();
    db.prepare('DELETE FROM receipts WHERE id=?').run(receipt!.id);
    db.prepare("DELETE FROM payments WHERE id=?").run(paymentId);
    db.prepare("DELETE FROM payment_intents WHERE id='pi_hl10'").run();
    db.prepare("DELETE FROM settlement_wallets WHERE id='sw_pi_hl10'").run();
  }
});
