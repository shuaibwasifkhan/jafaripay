/**
 * JafariPay — Phase 5F tests: Arbitrum Sepolia as the second independent EVM network.
 *
 * Proves the registry-driven multi-chain architecture works on a new network with
 * ZERO provider / verification / checkout code changes. The only implementation
 * deltas are: one network_configs row, one frontend allowlist entry, one CSP host.
 *
 * Facts used here are verified against OFFICIAL sources, never memory:
 *  • chain id 421614, official RPC https://sepolia-rollup.arbitrum.io/rpc,
 *    explorer https://sepolia.arbiscan.io — docs.arbitrum.io (node providers).
 *  • native Circle USDC 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d, decimals 6 —
 *    Circle "USDC contract addresses" (testnet table).
 *  • required_confirmations = 24 — head-progression gate derived from official
 *    Arbitrum Sepolia ~250ms block time (see the Phase 5F seed comment in
 *    server/db/schema.ts). Arbitrum hard finality is NOT a confirmation count
 *    (docs.arbitrum.io "Finality and reorgs"), so this gate is explicitly
 *    shallow-protection only and is documented as such in the final report.
 *
 * No real network is dialed: blockchain I/O is confined to a local JSON-RPC stub
 * (the eth_chainId path) and narrowly-mocked provider methods (the rule
 * pipeline). The real route handlers and the real verifyPayment rules run
 * unmodified. NO transaction is fabricated as "real" and ARBITRUM ONE / BASE
 * MAINNET are never registered or enabled.
 */
import { test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_phase5f_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'phase5f-test-secret';
process.env.SESSION_SECRET = 'phase5f-session-secret-that-is-long-enough';
process.env.ENABLE_LIVE_PAYMENTS = 'true';

const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');
const { CSP_CONNECT_SRC } = await import('./lib/csp.ts');
const { CIRCLE_INVENTORY, enabledEvmRows } = await import('./db/networks.ts');
const EXPECTED_SLUGS: string[] = enabledEvmRows().map((n) => n.slug).sort();
const EXPECTED_PAYABLE_IDS: number[] = enabledEvmRows().map((n) => n.chainId as number).sort((a, b) => a - b);
const FORBIDDEN_SLUGS_5F: string[] = CIRCLE_INVENTORY.filter((n) => n.status !== 'IMPLEMENTED_ENABLED').map((n) => n.slug);
const checkoutRouter = (await import('./api/checkout.ts')).default;
const intentsRouter = (await import('./api/payment-intents.ts')).default;
const settlementRouter = (await import('./api/settlement-wallets.ts')).default;
const { createSession } = await import('./auth/siwe.ts');
// The GENERATED frontend facts registry — reused unchanged by Phase 5F (Part N).
const facts = await import('../src/onchain-facts.ts');

// ── Officially-verified Arbitrum Sepolia facts ──────────────────────────────
const AS = 'arbitrum_sepolia';
const AS_CHAIN = 421614;
const AS_RPC = 'https://sepolia-rollup.arbitrum.io/rpc';
const AS_EXPLORER = 'https://sepolia.arbiscan.io';
const AS_USDC = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'; // Circle native USDC
const AS_USDC_E = '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'; // legacy bridged USDC.e — FORBIDDEN
const AS_SETTLEMENT = '0x6b8f3e2a1d4c5b6a7988f0e1d2c3b4a596877869'; // dedicated Arb-Sepolia wallet
const AS_REQUIRED_CONFIRMATIONS = 24;
const ARC_TESTNET = 'arc_testnet';
const ARC_MAINNET = 'arc_mainnet';
const ARC_CHAIN_TESTNET = 5042002;
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const BS = 'base_sepolia';
const BS_CHAIN = 84532;
const BS_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ARBITRUM_ONE = 42161;
const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let sessionA = '';
let sessionB = '';

const hashApiKey = (key: string) => createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

let seq = 0;
function txHash(): string { seq++; return '0x' + seq.toString(16).padStart(64, '0'); }

// Stub RPC server used ONLY for the eth_chainId validation path (group 3).
function startStubRpc(servesChainId: number) {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string };
      hits.push(body.method);
      const r = '0x' + BigInt(servesChainId).toString(16);
      return Response.json({ jsonrpc: '2.0', id: body.id, result: r });
    },
  });
  return { server, hits, url: `http://127.0.0.1:${server.port}/` };
}

/** Point the arbitrum_sepolia registry row at a local stub, run, then restore. */
async function withStubRpc<T>(servesChainId: number, fn: (stub: ReturnType<typeof startStubRpc>) => Promise<T>): Promise<T> {
  const stub = startStubRpc(servesChainId);
  getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(stub.url, AS);
  try {
    return await fn(stub);
  } finally {
    stub.server.stop();
    getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(AS_RPC, AS);
  }
}

function transferLog(contract: string, to: string, amount: bigint) {
  const topics = encodeEventTopics({
    abi: [TRANSFER], eventName: 'Transfer',
    args: { from: SENDER as `0x${string}`, to: to as `0x${string}` },
  });
  const data = encodeAbiParameters([{ type: 'uint256' }], [amount]);
  return { address: contract.toLowerCase(), topics: topics as string[], data, logIndex: 0 };
}

/**
 * Mock the two RPC fetch methods so verifyPayment runs its REAL rules with no
 * network. blockNumber/head control the finality gate; contract/to/amount/status
 * control the transfer-match rules. Defaults are a valid Arbitrum Sepolia payment.
 */
function mockProvider(opts: {
  contract?: string; to?: string; amount?: bigint; blockNumber?: bigint; head?: bigint;
  status?: 'success' | 'reverted'; noLogs?: boolean;
} = {}) {
  const contract = opts.contract ?? AS_USDC;
  const to = opts.to ?? AS_SETTLEMENT.toLowerCase();
  const amount = opts.amount ?? 1_000_000n;
  const blockNumber = opts.blockNumber ?? 100n;
  const head = opts.head ?? 200n; // comfortably above required_confirmations=24
  const status = opts.status ?? 'success';
  const logs = opts.noLogs ? [] : [transferLog(contract, to, amount)];
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockImplementation(((requested: string) => Promise.resolve({
    txHash: requested, status, blockNumber,
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)), from: SENDER, to: contract,
    logs,
  })) as never);
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockResolvedValue(head as never);
}

async function createIntent(auth: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/v1/payment-intents`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
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

async function postWallet(body: Record<string, unknown>, token = sessionA) {
  const res = await fetch(`${baseUrl}/settlement-wallets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-token': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function getNetworks(token = sessionA) {
  const res = await fetch(`${baseUrl}/settlement-wallets/networks`, { headers: { 'x-session-token': token } });
  return { status: res.status, body: await res.json() as { data: Record<string, unknown>[] } };
}

const piStatus = (id: string) =>
  (getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(id) as { status: string }).status;
const paymentFor = (piId: string) =>
  getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(piId);

/** Direct PI insert (bypasses the API) so expiry / state tests control the row. */
function insertIntent(id: string, opts: { network?: string; chainId?: number; usdc?: string; settlement?: string; amountUnits?: string; expiresAt?: number; status?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const network = opts.network ?? AS;
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
     amount_decimal,amount_base_units,currency,status,environment,expires_at,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, 'merch_5f', 'sw_5f_as', opts.settlement ?? AS_SETTLEMENT.toLowerCase(), network,
    opts.chainId ?? AS_CHAIN, opts.usdc ?? AS_USDC, '1.00', opts.amountUnits ?? '1000000', 'USDC',
    opts.status ?? 'requires_payment', 'test', opts.expiresAt ?? now + 3600, now, now,
  );
  return id;
}

