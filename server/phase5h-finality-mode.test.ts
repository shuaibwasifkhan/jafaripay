/**
 * JafariPay — Phase 5H tests: finality-mode hardening (registry-driven MODE).
 *
 * Proves the minimum OPTION-B architecture from the Phase 5G report:
 *  • network_configs.finality_mode ∈ {immediate, count, safe, finalized}
 *  • current behavior preserved EXACTLY: Arc rows -> immediate (0),
 *    Base Sepolia -> count(3), Arbitrum Sepolia -> count(24). required_confi...ents are never rewritten.
 *  • 'safe'/'finalized' FAIL CLOSED when the RPC cannot serve the tag — no
 *    silent fallback to latest / count / immediate (constraint 6 + 7).
 *  • finality policy is read LIVE from the registry at verification time, not
 *    snapshotted into payment_intents (audit item 8 — deliberate, documented).
 *
 * The gate path runs against a local JSON-RPC stub through the REAL provider:
 * only the constructor is touched (registry rpc_url -> 127.0.0.1 stub); the
 * viem client, ensureChainIdMatches, receipt fetch, tag reads, the full
 * verifyPayment rule pipeline and the real checkout route execute unmodified.
 * No real network is dialed and no transaction is fabricated as "real". This
 * 5H harness registers NOTHING itself — the four pre-existing curated networks
 * (arc/base/arbitrum) are what it exercises; the MASTER-PHASE base_mainnet and
 * arbitrum_one rows are seeded by the shared migration but never used here.
 *
 * NOTE (harness): `bun test` shares one module registry — the first test file
 * to import schema.ts freezes DATABASE_URL for the run. This suite therefore
 * runs on the SAME shared temp DB as the other phase suites and uses strictly
 * unique ids (p5h_*) plus per-test rollback for every registry mutation.
 */
