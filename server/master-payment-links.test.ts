/**
 * JafariPay — MASTER PHASE C (Payment Links / Invoices) tests.
 *
 * Mandated coverage:
 *   1. link creation (amount validated, pay_url returned)
 *   2. checkout: /pay/:id/create mints a payment intent from the LINK's amount
 *   3. expiry: past expires_at rejected at creation AND at checkout (410)
 *   4. already-paid link refuses a second charge (409 link_paid)
 *   5. merchant isolation (detail / disable are merchant-scoped → 404)
 *   6. network restrictions (allowed_networks validated for existence + class)
 *   7. invalid link (unknown id → 404)
 *   8. replay (a refresh reuses the open intent; a settled link cannot re-mint)
 *   9. amount integrity (the client can NEVER override the link's stored amount)
 *
 * Only inert fixture / registry-default networks are used; blockchain is mocked
 * at the single getTransactionReceipt boundary; NO real settlement occurs.
 */
import { test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_master_links_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'master-links-test-secret';
// NOTE: do NOT override CHECKOUT_BASE_URL here — the whole suite shares one
// process, and other files assert against their own checkout_url base. The
// pay_url assertions below only check the /pay/:id suffix, which is base-agnostic.

const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');
const checkoutRouter = (await import('./api/checkout.ts')).default;

const linksMod = await import('./api/payment-links.ts');
const paymentLinksRouter = linksMod.default;
const payRouter = linksMod.payRouter;

const USDC = '0x3600000000000000000000000000000000000000';
const SETTLEMENT = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

const hashApiKey = (key: string) =>
  createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

let seq = 0;
// Namespaced 64-hex tx hashes (see master-receipts.test.ts). The 0x4c ("L") high
// byte keeps this suite disjoint from phase3 (0x0..seq), the receipts suite
// (0x52) and the repeat-pattern suites, since all API files share one sqlite DB.
const HASH_BASE = BigInt('0x4c' + '0'.repeat(60));
function txHash(): string { seq++; return '0x' + (HASH_BASE + BigInt(seq)).toString(16).padStart(64, '0'); }

function mockValidReceipt(amountBaseUnits = 2_500_000n, contract = USDC, to = SETTLEMENT) {
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

function insertWallet(id: string, merchantId: string, network: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run(id, merchantId, SETTLEMENT.toLowerCase(), network);
}
function insertApiKey(id: string, merchantId: string, key: string): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)'
  ).run(id, merchantId, null, 'ml', key.slice(0, 8), hashApiKey(key), key.slice(0, 12), 1, 'test');
}

