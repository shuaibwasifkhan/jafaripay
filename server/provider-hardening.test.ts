/**
 * JafariPay — Provider hardening tests (bun:test, Phase 2).
 *
 * Proves the registry-driven provider cannot be tricked into chain confusion
 * and honours network_configs.required_confirmations:
 *
 *  A. RPC endpoint serves the configured chain id -> verification works.
 *  B. RPC endpoint serves a DIFFERENT chain id -> provider fails closed.
 *  MANDATORY: a network configured as chain X can NEVER verify money against
 *     an endpoint actually serving chain Y — even when that endpoint returns a
 *     perfectly valid, correctly-paid USDC receipt. No credit, no receipt read.
 *  C. Unknown network never falls back to Arc.
 *  D. RPC proxy mapping: Arc keeps its existing slugs; an unmapped network
 *     fails closed while proxy mode is enabled; nothing is ever routed to an
 *     invented Arc slug.
 *  E. required_confirmations = 0 (Arc today) -> verification identical to before,
 *     with no extra chain-head RPC.
 *  F/G. required_confirmations > 0 -> NOT credited below the threshold,
 *     credited exactly at/above it (integer block heights only).
 *  H. Invalid required_confirmations rejected at registry load.
 *  I. Invalid/missing RPC + USDC registry config rejected; an RPC that cannot
 *     answer eth_chainId fails closed (no fallback).
 *  J. Existing suites (payment-expiry, migration) run unchanged — see full run.
 *
 * Mocking policy: the chain-ID validation tests (A/B/mandatory/I-rpc) use a
 * REAL ArcProvider + REAL viem http transport against a local JSON-RPC stub
 * server — the stub fakes only the RPC endpoint itself, exactly like a lying
 * third-party provider would. Only in F/G/E are the RPC fetch methods
 * (getTransactionReceipt / getLatestBlockNumber) mocked, narrowly, so the
 * confirmation-gate arithmetic in verifyPayment runs for real.
 */
import { test, expect, beforeAll, afterEach, afterAll, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_provider_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB; // honored when run standalone; harmless when cached

const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');

const USDC = '0x3600000000000000000000000000000000000000';
const SETTLEMENT = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

// Inert fixture chain ids — no real production network is registered here.
const CHAIN_MATCH = 900011;   // served by the "honest" stub
const CHAIN_WRONG = 900012;   // registry value for the mismatch fixture
const CHAIN_FINAL = 900013;   // required_confirmations = 3 fixture

const hex = (n: number | bigint) => '0x' + BigInt(n).toString(16);
const B32 = '0x' + '11'.repeat(32);

function transferData() {
  const topics = encodeEventTopics({
    abi: [TRANSFER], eventName: 'Transfer',
    args: { from: SENDER as `0x${string}`, to: SETTLEMENT as `0x${string}` },
  });
  const data = encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]); // exact 1.00 USDC
  return { topics: topics as string[], data };
}

/** A fully valid receipt: correct contract, correct recipient, exact amount. */
function rawReceipt(txHash: string) {
  const { topics, data } = transferData();
  return {
    transactionHash: txHash, transactionIndex: '0x0', blockHash: B32, blockNumber: hex(100),
    from: SENDER, to: USDC, cumulativeGasUsed: hex(21000), gasUsed: hex(21000),
    effectiveGasPrice: hex(1), logsBloom: '0x' + '00'.repeat(256), status: '0x1',
    type: '0x0', contractAddress: null,
    logs: [{ address: USDC, topics, data, blockNumber: hex(100), blockHash: B32, logIndex: '0x0', transactionIndex: '0x0', transactionHash: txHash }],
  };
}

const rawBlock = () => ({
  number: hex(100), hash: B32, parentHash: '0x' + '22'.repeat(32),
  timestamp: hex(Math.floor(Date.now() / 1000)), nonce: null, miner: '0x' + '00'.repeat(20),
  difficulty: hex(0), totalDifficulty: hex(0), extraData: '0x', gasLimit: hex(30_000_000),
  gasUsed: hex(21000), baseFeePerGas: hex(1), size: hex(512), uncles: [], transactions: [],
});

