/**
 * JafariPay — MASTER PHASE F (Merchant Reconciliation) additive-view tests.
 *
 * Phase F is explicitly "implement only SAFE, ADDITIVE improvements". This suite
 * proves the enriched GET /payments/:id reconciliation view:
 *
 *   - the pre-existing payment + intent + blockchain_transaction fields remain
 *     (backward compatibility — nothing removed from the response shape)
 *   - verification_state is surfaced
 *   - the linked receipt (id / email_status / customer_email / explorer_url) is
 *     appended when one exists, and null otherwise
 *   - payment_link_id + usdc_address + currency (token identity) are surfaced
 *   - per-intent webhook delivery state is appended
 *   - it stays strictly merchant-scoped: a foreign merchant gets 404, and a
 *     foreign merchant's webhook endpoint never leaks into the view
 *
 * The money path is unchanged: verification still runs through the real
 * verifyPayment pipeline with ONLY ArcProvider.getTransactionReceipt mocked.
 */
import { test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_master_recon_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'master-recon-test-secret';
process.env.EMAIL_TRANSPORT = 'dev';

const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');
const checkoutRouter = (await import('./api/checkout.ts')).default;
const intentsRouter = (await import('./api/payment-intents.ts')).default;
const paymentsRouter = (await import('./api/payments.ts')).default;

const USDC = '0x3600000000000000000000000000000000000000';
const SETTLEMENT = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

const hashApiKey = (key: string) =>
  createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

// Namespaced 0x46 ("F") high byte so these tx hashes stay disjoint from every
// other API suite that shares ONE sqlite DB in a full `bun test` run.
let seq = 0;
const HASH_BASE = BigInt('0x46' + '0'.repeat(60));
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
  ).run(id, merchantId, null, 'mrf', key.slice(0, 8), hashApiKey(key), key.slice(0, 12), 1, 'test');
}

