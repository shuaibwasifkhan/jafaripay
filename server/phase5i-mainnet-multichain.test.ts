/**
 * JafariPay — MASTER PHASE tests: Base Mainnet + Arbitrum One readiness.
 *
 * This is the single self-contained certification of the two newly-enabled
 * live-class networks. It runs the REAL provider, the REAL verifyPayment rule
 * pipeline and the REAL checkout / payment-intent routes UNMODIFIED; only the
 * registry rpc_url is redirected to a local JSON-RPC stub (useCuratedRpc) so no
 * real network is dialed, no key is used, no transaction is fabricated as real
 * and no funds move. The two mainnet rows are seeded by the shared migration —
 * this suite registers NOTHING itself.
 *
 * Harness note (matches 5H): `bun test` shares one module registry, so the first
 * file to import schema.ts freezes DATABASE_URL for the run. This suite uses the
 * SAME shared temp DB as the other phase suites, strictly-unique ids (p5i_*) and
 * restores every curated rpc_url after each test.
 *
 * Covers required items A–AG (Phase 11) plus the mandatory USDC.e security model
 * (Part 10) and the cross-network tx_hash non-collision proof (Part 12).
 */
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';
import { createHmac } from 'crypto';
import express from 'express';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_phase5i_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'phase5i-test-secret';
process.env.SESSION_SECRET = 'phase5i-session-secret-that-is-long-enough';
process.env.ENABLE_LIVE_PAYMENTS = 'true';

const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');
const checkoutRouter = (await import('./api/checkout.ts')).default;
const intentsRouter = (await import('./api/payment-intents.ts')).default;
const { CSP_CONNECT_SRC } = await import('./lib/csp.ts');
const facts = await import('../src/onchain-facts.ts');
const { SUPPORTED_CHAIN_IDS } = await import('../src/supported-chains.ts');
const { CIRCLE_INVENTORY, enabledEvmRows } = await import('./db/networks.ts');
const PAYABLE_CHAIN_IDS_5I: number[] = enabledEvmRows().map((n) => n.chainId as number).sort((a, b) => a - b);
const HOLD_CHAIN_IDS_5I: number[] = CIRCLE_INVENTORY.filter((n) => n.evm && n.chainId != null && n.status !== 'IMPLEMENTED_ENABLED').map((n) => n.chainId as number);

// ── Officially-verified mainnet facts (already confirmed live in Phase 5I) ──
const BASE = 'base_mainnet';
const BASE_CHAIN = 8453;
const BASE_RPC = 'https://mainnet.base.org';
const BASE_EXPLORER = 'https://basescan.org';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Circle native USDC on Base

const ARB = 'arbitrum_one';
const ARB_CHAIN = 42161;
const ARB_RPC = 'https://arb1.arbitrum.io/rpc';
const ARB_EXPLORER = 'https://arbiscan.io';
const ARB_NATIVE_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // Circle NATIVE USDC — the ONLY valid token
const ARB_USDC_E = '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'; // legacy bridged USDC.e — MUST be rejected

const SET_BASE = '0x5ba5e0a1c9d3f2b6e8a7145d0c3b2a1908f7e6d5';
const SET_ARB = '0x7c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const SAME_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const AMOUNT = '2500000'; // 2.50 USDC, 6 decimals
const AMOUNT_BIG = 2_500_000n;
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

const hashApiKey = (key: string) => createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

let idSeq = 0;
const txHash = () => `0x${(++idSeq).toString(16).padStart(64, '0')}`;

// ── Local JSON-RPC stub (identical contract to the 5H harness) ──────────────
interface StubCfg {
  chainIdServed: number;
  latest?: bigint;
  safe?: bigint | null;
  finalized?: bigint | null; // null = RPC cannot serve the tag (fail-closed trigger)
  txBlock: bigint;
  status?: 'success' | 'reverted';
  logs?: 'match' | 'none';
  to?: string;
  amount?: bigint;
  contract?: string; // the address that EMITTED the Transfer log (authoritative token)
}