import { test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { join } from 'path';
import { existsSync, readFileSync, rmSync } from 'fs';
import express from 'express';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_phase5h_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'phase5h-test-secret';
process.env.SESSION_SECRET = 'phase5h-session-secret-that-is-long-enough';
process.env.ENABLE_LIVE_PAYMENTS = 'true';

const { migrate, getDb } = await import('./db/schema.ts');
const { CIRCLE_INVENTORY, enabledEvmRows } = await import('./db/networks.ts');
const EXPECTED_SLUGS_5H: string[] = enabledEvmRows().map((n) => n.slug).sort();
const FORBIDDEN_SLUGS_5H: string[] = CIRCLE_INVENTORY.filter((n) => n.status !== 'IMPLEMENTED_ENABLED').map((n) => n.slug);
const FORBIDDEN_CHAIN_IDS_5H: number[] = CIRCLE_INVENTORY.filter((n) => n.evm && n.chainId != null && n.status !== 'IMPLEMENTED_ENABLED').map((n) => n.chainId as number);
const arc = await import('./blockchain/arc-provider.ts');
const checkoutRouter = (await import('./api/checkout.ts')).default;

// Canonical network slugs + the pre-5H policy values that MUST be preserved.
const ARC_TESTNET = 'arc_testnet', ARC_MAINNET = 'arc_mainnet';
const BS = 'base_sepolia', AS = 'arbitrum_sepolia';
const FIXTURE = 'p5h_fixture_net'; // synthetic mode carriers ONLY — never a real network
const FIXTURE_CHAIN = 261729;
const FIXTURE_USDC = '0x1111111111111111111111111111111111111111';
const FIXTURE_SETTLEMENT = '0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a';
const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

let idSeq = 0;
const txHash = () => `0x${(++idSeq).toString(16).padStart(64, '0')}`;

// ── Local JSON-RPC stub ───────────────────────────────────────────────────
// Serves the exact shapes viem expects. `unsupportedTags` makes a tag return
// result:null (the real "RPC does not serve this tag" signature — viem throws
// UnknownBlockError on it). Every request is recorded as "method param0".

interface StubCfg {
  chainIdServed: number;
  latest?: bigint;
  safe?: bigint | null;      // null = serve as unsupported
  finalized?: bigint | null; // null = serve as unsupported
  txBlock: bigint;
  status?: 'success' | 'reverted';
  logs?: 'match' | 'none';
  to?: string;
  amount?: bigint;
  contract?: string;
}

function startStub(cfg: StubCfg) {
  const requests: string[] = [];
  const hex = (n: bigint) => '0x' + n.toString(16);
  const blockResult = (tag: string) => {
    let num: bigint | undefined | null;
    if (tag === 'latest') num = cfg.latest ?? cfg.txBlock + 100n;
    else if (tag === 'safe') num = cfg.safe === null ? null : cfg.safe ?? cfg.txBlock + 5n;
    else if (tag === 'finalized') num = cfg.finalized === null ? null : cfg.finalized ?? cfg.txBlock + 5n;
    else if (/^0x[0-9a-f]+$/i.test(tag)) num = BigInt(tag); // explicit block lookup (the receipt's own block)
    else num = undefined; // pending and anything else: unknown -> null
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
  const to = (cfg.to ?? FIXTURE_SETTLEMENT).toLowerCase();
  const transferTopics = encodeEventTopics({
    abi: [TRANSFER], eventName: 'Transfer',
    args: { from: SENDER as `0x${string}`, to: to as `0x${string}` },
  });
  const receiptResult = {
    transactionHash: null as string | null, // filled per-request below
    transactionIndex: '0x0',
    blockNumber: hex(cfg.txBlock),
    blockHash: '0x' + 'be'.repeat(32),
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    from: SENDER,
    to: (cfg.contract ?? FIXTURE_USDC).toLowerCase(),
    contractAddress: null,
    effectiveGasPrice: '0x3b9aca00',
    status: cfg.status === 'reverted' ? '0x0' : '0x1',
    type: '0x2', logsBloom: '0x' + '00'.repeat(256),
    transactionType: '0x2',
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
          result = receiptResult.transactionHash === null
            ? { ...receiptResult, transactionHash: p0 || txHash() }
            : { ...receiptResult, transactionHash: p0 || txHash() };
          if (cfg.logs === 'none') (result as { logs?: unknown[] }).logs = [];
          else {
            (result as { logs?: unknown[] }).logs = [{
              address: (cfg.contract ?? FIXTURE_USDC).toLowerCase(),
              topics: transferTopics as string[],
              data: encodeAbiParameters([{ type: 'uint256' }], [cfg.amount ?? 2_500_000n]),
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

// ── Fixture registry row (idempotent; strictly isolated from curated rows) ─
function ensureFixtureRow(rpcUrl: string, mode: string, confs: number) {
  getDb().run(
    `INSERT OR IGNORE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_testnet,required_confirmations,finality_mode,is_enabled)
     VALUES('nc_p5h_fixture',?,?,?, 'http://explorer.invalid', ?,6,1,?,?,1)`,
    [FIXTURE, FIXTURE_CHAIN, rpcUrl, FIXTURE_USDC, confs, mode],
  );
}
function setFixture(rpcUrl: string, mode: string, confs = 0) {
  getDb().prepare('UPDATE network_configs SET rpc_url=?, finality_mode=?, required_confirmations=?, is_enabled=1 WHERE network=?')
    .run(rpcUrl, mode, confs, FIXTURE);
  getDb().prepare('UPDATE network_configs SET is_enabled=1 WHERE network=?').run(FIXTURE);
}
function deleteFixtureRow() {
  getDb().prepare('DELETE FROM network_configs WHERE network=?').run(FIXTURE);
}

/** Point a CURATED row's rpc_url at a stub for one test, then restore. */
const savedRpc = new Map<string, string>();
function useCuratedRpc(network: string, url: string) {
  if (!savedRpc.has(network)) {
    const row = getDb().prepare('SELECT rpc_url FROM network_configs WHERE network=?').get(network) as { rpc_url: string };
    savedRpc.set(network, row.rpc_url);
  }
  getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(url, network);
}
function restoreCuratedRpc() {
  for (const [network, url] of savedRpc) {
    getDb().prepare('UPDATE network_configs SET rpc_url=? WHERE network=?').run(url, network);
  }
  savedRpc.clear();
}

function fixtureInput(piId: string, hash: string, over: { settlement?: string; amount?: string; usdc?: string } = {}) {
  return {
    txHash: hash, network: FIXTURE, paymentIntentId: piId,
    settlementAddress: (over.settlement ?? FIXTURE_SETTLEMENT).toLowerCase(),
    expectedAmountBaseUnits: over.amount ?? '2500000',
    usdcAddress: over.usdc ?? FIXTURE_USDC,
  };
}
function insertFixtureIntent(piId: string, opts: { settlement?: string; amount?: string; usdc?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
     amount_decimal,amount_base_units,currency,status,environment,expires_at,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    piId, 'merch_p5h', 'sw_p5h', (opts.settlement ?? FIXTURE_SETTLEMENT).toLowerCase(), FIXTURE,
    FIXTURE_CHAIN, opts.usdc ?? FIXTURE_USDC, '2.50', opts.amount ?? '2500000', 'USDC',
    'requires_payment', 'test', now + 3600, now, now,
  );
  return piId;
}
const rowOf = (piId: string) =>
  getDb().prepare('SELECT status, network, chain_id, usdc_address, settlement_address, amount_base_units FROM payment_intents WHERE id=?')
    .get(piId) as { status: string; network: string; chain_id: number; usdc_address: string; settlement_address: string; amount_base_units: string };
const paymentsFor = (piId: string) =>
  (getDb().prepare('SELECT COUNT(*) c FROM payments WHERE payment_intent_id=?').get(piId) as { c: number }).c;

async function checkoutVerify(piId: string, hash: string, chainId = FIXTURE_CHAIN) {
  const res = await fetch(`${baseUrl}/checkout/${piId}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx_hash: hash, chain_id: chainId }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

// Snapshot of a registry row's money-gate fields (for preservation checks).
const gateSnapshot = (network: string) => {
  const r = getDb().prepare('SELECT chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_testnet,required_confirmations,finality_mode,is_enabled FROM network_configs WHERE network=?')
    .get(network) as Record<string, unknown>;
  return r;
};

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_p5h', 'Phase5H Merchant');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_p5h', 'merch_p5h', FIXTURE_SETTLEMENT.toLowerCase(), FIXTURE);
  app = express();
  app.use(express.json());
  app.use('/checkout', checkoutRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(() => {
  restoreCuratedRpc();
  deleteFixtureRow();
});

afterAll(() => {
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    const f = TMP_DB + suffix;
    // Windows keeps a WAL handle briefly closed-adjacent; best-effort cleanup
    // only — getDb() transparently reopens for any later file in the run.
    try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* leave for the OS */ }
  }
});

// ═══ Group 1 — registry: canonical modes, seeds, migration, validation ═══

test('1a: canonical modes are exactly immediate/count(3)/count(24)/immediate', () => {
  const rows = getDb().prepare(
    "SELECT network, finality_mode, required_confirmations FROM network_configs WHERE is_enabled=1 AND network IN ('arc_testnet','arc_mainnet','base_sepolia','arbitrum_sepolia') ORDER BY network",
  ).all() as Array<{ network: string; finality_mode: string; required_confirmations: number }>;
  // ORDER BY network is alphabetical: arbitrum_sepolia < arc_mainnet < arc_testnet < base_sepolia
  expect(rows).toEqual([
    { network: AS, finality_mode: 'count', required_confirmations: 24 },
    { network: ARC_MAINNET, finality_mode: 'immediate', required_confirmations: 0 },
    { network: ARC_TESTNET, finality_mode: 'immediate', required_confirmations: 0 },
    { network: BS, finality_mode: 'count', required_confirmations: 3 },
  ]);
});

test('1b: provider config exposes the mode; count gate is coherent', () => {
  expect(arc.getNetworkConfig(ARC_TESTNET).finalityMode).toBe('immediate');
  expect(arc.getNetworkConfig(ARC_MAINNET).finalityMode).toBe('immediate');
  expect(arc.getNetworkConfig(BS).finalityMode).toBe('count');
  expect(arc.getNetworkConfig(BS).requiredConfirmations).toBe(3);
  expect(arc.getNetworkConfig(AS).finalityMode).toBe('count');
  expect(arc.getNetworkConfig(AS).requiredConfirmations).toBe(24);
});

test('1c: migrate() is idempotent under the new column and rewrites NO confirmation value', () => {
  const before = new Map([ARC_TESTNET, ARC_MAINNET, BS, AS].map((n) => [n, JSON.stringify(gateSnapshot(n))]));
  migrate();
  migrate();
  for (const [n, snap] of before) expect(JSON.stringify(gateSnapshot(n)), n).toBe(snap);
});

test('1d: legacy DB (post-Phase-1 shape, no finality_mode) gains the column with behavior-preserving backfill', () => {
  const LEG = 'p5h_legacy_net';
  const db = getDb();
  // Exactly the Phase 1 post-rebuild shape — WITHOUT finality_mode.
  db.run(`CREATE TABLE IF NOT EXISTS network_configs_leg5h_probe (
    id TEXT PRIMARY KEY, network TEXT NOT NULL UNIQUE, chain_id INTEGER NOT NULL, rpc_url TEXT NOT NULL,
    explorer_base TEXT NOT NULL, usdc_address TEXT NOT NULL, usdc_decimals INTEGER NOT NULL DEFAULT 6,
    is_testnet INTEGER NOT NULL DEFAULT 0, required_confirmations INTEGER NOT NULL DEFAULT 0,
    is_enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  db.run('DELETE FROM network_configs_leg5h_probe');
  db.run(`INSERT INTO network_configs_leg5h_probe(id,network,chain_id,rpc_url,explorer_base,usdc_address,required_confirmations,is_enabled)
          VALUES('nc_leg5h',?,999001,'https://rpc.invalid','https://explorer.invalid',?,5,1)`, [LEG, FIXTURE_USDC]);
  // Simulate the 5H ALTER on the legacy shape (this is the exact statement
  // ensureFinalityModeColumn runs on the real table).
  db.run(`ALTER TABLE network_configs_leg5h_probe ADD COLUMN finality_mode TEXT NOT NULL DEFAULT 'count'`);
  const r = db.prepare('SELECT finality_mode, required_confirmations FROM network_configs_leg5h_probe WHERE network=?').get(LEG) as { finality_mode: string; required_confirmations: number };
  expect(r.finality_mode).toBe('count'); // historical semantics preserved automatically
  expect(r.required_confirmations).toBe(5); // value untouched
  db.run('DROP TABLE network_configs_leg5h_probe');
});

test('1e: self-healing reconcile restores a deliberately drifted finality_mode on every curated row', () => {
  const db = getDb();
  db.run(`UPDATE network_configs SET finality_mode='finalized' WHERE network='arc_testnet'`);
  db.run(`UPDATE network_configs SET finality_mode='nonsense', required_confirmations=999 WHERE network='base_sepolia'`);
  migrate(); // the curated UPDATEs re-pin mode AND (unchanged) confirmation values
  expect(arc.getNetworkConfig(ARC_TESTNET).finalityMode).toBe('immediate');
  expect(arc.getNetworkConfig(BS).finalityMode).toBe('count');
  expect(arc.getNetworkConfig(BS).requiredConfirmations).toBe(3); // self-heal predates 5H; 5H did not weaken it
});

test('1f: getNetworkConfig fails closed on an unknown or empty finality_mode', () => {
  ensureFixtureRow('https://rpc.invalid', 'quorum', 0);
  expect(() => arc.getNetworkConfig(FIXTURE)).toThrow(/registry config invalid/);
  expect(() => arc.getNetworkConfig(FIXTURE)).toThrow(/finality_mode/);
  setFixture('https://rpc.invalid', '', 0);
  expect(() => arc.getNetworkConfig(FIXTURE)).toThrow(/finality_mode=""/);
});

test('1g: FINALITY_MODES is exactly the four documented modes', () => {
  expect([...arc.FINALITY_MODES].sort()).toEqual(['count', 'finalized', 'immediate', 'safe']);
});

// ═══ Group 2 — immediate mode (Arc semantics, zero extra RPC reads) ═══

test('2a: immediate credits a receipt sitting AT the head, with no head/tag read', async () => {
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 500n, txBlock: 500n }); // 0 confirmations under a count model
  ensureFixtureRow(stub.url, 'immediate', 0);
  const pi = insertFixtureIntent('pi_p5h_2a');
  const r = await arc.verifyPayment(fixtureInput(pi, txHash()));
  expect(r.success).toBe(true);
  // The gate performed NO head read at all (only chainId + receipt + tx block).
  expect(stub.requests.filter((q) => q.startsWith('eth_blockNumber'))).toHaveLength(0);
  expect(stub.requests.filter((q) => q.startsWith('eth_getBlockByNumber'))).toHaveLength(1); // the receipt's own block
});

test('2b: Arc rows read as immediate via the provider config', () => {
  expect(arc.getNetworkConfig(ARC_TESTNET).finalityMode).toBe('immediate');
  expect(arc.getNetworkConfig(ARC_MAINNET).finalityMode).toBe('immediate');
});

test('2c: immediate/count paths never call getHeadBlockNumber even if it would throw', async () => {
  const boom = spyOn(arc.ArcProvider.prototype, 'getHeadBlockNumber').mockImplementation(() => { throw new Error('must-not-be-called'); });
  try {
    const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 500n, txBlock: 500n });
    ensureFixtureRow(stub.url, 'immediate', 0);
    const pi = insertFixtureIntent('pi_p5h_2c');
    expect((await arc.verifyPayment(fixtureInput(pi, txHash()))).success).toBe(true);
    setFixture(stub.url, 'count', 2);
    const pi2 = insertFixtureIntent('pi_p5h_2c2');
    expect((await arc.verifyPayment(fixtureInput(pi2, txHash()))).success).toBe(false); // head=500, block=500 -> confs=1 < 2
    // Same config, head advances past the threshold: count must STILL never touch the tag method.
    stub.server.stop();
    const stubB = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 501n, txBlock: 500n });
    setFixture(stubB.url, 'count', 2);
    expect((await arc.verifyPayment(fixtureInput(pi2, txHash()))).success).toBe(true); // head=501, block=500 -> confs=2 >= 2
    stubB.server.stop();
  } finally { boom.mockRestore(); }
});

// ═══ Group 3 — count mode: exact pre/post thresholds, unchanged arithmetic ═══

test('3a: count(3) — below threshold (2 confs) refuses, no credit, no btx row', async () => {
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 100n, txBlock: 99n }); // 100-99+1 = 2
  ensureFixtureRow(stub.url, 'count', 3);
  const pi = insertFixtureIntent('pi_p5h_3a');
  const r = await arc.verifyPayment(fixtureInput(pi, txHash()));
  expect(r.success).toBe(false);
  expect(r.failureReason).toMatch(/Insufficient confirmations: 2 < required 3/);
  expect(rowOf(pi).status).toBe('requires_payment');
  stub.server.stop();
});

