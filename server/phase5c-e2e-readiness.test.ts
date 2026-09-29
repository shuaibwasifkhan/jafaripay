/**
 * JafariPay — Phase 5C tests: Base Sepolia real-E2E READINESS + safe-execution audit.
 *
 * Phase 5C is an audit phase, not an implementation phase. Product code is NOT
 * modified here. These tests prove the two things Phase 5C must establish before
 * any human attempts a real Base Sepolia payment:
 *
 *   C/D — a Base Sepolia Payment Intent created through the REAL HTTP API
 *         carries a complete, correct, immutable network snapshot, and the
 *         checkout surface derives exclusively from that snapshot.
 *   G   — the eight mandated cross-network / cross-asset negative cases all
 *         fail closed, so no transaction from the wrong chain, the wrong USDC
 *         contract, the wrong recipient or the wrong amount can ever satisfy an
 *         intent, and no transaction can be replayed.
 *   +   — the non-custodial invariant holds: the payment runtime contains no
 *         private-key, seed-phrase, keystore or transaction-signing code path.
 *         JafariPay can only ever OBSERVE a payment the user's wallet signed.
 *
 * Blockchain I/O is confined to a local JSON-RPC stub and narrowly-mocked
 * provider read methods; the real route handlers and the real verifyPayment
 * rules run unmodified. Nothing here is, or claims to be, a real E2E payment.
 * Base MAINNET is now registered by the shared seed (MASTER PHASE), but this
 * 5C suite never performs or claims a real Base Mainnet payment — its money
 * path stays confined to the local JSON-RPC stub on testnet-class networks.
 *
 * Facts are verified against OFFICIAL sources, never memory:
 *  • Base Sepolia chain id 84532 / RPC / explorer — Base + viem chain definitions.
 *  • USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e, 6 decimals — Circle
 *    "USDC contract addresses" testnet table.
 */
import { test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_phase5c_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'phase5c-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');
const { CSP_CONNECT_SRC } = await import('./lib/csp.ts');
const { CIRCLE_INVENTORY, enabledEvmRows } = await import('./db/networks.ts');
const checkoutRouter = (await import('./api/checkout.ts')).default;
const intentsRouter = (await import('./api/payment-intents.ts')).default;

// ── Officially-verified facts ───────────────────────────────────────────────
const BS = 'base_sepolia';
const BS_CHAIN = 84532;
const BS_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Circle official Base Sepolia USDC
const BS_SETTLEMENT = '0x5a7bd1b2a4b2c2d3e4f5061728394a5b6c7d8e9f'; // dedicated Base Sepolia wallet
const ARC_TESTNET = 'arc_testnet';
const ARC_CHAIN = 5042002;
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const ARC_SETTLEMENT = '0x9c1f3a5e7d2b4680a1c3e5f7092b4d6e8f0a1c3d'; // dedicated Arc Testnet wallet
const FOREIGN = '0xdead000000000000000000000000000000000000';
const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const ORDER_REF = 'PHASE5C-BASE-SEPOLIA-E2E-001';
const AMOUNT = '1.00';
const AMOUNT_BASE = '1000000'; // 1.00 USDC, 6 decimals
const KEY = 'sk_test_5c';

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

const hashApiKey = (key: string) => createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

let seq = 0;
function txHash(): string { seq++; return '0x' + seq.toString(16).padStart(64, '0'); }

function transferLog(contract: string, to: string, amount: bigint) {
  const topics = encodeEventTopics({
    abi: [TRANSFER], eventName: 'Transfer',
    args: { from: SENDER as `0x${string}`, to: to as `0x${string}` },
  });
  const data = encodeAbiParameters([{ type: 'uint256' }], [amount]);
  return { address: contract.toLowerCase(), topics: topics as string[], data, logIndex: 0 };
}

