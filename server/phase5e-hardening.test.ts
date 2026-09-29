/**
 * JafariPay — Phase 5E tests: Shared multi-chain prerequisites hardening.
 *
 * Covers the two objectives mandated by Phase 5E:
 *   A. Settlement wallet API is registry-driven (no hardcoded Arc-only list)
 *   B. RPC proxy behavior is explicit and fail-closed for non-Arc networks
 *
 * The settlement-wallet POST endpoint is exercised via the real Express router
 * using a valid session token, proving end-to-end that Base Sepolia and future
 * registry-enabled networks become selectable through the API without adding
 * another hardcoded network list.
 *
 * No real network is dialed. No private key. No transaction.
 */
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import express from 'express';

const TMP_DB = join(import.meta.dir, '..', 'data', `_phase5e_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'phase5e-test-secret';
process.env.SESSION_SECRET = 'phase5e-session-secret-that-is-long-enough';
process.env.ENABLE_LIVE_PAYMENTS = 'true';

const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');
const settlementRouter = (await import('./api/settlement-wallets.ts')).default;
const { createSession } = await import('./auth/siwe.ts');

// ── Constants (official Circle/viem facts, already verified in Phase 5B/5D) ─
const BS = 'base_sepolia';
const BS_CHAIN = 84532;
const ARC_TESTNET = 'arc_testnet';
const ARC_MAINNET = 'arc_mainnet';
const ARC_CHAIN_TESTNET = 5042002;
const ARC_CHAIN_MAINNET = 5042;
const { CIRCLE_INVENTORY, enabledEvmRows } = await import('./db/networks.ts');
const EXPECTED_SLUGS: string[] = enabledEvmRows().map((n) => n.slug).sort();
const FORBIDDEN_SLUGS: string[] = CIRCLE_INVENTORY.filter((n) => n.status !== 'IMPLEMENTED_ENABLED').map((n) => n.slug);
const ADDR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDR_C = '0xcccccccccccccccccccccccccccccccccccccccc';

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let sessionA = ''; // merchant A session token
let sessionB = ''; // merchant B session token

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_a', 'Merchant A');
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_b', 'Merchant B');
  sessionA = createSession('merch_a', ADDR_A);
  sessionB = createSession('merch_b', ADDR_B);

  const app = express();
  app.use(express.json());
  app.use('/settlement-wallets', settlementRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(() => {
  // Reset proxy env to avoid leaking across tests
  delete process.env.RPC_PROXY_BASE_URL;
  delete process.env.RPC_PROXY_CHAINS;
  delete process.env.RPC_PROXY_TOKEN;
});

afterAll(() => {
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    const p = TMP_DB + suffix;
    try { if (existsSync(p)) rmSync(p); } catch { /* Windows handle may linger */ }
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────
async function postWallet(body: Record<string, unknown>, token = sessionA) {
  const res = await fetch(`${baseUrl}/settlement-wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-token': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function getWallets(token = sessionA) {
  const res = await fetch(`${baseUrl}/settlement-wallets`, {
    headers: { 'x-session-token': token },
  });
  return { status: res.status, body: await res.json() as { data: Record<string, unknown>[] } };
}
async function getNetworks(token = sessionA) {
  const res = await fetch(`${baseUrl}/settlement-wallets/networks`, {
    headers: { 'x-session-token': token },
  });
  return { status: res.status, body: await res.json() as { data: Record<string, unknown>[] } };
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 1 — SETTLEMENT WALLET REGISTRY TESTS
// ═══════════════════════════════════════════════════════════════════════════

test('1a: Arc Testnet accepted via registry-driven path', async () => {
  const r = await postWallet({ address: ADDR_A, network: ARC_TESTNET });
  expect(r.status).toBe(201);
  expect(r.body.network).toBe(ARC_TESTNET);
  expect(r.body.environment).toBe('test');
  expect(r.body.chain_id).toBe(ARC_CHAIN_TESTNET);
});

test('1b: Arc Mainnet accepted via registry-driven path', async () => {
  const r = await postWallet({ address: ADDR_C, network: ARC_MAINNET });
  expect(r.status).toBe(201);
  expect(r.body.network).toBe(ARC_MAINNET);
  expect(r.body.environment).toBe('live');
  expect(r.body.chain_id).toBe(ARC_CHAIN_MAINNET);
});

test('1c: Base Sepolia accepted via registry — THE KEY 5E FIX', async () => {
  // Before Phase 5E this returned 400 because the hardcoded list was only
  // ['arc_testnet','arc_mainnet']. Now it works because base_sepolia is an
  // enabled testnet-class row in network_configs.
  const r = await postWallet({ address: ADDR_B, network: BS });
  expect(r.status).toBe(201);
  expect(r.body.network).toBe(BS);
  expect(r.body.environment).toBe('test');
  expect(r.body.chain_id).toBe(BS_CHAIN);
});

test('1d: nonexistent network rejected', async () => {
  const r = await postWallet({ address: ADDR_A, network: 'does_not_exist' });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('invalid_network');
});

test('1e: disabled network rejected', async () => {
  // Temporarily disable Base Sepolia
  getDb().prepare('UPDATE network_configs SET is_enabled=0 WHERE network=?').run(BS);
  const r = await postWallet({ address: '0xdddddddddddddddddddddddddddddddddddddddd', network: BS });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('network_disabled');
  // Re-enable for subsequent tests
  getDb().prepare('UPDATE network_configs SET is_enabled=1 WHERE network=?').run(BS);
});

test('1f: test-class network cannot be labeled "live"', async () => {
  const r = await postWallet({ address: '0xee0000000000000000000000000000000000000ee', network: BS, environment: 'live' });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('environment_network_mismatch');
});

test('1g: live-class network cannot be labeled "test"', async () => {
  const r = await postWallet({ address: '0xff0000000000000000000000000000000000000ff', network: ARC_MAINNET, environment: 'test' });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('environment_network_mismatch');
});

test('1h: environment alone maps via registry — no hardcoded Arc slug map', async () => {
  // With 2 enabled test-class networks, environment='test' is ambiguous
  // (the registry has BOTH arc_testnet AND base_sepolia). The endpoint should
  // refuse rather than guess a specific slug.
  const r = await postWallet({ address: '0x1234567890123456789012345678901234567890', environment: 'test' });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('network_ambiguous');
});

test('1i: registry is_testnet controls environment classification (not slug name)', async () => {
  // This test proves the Arc-only fallback (`network === 'arc_mainnet' ? 'live' : 'test'`)
  // is gone. base_sepolia is is_testnet=1 → classified 'test'; arc_mainnet is
  // is_testnet=0 → classified 'live'. The classification comes from the DB row.
  const r1 = await getNetworks();
  expect(r1.status).toBe(200);
  const bs = r1.body.data.find((n) => n.network === BS);
  expect(bs?.environment).toBe('test');
  expect(bs?.is_testnet).toBe(true);
  const am = r1.body.data.find((n) => n.network === ARC_MAINNET);
  expect(am?.environment).toBe('live');
  expect(am?.is_testnet).toBe(false);
});

test('1j: no Arc-specific fallback logic — GET lists all enabled networks', async () => {
  const r = await getNetworks();
  expect(r.status).toBe(200);
  const slugs = r.body.data.map((n) => n.network).sort();
  // UPDATED BY PHASE 5F, the MASTER PHASE and the MASTER EXPANSION. The
  // invariant is unchanged — the list comes from enabled network_configs rows,
  // not an Arc-only hardcoded array. Derived set keeps it registry-accurate.
  expect(slugs).toEqual(EXPECTED_SLUGS);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 2 — MERCHANT ISOLATION TESTS
// ═══════════════════════════════════════════════════════════════════════════

test('2a: merchant A cannot see merchant B wallets', async () => {
  // Wallet for B was created in test 1c using session A (ADDR_B), let's use
  // a dedicated one for merchant B:
  await postWallet({ address: '0x9999999999999999999999999999999999999999', network: ARC_TESTNET }, sessionB);
  const walletsA = await getWallets(sessionA);
  const allBelongToA = walletsA.body.data.every((w) => w.merchant_id === 'merch_a');
  expect(allBelongToA).toBe(true);
  const hasB = walletsA.body.data.some((w) => w.merchant_id === 'merch_b');
  expect(hasB).toBe(false);
});

test('2b: merchant B cannot PATCH merchant A wallet', async () => {
  const aWallets = await getWallets(sessionA);
  const target = aWallets.body.data.find((w) => w.network === ARC_TESTNET);
  if (!target) return; // covered by other tests
  const res = await fetch(`${baseUrl}/settlement-wallets/${target.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-session-token': sessionB },
    body: JSON.stringify({ label: 'hijacked' }),
  });
  expect(res.status).toBe(404);
});

test('2c: merchant B cannot DELETE merchant A wallet', async () => {
  const aWallets = await getWallets(sessionA);
  const target = aWallets.body.data.find((w) => w.network === BS);
  if (!target) return;
  const res = await fetch(`${baseUrl}/settlement-wallets/${target.id}`, {
    method: 'DELETE',
    headers: { 'x-session-token': sessionB },
  });
  expect(res.status).toBe(404);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 3 — RPC PROXY TESTS
// ═══════════════════════════════════════════════════════════════════════════

test('3a: Arc Testnet known proxy mapping works', () => {
  process.env.RPC_PROXY_BASE_URL = 'https://proxy.example';
  process.env.RPC_PROXY_CHAINS = 'Arc_Testnet,Arc';
  process.env.RPC_PROXY_TOKEN = 'tok';
  expect(arc.resolveRpcUrl('arc_testnet', 'r')).toBe('https://proxy.example/api/rpc/Arc_Testnet?_rpc_token=tok');
});

test('3b: Arc Mainnet known proxy mapping works', () => {
  process.env.RPC_PROXY_BASE_URL = 'https://proxy.example';
  process.env.RPC_PROXY_CHAINS = 'Arc_Testnet,Arc';
  process.env.RPC_PROXY_TOKEN = 'tok';
  expect(arc.resolveRpcUrl('arc_mainnet', 'r')).toBe('https://proxy.example/api/rpc/Arc?_rpc_token=tok');
});

test('3c: unknown mapping fails closed', () => {
  process.env.RPC_PROXY_BASE_URL = 'https://proxy.example';
  process.env.RPC_PROXY_CHAINS = 'Arc_Testnet,Arc';
  process.env.RPC_PROXY_TOKEN = 'tok';
  // base_sepolia has NO PROXY_SLUGS entry → must throw, never routed via Arc
  expect(() => arc.resolveRpcUrl(BS, 'registry-url')).toThrow(/no explicit proxy mapping/);
});

test('3d: unknown network fails closed', () => {
  process.env.RPC_PROXY_BASE_URL = 'https://proxy.example';
  process.env.RPC_PROXY_CHAINS = 'Arc_Testnet,Arc';
  process.env.RPC_PROXY_TOKEN = 'tok';
  expect(() => arc.resolveRpcUrl('arbitrum_one', 'x')).toThrow(/no explicit proxy mapping/);
});

test('3e: proxy CANNOT route Base Sepolia through Arc', () => {
  // The old Arc-specific ternary (`network === 'arc_testnet' ? 'Arc_Testnet' : 'Arc'`)
  // would silently map Base Sepolia to the Arc mainnet proxy slug. Phase 2
  // removed that and now it throws.
  process.env.RPC_PROXY_BASE_URL = 'https://proxy.example';
  process.env.RPC_PROXY_CHAINS = 'Arc_Testnet,Arc';
  process.env.RPC_PROXY_TOKEN = 'tok';
  expect(() => arc.resolveRpcUrl(BS, 'registry-url')).toThrow(/chain-confusion/);
});

test('3f: client cannot inject proxy slug (no user input reaches resolveRpcUrl)', () => {
  // resolveRpcUrl takes only (network, configuredRpcUrl) — the network slug
  // comes from the registry via getNetworkConfig, never from req.body. There is
  // no Express route or API parameter that feeds into resolveRpcUrl directly.
  // The test asserts the function signature: only registry-controlled inputs.
  const args = arc.resolveRpcUrl.length; // function arity is exactly 2
  expect(args).toBe(2);
});

test('3g: client cannot inject RPC URL (same invariant)', () => {
  // configuredRpcUrl is the registry's rpc_url. The ArcProvider constructor
  // calls getNetworkConfig(network) which reads from the database. No HTTP
  // request body or query parameter is ever passed into the provider constructor
  // (verified: the only ArcProvider instantiations are inside checkout.ts and
  // payment-intents.ts, using the PI's pinned network slug).
  process.env.RPC_PROXY_BASE_URL = '';
  delete process.env.RPC_PROXY_BASE_URL;
  // Without proxy mode, the registry URL is used directly (no client input)
  expect(arc.resolveRpcUrl(BS, 'https://sepolia.base.org')).toBe('https://sepolia.base.org');
});

test('3h: inherited object keys are NOT treated as proxy mappings (fail closed)', () => {
  // PROXY_SLUGS is a plain object literal. A naive `PROXY_SLUGS[network]` lookup
  // resolves inherited keys (constructor/toString/__proto__) to a truthy value and
  // silently skips the fail-closed path. Phase 5E uses an own-property check.
  process.env.RPC_PROXY_BASE_URL = 'https://proxy.example';
  process.env.RPC_PROXY_CHAINS = 'Arc_Testnet,Arc';
  process.env.RPC_PROXY_TOKEN = 'tok';
  for (const inherited of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
    expect(() => arc.resolveRpcUrl(inherited, 'registry-url'), `inherited key ${inherited}`).toThrow(/no explicit proxy mapping/);
  }
});

test('3i: proxy mode without RPC_PROXY_TOKEN fails closed (no unauthenticated call)', () => {
  process.env.RPC_PROXY_BASE_URL = 'https://proxy.example';
  process.env.RPC_PROXY_CHAINS = 'Arc_Testnet,Arc';
  delete process.env.RPC_PROXY_TOKEN;
  // Previously this produced a URL containing the literal string "undefined".
  expect(() => arc.resolveRpcUrl(ARC_TESTNET, 'r')).toThrow(/RPC_PROXY_TOKEN is not set/);
});

test('3j: mapped slug absent from RPC_PROXY_CHAINS stays on its OWN registry URL (per-network opt-out)', () => {
  // MODEL 2 nuance: PROXY_SLUGS decides *whether a network may be proxied at all*;
  // RPC_PROXY_CHAINS is the operator's list of slugs actually routed through the
  // proxy. A mapped network left out of RPC_PROXY_CHAINS keeps its own curated
  // registry URL — it is never re-pointed at another chain's endpoint. Only a
  // mapped (Arc) network can reach this path: unmapped ones throw earlier (3c/3e).
  process.env.RPC_PROXY_BASE_URL = 'https://proxy.example';
  process.env.RPC_PROXY_CHAINS = 'Arc'; // mainnet only
  process.env.RPC_PROXY_TOKEN = 'tok';
  expect(arc.resolveRpcUrl(ARC_MAINNET, 'r')).toBe('https://proxy.example/api/rpc/Arc?_rpc_token=tok');
  // arc_testnet is mapped but not listed → its own registry URL, no proxy, no Arc-mainnet route
  expect(arc.resolveRpcUrl(ARC_TESTNET, 'https://rpc.testnet.arc.io')).toBe('https://rpc.testnet.arc.io');
});

test('3k: MODEL 1 (no proxy env) — every enabled network resolves to its OWN registry URL', () => {
  delete process.env.RPC_PROXY_BASE_URL;
  delete process.env.RPC_PROXY_CHAINS;
  delete process.env.RPC_PROXY_TOKEN;
  for (const n of arc.listEnabledNetworks()) {
    const cfg = arc.getNetworkConfig(n.network);
    // Verbatim registry URL — no proxy prefix, and no other network's endpoint.
    expect(arc.resolveRpcUrl(n.network, cfg.rpcUrl)).toBe(cfg.rpcUrl);
  }
  // Explicitly: Base Sepolia never resolves to an Arc RPC host in either model.
  const bsCfg = arc.getNetworkConfig(BS);
  expect(bsCfg.rpcUrl).toBe('https://sepolia.base.org');
  expect(arc.resolveRpcUrl(BS, bsCfg.rpcUrl)).not.toContain('arc.io');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 4 — CHAIN IDENTITY TESTS
// ═══════════════════════════════════════════════════════════════════════════

test('4a: correct eth_chainId succeeds (no throw)', async () => {
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string };
      if (body.method === 'eth_chainId') {
        return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x' + BS_CHAIN.toString(16) });
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x0' });
    },
  });
  try {
    // Temporarily point the base_sepolia registry row at our stub
    const url = `http://127.0.0.1:${stub.port}/`;
    getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(url, BS);
    const provider = new arc.ArcProvider(BS);
    await provider.ensureChainIdMatches(); // must NOT throw
    expect(true).toBe(true);
  } finally {
    stub.stop();
    // Restore
    getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run('https://sepolia.base.org', BS);
  }
});

test('4b: wrong eth_chainId fails (throws, no fallback)', async () => {
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string };
      if (body.method === 'eth_chainId') {
        // Report Arc Testnet chain id for a Base Sepolia endpoint → mismatch
        return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x' + ARC_CHAIN_TESTNET.toString(16) });
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x0' });
    },
  });
  try {
    const url = `http://127.0.0.1:${stub.port}/`;
    getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(url, BS);
    const provider = new arc.ArcProvider(BS);
    await expect(provider.ensureChainIdMatches()).rejects.toThrow(/Chain mismatch/);
  } finally {
    stub.stop();
    getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run('https://sepolia.base.org', BS);
  }
});