function startStub(cfg: StubCfg) {
  const requests: string[] = [];
  const hex = (n: bigint) => '0x' + n.toString(16);
  const blockResult = (tag: string) => {
    let num: bigint | undefined | null;
    if (tag === 'latest') num = cfg.latest ?? cfg.txBlock + 100n;
    else if (tag === 'safe') num = cfg.safe === null ? null : cfg.safe ?? cfg.txBlock + 5n;
    else if (tag === 'finalized') num = cfg.finalized === null ? null : cfg.finalized ?? cfg.txBlock + 5n;
    else if (/^0x[0-9a-f]+$/i.test(tag)) num = BigInt(tag);
    else num = undefined;
    if (num === null || num === undefined) return null;
    return {
      number: hex(num), timestamp: hex(1_790_000_000n + num), hash: '0x' + 'ab'.repeat(32),
      parentHash: '0x' + 'cd'.repeat(32), gasUsed: '0x0', gasLimit: '0x1c9c380',
      baseFeePerGas: '0x3b9aca00', miner: '0x' + '00'.repeat(20), extraData: '0x',
      logsBloom: '0x' + '00'.repeat(256), difficulty: '0x0', totalDifficulty: '0x0',
      nonce: '0x' + '00'.repeat(8), mixHash: '0x' + '00'.repeat(32),
      transactions: [], uncles: [], receiptsRoot: '0x' + '00'.repeat(32),
      stateRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32),
      sha3Uncles: '0x' + '00'.repeat(32), size: '0x200',
    };
  };
  const to = (cfg.to ?? SET_BASE).toLowerCase();
  const transferTopics = encodeEventTopics({
    abi: [TRANSFER], eventName: 'Transfer',
    args: { from: SENDER as `0x${string}`, to: to as `0x${string}` },
  });
  const receiptResult = {
    transactionHash: null as string | null,
    transactionIndex: '0x0', blockNumber: hex(cfg.txBlock), blockHash: '0x' + 'be'.repeat(32),
    cumulativeGasUsed: '0x5208', gasUsed: '0x5208', from: SENDER,
    to: (cfg.contract ?? BASE_USDC).toLowerCase(), contractAddress: null,
    effectiveGasPrice: '0x3b9aca00', status: cfg.status === 'reverted' ? '0x0' : '0x1',
    type: '0x2', logsBloom: '0x' + '00'.repeat(256), transactionType: '0x2',
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string; params?: unknown[] };
      const p0 = Array.isArray(body.params) && typeof body.params[0] === 'string' ? body.params[0] : '';
      requests.push(`${body.method} ${p0}`);
      let result: unknown;
      switch (body.method) {
        case 'eth_chainId': result = hex(BigInt(cfg.chainIdServed)); break;
        case 'eth_blockNumber': result = hex(cfg.latest ?? cfg.txBlock + 100n); break;
        case 'eth_getBlockByNumber': result = blockResult(p0); break;
        case 'eth_getTransactionReceipt':
          result = { ...receiptResult, transactionHash: p0 || txHash() };
          if (cfg.logs === 'none') (result as { logs?: unknown[] }).logs = [];
          else {
            (result as { logs?: unknown[] }).logs = [{
              address: (cfg.contract ?? BASE_USDC).toLowerCase(),
              topics: transferTopics as string[],
              data: encodeAbiParameters([{ type: 'uint256' }], [cfg.amount ?? AMOUNT_BIG]),
              blockNumber: hex(cfg.txBlock), transactionHash: p0 || txHash(),
              logIndex: '0x0', transactionIndex: '0x0', blockHash: '0x' + 'be'.repeat(32), removed: false,
            }];
          }
          break;
        default: result = null;
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    },
  });
  return { server, requests, url: `http://127.0.0.1:${server.port}/` };
}

// ── Curated rpc_url redirection (restored after every test) ─────────────────
const savedRpc = new Map<string, string>();
function useRpc(network: string, url: string) {
  if (!savedRpc.has(network)) {
    const row = getDb().prepare('SELECT rpc_url FROM network_configs WHERE network=?').get(network) as { rpc_url: string };
    savedRpc.set(network, row.rpc_url);
  }
  getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(url, network);
}
function restoreRpc() {
  for (const [network, url] of savedRpc) {
    getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(url, network);
  }
  savedRpc.clear();
}