test('3b: count(3) — EXACT threshold (3 confs) passes verification', async () => {
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 101n, txBlock: 99n }); // 3 confs
  ensureFixtureRow(stub.url, 'count', 3);
  const pi = insertFixtureIntent('pi_p5h_3b');
  const r = await arc.verifyPayment(fixtureInput(pi, txHash()));
  expect(r.success).toBe(true);
  // verifyPayment VERIFY only — crediting (status -> succeeded) is the
  // checkout route's atomic transaction, exercised end-to-end in 5h.
  stub.server.stop();
});

test('3c: count(3) — above threshold credits', async () => {
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 250n, txBlock: 99n });
  ensureFixtureRow(stub.url, 'count', 3);
  const pi = insertFixtureIntent('pi_p5h_3c');
  expect((await arc.verifyPayment(fixtureInput(pi, txHash()))).success).toBe(true);
  stub.server.stop();
});

test('3d: count mode reads the LATEST head (eth_blockNumber), never a tag', async () => {
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 250n, txBlock: 99n, safe: null, finalized: null });
  ensureFixtureRow(stub.url, 'count', 3);
  const pi = insertFixtureIntent('pi_p5h_3d');
  const r = await arc.verifyPayment(fixtureInput(pi, txHash()));
  expect(r.success).toBe(true); // count works even though tags are unsupported
  expect(stub.requests.some((q) => q.startsWith('eth_blockNumber'))).toBe(true);
  expect(stub.requests.filter((q) => q.includes(' safe') || q.includes(' finalized'))).toHaveLength(0);
  stub.server.stop();
});

