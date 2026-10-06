/**
 * CCTP MASTER PHASE 3 — Payment Intent API cross-chain support.
 *
 * Proves the cross-chain intent creation contract WITHOUT touching the money
 * path (no verification, no live reads):
 *   • a cross-chain intent pins source = the customer chain and settlement =
 *     Arc, reusing the merchant's ONE Arc wallet — the merchant is NOT required
 *     to hold a per-source settlement wallet (the plan's core rule).
 *   • zkSync Era / Celo (non-CCTP) and Arc itself are refused with machine-
 *     readable cross_chain.* error codes — never a silent non-Circle fallback.
 *   • same-chain intent creation is byte-identical to before (no new columns
 *     set, cross_chain=false).
 *   • a cross-chain intent is REFUSED by the same-chain /verify path (fail
 *     closed — it may only be credited after Arc settlement, PHASE 8).
 * Mocks only what the intent route never calls; no funds move.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctpintents_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp-intents-test-secret';
process.env.EMAIL_TRANSPORT = 'dev';

const { migrate, getDb } = await import('./db/schema.ts');
const intentsModule = await import('./api/payment-intents.ts');
const intentsRouter = intentsModule.default;
const { setForwardingQuoteForTest } = intentsModule;
import { isCctpSource, NOT_A_CCTP_SOURCE } from './db/cctp.ts';

const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';

const hashApiKey = (key: string) =>
  createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

function insertWallet(id: string, merchantId: string, address: string, network: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run(id, merchantId, address.toLowerCase(), network);
}
function insertApiKey(id: string, merchantId: string, key: string, env: 'test' | 'live'): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)'
  ).run(id, merchantId, null, 'p3', key.slice(0, 8), hashApiKey(key), key.slice(0, 12), 1, env);
}

async function createIntent(auth: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/v1/payment-intents`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function verify(pi: string, body: Record<string, unknown>, auth: string) {
  const res = await fetch(`${baseUrl}/v1/payment-intents/${pi}/verify`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
function row(id: string): Record<string, unknown> {
  return getDb().prepare('SELECT * FROM payment_intents WHERE id=?').get(id) as Record<string, unknown>;
}

beforeAll(() => {
  migrate();
  // STEP 5N: the create route now derives the Forwarding fee F from a LIVE Circle
  // quote. These Phase-3 tests assert the CLIENT-CONTROL invariant — F stays the
  // migration default '0' because the request body can never author it — so we
  // stub the server quote to FAIL, exercising the route's documented fail-safe
  // (F stays 0 → DIRECT) with NO live Circle I/O. Every existing assertion
  // (including P3-10 / P3-11's `forwarding_max_fee_base_units === '0'`) holds
  // UNCHANGED and UNWEAKENED.
  setForwardingQuoteForTest(async () => { throw new Error('hermetic test: no live Circle quote'); });
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctpi', 'P3 merchant');
  // The merchant holds ONLY an Arc wallet (testnet destination) — no Base wallet.
  insertWallet('sw_cctpi_arc', 'merch_cctpi', ARC_WALLET, 'arc_testnet');
  // A live-class merchant + Arc mainnet wallet for the unsupported-source cases.
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctpil', 'P3 live merchant');
  insertWallet('sw_cctpil_arc', 'merch_cctpil', ARC_WALLET, 'arc_mainnet');
  insertApiKey('ak_cctpi_test', 'merch_cctpi', 'sk_test_cctpi', 'test');
  insertApiKey('ak_cctpi_live', 'merch_cctpil', 'sk_live_cctpi', 'live');

  const app = express();
  app.use(express.json());
  app.use('/v1/payment-intents', intentsRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => {
  setForwardingQuoteForTest(null);
  server.close();
  // Release the shared bun-test module-registry DB handle BEFORE deleting so the
  // next suite reopens cleanly (matches the established afterAll convention).
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('P3-1: cross-chain intent pins source=Base Sepolia, settlement=Arc using the ONE Arc wallet', async () => {
  const r = await createIntent('sk_test_cctpi', { amount: '5.00', network: 'base_sepolia', cross_chain: true });
  expect(r.status).toBe(201);
  expect(r.body.cross_chain).toBe(true);
  expect(r.body.network).toBe('base_sepolia');            // source carried on legacy columns
  expect(r.body.source_network).toBe('base_sepolia');
  expect(r.body.settlement_network).toBe('arc_testnet');
  expect(r.body.cctp_destination_domain).toBe(26);
  expect(r.body.settlement_address).toBe(ARC_WALLET);      // pinned Arc destination
  const dbRow = row(String(r.body.id));
  expect(dbRow.is_cross_chain).toBe(1);
  expect(dbRow.settlement_network).toBe('arc_testnet');
  expect(dbRow.source_network).toBe('base_sepolia');
});

test('P3-2: cross-chain needs NO per-source wallet — merchant only had an Arc wallet (P3-1 proves it)', async () => {
  // A merchant WITHOUT any Base wallet still succeeds above; assert there is
  // indeed no base_sepolia settlement wallet for merch_p3.
  const count = (getDb().prepare("SELECT COUNT(*) c FROM settlement_wallets WHERE merchant_id='merch_cctpi' AND network='base_sepolia'").get() as { c: number }).c;
  expect(count).toBe(0);
});

test('P3-3: a non-CCTP source is refused cross-chain with a machine-readable code (never a silent fallback)', async () => {
  // arbitrum_sepolia is a testnet-class ENABLED registry network but is NOT a
  // registered CCTP source (no verified testnet domain) → the cross-chain branch
  // must refuse it as unsupported, not fabricate a route. Same test key/env, so
  // this exercises the exact code path zkSync/Celo hit without needing live mode.
  const r = await createIntent('sk_test_cctpi', { amount: '1.00', network: 'arbitrum_sepolia', cross_chain: true });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('cross_chain.unsupported_source');
  // and a non-CCTP network is never persisted as an intent.
  const c = (getDb().prepare("SELECT COUNT(*) c FROM payment_intents WHERE network='arbitrum_sepolia'").get() as { c: number }).c;
  expect(c).toBe(0);
});

test('P3-4: zkSync Era and Celo are structurally non-CCTP sources (registry fact enforced at API gate)', () => {
  // zkSync/Celo are mainnet-class, so a test key cannot reach the cross-chain
  // branch (env class rejects first) and creating them needs live mode, which is
  // intentionally NOT enabled in the shared test process. The API gate refuses
  // ANY !isCctpSource network (proven by P3-3); these assertions bind the
  // zkSync/Celo fact so the unsupported route can never be silently opened.
  expect(isCctpSource('zksync_era')).toBe(false);
  expect(isCctpSource('celo')).toBe(false);
  expect(NOT_A_CCTP_SOURCE).toContain('zksync_era');
  expect(NOT_A_CCTP_SOURCE).toContain('celo');
});

test('P3-5: Arc itself cannot be a cross-chain SOURCE (it is the destination / same-chain)', async () => {
  const r = await createIntent('sk_test_cctpi', { amount: '1.00', network: 'arc_testnet', cross_chain: true });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('cross_chain.source_is_destination');
});

test('P3-6: cross_chain without an explicit source network is rejected', async () => {
  const r = await createIntent('sk_test_cctpi', { amount: '1.00', cross_chain: true });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('invalid_network');
});

test('P3-7: SAME-CHAIN intent creation is unchanged (cross_chain absent)', async () => {
  const r = await createIntent('sk_test_cctpi', { amount: '3.00', network: 'arc_testnet' });
  expect(r.status).toBe(201);
  expect(r.body.cross_chain).toBe(false);
  expect(r.body.settlement_network).toBeUndefined();
  const dbRow = row(String(r.body.id));
  expect(dbRow.is_cross_chain).toBe(0);
  expect(dbRow.source_network).toBeNull();
  expect(dbRow.settlement_network).toBeNull();
});

test('P3-8: a cross-chain intent is REFUSED by the same-chain /verify path (fail closed)', async () => {
  const created = await createIntent('sk_test_cctpi', { amount: '2.00', network: 'base_sepolia', cross_chain: true });
  const pi = String(created.body.id);
  const chain = Number(created.body.chain_id);
  const v = await verify(pi, { tx_hash: '0x' + 'ab'.repeat(32), chain_id: chain }, 'sk_test_cctpi');
  expect(v.status).toBe(400);
  expect(v.body.code).toBe('cross_chain.wrong_verify_endpoint');
});

test('P3-9: unsupported sources are NEVER persisted as intents (no silent fallback)', async () => {
  const before = (getDb().prepare("SELECT COUNT(*) c FROM payment_intents WHERE network='arbitrum_sepolia'").get() as { c: number }).c;
  await createIntent('sk_test_cctpi', { amount: '1.00', network: 'arbitrum_sepolia', cross_chain: true });
  const after = (getDb().prepare("SELECT COUNT(*) c FROM payment_intents WHERE network='arbitrum_sepolia'").get() as { c: number }).c;
  expect(after).toBe(before);
});

// ── STEP 4B-2 / TEST 8 — the approved Forwarding fee is SERVER-OWNED ───────
// payment_intents.forwarding_max_fee_base_units must NEVER be settable through
// the checkout/client body, URL, or metadata. The intent-creation INSERT omits
// the column entirely, so any client-supplied value is ignored and the persisted
// approved fee is the migration default '0'. Only a future server-side quote may
// populate it. This proves the invariant CLIENT CANNOT CHOOSE F.
test('P3-10: client cannot set the server-authored Forwarding fee (top-level body)', async () => {
  const r = await createIntent('sk_test_cctpi', {
    amount: '5.00', network: 'base_sepolia', cross_chain: true,
    forwarding_max_fee_base_units: '999999',
  });
  expect(r.status).toBe(201);
  const dbRow = row(String(r.body.id));
  // The client value is ignored — the persisted approved fee stays the default '0'.
  expect(dbRow.forwarding_max_fee_base_units).toBe('0');
  // The response must not echo an attacker-chosen fee either.
  expect(JSON.stringify(r.body)).not.toContain('999999');
});

test('P3-11: client cannot smuggle the fee through metadata either', async () => {
  const r = await createIntent('sk_test_cctpi', {
    amount: '5.00', network: 'base_sepolia', cross_chain: true,
    metadata: { forwarding_max_fee_base_units: '123456', fee: '123456' },
  });
  expect(r.status).toBe(201);
  const dbRow = row(String(r.body.id));
  expect(dbRow.forwarding_max_fee_base_units).toBe('0');
});