async function createIntent(auth: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/v1/payment-intents`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function checkoutVerify(piId: string, hash: string, chainId: number) {
  const res = await fetch(`${baseUrl}/checkout/${piId}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx_hash: hash, chain_id: chainId }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function apiGet(path: string, auth?: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

// Create + verify a succeeded payment (with receipt), returning the payment id.
async function payAndVerify(auth: string, email?: string) {
  const created = await createIntent(auth, email ? { amount: '2.50', receipt_email: email } : { amount: '2.50' });
  const pi = String(created.body.id);
  const chain = Number(created.body.chain_id);
  mockValidReceipt(2_500_000n);
  const v = await checkoutVerify(pi, txHash(), chain);
  const payment = getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi) as { id: string };
  return { pi, chain, paymentId: payment.id, verify: v };
}

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_fA', 'Merchant A');
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_fB', 'Merchant B');
  insertWallet('sw_fA', 'merch_fA', SETTLEMENT, 'arc_testnet');
  insertWallet('sw_fB', 'merch_fB', SETTLEMENT, 'arc_testnet');
  insertApiKey('ak_fA', 'merch_fA', 'sk_test_fA');
  insertApiKey('ak_fB', 'merch_fB', 'sk_test_fB');

  app = express();
  app.use(express.json());
  app.use('/checkout', checkoutRouter);
  app.use('/v1/payment-intents', intentsRouter);
  app.use('/v1/payments', paymentsRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(() => {
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockRestore();
});

afterAll(() => {
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* Windows handle may linger */ }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
test('F1: GET /payments/:id keeps the original shape and appends verification_state + receipt', async () => {
  const { paymentId, pi } = await payAndVerify('sk_test_fA', 'recon@a.com');
  const r = await apiGet(`/v1/payments/${paymentId}`, 'sk_test_fA');
  expect(r.status).toBe(200);
  // Pre-existing fields (backward compatibility).
  expect(r.body.id).toBe(paymentId);
  expect(r.body.payment_intent_id).toBe(pi);
  expect(r.body.amount).toBe('2.500000');
  expect(r.body.status).toBe('succeeded');
  expect(r.body.network).toBe('arc_testnet');
  expect(r.body.tx_hash).toBeTruthy();
  expect(r.body.recipient_address).toBe(SETTLEMENT.toLowerCase()); // settlement wallet
  expect(r.body.sender_address).toBe(SENDER.toLowerCase());        // payer
  // Additive reconciliation fields.
  expect(r.body.verification_state).toBe('verified');
  expect(r.body.usdc_address).toBe(USDC);   // token identity
  expect(r.body.currency).toBe('USDC');
  const receipt = r.body.receipt as Record<string, unknown>;
  expect(receipt).toBeTruthy();
  expect(String(receipt.id).startsWith('rcpt_')).toBe(true);
  expect(receipt.customer_email).toBe('recon@a.com');
  expect(['sent', 'pending']).toContain(receipt.email_status);
  expect(receipt.explorer_url).toBe(`https://explorer.testnet.arc.io/tx/${r.body.tx_hash}`);
});

test('F2: payment_link_id is null for a direct intent (no link) and surfaced additively', async () => {
  const { paymentId } = await payAndVerify('sk_test_fA');
  const r = await apiGet(`/v1/payments/${paymentId}`, 'sk_test_fA');
  expect('payment_link_id' in r.body).toBe(true);
  expect(r.body.payment_link_id).toBeNull();
});

test('F3: webhook_deliveries is an empty array when no delivery exists yet', async () => {
  const { paymentId } = await payAndVerify('sk_test_fA', 'nowh@a.com');
  const r = await apiGet(`/v1/payments/${paymentId}`, 'sk_test_fA');
  expect(Array.isArray(r.body.webhook_deliveries)).toBe(true);
  expect((r.body.webhook_deliveries as unknown[]).length).toBe(0);
});

test('F4: an existing webhook delivery for the intent is surfaced', async () => {
  const { paymentId, pi } = await payAndVerify('sk_test_fA', 'hook@a.com');
  const db = getDb();
  db.prepare(
    'INSERT INTO webhook_endpoints(id,merchant_id,url,secret_hash,secret_preview,environment) VALUES(?,?,?,?,?,?)'
  ).run('we_f1', 'merch_fA', 'https://merchant.example/hook', 'deadbeef', 'whsec_pfx', 'test');
  db.prepare(
    'INSERT INTO webhook_deliveries(id,webhook_endpoint_id,payment_intent_id,event_type,payload,status,attempts,delivered_at) VALUES(?,?,?,?,?,?,?,?)'
  ).run('wd_f1', 'we_f1', pi, 'payment.succeeded', '{}', 'delivered', 1, Math.floor(Date.now() / 1000));

  const r = await apiGet(`/v1/payments/${paymentId}`, 'sk_test_fA');
  const deliveries = r.body.webhook_deliveries as Array<Record<string, unknown>>;
  expect(deliveries.length).toBe(1);
  expect(deliveries[0].event_type).toBe('payment.succeeded');
  expect(deliveries[0].status).toBe('delivered');
  expect(deliveries[0].delivered_at).toBeTruthy();

  db.prepare("DELETE FROM webhook_deliveries WHERE id='wd_f1'").run();
  db.prepare("DELETE FROM webhook_endpoints WHERE id='we_f1'").run();
});

test('F5: cross-merchant isolation — merchant B cannot read merchant A payment (404)', async () => {
  const { paymentId } = await payAndVerify('sk_test_fA', 'iso@a.com');
  const r = await apiGet(`/v1/payments/${paymentId}`, 'sk_test_fB');
  expect(r.status).toBe(404);
});

test('F6: a foreign merchant\'s webhook endpoint never leaks into the reconciliation view', async () => {
  const { paymentId, pi } = await payAndVerify('sk_test_fA', 'leak@a.com');
  const db = getDb();
  // A webhook endpoint + delivery that POINTS AT merchant A's intent but is owned
  // by merchant B. The merchant-scoped JOIN must exclude it from A's view.
  db.prepare(
    'INSERT INTO webhook_endpoints(id,merchant_id,url,secret_hash,secret_preview,environment) VALUES(?,?,?,?,?,?)'
  ).run('we_fB', 'merch_fB', 'https://evil.example/hook', 'deadbeef', 'whsec_pfx', 'test');
  db.prepare(
    'INSERT INTO webhook_deliveries(id,webhook_endpoint_id,payment_intent_id,event_type,payload,status,attempts) VALUES(?,?,?,?,?,?,?)'
  ).run('wd_fB', 'we_fB', pi, 'payment.succeeded', '{}', 'pending', 0);

  const r = await apiGet(`/v1/payments/${paymentId}`, 'sk_test_fA');
  const deliveries = r.body.webhook_deliveries as Array<Record<string, unknown>>;
  expect(deliveries.some((d) => d.event_type === 'payment.succeeded' && d.status === 'pending')).toBe(false);

  db.prepare("DELETE FROM webhook_deliveries WHERE id='wd_fB'").run();
  db.prepare("DELETE FROM webhook_endpoints WHERE id='we_fB'").run();
});