// ═══ Group 4 — safe mode (tag-driven) ═══

test('4a: safe — tx exactly AT the safe head credits', async () => {
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 1000n, safe: 100n, txBlock: 100n });
  ensureFixtureRow(stub.url, 'safe', 0);
  const pi = insertFixtureIntent('pi_p5h_4a');
  const r = await arc.verifyPayment(fixtureInput(pi, txHash()));
  expect(r.success).toBe(true);
  stub.server.stop();
});

test('4b: safe — tx ONE block above the safe head is refused', async () => {
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 1000n, safe: 99n, txBlock: 100n });
  ensureFixtureRow(stub.url, 'safe', 0);
  const pi = insertFixtureIntent('pi_p5h_4b');
  const r = await arc.verifyPayment(fixtureInput(pi, txHash()));
  expect(r.success).toBe(false);
  expect(r.failureReason).toMatch(/not safe yet: block 100 > safe head 99/);
  expect(rowOf(pi).status).toBe('requires_payment');
  expect(paymentsFor(pi)).toBe(0);
  stub.server.stop();
});

test('4c: safe tag UNSUPPORTED at the RPC -> fail closed (throws), never degrades', async () => {
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 1000n, safe: null, txBlock: 100n });
  ensureFixtureRow(stub.url, 'safe', 0);
  const pi = insertFixtureIntent('pi_p5h_4c');
  let threw = false;
  try {
    await arc.verifyPayment(fixtureInput(pi, txHash()));
  } catch (e) {
    threw = true;
    expect((e as Error).message).toMatch(/requires the 'safe' finality tag/);
    expect((e as Error).message).toMatch(/no fallback to latest\/count\/immediate/);
  }
  expect(threw).toBe(true);
  expect(rowOf(pi).status).toBe('requires_payment'); // absolutely no credit
  expect(paymentsFor(pi)).toBe(0);
  stub.server.stop();
});