/** Minimal JSON-RPC endpoint stub. `servesChainId` may LIE vs. the registry. */
function startStubRpc(servesChainId: number, opts: { validReceipts?: boolean } = {}) {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { jsonrpc: string; id: number; method: string; params: unknown[] };
      hits.push(body.method);
      const result = (r: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result: r });
      const error = (m: string) => Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: m } });
      switch (body.method) {
        case 'eth_chainId': return result(hex(servesChainId));
        case 'eth_blockNumber': return result(hex(100));
        case 'eth_getTransactionReceipt':
          if (!opts.validReceipts) return error('Transaction could not be found');
          return result(rawReceipt(String(body.params[0])));
        case 'eth_getBlockByNumber': return result(rawBlock());
        default: return error(`the method ${body.method} is not found`);
      }
    },
  });
  return { server, hits, url: `http://127.0.0.1:${server.port}/` };
}

let stubHonest: ReturnType<typeof startStubRpc> | undefined; // serves CHAIN_MATCH
let stubLiar: ReturnType<typeof startStubRpc> | undefined;   // serves CHAIN_MATCH, registry says CHAIN_WRONG
let seq = 0;
// Zero-padded unique hashes — deliberately a different shape than the repeat-
// pattern hashes used by payment-expiry.test.ts, so the (tx_hash, network)
// replay guard can never cross-file collide in a shared test DB.
function txHash(): string { seq++; return '0x' + seq.toString(16).padStart(64, '0'); }

function seedNetwork(id: string, network: string, chainId: number, rpcUrl: string, requiredConfirmations = 0): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,required_confirmations,is_enabled) VALUES(?,?,?,?,?,?,?,?,1)'
  ).run(id, network, chainId, rpcUrl, 'http://localhost/ex', USDC, 6, requiredConfirmations);
}