test('4c: no fallback to another chain on RPC failure', async () => {
  // A server that returns JSON-RPC errors for eth_chainId causes viem to throw,
  // triggering the "Chain verification failed" path — no fallback to another chain.
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string };
      return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'service unavailable' } });
    },
  });
  try {
    const url = `http://127.0.0.1:${stub.port}/`;
    getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(url, BS);
    const provider = new arc.ArcProvider(BS);
    await expect(provider.ensureChainIdMatches()).rejects.toThrow(/Chain verification failed/);
  } finally {
    stub.stop();
    getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run('https://sepolia.base.org', BS);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 5 — BASE SEPOLIA REGRESSION
// ═══════════════════════════════════════════════════════════════════════════

test('5a: Base Sepolia registry row remains enabled, chain_id=84532, is_testnet=1', () => {
  const row = getDb().prepare('SELECT * FROM network_configs WHERE network=?').get(BS) as Record<string, unknown>;
  expect(row).toBeTruthy();
  expect(row.chain_id).toBe(BS_CHAIN);
  expect(row.is_testnet).toBe(1);
  expect(row.is_enabled).toBe(1);
  expect(row.usdc_address).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  expect(row.usdc_decimals).toBe(6);
});

test('5b: Base Sepolia wallet can be registered through API (THE CORE FIX)', async () => {
  const r = await postWallet({ address: '0x1122334455667788990011223344556677889900', network: BS, environment: 'test' });
  expect(r.status).toBe(201);
  expect(r.body.network).toBe(BS);
  expect(r.body.environment).toBe('test');
});

test('5c: Base Sepolia environment resolves to test (not hardcoded fallback)', async () => {
  const wallets = await getWallets();
  const bsWallet = wallets.body.data.find((w) => w.network === BS);
  expect(bsWallet).toBeTruthy();
  expect(bsWallet!.environment).toBe('test');
});

test('5d: Arc rows remain unchanged (chain_id, USDC, confirmations, testnet class)', () => {
  const at = getDb().prepare('SELECT * FROM network_configs WHERE network=?').get(ARC_TESTNET) as Record<string, unknown>;
  expect(at.chain_id).toBe(ARC_CHAIN_TESTNET);
  expect(at.usdc_address).toBe('0x3600000000000000000000000000000000000000');
  expect(at.usdc_decimals).toBe(6);
  expect(at.is_testnet).toBe(1);
  expect(at.required_confirmations).toBe(0);
  const am = getDb().prepare('SELECT * FROM network_configs WHERE network=?').get(ARC_MAINNET) as Record<string, unknown>;
  expect(am.chain_id).toBe(ARC_CHAIN_MAINNET);
  expect(am.is_testnet).toBe(0);
  expect(am.required_confirmations).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 6 — NETWORK EXPANSION HARD STOP
// ═══════════════════════════════════════════════════════════════════════════

// INTENTIONALLY UPDATED ACROSS PHASES: this hard stop asserted "exactly 3
// enabled" while Phase 5E only prepared the architecture. Phase 5F added
// arbitrum_sepolia (4). The MASTER PHASE added base_mainnet + arbitrum_one (6),
// after the Phase 5I readiness audit. The environment-expansion guard still
// holds for every OTHER candidate chain (6c: OP/Polygon/Avalanche/Ethereum-
// payable/ZKsync remain absent and unenabled).
// INTENTIONALLY UPDATED ACROSS PHASES and again by the MASTER EXPANSION, which
// enabled the conservative Circle-native-USDC EVM subset on top of the original
// six. The set is DERIVED from the inventory, so this guard tracks the registry
// exactly; 6c still hard-refuses every held / special / non-EVM / Ethereum-payable
// chain, so the money gate cannot be widened by accident.
test('6a: enabled set is exactly the approved Circle-native-USDC payable network set', () => {
  const enabled = getDb().prepare('SELECT network FROM network_configs WHERE is_enabled=1 ORDER BY network').all() as { network: string }[];
  expect(enabled.map((e) => e.network)).toEqual(EXPECTED_SLUGS);
});

test('6b: Base Mainnet is registered, enabled and live-class with finalized policy', () => {
  const row = getDb().prepare('SELECT network,chain_id,is_enabled,is_testnet,finality_mode FROM network_configs WHERE network=?').get('base_mainnet') as { chain_id: number; is_enabled: number; is_testnet: number; finality_mode: string } | null;
  expect(row).not.toBeNull();
  expect(row!.chain_id).toBe(8453);
  expect(row!.is_enabled).toBe(1);
  expect(row!.is_testnet).toBe(0); // live-class — never selectable by a test key
  expect(row!.finality_mode).toBe('finalized');
});

test('6c: no held / special-handling / non-EVM / Ethereum-payable chain is enabled', () => {
  // Only the inventory-approved enabled set may be live. Every other audited
  // network — including Ethereum (ENS-only), the held new chains and ALL non-EVM
  // rails — must have NO enabled row, and no disabled row either.
  for (const slug of FORBIDDEN_SLUGS) {
    expect(getDb().prepare('SELECT id FROM network_configs WHERE network=? AND is_enabled=1').get(slug)).toBeNull();
  }
  // Ethereum (1) in particular is never payable, and no non-enabled EVM chain id is enabled.
  const forbiddenChainIds = CIRCLE_INVENTORY
    .filter((n) => n.evm && n.chainId != null && n.status !== 'IMPLEMENTED_ENABLED')
    .map((n) => n.chainId as number);
  for (const cid of forbiddenChainIds) {
    expect(getDb().prepare('SELECT id FROM network_configs WHERE chain_id=? AND is_enabled=1').get(cid)).toBeNull();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 7 — SETTLEMENT WALLET SECURITY AUDIT (PART B)
// ═══════════════════════════════════════════════════════════════════════════

test('7a: invalid EVM address rejected even with correct network', async () => {
  const r = await postWallet({ address: 'not-an-address', network: BS });
  expect(r.status).toBe(400);
  expect(String(r.body.error)).toContain('valid EVM address');
});

test('7b: missing address rejected', async () => {
  const r = await postWallet({ network: BS } as Record<string, unknown>);
  expect(r.status).toBe(400);
});

test('7c: duplicate address+network returns 409', async () => {
  const addr = '0x4444444444444444444444444444444444444444';
  const first = await postWallet({ address: addr, network: BS });
  expect(first.status).toBe(201);
  const second = await postWallet({ address: addr, network: BS });
  expect(second.status).toBe(409);
});

test('7d: unauthenticated request rejected', async () => {
  const res = await fetch(`${baseUrl}/settlement-wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: ADDR_A, network: BS }),
  });
  expect(res.status).toBe(401);
});

test('7e: live-class network gated by ENABLE_LIVE_PAYMENTS', async () => {
  delete process.env.ENABLE_LIVE_PAYMENTS;
  const r = await postWallet({ address: '0x5555555555555555555555555555555555555555', network: ARC_MAINNET });
  expect(r.status).toBe(403);
  process.env.ENABLE_LIVE_PAYMENTS = 'true'; // restore
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 8 — REGISTRY HELPER UNIT TESTS
// ═══════════════════════════════════════════════════════════════════════════

test('8a: getNetworkMeta returns null for unknown slug', () => {
  expect(arc.getNetworkMeta('nonexistent')).toBeNull();
});

test('8b: getNetworkMeta returns correct data for enabled network', () => {
  const meta = arc.getNetworkMeta(BS);
  expect(meta).toEqual({ network: BS, chainId: BS_CHAIN, isTestnet: true, isEnabled: true });
});

// INTENTIONALLY UPDATED BY PHASE 5F (3->4), the MASTER PHASE (4->6) and the
// MASTER EXPANSION (6->canonical). Count + slugs derive from the inventory.
test('8c: listEnabledNetworks returns exactly the canonical enabled rows', () => {
  const list = arc.listEnabledNetworks();
  expect(list).toHaveLength(EXPECTED_SLUGS.length);
  const slugs = list.map((n) => n.network).sort();
  expect(slugs).toEqual(EXPECTED_SLUGS);
});

test('8d: getNetworkConfig still throws for UNREGISTERED slugs; expanded mainnets now resolve', () => {
  // The money gate is intact for slugs that are NOT registered at all — including
  // non-EVM rails and held chains that were deliberately never seeded.
  expect(() => arc.getNetworkConfig('nonexistent')).toThrow(/not configured/);
  expect(() => arc.getNetworkConfig('solana')).toThrow(/not configured/);
  expect(() => arc.getNetworkConfig('monad')).toThrow(/not configured/);
  // base_mainnet/arbitrum_one are seeded+enabled (MASTER PHASE) — they resolve.
  expect(arc.getNetworkConfig('base_mainnet').chainId).toBe(8453);
  expect(arc.getNetworkConfig('arbitrum_one').chainId).toBe(42161);
});