/** Verify through the real rule pipeline with a fully-mocked chain. */
async function verifyDirect(id: string, hash: string, over: Parameters<typeof mockProvider>[0] = {}) {
  mockProvider(over);
  return arc.verifyPayment({
    txHash: hash, network: AS, paymentIntentId: id,
    settlementAddress: AS_SETTLEMENT.toLowerCase(), expectedAmountBaseUnits: '1000000', usdcAddress: AS_USDC,
  });
}

beforeAll(() => {
  migrate(); // creates the canonical arbitrum_sepolia row from the Phase 5F seed
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_5f', 'Phase5F Merchant');
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_5f_b', 'Phase5F Merchant B');
  // Dedicated Arbitrum Sepolia settlement wallet — NOT a reused Arc/Base wallet.
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_5f_as', 'merch_5f', AS_SETTLEMENT.toLowerCase(), AS);
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_5f_at', 'merch_5f', SENDER.toLowerCase(), ARC_TESTNET);
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_5f_bs', 'merch_5f', '0x5a7bd1b2a4b2c2d3e4f5061728394a5b6c7d8e9f', BS);
  const testKey = 'sk_test_5f';
  const liveKey = 'sk_live_5f';
  db.prepare('INSERT OR REPLACE INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)')
    .run('ak_5f_test', 'merch_5f', null, 'p5f', testKey.slice(0, 8), hashApiKey(testKey), testKey.slice(0, 12), 1, 'test');
  db.prepare('INSERT OR REPLACE INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)')
    .run('ak_5f_live', 'merch_5f', null, 'p5f-live', liveKey.slice(0, 8), hashApiKey(liveKey), liveKey.slice(0, 12), 1, 'live');
  sessionA = createSession('merch_5f', SENDER);
  sessionB = createSession('merch_5f_b', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

  app = express();
  app.use(express.json());
  app.use('/checkout', checkoutRouter);
  app.use('/v1/payment-intents', intentsRouter);
  app.use('/settlement-wallets', settlementRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(() => {
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockRestore();
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockRestore();
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

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 1 — REGISTRY SEED / IDEMPOTENCY (Part B)
// ═══════════════════════════════════════════════════════════════════════════

test('1a: exactly ONE arbitrum_sepolia registry row exists with the verified facts', () => {
  const rows = getDb().prepare('SELECT * FROM network_configs WHERE network=?').all(AS) as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.chain_id).toBe(AS_CHAIN);
  expect(row.is_testnet).toBe(1);
  expect(row.is_enabled).toBe(1);
  expect(row.usdc_address).toBe(AS_USDC);
  expect(row.usdc_decimals).toBe(6);
  expect(row.rpc_url).toBe(AS_RPC);
  expect(row.required_confirmations).toBe(AS_REQUIRED_CONFIRMATIONS);
});

test('1b: explorer_base is compatible with the existing buildTxExplorerUrl() (no trailing path)', () => {
  const row = getDb().prepare('SELECT explorer_base FROM network_configs WHERE network=?').get(AS) as { explorer_base: string };
  expect(row.explorer_base).toBe(AS_EXPLORER);
  expect(row.explorer_base.endsWith('/')).toBe(false);
  expect(row.explorer_base).not.toContain('/tx');
  // The existing builder appends '/tx/<hash>' to the stored base.
  expect(facts.buildTxExplorerUrl(AS_CHAIN, '0xabc')).toBe(`${AS_EXPLORER}/tx/0xabc`);
  expect(facts.buildAddressExplorerUrl(AS_CHAIN, '0xdef')).toBe(`${AS_EXPLORER}/address/0xdef`);
});

test('1c: seed is idempotent — repeated migrate() never duplicates the row', () => {
  const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM network_configs WHERE network=?').get(AS) as { n: number }).n;
  const before = count();
  migrate();
  migrate();
  expect(count()).toBe(before);
  expect(count()).toBe(1);
});

test('1d: seed is self-healing — a drifted row is corrected by migrate()', () => {
  getDb().prepare('UPDATE network_configs SET rpc_url=?, required_confirmations=?, is_enabled=?, usdc_address=? WHERE network=?')
    .run('https://evil-rpc.example/', 999, 0, '0x0000000000000000000000000000000000000000', AS);
  migrate();
  const row = getDb().prepare('SELECT * FROM network_configs WHERE network=?').get(AS) as Record<string, unknown>;
  expect(row.rpc_url).toBe(AS_RPC);
  expect(row.required_confirmations).toBe(AS_REQUIRED_CONFIRMATIONS);
  expect(row.is_enabled).toBe(1);
  expect(row.usdc_address).toBe(AS_USDC);
});

test('1e: Arc and Base Sepolia rows are untouched by the Phase 5F seed', () => {
  const at = getDb().prepare('SELECT * FROM network_configs WHERE network=?').get(ARC_TESTNET) as Record<string, unknown>;
  expect(at.chain_id).toBe(ARC_CHAIN_TESTNET);
  expect(at.usdc_address).toBe(ARC_USDC);
  expect(at.usdc_decimals).toBe(6);
  expect(at.is_testnet).toBe(1);
  expect(at.required_confirmations).toBe(0);
  const bs = getDb().prepare('SELECT * FROM network_configs WHERE network=?').get(BS) as Record<string, unknown>;
  expect(bs.chain_id).toBe(BS_CHAIN);
  expect(bs.usdc_address).toBe(BS_USDC);
  expect(bs.required_confirmations).toBe(3);
  expect(bs.is_enabled).toBe(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 2 — OFFICIAL CHAIN FACTS (registry vs generated onchain-facts, Part A)
// ═══════════════════════════════════════════════════════════════════════════

test('2a: provider registry loads Arbitrum Sepolia with the official facts', () => {
  const cfg = arc.getNetworkConfig(AS);
  expect(cfg.chainId).toBe(AS_CHAIN);
  expect(cfg.usdcAddress).toBe(AS_USDC);
  expect(cfg.usdcDecimals).toBe(6);
  expect(cfg.rpcUrl).toBe(AS_RPC);
  expect(cfg.requiredConfirmations).toBe(AS_REQUIRED_CONFIRMATIONS);
  expect(cfg.explorerBase).toBe(AS_EXPLORER);
});

test('2b: generated onchain-facts (unmodified) agrees with the registry — no drift', () => {
  const chain = facts.getChain(AS_CHAIN);
  expect(chain).toBeTruthy();
  expect(chain!.name).toBe('Arbitrum Sepolia');
  expect(chain!.isTestnet).toBe(true);
  expect(chain!.rpcUrls).toContain(AS_RPC);
  expect(chain!.explorerBase).toBe(AS_EXPLORER);
  expect(chain!.usdc!.address).toBe(arc.getNetworkConfig(AS).usdcAddress);
  expect(chain!.usdc!.decimals).toBe(arc.getNetworkConfig(AS).usdcDecimals);
});

test('2c: getNetworkMeta reports the registry class (is_testnet drives environment)', () => {
  expect(arc.getNetworkMeta(AS)).toEqual({ network: AS, chainId: AS_CHAIN, isTestnet: true, isEnabled: true });
});

test('2d: MODEL 1 (direct curated RPC) resolves the registry URL verbatim', () => {
  // This checkout's configured deployment model — no proxy env is set, so the
  // verified curated registry URL is used exactly as stored.
  delete process.env.RPC_PROXY_BASE_URL;
  expect(arc.resolveRpcUrl(AS, AS_RPC)).toBe(AS_RPC);
  expect(arc.resolveRpcUrl(AS, AS_RPC)).not.toContain('arc');
});

test('2e: NO Arbitrum proxy slug was added — proxy mode fails closed (Part C)', () => {
  // Mandate: "Do NOT add an Arbitrum proxy slug merely to make the test pass."
  // PROXY_SLUGS still contains only the two Arc slugs, so with proxy mode ON an
  // Arbitrum Sepolia verification refuses to run instead of being routed to a
  // guessed slug or an Arc endpoint (chain-confusion protection intact).
  process.env.RPC_PROXY_BASE_URL = 'https://proxy.example';
  process.env.RPC_PROXY_CHAINS = 'Arc_Testnet,Arc,Arbitrum_Sepolia';
  process.env.RPC_PROXY_TOKEN = 'tok';
  expect(() => arc.resolveRpcUrl(AS, AS_RPC)).toThrow(/no explicit proxy mapping/);
  expect(() => arc.resolveRpcUrl(AS, AS_RPC)).toThrow(/chain-confusion/);
});

test('2f: provider source contains no Arbitrum-specific branch (no second abstraction)', () => {
  const src = readFileSync(join(import.meta.dir, 'blockchain', 'arc-provider.ts'), 'utf8');
  expect(src).not.toContain('arbitrum');
  expect(src).not.toContain('421614');
  expect(src).not.toContain('42161');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 3 — PROVIDER CHAIN IDENTITY (real viem stack over a local stub, Part C)
// ═══════════════════════════════════════════════════════════════════════════

test('3a: provider verifies eth_chainId against the Arbitrum Sepolia chain id', async () => {
  await withStubRpc(AS_CHAIN, async (stub) => {
    const provider = new arc.ArcProvider(AS);
    await provider.ensureChainIdMatches(); // resolves — no throw
    expect(stub.hits).toContain('eth_chainId');
  });
});

test('3b: endpoint serving Arbitrum ONE fails closed before any receipt read', async () => {
  await withStubRpc(ARBITRUM_ONE, async (stub) => {
    const provider = new arc.ArcProvider(AS);
    await expect(provider.getTransactionReceipt(txHash())).rejects.toThrow(/Chain mismatch/);
    expect(stub.hits).toContain('eth_chainId');
    expect(stub.hits).not.toContain('eth_getTransactionReceipt');
  });
});

test('3c: endpoint serving Arc or Base Sepolia chain ids fails closed (no cross-chain fallback)', async () => {
  for (const serves of [ARC_CHAIN_TESTNET, BS_CHAIN, 1]) {
    await withStubRpc(serves, async () => {
      const provider = new arc.ArcProvider(AS);
      await expect(provider.ensureChainIdMatches()).rejects.toThrow(/Chain mismatch/);
    });
  }
});

test('3d: unreachable/erroring endpoint fails closed (never falls back to Arc)', async () => {
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number };
      return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'service unavailable' } });
    },
  });
  getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(`http://127.0.0.1:${stub.port}/`, AS);
  try {
    const provider = new arc.ArcProvider(AS);
    await expect(provider.ensureChainIdMatches()).rejects.toThrow(/Chain verification failed/);
  } finally {
    stub.stop();
    getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(AS_RPC, AS);
  }
});

test('3e: RPC resolution is never client-controlled (arity + registry-only inputs)', () => {
  // resolveRpcUrl(network, configuredRpcUrl): the slug comes from the PI/registry
  // and the URL comes from network_configs — no request body reaches the provider.
  expect(arc.resolveRpcUrl.length).toBe(2);
  expect(arc.ArcProvider.length).toBe(1); // constructor takes only the network slug
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 4 — SETTLEMENT WALLET (Part F: registry-driven, no new hardcoded list)
// ═══════════════════════════════════════════════════════════════════════════

test('4a: POST settlement wallet with network=arbitrum_sepolia is accepted', async () => {
  const r = await postWallet({ address: '0x7777777777777777777777777777777777777777', network: AS });
  expect(r.status).toBe(201);
  expect(r.body.network).toBe(AS);
  expect(r.body.environment).toBe('test'); // from is_testnet=1, not from the slug name
  expect(r.body.chain_id).toBe(AS_CHAIN);
});

test('4b: /networks lists arbitrum_sepolia — selection comes from the registry', async () => {
  const r = await getNetworks();
  expect(r.status).toBe(200);
  const row = r.body.data.find((n) => n.network === AS);
  expect(row).toBeTruthy();
  expect(row!.chain_id).toBe(AS_CHAIN);
  expect(row!.environment).toBe('test');
  expect(row!.is_testnet).toBe(true);
});

test('4c: Arbitrum One is now a selectable LIVE-class network (Sepolia stays test-class)', async () => {
  // Registered + enabled by the MASTER PHASE after the Phase 5I readiness audit.
  // It is live-class, so a settlement-wallet POST succeeds here ONLY because
  // ENABLE_LIVE_PAYMENTS is set for this suite; the safety gate itself is proven
  // separately (7e). The wrong/ambiguous slugs remain rejected as unknown networks.
  const ok = await postWallet({ address: '0x8888888888888888888888888888888888888888', network: 'arbitrum_one' });
  expect(ok.status).toBe(201);
  expect(ok.body.environment).toBe('live');
  for (const slug of ['arbitrum', 'arbitrum_mainnet']) {
    const r = await postWallet({ address: '0x8888888888888888888888888888888888888888', network: slug });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_network');
  }
});

test('4d: testnet-class row cannot be labeled "live" (class separation retained)', async () => {
  const r = await postWallet({ address: '0x9999999999999999999999999999999999999901', network: AS, environment: 'live' });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('environment_network_mismatch');
});

test('4e: disabled arbitrum_sepolia row is not selectable (fail closed)', async () => {
  getDb().prepare('UPDATE network_configs SET is_enabled=0 WHERE network=?').run(AS);
  try {
    const r = await postWallet({ address: '0x9999999999999999999999999999999999999902', network: AS });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('network_disabled');
  } finally {
    getDb().prepare('UPDATE network_configs SET is_enabled=1 WHERE network=?').run(AS);
  }
});

test('4f: merchant isolation holds on the new network', async () => {
  const bWallet = await postWallet(
    { address: '0x9999999999999999999999999999999999999903', network: AS },
    sessionB,
  );
  expect(bWallet.status).toBe(201);
  const res = await fetch(`${baseUrl}/settlement-wallets`, { headers: { 'x-session-token': sessionA } });
  const wallets = (await res.json() as { data: Record<string, unknown>[] }).data;
  expect(wallets.every((w) => w.merchant_id === 'merch_5f')).toBe(true);
  expect(wallets.some((w) => w.merchant_id === 'merch_5f_b')).toBe(false);
  const del = await fetch(`${baseUrl}/settlement-wallets/${bWallet.body.id}`, {
    method: 'DELETE', headers: { 'x-session-token': sessionA },
  });
  expect(del.status).toBe(404);
});

test('4g: unauthenticated settlement-wallet POST is rejected', async () => {
  const res = await fetch(`${baseUrl}/settlement-wallets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: '0x9999999999999999999999999999999999999904', network: AS }),
  });
  expect(res.status).toBe(401);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 5 — PAYMENT INTENT SNAPSHOT (Part G: real API path)
// ═══════════════════════════════════════════════════════════════════════════

test('5a: intent creation snapshots network/chain_id/usdc/settlement/amount/environment', async () => {
  const r = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-5a' });
  expect(r.status).toBe(201);
  expect(r.body.network).toBe(AS);
  expect(r.body.chain_id).toBe(AS_CHAIN);
  expect(r.body.usdc_address).toBe(AS_USDC);
  expect(r.body.settlement_address).toBe(AS_SETTLEMENT.toLowerCase());
  expect(r.body.amount_base_units).toBe('1000000');

  const row = getDb().prepare(
    'SELECT network,chain_id,usdc_address,settlement_address,amount_base_units,environment,currency FROM payment_intents WHERE id=?',
  ).get(String(r.body.id)) as Record<string, unknown>;
  expect(row.network).toBe(AS);
  expect(row.chain_id).toBe(AS_CHAIN);
  expect(row.usdc_address).toBe(AS_USDC);
  expect(row.settlement_address).toBe(AS_SETTLEMENT.toLowerCase());
  expect(row.amount_base_units).toBe('1000000');
  expect(row.environment).toBe('test'); // resolved from the registry class
  expect(row.currency).toBe('USDC');
});

test('5b: the snapshot pins NATIVE Circle USDC and never USDC.e', async () => {
  const r = await createIntent('sk_test_5f', { amount: '2.50', network: AS, order_id: 'p5f-5b' });
  expect(r.status).toBe(201);
  const pinned = String(r.body.usdc_address).toLowerCase();
  expect(pinned).toBe(AS_USDC.toLowerCase());
  expect(pinned).not.toBe(AS_USDC_E.toLowerCase());
  expect(r.body.amount_base_units).toBe('2500000');
});

test('5c: a live key cannot create a testnet-class Arbitrum Sepolia intent', async () => {
  const r = await createIntent('sk_live_5f', { amount: '1.00', network: AS });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('environment_network_mismatch');
});

test('5d: merchant without an Arbitrum Sepolia wallet is refused (no silent Arc wallet)', async () => {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_5f_c', 'No Arb Wallet');
  const key = 'sk_test_5f_c';
  db.prepare('INSERT OR REPLACE INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)')
    .run('ak_5f_c', 'merch_5f_c', null, 'p5f-c', key.slice(0, 8), hashApiKey(key), key.slice(0, 12), 1, 'test');
  const r = await createIntent(key, { amount: '1.00', network: AS });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('setup.no_settlement_wallet');
});

test('5e: omitted network still defaults to the Arc testnet slug (Arc behavior intact)', async () => {
  const r = await createIntent('sk_test_5f', { amount: '1.00' });
  expect(r.status).toBe(201);
  expect(r.body.network).toBe(ARC_TESTNET);
  expect(r.body.chain_id).toBe(ARC_CHAIN_TESTNET);
  expect(r.body.usdc_address).toBe(ARC_USDC);
});

test('5f: an explicit settlement_wallet_id must belong to the selected network', async () => {
  const r = await createIntent('sk_test_5f', {
    amount: '1.00', network: AS, settlement_wallet_id: 'sw_5f_at', // an Arc wallet
  });
  expect(r.status).toBe(400);
  expect(String(r.body.error)).toContain('wrong network');
});

test('5g: an unregistered slug cannot create an intent; a live-class mainnet on a TEST key is env-rejected', async () => {
  // Truly unregistered / non-enabled slugs → invalid_network (registry is the gate).
  for (const slug of ['solana', 'monad', 'sonic', 'hyperevm', 'ethereum']) {
    const r = await createIntent('sk_test_5f', { amount: '1.00', network: slug });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_network');
  }
  // base_mainnet/arbitrum_one ARE now registered+enabled, but they are live-class
  // (is_testnet=0). A TEST key may not select them — the env-class gate rejects
  // with environment_network_mismatch, NOT invalid_network (they are known).
  for (const slug of ['arbitrum_one', 'base_mainnet']) {
    const r = await createIntent('sk_test_5f', { amount: '1.00', network: slug });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('environment_network_mismatch');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 6 — CHECKOUT RESOLUTION (Part J: PI is the sole network authority)
// ═══════════════════════════════════════════════════════════════════════════

const checkoutNet = await import('../src/checkout-network.ts');

test('6a: public checkout endpoint returns the pinned Arbitrum Sepolia fields', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-6a' });
  const pi = String(created.body.id);
  const res = await fetch(`${baseUrl}/checkout/${pi}`);
  expect(res.status).toBe(200);
  const pub = await res.json() as Record<string, unknown>;
  expect(pub.network).toBe(AS);
  expect(pub.chain_id).toBe(AS_CHAIN);
  expect(pub.usdc_address).toBe(AS_USDC);
  expect(pub.settlement_address).toBe(AS_SETTLEMENT.toLowerCase());
  expect(pub.amount_base_units).toBe('1000000');

  // The pure resolver the checkout page delegates to.
  const view = checkoutNet.resolveCheckoutNetwork(pub as unknown as import('../src/checkout-network.ts').CheckoutIntentNet);
  expect(view.status).toBe('ready');
  expect(view.isSupported).toBe(true);
  expect(view.chainId).toBe(AS_CHAIN);
  expect(view.displayName).toBe('Arbitrum Sepolia'); // display, not "Arc"
  expect(view.isTestnet).toBe(true);
  expect(view.usdcAddress).toBe(AS_USDC);
  expect(view.txExplorerUrl('0xdead')).toBe(`${AS_EXPLORER}/tx/0xdead`);
  expect(view.addressExplorerUrl('0xfeed')).toBe(`${AS_EXPLORER}/address/0xfeed`);
});

test('6b: checkout uses the PI-pinned USDC address, never a registry duplicate', () => {
  // If checkout re-derived USDC from a network table, this fixture address would
  // be replaced. It must pass through verbatim (no duplicated network facts).
  const view = checkoutNet.resolveCheckoutNetwork({
    chain_id: AS_CHAIN, network: AS, usdc_address: '0x00000000000000000000000000000000000000ee',
    settlement_address: AS_SETTLEMENT, amount_base_units: '1',
  });
  expect(view.status).toBe('ready');
  expect(view.usdcAddress).toBe('0x00000000000000000000000000000000000000ee');
});

test('6c: unknown chain id is UNSUPPORTED and never falls back to Arc', () => {
  const view = checkoutNet.resolveCheckoutNetwork({
    chain_id: 999999, network: 'unknown_chain', usdc_address: AS_USDC,
    settlement_address: AS_SETTLEMENT, amount_base_units: '1000000',
  });
  expect(view.status).toBe('unsupported');
  expect(view.isSupported).toBe(false);
  expect(view.chainId).toBe(999999);
  expect(view.usdcAddress).toBeNull();
  expect(view.txExplorerUrl('0xabc')).toBeNull();
  expect(view.displayName).not.toBe('Arc Testnet');
});

test('6d: Arbitrum ONE is now allowlisted in checkout and drives its OWN explorer (never testnet/Arc)', () => {
  // MASTER PHASE: Arbitrum One (42161) moved from "capability absent" to a curated
  // frontend chain. It must resolve ready on its own mainnet explorer, and the
  // PI-pinned USDC must pass through verbatim. USDC.e vs native USDC is a BACKEND
  // registry/verify concern (see the dedicated USDC.e rejection test), not a
  // frontend-capability one — the view only echoes whatever the PI pinned.
  const view = checkoutNet.resolveCheckoutNetwork({
    chain_id: ARBITRUM_ONE, network: 'arbitrum_one', usdc_address: AS_USDC_E,
    settlement_address: AS_SETTLEMENT, amount_base_units: '1000000',
  });
  expect(view.status).toBe('ready');
  expect(view.isSupported).toBe(true);
  expect(view.isTestnet).toBe(false);
  expect(view.usdcAddress).toBe(AS_USDC_E); // pinned passthrough
  const url = view.txExplorerUrl('0xabc')!;
  expect(url).toContain('arbiscan.io');
  expect(url.includes('sepolia.arbiscan.io')).toBe(false); // mainnet explorer, not testnet
  expect(url.includes('arc.io')).toBe(false);
});

test('6e: wrong wallet network blocks payment and triggers the existing switch path', () => {
  const view = checkoutNet.resolveCheckoutNetwork({
    chain_id: AS_CHAIN, network: AS, usdc_address: AS_USDC,
    settlement_address: AS_SETTLEMENT, amount_base_units: '1000000',
  });
  // Wallet on Arc Testnet while the intent pins Arbitrum Sepolia.
  expect(checkoutNet.isWrongNetwork(ARC_CHAIN_TESTNET, view.chainId)).toBe(true);
  expect(checkoutNet.canAttemptPayment({ view, isConnected: true, walletChainId: ARC_CHAIN_TESTNET, isExpired: false })).toBe(false);
  // Wallet on Base Sepolia likewise.
  expect(checkoutNet.canAttemptPayment({ view, isConnected: true, walletChainId: BS_CHAIN, isExpired: false })).toBe(false);
  // Correct wallet is the only one that may pay.
  expect(checkoutNet.isWrongNetwork(AS_CHAIN, view.chainId)).toBe(false);
  expect(checkoutNet.canAttemptPayment({ view, isConnected: true, walletChainId: AS_CHAIN, isExpired: false })).toBe(true);
});

test('6f: verify without the pinned chain_id is refused before any blockchain read', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-6f' });
  const pi = String(created.body.id);
  const r = await checkoutVerify(pi, txHash()); // chain_id omitted
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('wrong_network');
  expect(piStatus(pi)).toBe('requires_payment');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 7 — WRONG CHAIN (Part H proofs 2, 3, 4, 5, 13)
// ═══════════════════════════════════════════════════════════════════════════

test('7a: verify with the Arc chain id on an Arbitrum Sepolia intent is refused', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-7a' });
  const pi = String(created.body.id);
  mockProvider();
  const r = await checkoutVerify(pi, txHash(), ARC_CHAIN_TESTNET);
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('wrong_network');
  expect(piStatus(pi)).toBe('requires_payment'); // not transitioned, not verified
  expect(paymentFor(pi)).toBeFalsy();
});

test('7b: Arbitrum ONE and Base Sepolia chain ids are both refused on an AS intent', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-7b' });
  const pi = String(created.body.id);
  mockProvider();
  for (const wrong of [ARBITRUM_ONE, BS_CHAIN, 1, 137]) {
    const r = await checkoutVerify(pi, txHash(), wrong);
    expect(r.status, `chain_id ${wrong}`).toBe(400);
    expect(r.body.code).toBe('wrong_network');
  }
  expect(piStatus(pi)).toBe('requires_payment');
  expect(paymentFor(pi)).toBeFalsy();
});

test('7c: an Arc-chain endpoint cannot be verified as Arbitrum Sepolia (chain-id gate)', async () => {
  // The arbitrum_sepolia row is pointed at an endpoint that really answers
  // eth_chainId = 5042002 (Arc). verifyPayment throws BEFORE reading any receipt,
  // so a transaction from another chain can never resolve on this network.
  insertIntent('p5f_7c');
  await withStubRpc(ARC_CHAIN_TESTNET, async () => {
    await expect(arc.verifyPayment({
      txHash: txHash(), network: AS, paymentIntentId: 'p5f_7c',
      settlementAddress: AS_SETTLEMENT.toLowerCase(), expectedAmountBaseUnits: '1000000', usdcAddress: AS_USDC,
    })).rejects.toThrow(/Chain mismatch/);
    expect(piStatus('p5f_7c')).toBe('requires_payment');
    expect(paymentFor('p5f_7c')).toBeFalsy();
  });
});

test('7d: a correct-chain Arbitrum Sepolia payment does succeed (positive control)', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-7d' });
  const pi = String(created.body.id);
  mockProvider();
  const r = await checkoutVerify(pi, txHash(), AS_CHAIN);
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('succeeded');
  const payment = paymentFor(pi) as { id: string } | undefined;
  expect(payment).toBeTruthy();
  const row = getDb().prepare('SELECT network,chain_id FROM payments WHERE id=?').get(payment!.id) as Record<string, unknown>;
  expect(row.network).toBe(AS);
  expect(row.chain_id).toBe(AS_CHAIN);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 8 — WRONG USDC CONTRACT (Part H proof 6)
// ═══════════════════════════════════════════════════════════════════════════

test('8a: a Transfer emitted by another chain USDC contract is not recognized', async () => {
  insertIntent('p5f_8a');
  for (const wrong of [ARC_USDC, BS_USDC]) {
    const res = await verifyDirect('p5f_8a', txHash(), { contract: wrong });
    expect(res.success).toBe(false);
    expect(res.failureReason).toMatch(/No USDC Transfer event found/);
  }
});

test('8b: a random (non-pinned) ERC-20 contract paying the right amount is rejected', async () => {
  insertIntent('p5f_8b');
  const res = await verifyDirect('p5f_8b', txHash(), { contract: '0x1111111111111111111111111111111111111111' });
  expect(res.success).toBe(false);
  expect(res.failureReason).toMatch(/No USDC Transfer event found/);
});

test('8c: checkout with an Arc-USDC receipt is failed, not credited', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-8c' });
  const pi = String(created.body.id);
  mockProvider({ contract: ARC_USDC });
  const r = await checkoutVerify(pi, txHash(), AS_CHAIN);
  expect(r.status).toBe(422);
  expect(r.body.status).toBe('failed');
  expect(piStatus(pi)).toBe('failed');
  expect(paymentFor(pi)).toBeFalsy();
});

test('8d: the pinned contract address is the ONLY identity check (no symbol/name)', () => {
  // Identity rule: address equality in USDCAdapter.decodeTransfers. There is no
  // metadata read anywhere in the verification path — no symbol(), no name(),
  // no decimals() call, no eth_call. Asserted against the real source.
  const src = readFileSync(join(import.meta.dir, 'blockchain', 'arc-provider.ts'), 'utf8');
  expect(/symbol/i.test(src)).toBe(false);
  expect(/eth_call/.test(src)).toBe(false);
  expect(src).toMatch(/log\.address\.toLowerCase\(\) !== this\.usdcAddress/);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 9 — USDC.e REJECTION (Part I, mandatory hardening)
// ═══════════════════════════════════════════════════════════════════════════

test('9a: legacy bridged USDC.e is rejected even with correct recipient + exact amount', async () => {
  insertIntent('p5f_9a');
  const res = await verifyDirect('p5f_9a', txHash(), { contract: AS_USDC_E });
  expect(res.success).toBe(false);
  expect(res.failureReason).toMatch(/No USDC Transfer event found/);
});

test('9b: checkout cannot be satisfied by a USDC.e transfer', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-9b' });
  const pi = String(created.body.id);
  mockProvider({ contract: AS_USDC_E });
  const r = await checkoutVerify(pi, txHash(), AS_CHAIN);
  expect(r.status).toBe(422);
  expect(r.body.status).toBe('failed');
  expect(paymentFor(pi)).toBeFalsy();
});

test('9c: USDC.e is never the pinned address in the registry or the generated facts', () => {
  expect(arc.getNetworkConfig(AS).usdcAddress).toBe(AS_USDC);
  expect(arc.getNetworkConfig(AS).usdcAddress.toLowerCase()).not.toBe(AS_USDC_E.toLowerCase());
  expect(facts.getChain(AS_CHAIN)!.usdc!.address).toBe(AS_USDC);
  const row = getDb().prepare('SELECT usdc_address FROM network_configs WHERE network=?').get(AS) as { usdc_address: string };
  expect(row.usdc_address.toLowerCase()).not.toBe(AS_USDC_E.toLowerCase());
});

test('9d: no network row pins USDC.e anywhere', () => {
  const rows = getDb().prepare('SELECT network,usdc_address FROM network_configs').all() as { network: string; usdc_address: string }[];
  for (const r of rows) {
    expect(r.usdc_address.toLowerCase(), `network ${r.network}`).not.toBe(AS_USDC_E.toLowerCase());
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 10 — WRONG RECIPIENT (Part H proof 7)
// ═══════════════════════════════════════════════════════════════════════════

test('10a: a Transfer to a different recipient is rejected', async () => {
  insertIntent('p5f_10a');
  const res = await verifyDirect('p5f_10a', txHash(), { to: '0x9999999999999999999999999999999999999999' });
  expect(res.success).toBe(false);
  expect(res.failureReason).toMatch(/No Transfer to settlement address/);
});

test('10b: paying the merchant OTHER Arc wallet does not satisfy this intent', async () => {
  insertIntent('p5f_10b');
  // The merchant Arc Testnet wallet address — wrong recipient for an AS intent.
  const res = await verifyDirect('p5f_10b', txHash(), { to: SENDER.toLowerCase() });
  expect(res.success).toBe(false);
  expect(res.failureReason).toMatch(/No Transfer to settlement address/);
});

test('10c: checkout with the wrong recipient is failed, not credited', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-10c' });
  const pi = String(created.body.id);
  mockProvider({ to: '0x8888888888888888888888888888888888888888' });
  const r = await checkoutVerify(pi, txHash(), AS_CHAIN);
  expect(r.status).toBe(422);
  expect(paymentFor(pi)).toBeFalsy();
});

test('10d: recipient comes from the PI snapshot, not from the client request', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-10d' });
  const pi = String(created.body.id);
  mockProvider({ to: '0x8888888888888888888888888888888888888888' });
  // A client-supplied settlement_address / usdc_address must be ignored entirely.
  const res = await fetch(`${baseUrl}/checkout/${pi}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tx_hash: txHash(), chain_id: AS_CHAIN,
      settlement_address: '0x8888888888888888888888888888888888888888',
      usdc_address: AS_USDC_E, network: AS, amount_base_units: '1000000',
    }),
  });
  expect(res.status).toBe(422);
  expect(paymentFor(pi)).toBeFalsy();
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 11 — WRONG AMOUNT (Part H proof 8)
// ═══════════════════════════════════════════════════════════════════════════

test('11a: under-payment and over-payment are both rejected (exact match only)', async () => {
  insertIntent('p5f_11a');
  for (const amount of [999_999n, 1_000_001n, 1n, 0n]) {
    const res = await verifyDirect('p5f_11a', txHash(), { amount });
    expect(res.success, `amount ${amount}`).toBe(false);
    expect(res.failureReason).toMatch(/No Transfer to settlement address/);
  }
  const exact = await verifyDirect('p5f_11a', txHash(), { amount: 1_000_000n });
  expect(exact.success).toBe(true);
});

test('11b: a Transfer to someone else with the exact amount is still rejected', async () => {
  insertIntent('p5f_11b');
  const res = await verifyDirect('p5f_11b', txHash(), {
    to: '0x9999999999999999999999999999999999999999', amount: 1_000_000n,
  });
  expect(res.success).toBe(false);
});

test('11c: a partial payment is rejected', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-11c' });
  const pi = String(created.body.id);
  mockProvider({ amount: 500_000n }); // half of the pinned 1,000,000
  const r = await checkoutVerify(pi, txHash(), AS_CHAIN);
  expect(r.status).toBe(422);
  expect(paymentFor(pi)).toBeFalsy();
});

test('11d: amount is pinned by the PI — a client-supplied amount is ignored', async () => {
  const created = await createIntent('sk_test_5f', { amount: '9.99', network: AS, order_id: 'p5f-11d' });
  const pi = String(created.body.id); // expects 9,990,000 units
  mockProvider({ amount: 1_000_000n });
  const res = await fetch(`${baseUrl}/checkout/${pi}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx_hash: txHash(), chain_id: AS_CHAIN, amount_base_units: '1000000' }),
  });
  expect(res.status).toBe(422);
  expect(paymentFor(pi)).toBeFalsy();
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 12 — REPLAY (Part H proof 9: existing idempotent replay semantics)
// ═══════════════════════════════════════════════════════════════════════════

test('12a: the same tx_hash cannot be credited twice for one intent', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-12a' });
  const pi = String(created.body.id);
  mockProvider();
  const h = txHash();
  const first = await checkoutVerify(pi, h, AS_CHAIN);
  expect(first.body.status).toBe('succeeded');
  expect((getDb().prepare('SELECT COUNT(*) AS n FROM payments WHERE tx_hash=? AND network=?').get(h, AS) as { n: number }).n).toBe(1);

  const second = await checkoutVerify(pi, h, AS_CHAIN);
  expect(second.body.status).toBe('succeeded'); // idempotent already-succeeded
  expect((getDb().prepare('SELECT COUNT(*) AS n FROM payments WHERE tx_hash=? AND network=?').get(h, AS) as { n: number }).n).toBe(1);
  expect((getDb().prepare('SELECT COUNT(*) AS n FROM blockchain_transactions WHERE tx_hash=? AND network=?').get(h, AS) as { n: number }).n).toBe(1);
});

test('12b: a recorded tx_hash is refused for a SECOND Arbitrum Sepolia intent', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-12b' });
  const pi = String(created.body.id);
  mockProvider();
  const h = txHash();
  expect((await checkoutVerify(pi, h, AS_CHAIN)).body.status).toBe('succeeded');

  const other = insertIntent('p5f_12b_other');
  const res = await verifyDirect(other, h); // same hash, same network, different intent
  expect(res.success).toBe(false);
  expect(res.failureReason).toMatch(/already recorded .* possible replay/);
  expect(paymentFor(other)).toBeFalsy();
});

test('12c: a real Arbitrum tx cannot be replayed onto an Arc intent (contract pinning)', async () => {
  // blockchain_transactions is keyed (tx_hash, network), so cross-network replay
  // is blocked by the money rules themselves: the emitting contract of a real
  // Arbitrum Sepolia USDC transfer can never equal the Arc-pinned USDC address.
  const arcIntent = await createIntent('sk_test_5f', { amount: '1.00', order_id: 'p5f-12c' });
  expect(arcIntent.body.network).toBe(ARC_TESTNET);
  const pi = String(arcIntent.body.id);
  mockProvider({ contract: AS_USDC, to: SENDER.toLowerCase() }); // an Arbitrum-USDC receipt
  const r = await checkoutVerify(pi, txHash(), ARC_CHAIN_TESTNET);
  expect(r.status).toBe(422);
  expect(paymentFor(pi)).toBeFalsy();
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 13 — REVERTED TRANSACTION (Part H proof 11)
// ═══════════════════════════════════════════════════════════════════════════

test('13a: a reverted receipt is rejected by the rule pipeline', async () => {
  insertIntent('p5f_13a');
  const res = await verifyDirect('p5f_13a', txHash(), { status: 'reverted' });
  expect(res.success).toBe(false);
  expect(res.failureReason).toMatch(/receipt status is "reverted"/);
});

test('13b: checkout with a reverted receipt ends failed and credits nothing', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-13b' });
  const pi = String(created.body.id);
  mockProvider({ status: 'reverted' });
  const r = await checkoutVerify(pi, txHash(), AS_CHAIN);
  expect(r.status).toBe(422);
  expect(r.body.status).toBe('failed');
  expect(piStatus(pi)).toBe('failed');
  expect(paymentFor(pi)).toBeFalsy();
  const evt = getDb().prepare("SELECT event_type FROM payment_events WHERE payment_intent_id=? AND event_type='payment.failed'").get(pi);
  expect(evt).toBeTruthy();
});

test('13c: terminal states cannot be re-verified after a failure', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-13c' });
  const pi = String(created.body.id);
  mockProvider({ status: 'reverted' });
  expect((await checkoutVerify(pi, txHash(), AS_CHAIN)).status).toBe(422);
  mockProvider(); // now a perfectly valid receipt — but the intent is terminal
  const again = await checkoutVerify(pi, txHash(), AS_CHAIN);
  expect(again.status).toBe(400);
  expect(String(again.body.error)).toContain('failed');
  expect(paymentFor(pi)).toBeFalsy();
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 14 — EXPIRY (Part H proof 12: existing expiry + settlement grace)
// ═══════════════════════════════════════════════════════════════════════════

const GRACE = 20 * 60; // PI_SETTLEMENT_GRACE_S

test('14a: past the grace window the intent is expired and cannot be credited', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-14a' });
  const pi = String(created.body.id);
  getDb().prepare('UPDATE payment_intents SET expires_at=? WHERE id=?').run(Math.floor(Date.now() / 1000) - GRACE - 600, pi);
  mockProvider();
  const r = await checkoutVerify(pi, txHash(), AS_CHAIN);
  expect(r.status).toBe(400);
  expect(r.body.status).toBe('expired');
  expect(piStatus(pi)).toBe('expired');
  expect(paymentFor(pi)).toBeFalsy();
});

test('14b: inside the grace window a settled payment is still verified and credited', async () => {
  insertIntent('p5f_14b', { status: 'expired', expiresAt: Math.floor(Date.now() / 1000) - 60 });
  mockProvider();
  const r = await checkoutVerify('p5f_14b', txHash(), AS_CHAIN);
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('succeeded');
  expect(paymentFor('p5f_14b')).toBeTruthy();
});

test('14c: the rule pipeline independently enforces expiry + grace', async () => {
  insertIntent('p5f_14c', { expiresAt: Math.floor(Date.now() / 1000) - GRACE - 10 });
  const res = await verifyDirect('p5f_14c', txHash());
  expect(res.success).toBe(false);
  expect(res.failureReason).toMatch(/has expired/);
});

test('14d: a cancelled Arbitrum Sepolia intent is terminal', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-14d' });
  const pi = String(created.body.id);
  const cancel = await fetch(`${baseUrl}/v1/payment-intents/${pi}/cancel`, {
    method: 'POST', headers: { Authorization: 'Bearer sk_test_5f', 'Content-Type': 'application/json' }, body: '{}',
  });
  expect(cancel.status).toBe(200);
  mockProvider();
  const r = await checkoutVerify(pi, txHash(), AS_CHAIN);
  expect(r.status).toBe(400);
  expect(paymentFor(pi)).toBeFalsy();
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 15 — CONFIRMATION / FINALITY GATE (Part H proof 14, Part B choice)
// ═══════════════════════════════════════════════════════════════════════════

test('15a: 23 confirmations is below the pinned threshold of 24 and is not credited', async () => {
  insertIntent('p5f_15a');
  const below = await verifyDirect('p5f_15a', txHash(), { blockNumber: 100n, head: 122n }); // 23 confirmations
  expect(below.success).toBe(false);
  expect(below.failureReason).toMatch(/Insufficient confirmations: 23 < required 24/);

  const at = await verifyDirect('p5f_15a', txHash(), { blockNumber: 100n, head: 123n }); // exactly 24
  expect(at.success).toBe(true);
});

test('15b: the threshold comes from the registry, not a hardcoded constant', async () => {
  insertIntent('p5f_15b');
  getDb().prepare('UPDATE network_configs SET required_confirmations=? WHERE network=?').run(2, AS);
  try {
    expect(arc.getNetworkConfig(AS).requiredConfirmations).toBe(2);
    const res = await verifyDirect('p5f_15b', txHash(), { blockNumber: 100n, head: 101n }); // 2 confirmations
    expect(res.success).toBe(true);
  } finally {
    migrate(); // self-healing seed restores the pinned official value
  }
  expect(arc.getNetworkConfig(AS).requiredConfirmations).toBe(AS_REQUIRED_CONFIRMATIONS);
});

test('15c: an under-confirmed tx is a hard failure through the API (pre-existing Phase 2 semantics)', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', network: AS, order_id: 'p5f-15c' });
  const pi = String(created.body.id);
  mockProvider({ blockNumber: 100n, head: 105n });
  const r = await checkoutVerify(pi, txHash(), AS_CHAIN);
  expect(r.status).toBe(422);
  expect(String(r.body.error)).toMatch(/Insufficient confirmations/);
  expect(paymentFor(pi)).toBeFalsy();
});

test('15d: Arbitrum Sepolia requires confirmations while Arc keeps credit-on-receipt', () => {
  expect(arc.getNetworkConfig(AS).requiredConfirmations).toBeGreaterThan(0);
  expect(arc.getNetworkConfig(ARC_TESTNET).requiredConfirmations).toBe(0);
  expect(arc.getNetworkConfig(ARC_MAINNET).requiredConfirmations).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 16 — ARC REGRESSION (mandate: DO NOT modify Arc behavior)
// ═══════════════════════════════════════════════════════════════════════════

test('16a: Arc Testnet/Mainnet registry rows are unchanged', () => {
  const at = arc.getNetworkConfig(ARC_TESTNET);
  expect(at.chainId).toBe(ARC_CHAIN_TESTNET);
  expect(at.usdcAddress).toBe(ARC_USDC);
  expect(at.usdcDecimals).toBe(6);
  expect(at.requiredConfirmations).toBe(0);
  const am = arc.getNetworkConfig(ARC_MAINNET);
  expect(am.chainId).toBe(5042);
  expect(am.requiredConfirmations).toBe(0);
});

test('16b: Arc still credits on receipt with no confirmation delay', async () => {
  insertIntent('p5f_16b', { network: ARC_TESTNET, chainId: ARC_CHAIN_TESTNET, usdc: ARC_USDC, settlement: SENDER.toLowerCase() });
  // head BELOW the tx block: impossible on a real chain, but proves the gate is
  // skipped entirely for required_confirmations = 0 (Arc behavior preserved).
  mockProvider({ contract: ARC_USDC, to: SENDER.toLowerCase(), blockNumber: 500n, head: 1n });
  const res = await arc.verifyPayment({
    txHash: txHash(), network: ARC_TESTNET, paymentIntentId: 'p5f_16b',
    settlementAddress: SENDER.toLowerCase(), expectedAmountBaseUnits: '1000000', usdcAddress: ARC_USDC,
  });
  expect(res.success).toBe(true);
});

test('16c: Arc checkout end-to-end still succeeds through the real API', async () => {
  const created = await createIntent('sk_test_5f', { amount: '1.00', order_id: 'p5f-16c' });
  const pi = String(created.body.id);
  mockProvider({ contract: ARC_USDC, to: SENDER.toLowerCase() });
  const r = await checkoutVerify(pi, txHash(), ARC_CHAIN_TESTNET);
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('succeeded');
  expect(paymentFor(pi)).toBeTruthy();
});

test('16d: Arc RPC deployment models are untouched (direct URL + proxy slugs)', () => {
  delete process.env.RPC_PROXY_BASE_URL;
  expect(arc.resolveRpcUrl(ARC_TESTNET, 'https://rpc.testnet.arc.io')).toBe('https://rpc.testnet.arc.io');
  process.env.RPC_PROXY_BASE_URL = 'https://proxy.example';
  process.env.RPC_PROXY_CHAINS = 'Arc_Testnet,Arc';
  process.env.RPC_PROXY_TOKEN = 'tok';
  expect(arc.resolveRpcUrl(ARC_TESTNET, 'r')).toBe('https://proxy.example/api/rpc/Arc_Testnet?_rpc_token=tok');
  expect(arc.resolveRpcUrl(ARC_MAINNET, 'r')).toBe('https://proxy.example/api/rpc/Arc?_rpc_token=tok');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 17 — BASE SEPOLIA REGRESSION (the first additional network still works)
// ═══════════════════════════════════════════════════════════════════════════

test('17a: Base Sepolia intents still snapshot their own pinned facts', async () => {
  const r = await createIntent('sk_test_5f', { amount: '1.00', network: BS, order_id: 'p5f-17a' });
  expect(r.status).toBe(201);
  expect(r.body.network).toBe(BS);
  expect(r.body.chain_id).toBe(BS_CHAIN);
  expect(r.body.usdc_address).toBe(BS_USDC);
});

test('17b: Base Sepolia finality gate is still exactly 3 confirmations', async () => {
  const bsSettlement = '0x5a7bd1b2a4b2c2d3e4f5061728394a5b6c7d8e9f';
  insertIntent('p5f_17b', { network: BS, chainId: BS_CHAIN, usdc: BS_USDC, settlement: bsSettlement });
  const call = () => {
    mockProvider({ contract: BS_USDC, to: bsSettlement, blockNumber: 100n, head: 101n });
    return arc.verifyPayment({
      txHash: txHash(), network: BS, paymentIntentId: 'p5f_17b',
      settlementAddress: bsSettlement, expectedAmountBaseUnits: '1000000', usdcAddress: BS_USDC,
    });
  };
  const below = await call(); // 2 confirmations
  expect(below.success).toBe(false);
  expect(below.failureReason).toMatch(/Insufficient confirmations: 2 < required 3/);
});

test('17c: an Arbitrum-serving endpoint cannot be used to verify Base Sepolia', async () => {
  const stub = startStubRpc(AS_CHAIN);
  getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(stub.url, BS);
  try {
    const provider = new arc.ArcProvider(BS);
    await expect(provider.ensureChainIdMatches()).rejects.toThrow(/Chain mismatch/);
  } finally {
    stub.server.stop();
    getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run('https://sepolia.base.org', BS);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 18 — NETWORK-EXPANSION HARD STOP (Part N)
// ═══════════════════════════════════════════════════════════════════════════

test('18a: enabled networks are EXACTLY the approved Circle-native-USDC payable set', () => {
  const enabled = getDb().prepare('SELECT network FROM network_configs WHERE is_enabled=1 ORDER BY network').all() as { network: string }[];
  expect(enabled.map((e) => e.network)).toEqual(EXPECTED_SLUGS); // ORDER BY network
  expect(arc.listEnabledNetworks()).toHaveLength(EXPECTED_SLUGS.length);
});

test('18b: Base Mainnet and Arbitrum One are registered, enabled, and live-class', () => {
  const rows = {
    base_mainnet: getDb().prepare('SELECT network,chain_id,is_enabled,is_testnet,finality_mode FROM network_configs WHERE network=?').get('base_mainnet') as { chain_id: number; is_enabled: number; is_testnet: number; finality_mode: string } | null,
    arbitrum_one: getDb().prepare('SELECT network,chain_id,is_enabled,is_testnet,finality_mode FROM network_configs WHERE network=?').get('arbitrum_one') as { chain_id: number; is_enabled: number; is_testnet: number; finality_mode: string } | null,
  };
  expect(rows.base_mainnet).not.toBeNull();
  expect(rows.base_mainnet!.chain_id).toBe(8453);
  expect(rows.base_mainnet!.is_enabled).toBe(1);
  expect(rows.base_mainnet!.is_testnet).toBe(0); // live-class
  expect(rows.base_mainnet!.finality_mode).toBe('finalized');
  expect(rows.arbitrum_one).not.toBeNull();
  expect(rows.arbitrum_one!.chain_id).toBe(ARBITRUM_ONE);
  expect(rows.arbitrum_one!.is_enabled).toBe(1);
  expect(rows.arbitrum_one!.is_testnet).toBe(0);
  expect(rows.arbitrum_one!.finality_mode).toBe('finalized');
  // Provider money gate now resolves both (no longer "not configured").
  expect(arc.getNetworkConfig('base_mainnet').finalityMode).toBe('finalized');
  expect(arc.getNetworkConfig('arbitrum_one').finalityMode).toBe('finalized');
});

test('18c: no held / special-handling / non-EVM / Ethereum-payable network was enabled', () => {
  for (const slug of FORBIDDEN_SLUGS_5F) {
    expect(getDb().prepare('SELECT id FROM network_configs WHERE network=? AND is_enabled=1').get(slug), `slug ${slug}`).toBeNull();
  }
  // Ethereum mainnet is allow-listed in the frontend for ENS ONLY and is never a
  // payable registry network — it has NO row at all (not even disabled).
  expect(getDb().prepare('SELECT id FROM network_configs WHERE chain_id=1').get()).toBeNull();
  const forbiddenChainIds = CIRCLE_INVENTORY
    .filter((n) => n.evm && n.chainId != null && n.status !== 'IMPLEMENTED_ENABLED')
    .map((n) => n.chainId as number);
  for (const cid of forbiddenChainIds) {
    expect(getDb().prepare('SELECT id FROM network_configs WHERE chain_id=? AND is_enabled=1').get(cid), `chain ${cid}`).toBeNull();
  }
});

test('18d: CSP adds the two curated mainnet RPC hosts and nothing broader', () => {
  expect(CSP_CONNECT_SRC).toContain('https://sepolia-rollup.arbitrum.io');
  expect(CSP_CONNECT_SRC).toContain('https://arb1.arbitrum.io'); // MASTER PHASE: Arbitrum One
  expect(CSP_CONNECT_SRC).toContain('https://mainnet.base.org'); // MASTER PHASE: Base Mainnet
  // Exactly two Arbitrum hosts (Sepolia + One) and exactly two Base hosts — no
  // wildcard RPC, no explorer host slipped in.
  expect(CSP_CONNECT_SRC.filter((h) => h.includes('arbitrum'))).toHaveLength(2);
  expect(CSP_CONNECT_SRC.filter((h) => h.includes('base'))).toHaveLength(2);
  for (const forbidden of ['rum-node.arbitrum.io', 'sepolia.arbiscan.io', 'arbiscan.io', 'basescan.org']) {
    expect(CSP_CONNECT_SRC.some((h) => h.includes(forbidden)), forbidden).toBe(false);
  }
  expect(CSP_CONNECT_SRC.some((h) => h.includes('*.arbitrum') || h.includes('*.base'))).toBe(false);
  // Existing curated hosts and Arc/Circle service domains are preserved.
  expect(CSP_CONNECT_SRC).toContain('https://sepolia.base.org');
  expect(CSP_CONNECT_SRC).toContain("'self'");
  expect(CSP_CONNECT_SRC).toContain('https://*.arc.io');
  expect(CSP_CONNECT_SRC).toContain('https://*.circle.com');
  for (const src of CSP_CONNECT_SRC) {
    expect(src).not.toBe('*');
    expect(src).not.toBe('https://*');
    expect(src.startsWith('https://') || src === "'self'").toBe(true);
  }
});

test('18e: frontend allowlist now includes Base Mainnet and Arbitrum One (curated)', async () => {
  const { SUPPORTED_CHAIN_IDS, SUPPORTED_CHAINS } = await import('../src/supported-chains.ts');
  expect(SUPPORTED_CHAIN_IDS.has(AS_CHAIN)).toBe(true);
  expect(SUPPORTED_CHAIN_IDS.has(ARBITRUM_ONE)).toBe(true); // Arbitrum One mainnet
  expect(SUPPORTED_CHAIN_IDS.has(8453)).toBe(true); // Base mainnet
  expect(SUPPORTED_CHAIN_IDS.has(ARC_CHAIN_TESTNET)).toBe(true);
  expect(SUPPORTED_CHAIN_IDS.has(BS_CHAIN)).toBe(true);
  // Still a fixed curated set — mainnet (Ethereum, id 1) is the ENS-only entry and
  // every non-enabled network (held EVM, special-handling, non-EVM) remains absent.
  expect([...SUPPORTED_CHAIN_IDS].sort((a, b) => a - b)).toEqual([...EXPECTED_PAYABLE_IDS, 1].sort((a, b) => a - b));
  expect(SUPPORTED_CHAINS[0].id).toBe(ARC_CHAIN_TESTNET); // default chain unchanged
});

test('18f: exactly one Arbitrum Sepolia row and the canonical registry rows overall', () => {
  const count = (getDb().prepare('SELECT COUNT(*) AS n FROM network_configs').get() as { n: number }).n;
  const arbRows = (getDb().prepare('SELECT COUNT(*) AS n FROM network_configs WHERE network=?').get(AS) as { n: number }).n;
  expect(arbRows).toBe(1);
  // Only the inventory-approved enabled set is ever seeded (held / special / non-EVM
  // chains are deliberately NEVER given a row), so total rows == canonical enabled count.
  expect(count).toBe(EXPECTED_SLUGS.length);
});