function seedPi(network: string, chainId: number, usdc: string = USDC): string {
  const db = getDb();
  const id = `ph_pi_${process.pid}_${seq++}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'INSERT INTO payment_intents(id,merchant_id,project_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,currency,status,environment,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, 'merch_ph', null, 'sw_ph', SETTLEMENT, network, chainId, usdc, '1.00', '1000000', 'USDC', 'requires_payment', 'test', now + 3600, now, now);
  return id;
}

const paymentsCount = (piId: string): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM payments WHERE payment_intent_id=?').get(piId) as { n: number }).n;

/** Internal provider-shaped receipt used to mock the two RPC fetch methods. */
function mockReceipt(blockNumber: bigint) {
  const { topics, data } = transferData();
  return {
    txHash: '0x' + 'ab'.repeat(32), status: 'success' as const, blockNumber,
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    from: SENDER, to: USDC,
    logs: [{ address: USDC.toLowerCase(), topics, data, logIndex: 0 }],
  };
}

beforeAll(() => {
  migrate(); // idempotent — also re-seeds Arc rows when the file was recreated
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_ph', 'Phase2 Merchant');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network) VALUES(?,?,?,?)')
    .run('sw_ph', 'merch_ph', SETTLEMENT, 'arc_testnet');

  stubHonest = startStubRpc(CHAIN_MATCH, { validReceipts: true });
  stubLiar = startStubRpc(CHAIN_MATCH, { validReceipts: true }); // honest money, WRONG chain
  seedNetwork('nc_ph_match', 'ph_match', CHAIN_MATCH, stubHonest!.url, 0);
  seedNetwork('nc_ph_wrong', 'ph_wrong_chain', CHAIN_WRONG, stubLiar!.url, 0);
  seedNetwork('nc_ph_final', 'ph_final', CHAIN_FINAL, 'http://127.0.0.1:1/', 3);
});

afterEach(() => {
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockRestore();
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockRestore();
});

afterAll(() => {
  const db = getDb();
  for (const id of ['nc_ph_match', 'nc_ph_wrong', 'nc_ph_final', 'nc_ph_unreach', 'nc_ph_badconf', 'nc_ph_baddconf', 'nc_ph_badrpc', 'nc_ph_badaddr', 'nc_ph_deco18']) {
    try { db.prepare('DELETE FROM network_configs WHERE id=?').run(id); } catch { /* already gone */ }
  }
  stubHonest?.server.stop();
  stubLiar?.server.stop();
  try { getDb().close(); } catch { /* already closed */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* Windows may still hold the handle briefly */ }
  }
});

// ── A. RPC serves the configured chain -> provider works ────────────────────
test('A: RPC chain id matches registry chain id -> full verification works over real HTTP', async () => {
  const pi = seedPi('ph_match', CHAIN_MATCH);
  const h = txHash();
  const result = await arc.verifyPayment({
    txHash: h, network: 'ph_match', paymentIntentId: pi,
    settlementAddress: SETTLEMENT, expectedAmountBaseUnits: '1000000', usdcAddress: USDC,
  });
  expect(result.success).toBe(true);
  expect(result.amountBaseUnits).toBe('1000000');
  expect(stubHonest!.hits).toContain('eth_chainId');
  expect(stubHonest!.hits).toContain('eth_getTransactionReceipt');
});

// ── B. RPC serves a different chain -> fail closed ──────────────────────────
test('B: RPC chain id differs from registry chain id -> provider refuses to read receipts', async () => {
  const provider = new arc.ArcProvider('ph_wrong_chain'); // registry: 900012, endpoint: 900011
  await expect(provider.getTransactionReceipt(txHash())).rejects.toThrow(/Chain mismatch/);
  // Fail closed means: the mismatch is detected and NO verification read happens.
  expect(stubLiar!.hits).toContain('eth_chainId');
  expect(stubLiar!.hits).not.toContain('eth_getTransactionReceipt');
});

// ── MANDATORY SECURITY TEST ─────────────────────────────────────────────────
test('MANDATORY: network configured as chain X cannot verify money served by chain Y', async () => {
  // The stub returns a PERFECT receipt (right contract, recipient, exact amount)
  // — but from chain 900011 while the registry row says 900012. The real viem
  // stack runs; nothing about the chain-ID validation is mocked.
  const pi = seedPi('ph_wrong_chain', CHAIN_WRONG);
  const h = txHash();
  await expect(
    arc.verifyPayment({
      txHash: h, network: 'ph_wrong_chain', paymentIntentId: pi,
      settlementAddress: SETTLEMENT, expectedAmountBaseUnits: '1000000', usdcAddress: USDC,
    })
  ).rejects.toThrow(/Chain mismatch .* refusing to verify/i);

  expect(paymentsCount(pi)).toBe(0); // not credited
  expect(stubLiar!.hits).toContain('eth_chainId');
  expect(stubLiar!.hits).not.toContain('eth_getTransactionReceipt'); // verification never even started
});

// ── C. Unknown network never falls back to Arc ──────────────────────────────
test('C: unknown network fails at registry load — no Arc fallback', () => {
  expect(() => arc.getNetworkConfig('solana_mainnet')).toThrow(/not configured or not enabled/);
  // INTENTIONALLY UPDATED BY THE MASTER EXPANSION: polygon_pos is now a real,
  // enabled registry network, so the fail-closed example must be a network that
  // is genuinely NOT enabled — Solana (non-EVM, blocked rail) and Monad (audited
  // EVM with native USDC but deliberately held for a human go-live decision).
  expect(() => new arc.ArcProvider('solana_mainnet')).toThrow(/not configured or not enabled/);
  expect(() => new arc.ArcProvider('monad')).toThrow(/not configured or not enabled/);
});

// ── D. Proxy mapping ────────────────────────────────────────────────────────
test('D: proxy mapping — Arc keeps existing slugs, unmapped network fails closed', () => {
  const saved = { base: process.env.RPC_PROXY_BASE_URL, chains: process.env.RPC_PROXY_CHAINS, token: process.env.RPC_PROXY_TOKEN };
  try {
    process.env.RPC_PROXY_BASE_URL = 'https://proxy.example';
    process.env.RPC_PROXY_CHAINS = 'Arc_Testnet,Arc';
    process.env.RPC_PROXY_TOKEN = 'tok';
    // Arc keeps its existing proxy behaviour, explicitly mapped:
    expect(arc.resolveRpcUrl('arc_testnet', 'r')).toBe('https://proxy.example/api/rpc/Arc_Testnet?_rpc_token=tok');
    expect(arc.resolveRpcUrl('arc_mainnet', 'r')).toBe('https://proxy.example/api/rpc/Arc?_rpc_token=tok');
    // Unknown network must NOT silently map to the Arc slug — fail closed:
    expect(() => arc.resolveRpcUrl('ph_match', 'r')).toThrow(/no explicit proxy mapping/);
    // Slug not selected in RPC_PROXY_CHAINS -> registry URL (existing behaviour):
    process.env.RPC_PROXY_CHAINS = 'SomethingElse';
    expect(arc.resolveRpcUrl('arc_testnet', 'registry-url')).toBe('registry-url');
  } finally {
    for (const [k, v] of Object.entries({ RPC_PROXY_BASE_URL: saved.base, RPC_PROXY_CHAINS: saved.chains, RPC_PROXY_TOKEN: saved.token })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  // Proxy mode off -> registry URL always wins:
  expect(arc.resolveRpcUrl('arc_testnet', 'registry-url')).toBe('registry-url');
  expect(arc.resolveRpcUrl('brand_new_network', 'registry-url')).toBe('registry-url');
});

// ── E. required_confirmations = 0 -> Arc behaviour exactly as before ────────
test('E: required_confirmations=0 (Arc) — verification unchanged, no chain-head RPC', async () => {
  expect(arc.getNetworkConfig('arc_testnet').requiredConfirmations).toBe(0);
  expect(arc.getNetworkConfig('arc_mainnet').requiredConfirmations).toBe(0);
  const pi = seedPi('arc_testnet', 5042002);
  const h = txHash();
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockResolvedValue(mockReceipt(100n) as never);
  let headCalls = 0;
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockImplementation(() => { headCalls++; return Promise.resolve(0n); });

  const result = await arc.verifyPayment({
    txHash: h, network: 'arc_testnet', paymentIntentId: pi,
    settlementAddress: SETTLEMENT, expectedAmountBaseUnits: '1000000', usdcAddress: USDC,
  });
  expect(result.success).toBe(true); // credited immediately — no artificial delay
  expect(headCalls).toBe(0);
});

// ── F. required_confirmations > 0 -> not credited before threshold ─────────
test('F: required_confirmations=3 — payment NOT credited below the threshold', async () => {
  const pi = seedPi('ph_final', CHAIN_FINAL);
  const h = txHash();
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockResolvedValue(mockReceipt(100n) as never);
  // head 101 -> 2 confirmations < 3
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockResolvedValue(101n as never);

  const result = await arc.verifyPayment({
    txHash: h, network: 'ph_final', paymentIntentId: pi,
    settlementAddress: SETTLEMENT, expectedAmountBaseUnits: '1000000', usdcAddress: USDC,
  });
  expect(result.success).toBe(false);
  expect(result.failureReason).toMatch(/Insufficient confirmations: 2 < required 3/);

  // Reorged-below-head edge (head < tx block) also fails closed — never negative credits.
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockResolvedValue(50n as never);
  const r2 = await arc.verifyPayment({
    txHash: txHash(), network: 'ph_final', paymentIntentId: pi,
    settlementAddress: SETTLEMENT, expectedAmountBaseUnits: '1000000', usdcAddress: USDC,
  });
  expect(r2.success).toBe(false);
  expect(r2.failureReason).toMatch(/Insufficient confirmations/);
});

// ── G. required_confirmations > 0 -> credited at/above threshold ───────────
test('G: required_confirmations=3 — credited exactly at threshold (and above)', async () => {
  const pi = seedPi('ph_final', CHAIN_FINAL);
  const receipt = mockReceipt(100n);
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockResolvedValue(receipt as never);
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockResolvedValue(102n as never); // 3 confirmations
  const at = await arc.verifyPayment({
    txHash: txHash(), network: 'ph_final', paymentIntentId: pi,
    settlementAddress: SETTLEMENT, expectedAmountBaseUnits: '1000000', usdcAddress: USDC,
  });
  expect(at.success).toBe(true);
  expect(at.blockNumber).toBe(100);

  // Same spy handle — re-point the mocked chain head to 5 confirmations.
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockResolvedValue(104n as never);
  const above = await arc.verifyPayment({
    txHash: txHash(), network: 'ph_final', paymentIntentId: pi,
    settlementAddress: SETTLEMENT, expectedAmountBaseUnits: '1000000', usdcAddress: USDC,
  });
  expect(above.success).toBe(true);
});

// ── H. Invalid required_confirmations rejected at registry load ────────────
test('H: invalid required_confirmations (negative / non-integer) rejected', () => {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,required_confirmations,is_enabled) VALUES(?,?,?,?,?,?,?,?,1)'
  ).run('nc_ph_badconf', 'ph_neg_conf', 900014, 'http://127.0.0.1:1/', 'x', USDC, 6, -1);
  expect(() => arc.getNetworkConfig('ph_neg_conf')).toThrow(/registry config invalid/);

  db.prepare(
    'INSERT OR REPLACE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,required_confirmations,is_enabled) VALUES(?,?,?,?,?,?,?,?,1)'
  ).run('nc_ph_baddconf', 'ph_frac_conf', 900015, 'http://127.0.0.1:1/', 'x', USDC, 6, 2.5);
  expect(() => arc.getNetworkConfig('ph_frac_conf')).toThrow(/required_confirmations=2\.5/);
  db.prepare('DELETE FROM network_configs WHERE id IN (?,?)').run('nc_ph_badconf', 'nc_ph_baddconf');
});

// ── I. Invalid / missing RPC configuration fails closed ────────────────────
test('I: invalid registry rows and unreachable RPC all fail closed', async () => {
  const db = getDb();
  const ins = (id: string, net: string, chain: number, rpc: string, addr: string, dec: number) =>
    db.prepare('INSERT OR REPLACE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,required_confirmations,is_enabled) VALUES(?,?,?,?,?,?,?,0,1)')
      .run(id, net, chain, rpc, 'x', addr, dec);

  ins('nc_ph_badrpc', 'ph_no_rpc', 900016, '', USDC, 6);
  expect(() => arc.getNetworkConfig('ph_no_rpc')).toThrow(/rpc_url is missing/);

  ins('nc_ph_badaddr', 'ph_bad_addr', 900017, 'http://127.0.0.1:1/', '0xnothex', 6);
  expect(() => arc.getNetworkConfig('ph_bad_addr')).toThrow(/usdc_address/);

  ins('nc_ph_deco18', 'ph_dec18', 900018, 'http://127.0.0.1:1/', USDC, 18);
  expect(() => arc.getNetworkConfig('ph_dec18')).toThrow(/USDC-only/);

  // Unreachable endpoint: eth_chainId cannot be answered -> fail closed, no fallback.
  ins('nc_ph_unreach', 'ph_unreach', 900019, 'http://127.0.0.1:1/', USDC, 6);
  const provider = new arc.ArcProvider('ph_unreach');
  // Port 1 refuses fast; viem transport retries (3x) before we surface the failure.
  await expect(provider.getTransactionReceipt(txHash())).rejects.toThrow(/Chain verification failed/);
}, 30_000);