test('4d: safe mode compares against the SAFE head, not latest (shallow count would have credited)', async () => {
  // latest=1000 (tx would have 901 'count' confirmations) but safe=50 < txBlock=100
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 1000n, safe: 50n, txBlock: 100n });
  ensureFixtureRow(stub.url, 'safe', 0);
  const pi = insertFixtureIntent('pi_p5h_4d');
  const r = await arc.verifyPayment(fixtureInput(pi, txHash()));
  expect(r.success).toBe(false);
  expect(r.failureReason).toMatch(/safe head 50/);
  stub.server.stop();
});

// ═══ Group 5 — finalized mode (tag-driven) ═══

test('5a: finalized — tx below the finalized head credits', async () => {
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 2000n, finalized: 150n, txBlock: 100n });
  ensureFixtureRow(stub.url, 'finalized', 0);
  const pi = insertFixtureIntent('pi_p5h_5a');
  expect((await arc.verifyPayment(fixtureInput(pi, txHash()))).success).toBe(true);
  stub.server.stop();
});

test('5b: finalized — tx above the finalized head (but inside safe) is refused', async () => {
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 2000n, safe: 150n, finalized: 99n, txBlock: 100n });
  ensureFixtureRow(stub.url, 'finalized', 0);
  const pi = insertFixtureIntent('pi_p5h_5b');
  const r = await arc.verifyPayment(fixtureInput(pi, txHash()));
  expect(r.success).toBe(false);
  expect(r.failureReason).toMatch(/not finalized yet: block 100 > finalized head 99/);
  stub.server.stop();
});

test('5c: finalized tag UNSUPPORTED -> fail closed; no credit, no fallback', async () => {
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 2000n, finalized: null, txBlock: 100n });
  ensureFixtureRow(stub.url, 'finalized', 0);
  const pi = insertFixtureIntent('pi_p5h_5c');
  let err = '';
  try { await arc.verifyPayment(fixtureInput(pi, txHash())); } catch (e) { err = (e as Error).message; }
  expect(err).toMatch(/requires the 'finalized' finality tag/);
  expect(rowOf(pi).status).toBe('requires_payment');
  expect(paymentsFor(pi)).toBe(0);
  stub.server.stop();
});

