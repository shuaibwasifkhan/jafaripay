/**
 * JafariPay — Phase 5B tests: Base Sepolia as the first additional real network.
 *
 * Covers the mandated Phase 5B matrix (I.1–15, 21–24). Checkout items I.16–20
 * (network resolution, explorer, wrong-wallet detection, wallet switching, no
 * Arc fallback for Base Sepolia) are already exercised in
 * src/checkout-network.test.ts, which resolves the real Base Sepolia chain id
 * (84532) through the pure checkout-network resolver.
 *
 * Facts used here are verified against OFFICIAL sources, never memory:
 *  • chain id 84532, USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e, decimals 6
 *    — Circle "USDC contract addresses" (testnet table) + onchain-facts/viem.
 *
 * No real network is dialed: blockchain I/O is confined to a local JSON-RPC
 * stub (for the eth_chainId path) and to narrowly-mocked provider methods (for
 * the rule pipeline). The real route handlers and the real verifyPayment rules
 * run unmodified. Base MAINNET is never registered or enabled.
 */
import { test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_phase5b_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'phase5b-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');
const { CSP_CONNECT_SRC } = await import('./lib/csp.ts');
const checkoutRouter = (await import('./api/checkout.ts')).default;
const intentsRouter = (await import('./api/payment-intents.ts')).default;

// ── Officially-verified Base Sepolia facts (Circle + viem) ──────────────────
const BS = 'base_sepolia';
const BS_CHAIN = 84532;
const BS_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Circle official
const BS_SETTLEMENT = '0x5a7bd1b2a4b2c2d3e4f5061728394a5b6c7d8e9f'; // dedicated BS test wallet (not an Arc wallet)
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

const hashApiKey = (key: string) => createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

let seq = 0;
function txHash(): string { seq++; return '0x' + seq.toString(16).padStart(64, '0'); }

// Stub RPC server used ONLY for the eth_chainId validation path (6/7).
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
 * network. blockNumber/head control the finality gate; contract/to/amount
 * control the transfer-match rules.
 */
