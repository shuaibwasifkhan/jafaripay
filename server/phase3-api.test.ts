/**
 * JafariPay — Phase 3 API tests (bun:test): verify-endpoint chain_id gating +
 * payment-intent network selection.
 *
 * Covers the mandated security matrix:
 *  A. POST /checkout/:id/verify and POST /v1/payment-intents/:id/verify require
 *     chain_id; a missing or mismatched chain_id is rejected and NO verification
 *     is attempted; the PI's PINNED chain_id is the source of truth.
 *  B. POST /v1/payment-intents network selector: omitted -> today's exact
 *     env default (test->arc_testnet, live->arc_mainnet); supplied -> must exist,
 *     be enabled, and its test/live class must match the API-key environment.
 *     Live keys cannot make testnet intents and vice-versa; the merchant must
 *     have an active settlement wallet on the selected network; the PI snapshots
 *     network/chain_id/usdc_address/settlement_address from the registry+wallet.
 *  Verification after creation always uses the PI snapshot, never the live
 *     registry (proven by mutating the registry row post-creation).
 *
 * Only inert local fixture networks (chain ids 9100xx) are used. NO real second
 * network is registered or enabled. Blockchain I/O is mocked at exactly one
 * boundary — ArcProvider.getTransactionReceipt — so the real route handlers and
 * the real verifyPayment rule pipeline execute unmodified.
 */
import { test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_phase3_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.ENABLE_LIVE_PAYMENTS = 'true'; // exercise live-key paths deterministically
process.env.API_KEY_HMAC_SECRET = 'phase3-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');
const checkoutRouter = (await import('./api/checkout.ts')).default;
const intentsRouter = (await import('./api/payment-intents.ts')).default;

const USDC = '0x3600000000000000000000000000000000000000';
const SETTLEMENT = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

const hashApiKey = (key: string) =>
  createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

// Deterministic, unique 32-byte tx hashes that never collide with the repeat-
// pattern hashes used by payment-expiry / provider-hardening suites.
let seq = 0;
function txHash(): string { seq++; return '0x' + seq.toString(16).padStart(64, '0'); }

function mockValidReceipt(amountBaseUnits = 1_000_000n, contract = USDC, to = SETTLEMENT) {
  const topics = encodeEventTopics({
    abi: [TRANSFER], eventName: 'Transfer',
    args: { from: SENDER as `0x${string}`, to: to as `0x${string}` },
  });
  const data = encodeAbiParameters([{ type: 'uint256' }], [amountBaseUnits]);
  // Echo the REQUESTED hash (like a real RPC) so each verified tx is unique and
  // the credit path never collides on the (tx_hash, network) uniqueness.
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockImplementation(((requested: string) => ({
    txHash: requested, status: 'success' as const, blockNumber: 100n,
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)), from: SENDER, to: contract,
    logs: [{ address: contract.toLowerCase(), topics: topics as string[], data, logIndex: 0 }],
  })) as never);
}

function insertNetwork(id: string, network: string, chainId: number, isTestnet: number, isEnabled: number, usdc = USDC): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_testnet,required_confirmations,is_enabled) VALUES(?,?,?,?,?,?,6,?,?,?)'
  ).run(id, network, chainId, 'http://127.0.0.1:1/', 'http://localhost/ex', usdc, isTestnet, 0, isEnabled);
}

function insertWallet(id: string, merchantId: string, address: string, network: string, active = 1): void {
  getDb().prepare('INSERT OR REPLACE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,?)')
    .run(id, merchantId, address.toLowerCase(), network, active);
}

function insertApiKey(id: string, merchantId: string, key: string, environment: 'test' | 'live'): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)'
  ).run(id, merchantId, null, 'p3', key.slice(0, 8), hashApiKey(key), key.slice(0, 12), 1, environment);
}