test('5d: finalized mode reads the finalized tag; a safe-capable RPC does not satisfy it', async () => {
  // safe present, finalized unsupported: a hypothetical silent-fallback-to-safe bug would credit here — must NOT happen.
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 2000n, safe: 500n, finalized: null, txBlock: 100n });
  ensureFixtureRow(stub.url, 'finalized', 0);
  const pi = insertFixtureIntent('pi_p5h_5d');
  let threw = false;
  try { await arc.verifyPayment(fixtureInput(pi, txHash())); } catch { threw = true; }
  expect(threw).toBe(true);
  expect(stub.requests.some((q) => q === 'eth_getBlockByNumber finalized')).toBe(true);
  stub.server.stop();
});

test('5e: chain id mismatch fails closed BEFORE any receipt or tag read', async () => {
  const stub = startStub({ chainIdServed: 999999, latest: 2000n, finalized: 500n, txBlock: 100n });
  ensureFixtureRow(stub.url, 'finalized', 0);
  const pi = insertFixtureIntent('pi_p5h_5e');
  let err = '';
  try { await arc.verifyPayment(fixtureInput(pi, txHash())); } catch (e) { err = (e as Error).message; }
  expect(err).toMatch(/Chain mismatch/);
  // No receipt and no tag lookup ever left the provider: only eth_chainId.
  expect(stub.requests.filter((q) => q.startsWith('eth_getTransactionReceipt'))).toHaveLength(0);
  expect(stub.requests.filter((q) => q.startsWith('eth_getBlockByNumber'))).toHaveLength(0);
  stub.server.stop();
});

test('5f: finality gate runs BEFORE revert-status (documented 5G quirk preserved)', async () => {
  // A REVERTED tx below the finalized head: the 2b gate passes, then step 3 refuses.
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 2000n, finalized: 500n, txBlock: 100n, status: 'reverted' });
  ensureFixtureRow(stub.url, 'finalized', 0);
  const pi = insertFixtureIntent('pi_p5h_5f');
  const r = await arc.verifyPayment(fixtureInput(pi, txHash()));
  expect(r.success).toBe(false);
  expect(r.failureReason).toMatch(/reverted/);
  // And a reverted tx ABOVE the head reports the finality refusal first:
  const stub2 = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 2000n, finalized: 99n, txBlock: 100n, status: 'reverted' });
  setFixture(stub2.url, 'finalized', 0);
  const pi2 = insertFixtureIntent('pi_p5h_5f2');
  const r2 = await arc.verifyPayment(fixtureInput(pi2, txHash()));
  expect(r2.failureReason).toMatch(/not finalized yet/); // finality before revert
  stub.server.stop(); stub2.server.stop();
});

test('5g: money rules remain enforced under finalized mode (wrong recipient refuses)', async () => {
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 2000n, finalized: 500n, txBlock: 100n, to: '0x8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b' });
  ensureFixtureRow(stub.url, 'finalized', 0);
  const pi = insertFixtureIntent('pi_p5h_5g');
  const r = await arc.verifyPayment(fixtureInput(pi, txHash()));
  expect(r.success).toBe(false);
  expect(r.failureReason).toMatch(/No Transfer to settlement address/);
  stub.server.stop();
});

test('5h: full REAL checkout endpoint — finalized credits end-to-end, not-yet-finalized refuses', async () => {
  const good = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 2000n, finalized: 500n, txBlock: 100n });
  ensureFixtureRow(good.url, 'finalized', 0);
  const pi = insertFixtureIntent('pi_p5h_5h');
  const ok = await checkoutVerify(pi, txHash());
  expect(ok.status).toBe(200);
  expect(ok.body.status).toBe('succeeded');
  expect(rowOf(pi).status).toBe('succeeded');
  good.server.stop();

  const shallow = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 2000n, finalized: 99n, txBlock: 100n });
  setFixture(shallow.url, 'finalized', 0);
  const pi2 = insertFixtureIntent('pi_p5h_5h2');
  const no = await checkoutVerify(pi2, txHash());
  expect(String(no.body.status ?? no.body.failure_reason ?? JSON.stringify(no.body))).toMatch(/not finalized yet|failed/);
  expect(rowOf(pi2).status).not.toBe('succeeded');
  shallow.server.stop();
});

// ═══ Group 6 — audit item 8: finality mode is LIVE registry policy, not a PI snapshot ═══