/** Run the REAL verifyPayment rules against a synthetic receipt (no network). */
function mockReceipt(opts: {
  contract?: string; to?: string; amount?: bigint; blockNumber?: bigint; head?: bigint;
} = {}) {
  const contract = opts.contract ?? BS_USDC;
  const to = opts.to ?? BS_SETTLEMENT.toLowerCase();
  const amount = opts.amount ?? 1_000_000n;
  const blockNumber = opts.blockNumber ?? 100n;
  const head = opts.head ?? 200n; // well above required_confirmations=3
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockImplementation(((requested: string) => Promise.resolve({
    txHash: requested, status: 'success' as const, blockNumber,
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)), from: SENDER, to: contract,
    logs: [transferLog(contract, to, amount)],
  })) as never);
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockResolvedValue(head as never);
}

async function createIntent(body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/v1/payment-intents`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
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

async function checkoutMeta(piId: string) {
  const res = await fetch(`${baseUrl}/checkout/${piId}`);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const piRow = (id: string) => getDb().prepare('SELECT * FROM payment_intents WHERE id=?').get(id) as Record<string, unknown>;
const paymentsFor = (piId: string) =>
  getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').all(piId) as { id: string }[];

/** Create a Base Sepolia intent and return its id (helper for the negative cases). */
async function newBsIntent(orderRef = `${ORDER_REF}-NEG`) {
  const r = await createIntent({ amount: AMOUNT, currency: 'USDC', network: BS, order_id: orderRef });
  expect(r.status).toBe(201);
  return String(r.body.id);
}

beforeAll(() => {
  migrate(); // applies the Phase 5B Base Sepolia registry seed
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_5c', 'Phase5C Merchant');
  // Per-network settlement wallets — deliberately DIFFERENT addresses, never reused.
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_5c_bs', 'merch_5c', BS_SETTLEMENT.toLowerCase(), BS);
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_5c_at', 'merch_5c', ARC_SETTLEMENT.toLowerCase(), ARC_TESTNET);
  db.prepare('INSERT OR REPLACE INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)')
    .run('ak_5c_test', 'merch_5c', null, 'p5c', KEY.slice(0, 8), hashApiKey(KEY), KEY.slice(0, 12), 1, 'test');

  const app = express();
  app.use(express.json());
  app.use('/checkout', checkoutRouter);
  app.use('/v1/payment-intents', intentsRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(() => {
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockRestore();
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockRestore();
});

afterAll(() => {
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    const p = TMP_DB + suffix;
    try { if (existsSync(p)) rmSync(p); } catch { /* Windows handle may linger */ }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// C. PAYMENT INTENT READINESS — real API, named test order id, small amount.
// ═══════════════════════════════════════════════════════════════════════════

test('C: existing API creates a Base Sepolia test intent with a complete verified snapshot', async () => {
  const before = Date.now();
  const r = await createIntent({
    amount: AMOUNT, currency: 'USDC', network: BS, order_id: ORDER_REF,
    description: 'Phase 5C readiness intent',
  });
  expect(r.status).toBe(201);

  // network / chain / asset / amount / recipient / state — all pinned by the server
  expect(r.body.network).toBe(BS);
  expect(r.body.chain_id).toBe(BS_CHAIN);
  expect(r.body.usdc_address).toBe(BS_USDC);
  expect(r.body.amount_base_units).toBe(AMOUNT_BASE);
  expect(r.body.currency).toBe('USDC');
  expect(r.body.settlement_address).toBe(BS_SETTLEMENT.toLowerCase());
  expect(r.body.order_id).toBe(ORDER_REF);
  expect(r.body.status).toBe('requires_payment'); // correct initial state

  // correct expiration: a real future deadline, server-assigned
  const created = Number(r.body.created_at);
  const expires = Number(r.body.expires_at);
  expect(created * 1000).toBeGreaterThanOrEqual(before - 5000);
  expect(expires).toBeGreaterThan(created);
  expect(expires * 1000 - Date.now()).toBeGreaterThan(60_000); // still payable

  // the checkout URL points at this intent
  expect(String(r.body.checkout_url)).toContain(String(r.body.id));

  // persisted row == API response (nothing is client-controlled)
  const row = piRow(String(r.body.id));
  expect(row.network).toBe(BS);
  expect(row.chain_id).toBe(BS_CHAIN);
  expect(row.usdc_address).toBe(BS_USDC);
  expect(row.amount_base_units).toBe(AMOUNT_BASE);
  expect(row.settlement_address).toBe(BS_SETTLEMENT.toLowerCase());
  expect(row.status).toBe('requires_payment');
  expect(row.environment).toBe('test');
  expect(row.expires_at).toBe(expires);

  // no payment exists yet, and no state was altered manually
  expect(paymentsFor(String(r.body.id))).toHaveLength(0);
  const events = getDb().prepare('SELECT event_type FROM payment_events WHERE payment_intent_id=?').all(String(r.body.id)) as { event_type: string }[];
  expect(events.map((e) => e.event_type)).toEqual(['payment.created']);
});

// ═══════════════════════════════════════════════════════════════════════════
// D. CHECKOUT READINESS — checkout derives only from the pinned intent.
// ═══════════════════════════════════════════════════════════════════════════

test('D1: checkout identifies Base Sepolia from the intent snapshot (not from the client)', async () => {
  const id = await newBsIntent(`${ORDER_REF}-D1`);
  const meta = await checkoutMeta(id);
  expect(meta.status).toBe(200);
  expect(meta.body.network).toBe(BS);
  expect(meta.body.chain_id).toBe(BS_CHAIN);
  expect(meta.body.usdc_address).toBe(BS_USDC);
  expect(meta.body.amount_base_units).toBe(AMOUNT_BASE);
  expect(meta.body.settlement_address).toBe(BS_SETTLEMENT.toLowerCase());
  // explorer resolves from registry chain facts for THIS chain, never a hardcoded Arc host
  const explorer = (getDb().prepare('SELECT explorer_base FROM network_configs WHERE network=?').get(BS) as { explorer_base: string }).explorer_base;
  expect(explorer).toBe('https://sepolia.basescan.org');
  expect(explorer).not.toContain('arc');
});

test('D10: verify requires chain_id 84532; missing or foreign chain_id is rejected before any verification', async () => {
  const id = await newBsIntent(`${ORDER_REF}-D10`);
  mockReceipt();

  const missing = await checkoutVerify(id, txHash()); // no chain_id at all
  expect(missing.status).toBe(400);
  expect(missing.body.code).toBe('wrong_network');
  expect(piRow(id).status).toBe('requires_payment'); // untouched, pre-verification rejection

  const arcChain = await checkoutVerify(id, txHash(), ARC_CHAIN); // Arc chain id on a Base Sepolia intent
  expect(arcChain.status).toBe(400);
  expect(arcChain.body.code).toBe('wrong_network');
  expect(piRow(id).status).toBe('requires_payment');

  const mainnetChain = await checkoutVerify(id, txHash(), 8453); // Base MAINNET on a testnet intent
  expect(mainnetChain.status).toBe(400);
  expect(piRow(id).status).toBe('requires_payment');

  const ok = await checkoutVerify(id, txHash(), BS_CHAIN);
  expect(ok.status).toBe(200);
  expect(ok.body.status).toBe('succeeded');
  expect(paymentsFor(id)).toHaveLength(1);
});

test('D8/D9: no Arc fallback and no Base Mainnet fallback is even addressable', async () => {
  // A Base Sepolia slug variant that would fall back to Arc is not selectable.
  const arcish = await createIntent({ amount: AMOUNT, currency: 'USDC', network: 'arc_testnet', order_id: `${ORDER_REF}-FALLBACK` });
  expect(arcish.status).toBe(201);
  expect(arcish.body.chain_id).toBe(ARC_CHAIN); // explicit selection, NOT a silent fallback
  expect(arcish.body.usdc_address).toBe(ARC_USDC);

  // Base Mainnet is now REGISTERED + ENABLED, but it is LIVE-class. A TEST key
  // creating a base_mainnet intent is therefore refused by the environment-class
  // gate (not by "unknown network"). The security property is unchanged: a test
  // key can NEVER open a mainnet money path — only the rejection code moved.
  const baseMainnet = await createIntent({ amount: AMOUNT, currency: 'USDC', network: 'base_mainnet', order_id: `${ORDER_REF}-NO-MAINNET` });
  expect(baseMainnet.status).toBe(400);
  expect(baseMainnet.body.code).toBe('environment_network_mismatch');
});

// ═══════════════════════════════════════════════════════════════════════════
// G. MANDATED NEGATIVE / SECURITY CASES (1–8)
// ═══════════════════════════════════════════════════════════════════════════

test('G1: Base Sepolia intent + Arc USDC transaction => REJECT', async () => {
  const id = await newBsIntent(`${ORDER_REF}-G1`);
  // a genuine-looking Arc Testnet USDC transfer, right amount, right recipient
  mockReceipt({ contract: ARC_USDC, to: BS_SETTLEMENT.toLowerCase(), amount: 1_000_000n });
  const r = await checkoutVerify(id, txHash(), BS_CHAIN);
  expect(r.status).toBe(422);
  expect(r.body.status).toBe('failed');
  expect(String(r.body.error)).toMatch(/USDC contract|Transfer/i);
  expect(paymentsFor(id)).toHaveLength(0);
});

test('G2: Arc intent + Base Sepolia USDC transaction => REJECT', async () => {
  const created = await createIntent({ amount: AMOUNT, currency: 'USDC', network: ARC_TESTNET, order_id: `${ORDER_REF}-G2` });
  expect(created.status).toBe(201);
  const id = String(created.body.id);
  expect(created.body.chain_id).toBe(ARC_CHAIN);
  expect(created.body.usdc_address).toBe(ARC_USDC);
  expect(created.body.settlement_address).toBe(ARC_SETTLEMENT.toLowerCase());

  // a genuine-looking Base Sepolia USDC transfer paid to the Arc settlement wallet
  mockReceipt({ contract: BS_USDC, to: ARC_SETTLEMENT.toLowerCase(), amount: 1_000_000n });
  const r = await checkoutVerify(id, txHash(), ARC_CHAIN);
  expect(r.status).toBe(422);
  expect(r.body.status).toBe('failed');
  expect(paymentsFor(id)).toHaveLength(0);
});

test('G3: Base Sepolia intent + wrong USDC contract => REJECT', async () => {
  const id = await newBsIntent(`${ORDER_REF}-G3`);
  mockReceipt({ contract: FOREIGN });
  const r = await checkoutVerify(id, txHash(), BS_CHAIN);
  expect(r.status).toBe(422);
  expect(paymentsFor(id)).toHaveLength(0);
});

test('G4: Base Sepolia intent + wrong recipient => REJECT', async () => {
  const id = await newBsIntent(`${ORDER_REF}-G4`);
  mockReceipt({ to: ARC_SETTLEMENT.toLowerCase() }); // correct contract + amount, wrong recipient
  const r = await checkoutVerify(id, txHash(), BS_CHAIN);
  expect(r.status).toBe(422);
  expect(String(r.body.error)).toMatch(/No Transfer to settlement/i);
  expect(paymentsFor(id)).toHaveLength(0);
});

test('G5: Base Sepolia intent + wrong amount => REJECT', async () => {
  const id = await newBsIntent(`${ORDER_REF}-G5`);
  mockReceipt({ amount: 999_999n }); // 1 base-unit short — exact-match rule
  const r = await checkoutVerify(id, txHash(), BS_CHAIN);
  expect(r.status).toBe(422);
  expect(paymentsFor(id)).toHaveLength(0);
});

test('G6: Base Sepolia intent + wrong chain_id => REJECT before verification', async () => {
  const id = await newBsIntent(`${ORDER_REF}-G6`);
  mockReceipt(); // receipt would otherwise be perfect
  const r = await checkoutVerify(id, txHash(), ARC_CHAIN);
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('wrong_network');
  expect(piRow(id).status).toBe('requires_payment');
  expect(paymentsFor(id)).toHaveLength(0);
});

test('G7: Base Sepolia transaction below the required 3 confirmations => NOT SUCCEEDED', async () => {
  const id = await newBsIntent(`${ORDER_REF}-G7`);
  mockReceipt({ blockNumber: 100n, head: 101n }); // 2 confirmations < 3
  const r = await checkoutVerify(id, txHash(), BS_CHAIN);
  expect(r.body.status).not.toBe('succeeded');
  expect(paymentsFor(id)).toHaveLength(0);
  // the same receipt becomes creditable only once the finality gate is satisfied
  const id2 = await newBsIntent(`${ORDER_REF}-G7B`);
  mockReceipt({ blockNumber: 100n, head: 102n }); // exactly 3 confirmations
  const ok = await checkoutVerify(id2, txHash(), BS_CHAIN);
  expect(ok.body.status).toBe('succeeded');
});

test('G8: replaying an already-recorded Base Sepolia transaction => REJECT (existing semantics)', async () => {
  const hash = txHash();
  const first = await newBsIntent(`${ORDER_REF}-G8A`);
  mockReceipt();
  const ok = await checkoutVerify(first, hash, BS_CHAIN);
  expect(ok.body.status).toBe('succeeded');
  expect(paymentsFor(first)).toHaveLength(1);

  // same tx hash + same network against a DIFFERENT intent: duplicate protection
  const second = await newBsIntent(`${ORDER_REF}-G8B`);
  const replay = await checkoutVerify(second, hash, BS_CHAIN);
  expect(replay.status).toBe(422);
  expect(String(replay.body.error)).toMatch(/already recorded|replay/i);
  expect(paymentsFor(second)).toHaveLength(0);

  // re-submitting to the already-succeeded intent is idempotent, never a second payment
  const again = await checkoutVerify(first, hash, BS_CHAIN);
  expect(again.body.status).toBe('succeeded');
  expect(paymentsFor(first)).toHaveLength(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Non-custodial invariant + Base Mainnet hard stop + Arc regression.
// ═══════════════════════════════════════════════════════════════════════════

test('Safety: the payment runtime contains no private-key / signer / custody code path', () => {
  const runtimeFiles = [
    'blockchain/arc-provider.ts', 'api/checkout.ts', 'api/payment-intents.ts',
    'api/payments.ts', 'api/settlement-wallets.ts', 'db/schema.ts', 'index.ts',
  ];
  const forbidden = /privateKey|PRIVATE_KEY|mnemonic|seed\s?phrase|keystore|signTransaction|signMessage|createWalletClient|hdWallet/i;
  for (const f of runtimeFiles) {
    const src = readFileSync(join(import.meta.dir, f), 'utf8');
    expect(forbidden.test(src), `${f} must not contain signer/private-key code`).toBe(false);
  }
});

test('Safety: registry never auto-derives a settlement address — wallet is stored per network', () => {
  const rows = getDb().prepare('SELECT network,address FROM settlement_wallets WHERE merchant_id=?').all('merch_5c') as { network: string; address: string }[];
  const byNet = new Map(rows.map((r) => [r.network, r.address]));
  expect(byNet.get(BS)).toBe(BS_SETTLEMENT.toLowerCase());
  expect(byNet.get(ARC_TESTNET)).toBe(ARC_SETTLEMENT.toLowerCase());
  expect(byNet.get(BS)).not.toBe(byNet.get(ARC_TESTNET)); // Arc wallet is never reused for Base Sepolia
});

// INTENTIONALLY UPDATED BY THE MASTER EXPANSION: the enabled set is exactly the
// inventory-approved Circle-native-USDC set — DERIVED from the single source of
// truth so this guard can never drift from the registry it validates (PHASE 19).
test('J: enabled set is exactly the approved Circle-native-USDC payable networks; Base Mainnet is live-class and CSP stays curated', () => {
  const enabled = (getDb().prepare('SELECT network,chain_id FROM network_configs WHERE is_enabled=1 ORDER BY network').all() as { network: string; chain_id: number }[]);
  expect(enabled.map((e) => e.network)).toEqual(enabledEvmRows().map((n) => n.slug).sort());
  expect(enabled.map((e) => e.chain_id).sort((a, b) => a - b)).toEqual(enabledEvmRows().map((n) => n.chainId as number).sort((a, b) => a - b));

  // Ethereum stays ENS-only: chain id 1 is NEVER an enabled payable row.
  expect(getDb().prepare('SELECT id FROM network_configs WHERE chain_id=1 AND is_enabled=1').get()).toBeNull();
  // Every audited-but-not-enabled EVM chain id (held Monad/Morph/…, special-handling
  // Sonic/HyperEVM) and every non-enabled slug must have NO enabled row either.
  for (const n of CIRCLE_INVENTORY.filter((x) => x.status !== 'IMPLEMENTED_ENABLED')) {
    expect(getDb().prepare('SELECT id FROM network_configs WHERE network=? AND is_enabled=1').get(n.slug)).toBeNull();
    if (n.evm && n.chainId != null) {
      expect(getDb().prepare('SELECT id FROM network_configs WHERE chain_id=? AND is_enabled=1').get(n.chainId)).toBeNull();
    }
  }

  // Base Mainnet is now a registered, enabled, LIVE-class network on finalized policy.
  const bm = getDb().prepare("SELECT chain_id,is_enabled,is_testnet,finality_mode FROM network_configs WHERE network='base_mainnet'").get() as { chain_id: number; is_enabled: number; is_testnet: number; finality_mode: string };
  expect(bm.chain_id).toBe(8453);
  expect(bm.is_enabled).toBe(1);
  expect(bm.is_testnet).toBe(0);
  expect(bm.finality_mode).toBe('finalized');

  // CSP allows ONLY curated first-party hosts. Base Mainnet adds the single exact
  // `https://mainnet.base.org` — never a wildcard, never a third-party Base
  // endpoint (base.rpc.flow.com), never bare `https://base.org`. The pre-existing
  // `https://*.arc.io` / `https://*.arc.network` / `https://*.circle.com` entries
  // are intentional service domains, not protocol wildcards.
  expect(CSP_CONNECT_SRC).toContain('https://sepolia.base.org');
  expect(CSP_CONNECT_SRC).toContain('https://mainnet.base.org');
  for (const src of CSP_CONNECT_SRC) {
    expect(src).not.toBe('*');
    expect(src).not.toBe('https://*');
    expect(src).not.toBe('http://*');
    expect(src).not.toBe('https://*.base.org');
    expect(/base\.rpc\.flow\.com|^https:\/\/base\.org$/.test(src), `unexpected Base host ${src}`).toBe(false);
  }
  // exactly two Base origins — both curated RPCs (testnet + mainnet), nothing broader.
  expect(CSP_CONNECT_SRC.filter((h) => h.includes('base')).sort()).toEqual(['https://mainnet.base.org', 'https://sepolia.base.org']);

  // MASTER EXPANSION CSP guard: every enabled network's curated RPC origin is
  // allowlisted EXACTLY (no wildcard, no path-level entry), and no held/
  // special-handling RPC host ever crept into the CSP list. Only the EXACT
  // entries are origin-parsed — the pre-existing service wildcards ('self',
  // *.arc.io, *.arc.network, *.circle.com) are intentional and preserved.
  const exactEntries = CSP_CONNECT_SRC.filter((h) => !h.includes('*') && !h.startsWith("'"));
  // The ONLY wildcards allowed are the three pre-existing first-party service
  // domains — never a generic one, and they cover Arc/Circle hosts only.
  const serviceWildcards = CSP_CONNECT_SRC.filter((h) => h.includes('*')).sort();
  expect(serviceWildcards).toEqual(['https://*.arc.io', 'https://*.arc.network', 'https://*.circle.com']);
  const coveredByOrigin = (origin: string) => {
    const u = new URL(origin);
    return (
      exactEntries.includes(u.origin) ||
      serviceWildcards.some((w) => u.protocol === 'https:' && u.hostname.endsWith(w.slice(w.indexOf('*') + 1)))
    );
  };
  for (const n of enabledEvmRows()) {
    const u = new URL(n.rpc as string);
    expect(coveredByOrigin(u.origin), `missing curated host for ${n.slug}`).toBe(true);
    // CSP entries are always bare origins — connect-src does not govern paths
    // (Avalanche's official endpoint carries /ext/bc/C/rpc on the same host).
    for (const e of exactEntries) expect(new URL(e).pathname.replace(/\/$/, ''), `path-level CSP entry ${e}`).toBe('');
  }
  for (const n of CIRCLE_INVENTORY.filter((x) => x.status !== 'IMPLEMENTED_ENABLED' && x.rpc != null)) {
    const rpc = n.rpc as string;
    // A held/special/non-EVM RPC must never be reachable via ANY CSP entry —
    // neither an exact host nor one of the intentional service wildcards.
    expect(CSP_CONNECT_SRC, `held-chain host must not be allowlisted: ${n.slug}`).not.toContain(rpc);
    expect(coveredByOrigin(new URL(rpc).origin), `CSP covers held chain ${n.slug}: ${rpc}`).toBe(false);
  }

  // No settlement wallet uses a bogus bare 'base' slug (only real registry slugs).
  const wallets = getDb().prepare("SELECT COUNT(*) c FROM settlement_wallets WHERE network='base'").get() as { c: number };
  expect(wallets.c).toBe(0);
});