// ── Direct PI insert for a real mainnet (bypasses the API/env gate) ─────────
function insertPi(id: string, net: 'base' | 'arb', over: { settlement?: string; usdc?: string; amount?: string; expiresAt?: number; status?: string; chainId?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const network = net === 'base' ? BASE : ARB;
  const chainId = over.chainId ?? (net === 'base' ? BASE_CHAIN : ARB_CHAIN);
  const usdc = over.usdc ?? (net === 'base' ? BASE_USDC : ARB_NATIVE_USDC);
  const settlement = (over.settlement ?? (net === 'base' ? SET_BASE : SET_ARB)).toLowerCase();
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
     amount_decimal,amount_base_units,currency,status,environment,expires_at,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, 'merch_p5i', net === 'base' ? 'sw_p5i_base' : 'sw_p5i_arb', settlement, network,
    chainId, usdc, '2.50', over.amount ?? AMOUNT, 'USDC',
    over.status ?? 'requires_payment', 'live', over.expiresAt ?? now + 3600, now, now,
  );
  return id;
}
const rowOf = (piId: string) =>
  getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(piId) as { status: string };
const btxCount = (hash: string, network: string) =>
  (getDb().prepare('SELECT COUNT(*) c FROM blockchain_transactions WHERE tx_hash=? AND network=?').get(hash, network) as { c: number }).c;

/** Verify a base/arb PI through the REAL pipeline against a stub. */
async function verifyNet(net: 'base' | 'arb', piId: string, hash: string) {
  const network = net === 'base' ? BASE : ARB;
  const settlement = net === 'base' ? SET_BASE : SET_ARB;
  const usdc = net === 'base' ? BASE_USDC : ARB_NATIVE_USDC;
  return arc.verifyPayment({
    txHash: hash, network, paymentIntentId: piId,
    settlementAddress: settlement.toLowerCase(), expectedAmountBaseUnits: AMOUNT, usdcAddress: usdc,
  });
}