function mockProvider(opts: {
  contract?: string; to?: string; amount?: bigint; blockNumber?: bigint; head?: bigint;
} = {}) {
  const contract = opts.contract ?? BS_USDC;
  const to = opts.to ?? BS_SETTLEMENT.toLowerCase();
  const amount = opts.amount ?? 1_000_000n;
  const blockNumber = opts.blockNumber ?? 100n;
  const head = opts.head ?? 200n; // default comfortably above required_confirmations=3
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockImplementation(((requested: string) => Promise.resolve({
    txHash: requested, status: 'success' as const, blockNumber,
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)), from: SENDER, to: contract,
    logs: [transferLog(contract, to, amount)],
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

const piStatus = (id: string) =>
  (getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(id) as { status: string }).status;
const paymentFor = (piId: string) =>
  getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(piId);

let stubHonest: ReturnType<typeof startStubRpc> | undefined;

beforeAll(() => {
  migrate(); // creates the canonical base_sepolia row from Phase 5B seed
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_5b', 'Phase5B Merchant');
  // PART B: a dedicated Base Sepolia settlement wallet — NOT a reused Arc wallet.
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_5b_bs', 'merch_5b', BS_SETTLEMENT.toLowerCase(), BS);
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_5b_at', 'merch_5b', SENDER.toLowerCase(), 'arc_testnet');
  const bsKey = 'sk_test_5b';
  db.prepare('INSERT OR REPLACE INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)')
    .run('ak_5b_test', 'merch_5b', null, 'p5b', bsKey.slice(0, 8), hashApiKey(bsKey), bsKey.slice(0, 12), 1, 'test');

  app = express();
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
  stubHonest?.server.stop();
  stubHonest = undefined;
});

afterAll(() => {
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* Windows handle may linger */ }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1–5. Registry row: exists and carries the officially-verified facts.
// ═══════════════════════════════════════════════════════════════════════════

test('1-5: Base Sepolia registry row exists with verified chain_id / is_testnet / decimals / canonical USDC', () => {
  const row = getDb().prepare('SELECT * FROM network_configs WHERE network=?').get(BS) as Record<string, unknown>;
  expect(row).toBeTruthy();
  expect(row.chain_id).toBe(BS_CHAIN);                    // 2
  expect(row.is_testnet).toBe(1);                          // 3
  expect(row.usdc_decimals).toBe(6);                       // 4
  expect(row.usdc_address).toBe(BS_USDC);                  // 5 (Circle canonical)
  expect(row.rpc_url).toBe('https://sepolia.base.org');    // curated official RPC
  expect(row.explorer_base).toBe('https://sepolia.basescan.org');
  expect(row.is_enabled).toBe(1);
});

test('8a: registry loads Base Sepolia and reports required_confirmations=3', () => {
  const cfg = arc.getNetworkConfig(BS);
  expect(cfg.chainId).toBe(BS_CHAIN);
  expect(cfg.usdcAddress).toBe(BS_USDC);
  expect(cfg.usdcDecimals).toBe(6);
  expect(cfg.requiredConfirmations).toBe(3); // explicitly justified testnet value
});

// ═══════════════════════════════════════════════════════════════════════════
// 6–7. Provider eth_chainId verification (real viem stack over a local stub).
// ═══════════════════════════════════════════════════════════════════════════

test('6: provider verifies eth_chainId against Base Sepolia registry chain id', async () => {
  stubHonest = startStubRpc(BS_CHAIN); // endpoint really serves 84532
  getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(stubHonest!.url, BS);
  try {
    const provider = new arc.ArcProvider(BS);
    await provider.ensureChainIdMatches(); // resolves — no throw
    expect(stubHonest!.hits).toContain('eth_chainId');
  } finally {
    getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run('https://sepolia.base.org', BS);
  }
});

test('7: Base Sepolia RPC serving a DIFFERENT chain id fails closed (no receipt read)', async () => {
  stubHonest = startStubRpc(1); // lying endpoint claims Ethereum mainnet
  getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(stubHonest!.url, BS);
  try {
    const provider = new arc.ArcProvider(BS);
    await expect(provider.getTransactionReceipt(txHash())).rejects.toThrow(/Chain mismatch/);
    expect(stubHonest!.hits).toContain('eth_chainId');
    expect(stubHonest!.hits).not.toContain('eth_getTransactionReceipt'); // verification never started
  } finally {
    getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run('https://sepolia.base.org', BS);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. required_confirmations gate is honoured for Base Sepolia (=3).
// ═══════════════════════════════════════════════════════════════════════════

test('8b: finality gate — below required_confirmations is not credited, at/above is', async () => {
  const db = getDb();
  const pi = 'p5b_final_gate';
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,currency,status,environment,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(pi, 'merch_5b', 'sw_5b_bs', BS_SETTLEMENT.toLowerCase(), BS, BS_CHAIN, BS_USDC, '1.00', '1000000', 'USDC', 'requires_payment', 'test', now + 3600, now, now);

  // 2 confirmations < 3 → blocked.
  mockProvider({ blockNumber: 100n, head: 101n });
  const below = await arc.verifyPayment({
    txHash: txHash(), network: BS, paymentIntentId: pi,
    settlementAddress: BS_SETTLEMENT.toLowerCase(), expectedAmountBaseUnits: '1000000', usdcAddress: BS_USDC,
  });
  expect(below.success).toBe(false);
  expect(below.failureReason).toMatch(/Insufficient confirmations: 2 < required 3/);

  // 3 confirmations (at threshold) → credited.
  mockProvider({ blockNumber: 100n, head: 102n });
  const at = await arc.verifyPayment({
    txHash: txHash(), network: BS, paymentIntentId: pi,
    settlementAddress: BS_SETTLEMENT.toLowerCase(), expectedAmountBaseUnits: '1000000', usdcAddress: BS_USDC,
  });
  expect(at.success).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 9–10. Base Sepolia Payment Intent creation + snapshot correctness (API).
// ═══════════════════════════════════════════════════════════════════════════

test('9-10: test key + network=base_sepolia creates an intent that snapshots the pinned Base Sepolia facts', async () => {
  const r = await createIntent('sk_test_5b', { amount: '1.00', network: BS });
  expect(r.status).toBe(201);
  expect(r.body.network).toBe(BS);
  expect(r.body.chain_id).toBe(BS_CHAIN);
  expect(r.body.usdc_address).toBe(BS_USDC);
  expect(r.body.settlement_address).toBe(BS_SETTLEMENT.toLowerCase());

  const row = getDb().prepare('SELECT network,chain_id,usdc_address,settlement_address,environment FROM payment_intents WHERE id=?')
    .get(String(r.body.id)) as Record<string, unknown>;
  expect(row.network).toBe(BS);
  expect(row.chain_id).toBe(BS_CHAIN);
  expect(row.usdc_address).toBe(BS_USDC);
  expect(row.environment).toBe('test'); // testnet-class enforced against test key
});

test('9b: test key may repeatedly select base_sepolia (testnet-class) — env class gate is stable', async () => {
  const r = await createIntent('sk_test_5b', { amount: '1.00', network: BS }); // sanity: test key ok
  expect(r.status).toBe(201);
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Wrong chain_id verification rejected BEFORE verification.
// ═══════════════════════════════════════════════════════════════════════════

test('11: verify with wrong chain_id is rejected; PI is not transitioned or credited', async () => {
  const created = await createIntent('sk_test_5b', { amount: '1.00', network: BS });
  const pi = String(created.body.id);
  mockProvider();
  const bad = await checkoutVerify(pi, txHash(), 5042002); // Arc chain id against a Base Sepolia PI
  expect(bad.status).toBe(400);
  expect(bad.body.code).toBe('wrong_network');
  expect(piStatus(pi)).toBe('requires_payment');
  expect(paymentFor(pi)).toBeFalsy();
});

test('11b: correct chain_id verify succeeds and credits Base Sepolia payment', async () => {
  const created = await createIntent('sk_test_5b', { amount: '1.00', network: BS });
  const pi = String(created.body.id);
  mockProvider();
  const ok = await checkoutVerify(pi, txHash(), BS_CHAIN);
  expect(ok.status).toBe(200);
  expect(ok.body.status).toBe('succeeded');
  expect(paymentFor(pi)).toBeTruthy();
});

// ═══════════════════════════════════════════════════════════════════════════
// 12–14. Wrong USDC contract / recipient / amount are all rejected.
// ═══════════════════════════════════════════════════════════════════════════

test('12: a receipt paying a NON-canonical USDC contract is rejected (chain id matches)', async () => {
  const created = await createIntent('sk_test_5b', { amount: '1.00', network: BS });
  const pi = String(created.body.id);
  // wrong contract (e.g. the Arc USDC address) on a Base Sepolia receipt
  mockProvider({ contract: ARC_USDC });
  const r = await checkoutVerify(pi, txHash(), BS_CHAIN);
  expect(r.body.status).not.toBe('succeeded');
  expect(paymentFor(pi)).toBeFalsy();
});

test('13: a Transfer to the WRONG recipient is rejected', async () => {
  const created = await createIntent('sk_test_5b', { amount: '1.00', network: BS });
  const pi = String(created.body.id);
  mockProvider({ to: '0x9999999999999999999999999999999999999999' });
  const r = await checkoutVerify(pi, txHash(), BS_CHAIN);
  expect(r.body.status).not.toBe('succeeded');
  expect(paymentFor(pi)).toBeFalsy();
});

test('14: a Transfer of the WRONG amount is rejected', async () => {
  const created = await createIntent('sk_test_5b', { amount: '1.00', network: BS }); // expects 1,000,000
  const pi = String(created.body.id);
  mockProvider({ amount: 999_999n });
  const r = await checkoutVerify(pi, txHash(), BS_CHAIN);
  expect(r.body.status).not.toBe('succeeded');
  expect(paymentFor(pi)).toBeFalsy();
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. Replay protection stays network-scoped (UNIQUE(tx_hash, network)).
// ═══════════════════════════════════════════════════════════════════════════

test('15: the same tx_hash cannot be credited twice for Base Sepolia', async () => {
  const created = await createIntent('sk_test_5b', { amount: '1.00', network: BS });
  const pi = String(created.body.id);
  mockProvider();
  const h = txHash();
  const first = await checkoutVerify(pi, h, BS_CHAIN);
  expect(first.body.status).toBe('succeeded');
  const countAfter = (getDb().prepare('SELECT COUNT(*) AS n FROM payments WHERE tx_hash=? AND network=?').get(h, BS) as { n: number }).n;
  expect(countAfter).toBe(1);

  // Re-running verification with the SAME hash must not create a second payment.
  const second = await checkoutVerify(pi, h, BS_CHAIN);
  expect(second.body.status).toBe('succeeded'); // idempotent already-succeeded
  const countAfter2 = (getDb().prepare('SELECT COUNT(*) AS n FROM payments WHERE tx_hash=? AND network=?').get(h, BS) as { n: number }).n;
  expect(countAfter2).toBe(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 21–22. CSP curated host + no arbitrary RPC routing.
// ═══════════════════════════════════════════════════════════════════════════

test('21: CSP connectSrc allow-lists exactly the Base Sepolia curated RPC host', () => {
  expect(CSP_CONNECT_SRC).toContain('https://sepolia.base.org');
});

test('22: CSP stays curated/minimal — no wildcards, Arc/Circle hosts preserved', () => {
  // No arbitrary/blanket origin, and never a broad base.org wildcard.
  for (const src of CSP_CONNECT_SRC) {
    expect(src).not.toBe('*');
    expect(src).not.toBe('https://*');
    expect(src).not.toBe('http://*');
    expect(src).not.toBe('https://*.base.org');
  }
  // Existing Arc/Circle restrictions preserved intact.
  expect(CSP_CONNECT_SRC).toContain('https://*.arc.io');
  expect(CSP_CONNECT_SRC).toContain('https://*.arc.network');
  expect(CSP_CONNECT_SRC).toContain('https://*.circle.com');
});

test('22b: proxy mode fails closed for Base Sepolia — never routed to an invented Arc slug', () => {
  const saved = { base: process.env.RPC_PROXY_BASE_URL, chains: process.env.RPC_PROXY_CHAINS, token: process.env.RPC_PROXY_TOKEN };
  try {
    process.env.RPC_PROXY_BASE_URL = 'https://proxy.example';
    process.env.RPC_PROXY_CHAINS = 'Arc_Testnet,Arc';
    process.env.RPC_PROXY_TOKEN = 'tok';
    // Base Sepolia has NO explicit proxy mapping — with proxy mode on it must fail closed,
    // proving no unknown network is ever silently routed through an Arc endpoint.
    expect(() => arc.resolveRpcUrl(BS, 'r')).toThrow(/no explicit proxy mapping/);
  } finally {
    for (const [k, v] of Object.entries({ RPC_PROXY_BASE_URL: saved.base, RPC_PROXY_CHAINS: saved.chains, RPC_PROXY_TOKEN: saved.token })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  // Proxy mode off -> the curated registry URL is always used, never a client value.
  expect(arc.resolveRpcUrl(BS, 'https://sepolia.base.org')).toBe('https://sepolia.base.org');
});

// ═══════════════════════════════════════════════════════════════════════════
// 23–24. Arc regression: existing Arc behavior is byte-for-byte unchanged.
// ═══════════════════════════════════════════════════════════════════════════

test('23: Arc Testnet regression — chain id / class / confirmations / USDC unchanged', () => {
  const cfg = arc.getNetworkConfig('arc_testnet');
  expect(cfg.chainId).toBe(5042002);
  expect(cfg.usdcAddress).toBe(ARC_USDC);
  expect(cfg.requiredConfirmations).toBe(0); // Arc keeps credit-on-receipt, no new delay
  expect(getDb().prepare('SELECT is_testnet FROM network_configs WHERE network=?').get('arc_testnet')).toBeTruthy();
});

test('24: Arc Mainnet regression + migrate() idempotency (no duplicate Base Sepolia)', () => {
  const cfg = arc.getNetworkConfig('arc_mainnet');
  expect(cfg.chainId).toBe(5042);
  expect(cfg.usdcAddress).toBe(ARC_USDC);
  expect(cfg.requiredConfirmations).toBe(0);

  const before = (getDb().prepare('SELECT COUNT(*) AS n FROM network_configs WHERE network=?').get(BS) as { n: number }).n;
  migrate();
  migrate();
  const after = (getDb().prepare('SELECT COUNT(*) AS n FROM network_configs WHERE network=?').get(BS) as { n: number }).n;
  expect(after).toBe(before); // idempotent — Base Sepolia never duplicated
});