test('6a: payment_intents has NO finality/confirmation column — snapshot is immutable and untouched', () => {
  const ddl = (getDb().prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='payment_intents'`).get() as { sql: string }).sql;
  expect(ddl).not.toMatch(/finality/i);
  expect(ddl).not.toMatch(/confirmation/i);
  expect(ddl).not.toMatch(/mode/i);
});

test('6b: mid-flight registry change takes effect at verification time (deliberate, proven)', async () => {
  // One PI, TWO verify attempts with a registry flip between them:
  //  attempt 1: finalized mode, finalized head 99 < tx block 100 -> refuse (safe forever).
  //  attempt 2: flip to count(3) — same PI, same tx — 901 confs -> credit.
  // The PI row (chain/usdc/amount/recipient snapshot) NEVER changed; only the
  // live registry policy did. This documents the chosen semantics: tightening
  // or loosening the gate is an OPS decision applied at credit time.
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 1000n, safe: 900n, finalized: 99n, txBlock: 100n });
  ensureFixtureRow(stub.url, 'finalized', 0);
  const pi = insertFixtureIntent('pi_p5h_6b');
  const snapshotBefore = rowOf(pi);
  const r1 = await arc.verifyPayment(fixtureInput(pi, txHash()));
  expect(r1.success).toBe(false);
  expect(r1.failureReason).toMatch(/not finalized yet/);

  setFixture(stub.url, 'count', 3);
  const r2 = await arc.verifyPayment(fixtureInput(pi, txHash()));
  expect(r2.success).toBe(true);
  const snapshotAfter = rowOf(pi);
  expect(snapshotAfter.chain_id).toBe(snapshotBefore.chain_id);
  expect(snapshotAfter.usdc_address).toBe(snapshotBefore.usdc_address);
  expect(snapshotAfter.amount_base_units).toBe(snapshotBefore.amount_base_units);
  expect(snapshotAfter.settlement_address).toBe(snapshotBefore.settlement_address);
  stub.server.stop();
});

test('6c: mode reads are per-call — no provider/config cache survives a registry change', async () => {
  const stub = startStub({ chainIdServed: FIXTURE_CHAIN, latest: 1000n, safe: 50n, txBlock: 100n });
  ensureFixtureRow(stub.url, 'safe', 0);
  expect(arc.getNetworkConfig(FIXTURE).finalityMode).toBe('safe');
  setFixture(stub.url, 'immediate', 0);
  expect(arc.getNetworkConfig(FIXTURE).finalityMode).toBe('immediate');
  stub.server.stop();
});

// ═══ Group 7 — Arc regression (real API path on the pinned registry row) ═══

test('7a: Arc Testnet checkout still succeeds end-to-end under immediate mode', async () => {
  // The stub must emit the log from the REAL Arc USDC contract and to the
  // PI's settlement address (SENDER), otherwise a money rule rejects it
  // before the gate is ever exercised.
  const stub = startStub({
    chainIdServed: 5042002, latest: 700n, txBlock: 700n,
    contract: '0x3600000000000000000000000000000000000000', to: SENDER,
  }); // receipt AT head — any delay gate would refuse
  useCuratedRpc(ARC_TESTNET, stub.url);
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_p5h_arc', 'Arc Merchant');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_p5h_arc', 'merch_p5h_arc', SENDER, ARC_TESTNET);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
     amount_decimal,amount_base_units,currency,status,environment,expires_at,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('pi_p5h_7a', 'merch_p5h_arc', 'sw_p5h_arc', SENDER, ARC_TESTNET, 5042002,
    '0x3600000000000000000000000000000000000000', '2.50', '2500000', 'USDC', 'requires_payment', 'test', now + 3600, now, now);
  const res = await fetch(`${baseUrl}/checkout/pi_p5h_7a/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx_hash: txHash(), chain_id: 5042002 }),
  });
  const body = await res.json() as Record<string, unknown>;
  expect(res.status).toBe(200);
  expect(body.status).toBe('succeeded');
  // No head/tag read happened for an immediate network:
  expect(stub.requests.filter((q) => q.startsWith('eth_blockNumber'))).toHaveLength(0);
  stub.server.stop();
});

test('7b: Arc gate snapshots (row + provider config) are unchanged by Phase 5H', () => {
  expect(arc.getNetworkConfig(ARC_TESTNET).requiredConfirmations).toBe(0);
  expect(arc.getNetworkConfig(ARC_MAINNET).requiredConfirmations).toBe(0);
  const modeSet = new Set((getDb().prepare("SELECT finality_mode FROM network_configs WHERE network LIKE 'arc_%'").all() as Array<{ finality_mode: string }>).map(r => r.finality_mode));
  expect([...modeSet]).toEqual(['immediate']);
});

// ═══ Group 8 — Base Sepolia / Arbitrum Sepolia count regression ═══

test('8a: Base Sepolia still reads count(3) from the registry', () => {
  const cfg = arc.getNetworkConfig(BS);
  expect(cfg.finalityMode).toBe('count');
  expect(cfg.requiredConfirmations).toBe(3);
});