async function checkoutVerify(piId: string, hash: string, chainId: number) {
  const res = await fetch(`${baseUrl}/checkout/${piId}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx_hash: hash, chain_id: chainId }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function createIntent(auth: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/v1/payment-intents`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const readRow = (network: string) =>
  getDb().prepare('SELECT network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_testnet,required_confirmations,finality_mode,is_enabled FROM network_configs WHERE network=?').get(network) as Record<string, unknown>;

// A valid, finalized, native-USDC payment config for a network.
const okCfg = (net: 'base' | 'arb'): StubCfg => ({
  chainIdServed: net === 'base' ? BASE_CHAIN : ARB_CHAIN,
  txBlock: 100n, finalized: 500n,
  contract: net === 'base' ? BASE_USDC : ARB_NATIVE_USDC,
  to: net === 'base' ? SET_BASE : SET_ARB, amount: AMOUNT_BIG,
});

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_p5i', 'Phase5I Merchant');
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_p5i_b', 'Phase5I Merchant B');
  // Live-class settlement wallets for the two new mainnets (used by AA + AG).
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_p5i_base', 'merch_p5i', SET_BASE.toLowerCase(), BASE);
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_p5i_arb', 'merch_p5i', SET_ARB.toLowerCase(), ARB);
  const testKey = 'sk_test_p5i', liveKey = 'sk_live_p5i';
  db.prepare('INSERT OR REPLACE INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)')
    .run('ak_p5i_test', 'merch_p5i', null, 'p5i', testKey.slice(0, 8), hashApiKey(testKey), testKey.slice(0, 12), 1, 'test');
  db.prepare('INSERT OR REPLACE INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)')
    .run('ak_p5i_live', 'merch_p5i', null, 'p5i-live', liveKey.slice(0, 8), hashApiKey(liveKey), liveKey.slice(0, 12), 1, 'live');

  app = express();
  app.use(express.json());
  app.use('/checkout', checkoutRouter);
  app.use('/v1/payment-intents', intentsRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(() => restoreRpc());
afterAll(() => {
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { const f = TMP_DB + suffix; if (existsSync(f)) rmSync(f, { force: true }); } catch { /* OS handle */ }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// A–J — Registry facts for both new mainnets (Parts 2/3)
// ═══════════════════════════════════════════════════════════════════════════

test('A/B/C: exactly one row each; correct chain ids (8453 / 42161)', () => {
  const baseRows = getDb().prepare('SELECT * FROM network_configs WHERE network=?').all(BASE) as unknown[];
  const arbRows = getDb().prepare('SELECT * FROM network_configs WHERE network=?').all(ARB) as unknown[];
  expect(baseRows).toHaveLength(1);
  expect(arbRows).toHaveLength(1);
  expect(readRow(BASE).chain_id).toBe(BASE_CHAIN);
  expect(readRow(ARB).chain_id).toBe(ARB_CHAIN);
});

test('D: correct official curated RPCs', () => {
  expect(readRow(BASE).rpc_url).toBe(BASE_RPC);
  expect(readRow(ARB).rpc_url).toBe(ARB_RPC);
});

test('E: correct explorers (no trailing path, builder appends /tx)', () => {
  expect(readRow(BASE).explorer_base).toBe(BASE_EXPLORER);
  expect(readRow(ARB).explorer_base).toBe(ARB_EXPLORER);
  expect(String(readRow(BASE).explorer_base).endsWith('/')).toBe(false);
});

test('F/G: correct native USDC contracts, 6 decimals (never USDC.e on Arbitrum)', () => {
  expect(readRow(BASE).usdc_address).toBe(BASE_USDC);
  expect(readRow(ARB).usdc_address).toBe(ARB_NATIVE_USDC);
  expect(readRow(ARB).usdc_address).not.toBe(ARB_USDC_E);
  expect(readRow(BASE).usdc_decimals).toBe(6);
  expect(readRow(ARB).usdc_decimals).toBe(6);
});

test('H: both are live-class (is_testnet=0)', () => {
  expect(readRow(BASE).is_testnet).toBe(0);
  expect(readRow(ARB).is_testnet).toBe(0);
});

test('I/J: finality_mode=finalized, required_confirmations=0, enabled; provider agrees', () => {
  expect(readRow(BASE).finality_mode).toBe('finalized');
  expect(readRow(ARB).finality_mode).toBe('finalized');
  expect(readRow(BASE).required_confirmations).toBe(0);
  expect(readRow(ARB).required_confirmations).toBe(0);
  expect(readRow(BASE).is_enabled).toBe(1);
  expect(readRow(ARB).is_enabled).toBe(1);
  expect(arc.getNetworkConfig(BASE).finalityMode).toBe('finalized');
  expect(arc.getNetworkConfig(ARB).finalityMode).toBe('finalized');
  expect(arc.getNetworkConfig(BASE).chainId).toBe(BASE_CHAIN);
  expect(arc.getNetworkConfig(ARB).chainId).toBe(ARB_CHAIN);
});

test('J2: preserved policies for the four pre-existing networks are untouched', () => {
  expect(arc.getNetworkConfig('arc_testnet').finalityMode).toBe('immediate');
  expect(arc.getNetworkConfig('arc_mainnet').finalityMode).toBe('immediate');
  expect(arc.getNetworkConfig('base_sepolia').finalityMode).toBe('count');
  expect(arc.getNetworkConfig('base_sepolia').requiredConfirmations).toBe(3);
  expect(arc.getNetworkConfig('arbitrum_sepolia').finalityMode).toBe('count');
  expect(arc.getNetworkConfig('arbitrum_sepolia').requiredConfirmations).toBe(24);
});

// ═══════════════════════════════════════════════════════════════════════════
// K–Q — finalized gate for BOTH real mainnets (Parts 9)
// ═══════════════════════════════════════════════════════════════════════════

for (const net of ['base', 'arb'] as const) {
  const network = net === 'base' ? BASE : ARB;
  const label = net === 'base' ? 'Base Mainnet' : 'Arbitrum One';

  test(`K/L/N ${label}: finalized — tx at/below finalized head credits`, async () => {
    const stub = startStub(okCfg(net));
    useRpc(network, stub.url);
    const pi = insertPi(`pi_p5i_${net}_ok`, net);
    const r = await verifyNet(net, pi, txHash());
    expect(r.success).toBe(true);
    expect(r.amountBaseUnits).toBe(AMOUNT);
    stub.server.stop();
  });

  test(`M ${label}: finalized — safe-but-not-finalized (tx above finalized head) refuses`, async () => {
    // safe head comfortably above the tx, but finalized head is BELOW it: a
    // shallow/safe policy would wrongly credit; finalized must refuse.
    const stub = startStub({ ...okCfg(net), safe: 500n, finalized: 99n, txBlock: 100n });
    useRpc(network, stub.url);
    const pi = insertPi(`pi_p5i_${net}_shallow`, net);
    const r = await verifyNet(net, pi, txHash());
    expect(r.success).toBe(false);
    expect(r.failureReason).toMatch(new RegExp(`not finalized yet: block 100 > finalized head 99 on "${network}"`));
    expect(rowOf(pi).status).toBe('requires_payment');
    stub.server.stop();
  });

  test(`O ${label}: finalized tag UNSUPPORTED at the RPC -> fail closed, never degrades`, async () => {
    const stub = startStub({ ...okCfg(net), finalized: null, safe: 500n, txBlock: 100n });
    useRpc(network, stub.url);
    const pi = insertPi(`pi_p5i_${net}_noTag`, net);
    let err = '';
    try { await verifyNet(net, pi, txHash()); } catch (e) { err = (e as Error).message; }
    expect(err).toMatch(new RegExp(`Network "${network}" requires the 'finalized' finality tag`));
    expect(err).toMatch(/no fallback to latest\/count\/immediate/);
    expect(rowOf(pi).status).toBe('requires_payment');
    stub.server.stop();
  });

  test(`P/Q ${label}: a safe-capable RPC never satisfies finalized (no fallback to safe/count/immediate)`, async () => {
    const stub = startStub({ ...okCfg(net), finalized: null, safe: 1000n, txBlock: 100n });
    useRpc(network, stub.url);
    const pi = insertPi(`pi_p5i_${net}_noFallback`, net);
    let threw = false;
    try { await verifyNet(net, pi, txHash()); } catch { threw = true; }
    expect(threw).toBe(true); // would have credited under safe/count -> must NOT happen
    // The gate explicitly queried the finalized tag (never latest/safe).
    expect(stub.requests.some((q) => q === 'eth_getBlockByNumber finalized')).toBe(true);
    expect(stub.requests.filter((q) => q.startsWith('eth_blockNumber'))).toHaveLength(0);
    stub.server.stop();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// R–V — money rules remain enforced on the new mainnets
// ═══════════════════════════════════════════════════════════════════════════

test('R: wrong chain id (endpoint lies) fails closed before any receipt/tag read', async () => {
  const stub = startStub({ ...okCfg('base'), chainIdServed: 999999 });
  useRpc(BASE, stub.url);
  const pi = insertPi('pi_p5i_wrongchain', 'base');
  let err = '';
  try { await verifyNet('base', pi, txHash()); } catch (e) { err = (e as Error).message; }
  expect(err).toMatch(/Chain mismatch/);
  expect(stub.requests.filter((q) => q.startsWith('eth_getTransactionReceipt'))).toHaveLength(0);
  expect(stub.requests.filter((q) => q.startsWith('eth_getBlockByNumber'))).toHaveLength(0);
  stub.server.stop();
});

test('S: checkout refuses a client chain_id that differs from the pinned PI chain (before any read)', async () => {
  const pi = insertPi('pi_p5i_s', 'base');
  const r = await checkoutVerify(pi, txHash(), ARB_CHAIN); // PI pins 8453, client asserts 42161
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('wrong_network');
  expect(rowOf(pi).status).toBe('requires_payment');
});

test('T: wrong recipient (Transfer to another address) refuses', async () => {
  const stub = startStub({ ...okCfg('base'), to: '0x8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b' });
  useRpc(BASE, stub.url);
  const pi = insertPi('pi_p5i_t', 'base');
  const r = await verifyNet('base', pi, txHash());
  expect(r.success).toBe(false);
  expect(r.failureReason).toMatch(/No Transfer to settlement address/);
  stub.server.stop();
});

test('U: wrong amount (off by one base unit) refuses', async () => {
  const stub = startStub({ ...okCfg('base'), amount: AMOUNT_BIG - 1n });
  useRpc(BASE, stub.url);
  const pi = insertPi('pi_p5i_u', 'base');
  const r = await verifyNet('base', pi, txHash());
  expect(r.success).toBe(false);
  expect(r.failureReason).toMatch(/exact amount/);
  stub.server.stop();
});

test('V: wrong token (a non-USDC contract emits the transfer) -> no USDC Transfer, refuses', async () => {
  // intent pins native Base USDC, but the log came from an unrelated contract
  const stub = startStub({ ...okCfg('base'), contract: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  useRpc(BASE, stub.url);
  const pi = insertPi('pi_p5i_v', 'base');
  const r = await verifyNet('base', pi, txHash());
  expect(r.success).toBe(false);
  expect(r.failureReason).toMatch(/No USDC Transfer event found/);
  stub.server.stop();
});

// ═══════════════════════════════════════════════════════════════════════════
// W — PART 10 MANDATORY: Arbitrum USDC.e rejection (address is authoritative)
// ═══════════════════════════════════════════════════════════════════════════

test('W: Arbitrum USDC.e transfer with correct recipient/amount/chain/finalized MUST STILL FAIL', async () => {
  const stub = startStub({
    chainIdServed: ARB_CHAIN, txBlock: 100n, finalized: 500n,
    contract: ARB_USDC_E,               // legacy bridged USDC.e paid out
    to: SET_ARB, amount: AMOUNT_BIG,    // otherwise perfect payment
  });
  useRpc(ARB, stub.url);
  const pi = insertPi('pi_p5i_usdce', 'arb'); // pins NATIVE USDC (0xaf88)
  const r = await verifyNet('arb', pi, txHash());
  expect(r.success).toBe(false);
  expect(r.failureReason).toMatch(/No USDC Transfer event found/);
  expect(rowOf(pi).status).toBe('requires_payment');
  stub.server.stop();
});

test('W2: identical conditions but NATIVE USDC (0xaf88) MUST PASS — proves address, not symbol/name', async () => {
  const stub = startStub({
    chainIdServed: ARB_CHAIN, txBlock: 100n, finalized: 500n,
    contract: ARB_NATIVE_USDC, to: SET_ARB, amount: AMOUNT_BIG,
  });
  useRpc(ARB, stub.url);
  const pi = insertPi('pi_p5i_native', 'arb');
  const r = await verifyNet('arb', pi, txHash());
  expect(r.success).toBe(true);
  stub.server.stop();
});

// ═══════════════════════════════════════════════════════════════════════════
// X / Y — replay + expiry
// ═══════════════════════════════════════════════════════════════════════════

test('X: replay — a tx_hash already recorded on the SAME network is rejected', async () => {
  const stub = startStub(okCfg('base'));
  useRpc(BASE, stub.url);
  const h = txHash();
  // First, genuinely credit a base PI for this hash via the real route.
  const pi1 = insertPi('pi_p5i_x1', 'base');
  const ok = await checkoutVerify(pi1, h, BASE_CHAIN);
  expect(ok.status).toBe(200);
  expect(rowOf(pi1).status).toBe('succeeded');
  // A second base PI presented with the SAME (hash, network) must be refused.
  const pi2 = insertPi('pi_p5i_x2', 'base');
  const r = await verifyNet('base', pi2, h);
  expect(r.success).toBe(false);
  expect(r.failureReason).toMatch(/already recorded — possible replay/);
  stub.server.stop();
});

test('Y: expired PI (past settlement grace) is refused even with a valid finalized payment', async () => {
  const stub = startStub(okCfg('arb'));
  useRpc(ARB, stub.url);
  const pi = insertPi('pi_p5i_y', 'arb', { expiresAt: Math.floor(Date.now() / 1000) - 999999 });
  const r = await verifyNet('arb', pi, txHash());
  expect(r.success).toBe(false);
  expect(r.failureReason).toMatch(/expired/);
  stub.server.stop();
});

// ═══════════════════════════════════════════════════════════════════════════
// Z / AA — environment-class enforcement (via the real payment-intents route)
// ═══════════════════════════════════════════════════════════════════════════

test('Z: a TEST key cannot select the live-class mainnets (environment_network_mismatch)', async () => {
  for (const slug of [BASE, ARB]) {
    const r = await createIntent('sk_test_p5i', { amount: '1.00', network: slug });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('environment_network_mismatch');
  }
});

test('AA: a LIVE key may select each mainnet ONLY while it is enabled', async () => {
  // Enabled → a live-class intent is created for each mainnet.
  const b = await createIntent('sk_live_p5i', { amount: '1.00', network: BASE });
  expect(b.status).toBe(201);
  expect(b.body.network).toBe(BASE);
  expect(b.body.chain_id).toBe(BASE_CHAIN);
  const a = await createIntent('sk_live_p5i', { amount: '1.00', network: ARB });
  expect(a.status).toBe(201);
  expect(a.body.chain_id).toBe(ARB_CHAIN);

  // Disable base_mainnet → the same selection is now invalid_network (registry gate).
  getDb().prepare('UPDATE network_configs SET is_enabled=0 WHERE network=?').run(BASE);
  try {
    const off = await createIntent('sk_live_p5i', { amount: '1.00', network: BASE });
    expect(off.status).toBe(400);
    expect(off.body.code).toBe('invalid_network');
  } finally {
    migrate(); // self-healing seed re-enables the curated row
  }
  expect(arc.getNetworkConfig(BASE).chainId).toBe(BASE_CHAIN);
});

// ═══════════════════════════════════════════════════════════════════════════
// AB — merchant settlement wallet isolation across the new mainnets
// ═══════════════════════════════════════════════════════════════════════════

test('AB: same address on two networks = independent rows; a wallet never crosses networks', () => {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_p5i_same_base', 'merch_p5i', SAME_ADDR.toLowerCase(), BASE);
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_p5i_same_arb', 'merch_p5i', SAME_ADDR.toLowerCase(), ARB);
  // Two independent rows for the same (merchant,address), differing only by network.
  const rows = db.prepare('SELECT network FROM settlement_wallets WHERE merchant_id=? AND address=? ORDER BY network')
    .all('merch_p5i', SAME_ADDR.toLowerCase()) as { network: string }[];
  expect(rows.map((r) => r.network)).toEqual([ARB, BASE]);
  // Per-network selection (the exact query the intent path uses) returns ONLY the target network.
  const forBase = db.prepare('SELECT id FROM settlement_wallets WHERE merchant_id=? AND network=? AND address=? AND is_active=1')
    .all('merch_p5i', BASE, SAME_ADDR.toLowerCase()) as { id: string }[];
  expect(forBase).toHaveLength(1);
  expect(forBase[0]!.id).toBe('sw_p5i_same_base');
  // A different merchant cannot use merch_p5i's wallet on the same network.
  const other = db.prepare('SELECT id FROM settlement_wallets WHERE merchant_id=? AND network=? AND address=?')
    .get('merch_p5i_b', BASE, SAME_ADDR.toLowerCase());
  expect(other ?? null).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// AC / AD / AE — CSP, frontend allowlist, explorer URLs
// ═══════════════════════════════════════════════════════════════════════════

test('AC: CSP connect-src lists both official RPCs explicitly, no wildcard, no explorer hosts', () => {
  expect(CSP_CONNECT_SRC).toContain('https://mainnet.base.org');
  expect(CSP_CONNECT_SRC).toContain('https://arb1.arbitrum.io');
  expect(CSP_CONNECT_SRC).not.toContain('*');
  expect(CSP_CONNECT_SRC).not.toContain('https://*.');
  // Explorers are <a href> navigations, never fetch targets — must NOT be in connect-src.
  expect(CSP_CONNECT_SRC).not.toContain('basescan.org');
  expect(CSP_CONNECT_SRC).not.toContain('arbiscan.io');
});

test('AD: frontend curated allowlist contains exactly the payable chains (+ Ethereum for ENS)', () => {
  expect(SUPPORTED_CHAIN_IDS.has(BASE_CHAIN)).toBe(true);
  expect(SUPPORTED_CHAIN_IDS.has(ARB_CHAIN)).toBe(true);
  // The conservative-subset EVM mainnets enabled by the MASTER EXPANSION are now
  // payable capability entries and so ARE allow-listed.
  for (const cid of PAYABLE_CHAIN_IDS_5I) expect(SUPPORTED_CHAIN_IDS.has(cid), `payable ${cid}`).toBe(true);
  // Every HELD / special-handling EVM chain (incl. Ethereum id 1, which stays
  // ENS-only) plus all non-EVM rails must remain OUT of the payable allow-list,
  // except Ethereum which is present solely as the ENS resolution entry.
  for (const cid of HOLD_CHAIN_IDS_5I) {
    if (cid === 1) continue; // Ethereum is allow-listed for ENS, not payment
    expect(SUPPORTED_CHAIN_IDS.has(cid), `held ${cid}`).toBe(false);
  }
  // The full allowlist is exactly the payable set plus Ethereum (ENS), nothing else.
  expect([...SUPPORTED_CHAIN_IDS].sort((x, y) => x - y)).toEqual([...PAYABLE_CHAIN_IDS_5I, 1].sort((x, y) => x - y));
});

test('AE: explorer URLs resolve to each chain’s own explorer, never testnet/Arc', () => {
  expect(facts.buildTxExplorerUrl(BASE_CHAIN, '0xabc')).toBe(`${BASE_EXPLORER}/tx/0xabc`);
  expect(facts.buildTxExplorerUrl(ARB_CHAIN, '0xdef')).toBe(`${ARB_EXPLORER}/tx/0xdef`);
  expect(facts.buildTxExplorerUrl(BASE_CHAIN, '0xabc').includes('sepolia')).toBe(false);
  expect(facts.buildTxExplorerUrl(ARB_CHAIN, '0xdef').includes('sepolia')).toBe(false);
  expect(facts.buildTxExplorerUrl(ARB_CHAIN, '0xdef').includes('arc.io')).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════════
// AF / AG — cross-network isolation + SAME tx_hash non-collision (Part 12)
// ═══════════════════════════════════════════════════════════════════════════

test('AF: a tx recorded on Base is invisible to Arbitrum verification (per-network replay scope)', async () => {
  const stubBase = startStub(okCfg('base'));
  const stubArb = startStub(okCfg('arb'));
  useRpc(BASE, stubBase.url);
  useRpc(ARB, stubArb.url);
  const h = txHash();
  // Record (h, base_mainnet) directly.
  getDb().prepare('INSERT INTO blockchain_transactions(id,tx_hash,network,chain_id,block_number,block_timestamp,from_address,to_address,usdc_address,amount,log_index,raw_receipt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('btx_p5i_af', h, BASE, BASE_CHAIN, 100, 1_790_000_000, SENDER, SET_BASE.toLowerCase(), BASE_USDC, AMOUNT, 0, '{}');
  expect(btxCount(h, BASE)).toBe(1);
  expect(btxCount(h, ARB)).toBe(0);
  // An Arbitrum PI using the SAME hash is unaffected by the Base record.
  const piArb = insertPi('pi_p5i_af_arb', 'arb');
  const r = await verifyNet('arb', piArb, h);
  expect(r.success).toBe(true);
  stubBase.server.stop(); stubArb.server.stop();
});

test('AG: SAME tx_hash on Base Mainnet and Arbitrum One is INDEPENDENTLY valid (mandatory)', async () => {
  const stubBase = startStub(okCfg('base'));
  const stubArb = startStub(okCfg('arb'));
  useRpc(BASE, stubBase.url);
  useRpc(ARB, stubArb.url);
  const sharedHash = `0x${'ca'.repeat(32)}`; // one deterministic 32-byte hash used on BOTH networks

  // Both networks credit the SAME tx_hash independently (UNIQUE(tx_hash, network)).
  const piBase = insertPi('pi_p5i_ag_base', 'base');
  const piArb = insertPi('pi_p5i_ag_arb', 'arb');
  const rb = await checkoutVerify(piBase, sharedHash, BASE_CHAIN);
  const ra = await checkoutVerify(piArb, sharedHash, ARB_CHAIN);
  expect(rb.status).toBe(200);
  expect(ra.status).toBe(200);
  expect(rowOf(piBase).status).toBe('succeeded');
  expect(rowOf(piArb).status).toBe('succeeded');
  expect(btxCount(sharedHash, BASE)).toBe(1);
  expect(btxCount(sharedHash, ARB)).toBe(1);

  // Same hash on a THIRD base PI is still rejected as replay (same-network guard intact).
  const piBase2 = insertPi('pi_p5i_ag_base2', 'base');
  const again = await verifyNet('base', piBase2, sharedHash);
  expect(again.success).toBe(false);
  expect(again.failureReason).toMatch(/already recorded — possible replay/);

  stubBase.server.stop(); stubArb.server.stop();
});