async function createIntent(auth: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/v1/payment-intents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function checkoutVerify(piId: string, hash: string, chainId?: number) {
  const res = await fetch(`${baseUrl}/checkout/${piId}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chainId === undefined ? { tx_hash: hash } : { tx_hash: hash, chain_id: chainId }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function apiVerify(piId: string, auth: string, hash: string, chainId?: number) {
  const res = await fetch(`${baseUrl}/v1/payment-intents/${piId}/verify`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(chainId === undefined ? { tx_hash: hash } : { tx_hash: hash, chain_id: chainId }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_p3', 'Phase3 Merchant');

  // Inert fixture networks (no real production network is registered).
  insertNetwork('nc_p3_ftest', 'p3_fixture_test', 910001, /* is_testnet */ 1, /* enabled */ 1);
  insertNetwork('nc_p3_fmain', 'p3_fixture_main', 910002, 0, 1);
  insertNetwork('nc_p3_off', 'p3_disabled', 910003, 1, 0); // disabled testnet-class
  insertNetwork('nc_p3_nowallet', 'p3_fixture_nowallet', 910004, 1, 1); // enabled, no wallet

  // Settlement wallets per network the merchant may select.
  insertWallet('sw_p3_atest', 'merch_p3', SETTLEMENT, 'arc_testnet');
  insertWallet('sw_p3_amain', 'merch_p3', SETTLEMENT, 'arc_mainnet');
  insertWallet('sw_p3_ftest', 'merch_p3', SETTLEMENT, 'p3_fixture_test');
  insertWallet('sw_p3_fmain', 'merch_p3', SETTLEMENT, 'p3_fixture_main');

  // API keys (secret) for both environments.
  insertApiKey('ak_p3_test', 'merch_p3', 'sk_test_p3key', 'test');
  insertApiKey('ak_p3_live', 'merch_p3', 'sk_live_p3key', 'live');

  app = express();
  app.use(express.json());
  app.use('/checkout', checkoutRouter);
  app.use('/v1/payment-intents', intentsRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(() => { spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockRestore(); });

afterAll(() => {
  server?.close();
  const db = getDb();
  for (const id of ['nc_p3_ftest', 'nc_p3_fmain', 'nc_p3_off', 'nc_p3_nowallet']) {
    try { db.prepare('DELETE FROM network_configs WHERE id=?').run(id); } catch { /* gone */ }
  }
  try { getDb().close(); } catch { /* already closed */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* Windows handle may linger */ }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PART A — verify endpoint requires chain_id
// ═══════════════════════════════════════════════════════════════════════════

test('A1: checkout verify with MISSING chain_id -> rejected, no verification attempted', async () => {
  const created = await createIntent('sk_test_p3key', { amount: '1.00' });
  expect(created.status).toBe(201);
  const pi = String(created.body.id);
  const r = await checkoutVerify(pi, txHash());
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/chain_id is required/);
  // The PI must NOT have been transitioned to processing (no verification run).
  expect((getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(pi) as { status: string }).status).toBe('requires_payment');
});

test('A2: checkout verify with WRONG chain_id -> rejected, PI not credited', async () => {
  const created = await createIntent('sk_test_p3key', { amount: '1.00' });
  const pi = String(created.body.id);
  const r = await checkoutVerify(pi, txHash(), 999999); // wrong
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('wrong_network');
  expect(getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi)).toBeFalsy();
});

test('A3: checkout verify with CORRECT chain_id -> existing verification succeeds', async () => {
  const created = await createIntent('sk_test_p3key', { amount: '1.00' });
  const pi = String(created.body.id);
  const chain = Number(created.body.chain_id); // 5042002 pinned
  mockValidReceipt();
  const r = await checkoutVerify(pi, txHash(), chain);
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('succeeded');
  expect(getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi)).toBeTruthy();
});

test('A4: API verify with MISSING chain_id -> rejected', async () => {
  const created = await createIntent('sk_test_p3key', { amount: '1.00' });
  const pi = String(created.body.id);
  const r = await apiVerify(pi, 'sk_test_p3key', txHash());
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/chain_id is required/);
  expect((getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(pi) as { status: string }).status).toBe('requires_payment');
});

test('A5: API verify with WRONG chain_id -> rejected; CORRECT chain_id -> succeeds', async () => {
  const created = await createIntent('sk_test_p3key', { amount: '1.00' });
  const pi = String(created.body.id);
  const bad = await apiVerify(pi, 'sk_test_p3key', txHash(), 123456);
  expect(bad.status).toBe(400);
  expect(bad.body.code).toBe('wrong_network');
  mockValidReceipt();
  const ok = await apiVerify(pi, 'sk_test_p3key', txHash(), Number(created.body.chain_id));
  expect(ok.status).toBe(200);
  expect(ok.body.status).toBe('succeeded');
});

test('A6: a client-supplied chain_id never redirects the target (PI snapshot wins)', async () => {
  // PI is pinned to arc_testnet/5042002. Even a receipt that would be valid on
  // another chain is verified only against the pinned network/USDC/settlement.
  const created = await createIntent('sk_test_p3key', { amount: '1.00' });
  const pi = String(created.body.id);
  mockValidReceipt(1_000_000n, '0x1111111111111111111111111111111111111111'); // wrong contract
  const r = await checkoutVerify(pi, txHash(), Number(created.body.chain_id)); // correct chain_id
  // chain_id matches so verification RUNS, but the pinned USDC contract is not
  // in the receipt -> not credited. chain_id is an assertion, not a selector.
  expect(r.body.status).not.toBe('succeeded');
  expect(getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi)).toBeFalsy();
});

// ═══════════════════════════════════════════════════════════════════════════
// PART B — payment-intent network selection + environment-class enforcement
// ═══════════════════════════════════════════════════════════════════════════

test('B1: no network supplied -> preserved Arc default (test->arc_testnet, live->arc_mainnet)', async () => {
  const t = await createIntent('sk_test_p3key', { amount: '1.00' });
  expect(t.status).toBe(201);
  expect(t.body.network).toBe('arc_testnet');
  expect(t.body.chain_id).toBe(5042002);

  const l = await createIntent('sk_live_p3key', { amount: '1.00' });
  expect(l.status).toBe(201);
  expect(l.body.network).toBe('arc_mainnet');
  expect(l.body.chain_id).toBe(5042);
});

test('B2: live key + arc_testnet (testnet-class) -> rejected', async () => {
  const r = await createIntent('sk_live_p3key', { amount: '1.00', network: 'arc_testnet' });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('environment_network_mismatch');
});

test('B3: test key + arc_mainnet (mainnet-class) -> rejected', async () => {
  const r = await createIntent('sk_test_p3key', { amount: '1.00', network: 'arc_mainnet' });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('environment_network_mismatch');
});

test('B4: live key + enabled mainnet-class fixture -> accepted with correct snapshot', async () => {
  const r = await createIntent('sk_live_p3key', { amount: '1.00', network: 'p3_fixture_main' });
  expect(r.status).toBe(201);
  expect(r.body.network).toBe('p3_fixture_main');
  expect(r.body.chain_id).toBe(910002);
  expect(r.body.usdc_address).toBe(USDC);
  expect(r.body.settlement_address).toBe(SETTLEMENT.toLowerCase());
});

test('B5: test key + enabled testnet-class fixture -> accepted', async () => {
  const r = await createIntent('sk_test_p3key', { amount: '1.00', network: 'p3_fixture_test' });
  expect(r.status).toBe(201);
  expect(r.body.chain_id).toBe(910001);
});

test('B6: disabled network -> rejected', async () => {
  const r = await createIntent('sk_test_p3key', { amount: '1.00', network: 'p3_disabled' });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('invalid_network');
});

test('B7: unknown network -> rejected', async () => {
  const r = await createIntent('sk_test_p3key', { amount: '1.00', network: 'solana_mainnet' });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('invalid_network');
});

test('B8: missing settlement wallet for selected network -> rejected', async () => {
  const r = await createIntent('sk_test_p3key', { amount: '1.00', network: 'p3_fixture_nowallet' });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('setup.no_settlement_wallet');
});

test('B9: created PI persists the correct network/chain_id/usdc_address snapshot', async () => {
  const r = await createIntent('sk_test_p3key', { amount: '1.00', network: 'p3_fixture_test' });
  const row = getDb().prepare('SELECT network,chain_id,usdc_address,settlement_address FROM payment_intents WHERE id=?')
    .get(String(r.body.id)) as { network: string; chain_id: number; usdc_address: string; settlement_address: string };
  expect(row.network).toBe('p3_fixture_test');
  expect(row.chain_id).toBe(910001);
  expect(row.usdc_address).toBe(USDC);
  expect(row.settlement_address).toBe(SETTLEMENT.toLowerCase());
});

// ═══════════════════════════════════════════════════════════════════════════
// Verification uses the PI snapshot, not the live registry
// ═══════════════════════════════════════════════════════════════════════════

test('S13: mutating registry after creation does NOT change the verification target', async () => {
  const created = await createIntent('sk_test_p3key', { amount: '1.00' }); // arc_testnet, usdc=USDC pinned
  const pi = String(created.body.id);

  // Operator changes the registry's USDC address for arc_testnet AFTER creation.
  getDb().prepare('UPDATE network_configs SET usdc_address=? WHERE network=?')
    .run('0x9999999999999999999999999999999999999999', 'arc_testnet');
  try {
    // A receipt paying the ORIGINAL (pinned) USDC contract must still verify,
    // proving the target comes from the PI snapshot, not the mutated registry.
    mockValidReceipt(1_000_000n, USDC);
    const r = await checkoutVerify(pi, txHash(), Number(created.body.chain_id));
    expect(r.body.status).toBe('succeeded');
  } finally {
    getDb().prepare('UPDATE network_configs SET usdc_address=? WHERE network=?').run(USDC, 'arc_testnet');
  }
});