test('Regression: Arc rows are untouched and Arc verification still requires 0 confirmations', () => {
  const arcTestnet = getDb().prepare('SELECT * FROM network_configs WHERE network=?').get(ARC_TESTNET) as Record<string, unknown>;
  expect(arcTestnet.chain_id).toBe(ARC_CHAIN);
  expect(arcTestnet.usdc_address).toBe(ARC_USDC);
  expect(arcTestnet.usdc_decimals).toBe(6);
  expect(arcTestnet.is_testnet).toBe(1);
  expect(arcTestnet.required_confirmations).toBe(0);

  const arcMainnet = getDb().prepare('SELECT * FROM network_configs WHERE network=?').get('arc_mainnet') as Record<string, unknown>;
  expect(arcMainnet.chain_id).toBe(5042);
  expect(arcMainnet.usdc_address).toBe(ARC_USDC);
  expect(arcMainnet.is_testnet).toBe(0);

  // a Base Sepolia receipt can never satisfy an Arc intent, and vice versa
  const cfg = arc.getNetworkConfig(BS);
  expect(cfg.chainId).toBe(BS_CHAIN);
  expect(cfg.requiredConfirmations).toBe(3);
  expect(cfg.usdcAddress).toBe(BS_USDC);
  expect(arc.getNetworkConfig(ARC_TESTNET).requiredConfirmations).toBe(0);
});

test('Readiness: migrate() is idempotent — re-running it does not duplicate or flip the Base Sepolia row', () => {
  migrate();
  const rows = getDb().prepare("SELECT * FROM network_configs WHERE network='base_sepolia'").all() as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  expect(rows[0].chain_id).toBe(BS_CHAIN);
  expect(rows[0].is_enabled).toBe(1);
  expect(rows[0].required_confirmations).toBe(3);
});