async function post(path: string, body: Record<string, unknown>, auth?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function get(path: string, auth?: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function createLink(body: Record<string, unknown>, auth = 'sk_test_mlA') {
  return post('/v1/payment-links', body, auth);
}

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_mlA', 'Link Merchant A');
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_mlB', 'Link Merchant B');
  insertWallet('sw_mlA', 'merch_mlA', 'arc_testnet');
  insertWallet('sw_mlB', 'merch_mlB', 'arc_testnet');
  insertApiKey('ak_mlA', 'merch_mlA', 'sk_test_mlA');
  insertApiKey('ak_mlB', 'merch_mlB', 'sk_test_mlB');

  const app = express();
  app.use(express.json());
  app.use('/v1/payment-links', paymentLinksRouter);
  app.use('/pay', payRouter);
  app.use('/checkout', checkoutRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(() => { spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockRestore(); });

afterAll(() => {
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* Windows handle may linger */ }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1 — creation
// ═══════════════════════════════════════════════════════════════════════════

test('L1: create a link → 201, id + pay_url, stored amount pinned', async () => {
  const r = await createLink({ amount: '2.50', description: 'Invoice #10', order_id: 'inv-10' });
  expect(r.status).toBe(201);
  expect(String(r.body.id).startsWith('plink_')).toBe(true);
  expect(r.body.pay_url).toContain(`/pay/${r.body.id}`);
  expect(r.body.amount_decimal).toBe('2.50');
  expect(r.body.amount_base_units).toBe('2500000');
  expect(r.body.status).toBe('active');
  expect(r.body.environment).toBe('test');
});

test('L2: missing / non-positive amount rejected', async () => {
  expect((await createLink({ description: 'x' })).status).toBe(400);
  expect((await createLink({ amount: '0' })).status).toBe(400);
  expect((await createLink({ amount: '-1' })).status).toBe(400);
});

test('L3: non-USDC currency rejected', async () => {
  const r = await createLink({ amount: '1.00', currency: 'EURC' });
  expect(r.status).toBe(400);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — checkout mints an intent from the link
// ═══════════════════════════════════════════════════════════════════════════

test('L4: /pay/:id/create mints a payment intent carrying the link amount', async () => {
  const link = await createLink({ amount: '2.50', order_id: 'inv-4' });
  const r = await post(`/pay/${link.body.id}/create`, {});
  expect(r.status).toBe(201);
  expect(r.body.amount).toBe('2.50');
  expect(r.body.amount_base_units).toBe('2500000');
  expect(r.body.network).toBe('arc_testnet');
  expect(r.body.chain_id).toBe(5042002);
  expect(String(r.body.id).startsWith('pi_')).toBe(true);
  // The intent is linked back to the link.
  const row = getDb().prepare('SELECT payment_link_id FROM payment_intents WHERE id=?').get(String(r.body.id)) as { payment_link_id: string };
  expect(row.payment_link_id).toBe(String(link.body.id));
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 — amount integrity (client can never override the link's amount)
// ═══════════════════════════════════════════════════════════════════════════

test('L5: a client-supplied amount at create is IGNORED (link amount wins)', async () => {
  const link = await createLink({ amount: '2.50', order_id: 'inv-5' });
  const r = await post(`/pay/${link.body.id}/create`, { amount: '999999.00', network: 'arc_mainnet' });
  expect(r.status).toBe(201);
  expect(r.body.amount_base_units).toBe('2500000'); // NOT the 999999 body value
  expect(r.body.network).toBe('arc_testnet');       // NOT the tampered mainnet value (test-class link)
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — expiry
// ═══════════════════════════════════════════════════════════════════════════

test('L6a: expires_at in the past is rejected at creation', async () => {
  const r = await createLink({ amount: '1.00', expires_at: Math.floor(Date.now() / 1000) - 10 });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('invalid_expiry');
});

test('L6b: an expired link cannot be checked out (410 link_expired)', async () => {
  const link = await createLink({ amount: '1.00', expires_at: Math.floor(Date.now() / 1000) + 3600 });
  getDb().prepare('UPDATE payment_links SET expires_at=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 5, String(link.body.id));
  const info = await get(`/pay/${link.body.id}`);
  expect(info.body.expired).toBe(true);
  expect(info.body.payable).toBe(false);
  const r = await post(`/pay/${link.body.id}/create`, {});
  expect(r.status).toBe(410);
  expect(r.body.code).toBe('link_expired');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 & 8 — already-paid + replay
// ═══════════════════════════════════════════════════════════════════════════

test('L7: once a minted intent succeeds, the link is paid and cannot be re-charged', async () => {
  const link = await createLink({ amount: '2.50', order_id: 'inv-7' });
  const created = await post(`/pay/${link.body.id}/create`, {});
  const pi = String(created.body.id);
  // Verify it to succeeded via the real checkout pipeline.
  mockValidReceipt(2_500_000n);
  const v = await post(`/checkout/${pi}/verify`, { tx_hash: txHash(), chain_id: Number(created.body.chain_id) });
  expect(v.body.status).toBe('succeeded');

  const info = await get(`/pay/${link.body.id}`);
  expect(info.body.paid).toBe(true);
  expect(info.body.payable).toBe(false);

  const again = await post(`/pay/${link.body.id}/create`, {});
  expect(again.status).toBe(409);
  expect(again.body.code).toBe('link_paid');
});

test('L8: refreshing an unpaid link reuses the open intent (no intent stacking)', async () => {
  const link = await createLink({ amount: '2.50', order_id: 'inv-8' });
  const a = await post(`/pay/${link.body.id}/create`, {});
  const b = await post(`/pay/${link.body.id}/create`, {});
  expect(a.body.id).toBe(b.body.id);
  expect(b.body.reused).toBe(true);
  const count = (getDb().prepare('SELECT COUNT(*) c FROM payment_intents WHERE payment_link_id=?').get(String(link.body.id)) as { c: number }).c;
  expect(count).toBe(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — merchant isolation
// ═══════════════════════════════════════════════════════════════════════════

test('L9: merchant B cannot read or disable merchant A\'s link (404)', async () => {
  const link = await createLink({ amount: '1.00', order_id: 'inv-9' }, 'sk_test_mlA');
  const detail = await get(`/v1/payment-links/${link.body.id}`, 'sk_test_mlB');
  expect(detail.status).toBe(404);
  const dis = await post(`/v1/payment-links/${link.body.id}/disable`, {}, 'sk_test_mlB');
  expect(dis.status).toBe(404);
  // A's own list shows it; B's does not.
  const listA = await get('/v1/payment-links', 'sk_test_mlA');
  const listB = await get('/v1/payment-links', 'sk_test_mlB');
  const inA = (listA.body.data as Array<Record<string, unknown>>).some((x) => x.id === link.body.id);
  const inB = (listB.body.data as Array<Record<string, unknown>>).some((x) => x.id === link.body.id);
  expect(inA).toBe(true);
  expect(inB).toBe(false);
});

test('L10: disabling a link makes it non-payable (410 link_disabled)', async () => {
  const link = await createLink({ amount: '1.00', order_id: 'inv-10' });
  const dis = await post(`/v1/payment-links/${link.body.id}/disable`, {}, 'sk_test_mlA');
  expect(dis.status).toBe(200);
  expect(dis.body.status).toBe('disabled');
  const r = await post(`/pay/${link.body.id}/create`, {});
  expect(r.status).toBe(410);
  expect(r.body.code).toBe('link_disabled');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — network restrictions
// ═══════════════════════════════════════════════════════════════════════════

test('L11a: allowed_networks with a valid enabled testnet slug is accepted', async () => {
  const r = await createLink({ amount: '1.00', allowed_networks: ['arc_testnet'] });
  expect(r.status).toBe(201);
  expect(JSON.parse(String(r.body.allowed_networks))).toEqual(['arc_testnet']);
});

test('L11b: allowed_networks with a mainnet-class slug under a test key → class mismatch', async () => {
  const r = await createLink({ amount: '1.00', allowed_networks: ['arc_mainnet'] });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('environment_network_mismatch');
});

test('L11c: allowed_networks with an unknown slug → invalid_network', async () => {
  const r = await createLink({ amount: '1.00', allowed_networks: ['solana_mainnet'] });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('invalid_network');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 — invalid link
// ═══════════════════════════════════════════════════════════════════════════

test('L12: unknown link id → 404 on both public read and create', async () => {
  const info = await get('/pay/plink_nonexistent_00000000');
  expect(info.status).toBe(404);
  const r = await post('/pay/plink_nonexistent_00000000/create', {});
  expect(r.status).toBe(404);
});