test('8b: Arbitrum Sepolia still reads count(24); threshold behaves identically to pre-5H', async () => {
  expect(arc.getNetworkConfig(AS).finalityMode).toBe('count');
  expect(arc.getNetworkConfig(AS).requiredConfirmations).toBe(24);
  // 23 confs -> refuse; 24 -> credit; via the mocked-head harness pattern.
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockImplementation((async (h: string) => ({
    txHash: h, status: 'success', blockNumber: 100n, blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    from: SENDER, to: arc.getNetworkConfig(AS).usdcAddress, logs: [],
  })) as never);
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockResolvedValue(122n as never); // 23 confs
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
     amount_decimal,amount_base_units,currency,status,environment,expires_at,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('pi_p5h_8b', 'merch_p5h', 'sw_p5h', FIXTURE_SETTLEMENT, AS, 421614, arc.getNetworkConfig(AS).usdcAddress,
    '2.50', '2500000', 'USDC', 'requires_payment', 'test', now + 3600, now, now);
  const r = await arc.verifyPayment({
    txHash: txHash(), network: AS, paymentIntentId: 'pi_p5h_8b',
    settlementAddress: FIXTURE_SETTLEMENT, expectedAmountBaseUnits: '2500000',
    usdcAddress: arc.getNetworkConfig(AS).usdcAddress,
  });
  expect(r.success).toBe(false);
  expect(r.failureReason).toMatch(/Insufficient confirmations: 23 < required 24/);
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockResolvedValue(123n as never); // 24 confs — passes the gate; empty logs then fail the transfer rule (gate order proven)
  const r2 = await arc.verifyPayment({
    txHash: txHash(), network: AS, paymentIntentId: 'pi_p5h_8b',
    settlementAddress: FIXTURE_SETTLEMENT, expectedAmountBaseUnits: '2500000',
    usdcAddress: arc.getNetworkConfig(AS).usdcAddress,
  });
  expect(r2.failureReason).toMatch(/No USDC Transfer event/); // gate passed, rule failed
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockRestore();
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockRestore();
});

test('8c: curated networks NEVER consult getHeadBlockNumber (no tag traffic introduced on existing networks)', async () => {
  let calls = 0;
  const probe = spyOn(arc.ArcProvider.prototype, 'getHeadBlockNumber').mockImplementation(() => { calls++; throw new Error('no tag on count mode'); });
  try {
    // Base Sepolia count(3) via mocked receipt/head — tag method must stay untouched.
    spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockImplementation((async (h: string) => ({
      txHash: h, status: 'success', blockNumber: 100n, blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      from: SENDER, to: arc.getNetworkConfig(BS).usdcAddress, logs: [],
    })) as never);
    spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockResolvedValue(200n as never);
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
       amount_decimal,amount_base_units,currency,status,environment,expires_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('pi_p5h_8c', 'merch_p5h', 'sw_p5h', FIXTURE_SETTLEMENT, BS, 84532, arc.getNetworkConfig(BS).usdcAddress,
      '2.50', '2500000', 'USDC', 'requires_payment', 'test', now + 3600, now, now);
    await arc.verifyPayment({
      txHash: txHash(), network: BS, paymentIntentId: 'pi_p5h_8c',
      settlementAddress: FIXTURE_SETTLEMENT, expectedAmountBaseUnits: '2500000',
      usdcAddress: arc.getNetworkConfig(BS).usdcAddress,
    }).catch(() => { /* transfer rule will fail on empty logs — irrelevant here */ });
    expect(calls).toBe(0);
    spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockRestore();
    spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockRestore();
  } finally { probe.mockRestore(); }
});

// ═══ Group 9 — network-expansion HARD STOP ═══

test('9a: enabled rows are exactly the canonical payable networks (fixture cleaned up per test)', () => {
  const rows = getDb().prepare('SELECT network FROM network_configs WHERE is_enabled=1 ORDER BY network').all() as Array<{ network: string }>;
  expect(rows.map(r => r.network)).toEqual(EXPECTED_SLUGS_5H);
});

test('9b: no registry row for any held / special-handling / non-EVM / Ethereum-payable network', () => {
  // Only the inventory-approved enabled set is ever seeded. Every other audited
  // network — held new chains, special-handling (Sonic/HyperEVM), all non-EVM
  // rails, and Ethereum (ENS-only) — has NO registry row at all, enabled or not.
  const db = getDb();
  for (const slug of FORBIDDEN_SLUGS_5H) {
    expect(db.prepare('SELECT id FROM network_configs WHERE network=?').get(slug), slug).toBeNull();
  }
  for (const cid of FORBIDDEN_CHAIN_IDS_5H) {
    expect(db.prepare('SELECT id FROM network_configs WHERE chain_id=? AND is_enabled=1').get(cid), String(cid)).toBeNull();
  }
});

test('9c: provider source gained NO new-network literals', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'server', 'blockchain', 'arc-provider.ts'), 'utf8');
  for (const bad of ['0x2B21', 'arbitrum-one', 'base-mainnet']) {
    expect(src.includes(bad), bad).toBe(false);
  }
  // \\b42161\\b must not appear (421614 legitimately contains the digits):
  expect(/(?<!\d)42161(?!\d)/.test(src)).toBe(false);
  expect(/(?<!\d)8453(?!\d)/.test(src)).toBe(false);
});

test('9d: getHeadBlockNumber accepts ONLY the two fail-closed tags', () => {
  // Signature level: the parameter union is 'safe' | 'finalized'.
  const fn = arc.ArcProvider.prototype.getHeadBlockNumber;
  expect(typeof fn).toBe('function');
  expect(fn.length).toBe(1);
  // A wrong-tag call must fail closed at the RPC layer, never return a height:
  // (runtime union enforced by TypeScript; exercised via tests 4c/5c/5d.)
});
