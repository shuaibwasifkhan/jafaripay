/**
 * PHASE 21F — THE BROWSER BRIDGE AGAINST THE REAL CHECKOUT ROUTE.
 *
 * Production bug (Phase 21 UAT): a real Base → Arc CCTP Forwarding payment settled
 * on-chain (merchant netted exactly M) while `cross_chain_transfers` stayed empty
 * and the intent never left 'requires_payment'. Root cause: nothing in the browser
 * ever reported the source burn, so POST /checkout/:id/verify — the ONLY production
 * caller of detectSourceBurn() — never ran.
 *
 * This file is the regression gate at the true application boundary: it drives the
 * ACTUAL frontend bridge (src/checkout-verify-client.ts) over real HTTP against the
 * ACTUAL Express checkout router, which calls the ACTUAL detectSourceBurn() and
 * writes the ACTUAL rows. No money logic is mocked. Only two things are canned:
 *   · the source-chain provider (the cctp-burn.test.ts technique) so no live RPC is
 *     needed, with a head block that FINALISES after a couple of looks — which is
 *     precisely what the browser's repeated submission is for;
 *   · the same-chain Arc receipt (the cctp17/5N spyOn technique) for the unchanged
 *     same-chain case.
 * Fixture ids are uniquely namespaced (*_cct21f*) and the DB is per-file.
 */
import { test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem, toBytes, toHex } from 'viem';
import express from 'express';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctp21f_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp21f-test-secret';
process.env.EMAIL_TRANSPORT = 'dev';

const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');
const sourceModule = await import('./blockchain/cctp-source.ts');
const { detectSourceBurn, DEPOSIT_FOR_BURN_ABI, MESSAGE_SENT_ABI } = sourceModule;
const checkoutModule = await import('./api/checkout.ts');
const checkoutRouter = checkoutModule.default;
const { setSourceBurnDetectionForTest } = checkoutModule;
/**
 * IMPORTANT — WHY EVERY SERVER IMPORT BELOW IS `await import()` AND NOT `import`:
 * `server/db/schema.ts` resolves DB_PATH from `process.env.DATABASE_URL` ONCE, at
 * module-evaluation time. ESM `import` declarations are hoisted and run BEFORE the
 * `process.env` assignments above, so a single static import of anything that
 * touches the DB (directly or transitively) would silently point every write in this
 * file at the developer database `data/jafaripay.db`. `beforeAll` asserts that the
 * attached database is always a per-run `*_test_<pid>.db`, so the mistake cannot
 * regress invisibly.
 */
import type { SourceBurnProvider } from './blockchain/cctp-source.ts';
import type { VerifyBridgeAction, VerifyFetch } from '../src/checkout-verify-client.ts';
const { addressToBytes32, ARC_CCTP_DOMAIN, CCTP_CONTRACTS_TESTNET } = await import('./db/cctp.ts');
const { CCTP_FORWARD_HOOK_DATA } = await import('./blockchain/cctp-forwarding-fee.ts');
const { verifyCheckoutTransaction, CROSS_CHAIN_VERIFY_PROFILE, SAME_CHAIN_VERIFY_PROFILE } =
  await import('../src/checkout-verify-client.ts');

const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const DEPOSITOR = '0x9999999999999999999999999999999999999999';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';   // registry base_sepolia
const TM = CCTP_CONTRACTS_TESTNET.tokenMessengerV2;
const MT = CCTP_CONTRACTS_TESTNET.messageTransmitterV2;
const BASE_SEPOLIA_CHAIN = 84532;
const ARC_TESTNET = 'arc_testnet';
const ARC_CHAIN = 5042002;
const ARC_USDC = '0x3600000000000000000000000000000000000000';

// The UAT shape: M = 1.000000 USDC to the merchant, F = 0.016712 Circle fee, so the
// source must burn M + F. Same magnitudes, scaled to a 5.00 intent.
const M = 5_000_000n;
const F = 16_712n;
const GROSS = M + F;

const u32 = (n: number) => n.toString(16).padStart(8, '0');
const b32hex = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const addrB32 = (a: string) => addressToBytes32(a).slice(2);

const TOPIC_DEPOSIT_FOR_BURN = keccak256(toBytes(`DepositForBurn(${DEPOSIT_FOR_BURN_ABI.inputs!.map((i) => i.type).join(',')})`));
const TOPIC_MESSAGE_SENT = keccak256(toBytes(`MessageSent(${MESSAGE_SENT_ABI.inputs!.map((i) => i.type).join(',')})`));

let seq = 0;
const nextId = (p: string) => `${p}_cct21f_${++seq}`;
const burnHashFor = (n: number) => '0x' + n.toString(16).padStart(64, '0');

/** Circle CCTP V2 message, byte-for-byte per the published offsets. */
function buildCctpMessage(nonce: bigint, amount: bigint, maxFee: bigint, minFinality: number): Uint8Array {
  const wire =
    u32(1) + u32(6) + u32(ARC_CCTP_DOMAIN) + b32hex(nonce) +
    addrB32(TM) + addrB32(MT) + b32hex(0) + u32(minFinality) + u32(2000) +
    u32(1) + addrB32(SRC_USDC) + addrB32(ARC_WALLET) + b32hex(amount) +
    addrB32(DEPOSITOR) + b32hex(maxFee) + b32hex(0n) + b32hex(1_000_000n);
  return toBytes(`0x${wire}`);
}

function receiptForBurn(nonce: bigint, opts: { amount?: bigint; maxFee?: bigint; minFinality?: number; blockNumber?: bigint } = {}) {
  const amount = opts.amount ?? GROSS;
  const maxFee = opts.maxFee ?? F;
  const minFinality = opts.minFinality ?? 2000;
  const burnData = encodeAbiParameters(
    [
      { name: 'amount', type: 'uint256' }, { name: 'mintRecipient', type: 'bytes32' },
      { name: 'destinationDomain', type: 'uint32' }, { name: 'destinationTokenMessenger', type: 'bytes32' },
      { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' },
      { name: 'hookData', type: 'bytes' },
    ],
    [amount, `0x${addrB32(ARC_WALLET)}`, ARC_CCTP_DOMAIN, `0x${addrB32(TM)}`, `0x${b32hex(0)}`, maxFee, CCTP_FORWARD_HOOK_DATA],
  );
  const message = buildCctpMessage(nonce, amount, maxFee, minFinality);
  return {
    txHash: '0x' + 'b1'.repeat(32),
    status: 'success' as const,
    blockNumber: opts.blockNumber ?? 1_000n,
    blockTimestamp: 1_700_000_000n,
    from: DEPOSITOR.toLowerCase(),
    to: TM.toLowerCase(),
    logs: [
      {
        address: TM.toLowerCase(), logIndex: 0, data: burnData,
        topics: [TOPIC_DEPOSIT_FOR_BURN, `0x${addrB32(SRC_USDC)}`, `0x${addrB32(DEPOSITOR)}`, `0x${b32hex(minFinality)}`],
      },
      {
        address: MT.toLowerCase(), logIndex: 1,
        data: encodeAbiParameters([{ name: 'message', type: 'bytes' }], [toHex(message)]),
        topics: [TOPIC_MESSAGE_SENT],
      },
    ],
  };
}

/**
 * Canned source chain whose finality head can be moved between detection calls —
 * base_sepolia is finality_mode 'count' with 3 required confirmations, so head 1001
 * means "not final yet" and head >= 1002 means "final".
 */
const chain = { head: 1_001n, ticks: 0, finalizeAfter: null as number | null, providerCalls: 0, detectCalls: [] as { paymentIntentId: string; sourceTxHash: string }[] };
let pendingBurn: ReturnType<typeof receiptForBurn> | null = null;
const setPendingBurn = (r: ReturnType<typeof receiptForBurn> | null) => { pendingBurn = r; };
function fakeSourceProvider(receipt: ReturnType<typeof receiptForBurn> | null): SourceBurnProvider {
  return {
    getTransactionReceipt: async () => { chain.providerCalls += 1; return (receipt as never) ?? null; },
    // "Time" on the source chain advances with the browser's re-submissions: after
    // `finalizeAfter` looks the child blocks catch up and the burn becomes final.
    getLatestBlockNumber: async () => {
      chain.ticks += 1;
      if (chain.finalizeAfter !== null && chain.ticks >= chain.finalizeAfter) chain.head = 1_003n;
      return chain.head;
    },
    getHeadBlockNumber: async () => chain.head,
    getConfig: () => ({
      network: 'base_sepolia', chainId: BASE_SEPOLIA_CHAIN, rpcUrl: 'http://127.0.0.1:1/rpc', explorerBase: '',
      usdcAddress: SRC_USDC, usdcDecimals: 6, requiredConfirmations: 3, finalityMode: 'count',
    }),
    ensureChainIdMatches: async () => { /* the real provider proves eth_chainId */ },
  } as unknown as SourceBurnProvider;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
function insertIntent(id: string, over: { crossChain: boolean; status?: string; email?: string | null }): void {
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
       amount_decimal,amount_base_units,forwarding_max_fee_base_units,environment,expires_at,is_cross_chain,
       source_network,settlement_network,settlement_chain_id,customer_email)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, 'merch_cct21f', 'sw_cct21f', ARC_WALLET,
    over.crossChain ? 'base_sepolia' : ARC_TESTNET,
    over.crossChain ? BASE_SEPOLIA_CHAIN : ARC_CHAIN,
    over.crossChain ? SRC_USDC : ARC_USDC,
    '5.00', String(M), over.crossChain ? String(F) : '0', 'test', 9999999999,
    over.crossChain ? 1 : 0,
    over.crossChain ? 'base_sepolia' : null,
    over.crossChain ? ARC_TESTNET : null,
    over.crossChain ? ARC_CHAIN : null,
    over.email ?? null,
  );
}

const intentRow = (id: string) => getDb().prepare('SELECT * FROM payment_intents WHERE id=?').get(id) as Record<string, unknown>;
const transfersFor = (id: string) => getDb().prepare('SELECT * FROM cross_chain_transfers WHERE payment_intent_id=?').all(id) as Record<string, unknown>[];
const eventsFor = (id: string, type: string) => getDb().prepare('SELECT id FROM payment_events WHERE payment_intent_id=? AND event_type=?').all(id, type) as { id: string }[];
const paymentsFor = (id: string) => getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').all(id) as { id: string }[];

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

/** The REAL bridge, pointed at the REAL router. */
async function browserVerifies(
  id: string, chainId: number, txHash: string,
  profile: typeof CROSS_CHAIN_VERIFY_PROFILE | typeof SAME_CHAIN_VERIFY_PROFILE,
  extra: { receiptEmail?: string } = {},
): Promise<{ actions: VerifyBridgeAction[]; outcome: string }> {
  const actions: VerifyBridgeAction[] = [];
  const fetchImpl: VerifyFetch = (path, init) => fetch(baseUrl + path, init) as never;
  const outcome = await verifyCheckoutTransaction({
    checkoutId: id, chainId, txHash, profile,
    dispatch: (a) => { actions.push(a); },
    fetchImpl,
    sleep: async () => { /* instant: the head block, not the clock, drives progress */ },
    ...extra,
  });
  return { actions, outcome };
}

const purgeTmpDb = () => { for (const suffix of ['', '-shm', '-wal']) { try { if (existsSync(TMP_DB + suffix)) rmSync(TMP_DB + suffix); } catch { /* Windows may still hold the handle */ } } };

beforeAll(() => {
  // Windows reuses pids, and `afterAll` may have been unable to delete a locked
  // file — never inherit a stale journey from an earlier run.
  purgeTmpDb();
  migrate();
  const db = getDb();
  // SAFETY GATE. `bun test` shares ONE module registry (and therefore ONE
  // schema.ts SQLite singleton) across files, so whichever file opens the DB first
  // names the temporary database every later file uses — that is the repo's normal
  // test reality, and the uniquely namespaced *_cct21f* fixtures keep it harmless.
  // What must NEVER happen is writing into the developer database, which is exactly
  // what a hoisted static import of a DB-touching module selects (DB_PATH is frozen
  // at module-eval time, before the DATABASE_URL assignment above can take effect).
  const [{ file: openDbFile }] = db.query('PRAGMA database_list').all() as { file: string }[];
  if (!/_test_\d+\.db$/.test(openDbFile)) {
    throw new Error(`refusing to run: SQLite is attached to ${openDbFile}, which is not a per-run *_test_<pid>.db database`);
  }
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cct21f', '21F merchant');
  db.prepare('INSERT INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_cct21f', 'merch_cct21f', ARC_WALLET.toLowerCase(), ARC_TESTNET);

  const app = express();
  app.use(express.json());
  app.use('/api/checkout', checkoutRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;

  // The router keeps its production code path untouched; only the SOURCE PROVIDER
  // behind the real detectSourceBurn is canned (cctp-burn.test.ts technique), so the
  // router → detector → SQLite chain under test is entirely real.
  setSourceBurnDetectionForTest(async (input) => {
    chain.detectCalls.push({ paymentIntentId: input.paymentIntentId, sourceTxHash: input.sourceTxHash });
    return detectSourceBurn({ ...input, providerFactory: () => fakeSourceProvider(pendingBurn) });
  });
});

afterEach(() => {
  chain.head = 1_001n;
  chain.ticks = 0;
  chain.finalizeAfter = null;
  chain.providerCalls = 0;
  chain.detectCalls = [];
  setPendingBurn(null);
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockRestore();
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockRestore();
});

afterAll(() => {
  setSourceBurnDetectionForTest(null);
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  purgeTmpDb();
});

// ── A/B/C/D: the browser submission drives the real pipeline ────────────────
test('21F-S1: the browser burn submission creates the transfer row, moves the intent to processing and credits nothing', async () => {
  const id = nextId('pi'); insertIntent(id, { crossChain: true });
  const burn = burnHashFor(500 + seq);
  setPendingBurn(receiptForBurn(9_001n + BigInt(seq)));
  chain.finalizeAfter = 3;   // the source finalises on the third look

  const t = await browserVerifies(id, BASE_SEPOLIA_CHAIN, burn, CROSS_CHAIN_VERIFY_PROFILE);

  // The bridge stopped once the server named a worker-owned state, i.e. it kept
  // re-submitting while the source was still finalising (final on the 3rd look).
  expect(chain.detectCalls.length).toBe(3);
  expect(t.outcome).toBe('handed_off');
  expect(t.actions).toEqual([{ type: 'SUBMITTED', hash: burn }]);

  // C — exactly ONE cross_chain_transfers row, carrying THIS burn hash and M (never
  // the gross M + F), and nothing is credited on this path.
  const rows = transfersFor(id);
  expect(rows).toHaveLength(1);
  expect(String(rows[0]!.source_tx_hash).toLowerCase()).toBe(burn);
  expect(rows[0]!.amount_base_units).toBe(String(M));
  expect(rows[0]!.state).toBe('source_finalized');
  expect(rows[0]!.source_finalized_at).not.toBeNull();
  // D — the intent entered the pipeline.
  expect(intentRow(id).status).toBe('processing');
  expect(eventsFor(id, 'payment.cross_chain.source_burn_detected').length).toBeGreaterThanOrEqual(1);
  expect(paymentsFor(id)).toHaveLength(0);
});

test('21F-S2: repeated submission of the same burn is idempotent — no second transfer, no payment', async () => {
  const id = nextId('pi'); insertIntent(id, { crossChain: true });
  const burn = burnHashFor(600 + seq);
  setPendingBurn(receiptForBurn(9_101n + BigInt(seq)));
  chain.head = 1_003n; // already final: one call is enough

  const first = await browserVerifies(id, BASE_SEPOLIA_CHAIN, burn, CROSS_CHAIN_VERIFY_PROFILE);
  expect(first.outcome).toBe('handed_off');
  const second = await browserVerifies(id, BASE_SEPOLIA_CHAIN, burn, CROSS_CHAIN_VERIFY_PROFILE);
  expect(second.outcome).toBe('handed_off');

  expect(transfersFor(id)).toHaveLength(1);
  expect(paymentsFor(id)).toHaveLength(0);
  expect(intentRow(id).status).toBe('processing');
  // The detector re-validates the SAME journey rather than binding a second burn.
  expect(chain.detectCalls.length).toBeGreaterThanOrEqual(2);
  expect(new Set(chain.detectCalls.map((c) => c.sourceTxHash)).size).toBe(1);
});

test('21F-S3: a burn that is NOT the server-approved M + F is rejected 422 and records nothing', async () => {
  const id = nextId('pi'); insertIntent(id, { crossChain: true });
  const burn = burnHashFor(700 + seq);
  // Customer burned M only (no forwarding fee) — a hard, non-retryable rejection.
  setPendingBurn(receiptForBurn(9_201n + BigInt(seq), { amount: M, maxFee: 0n, minFinality: 0 }));

  const t = await browserVerifies(id, BASE_SEPOLIA_CHAIN, burn, CROSS_CHAIN_VERIFY_PROFILE);

  expect(t.outcome).toBe('failed');
  expect(t.actions).toEqual([{ type: 'FAILED', error: expect.stringContaining('5000000') }]);
  expect(transfersFor(id)).toHaveLength(0);
  expect(intentRow(id).status).toBe('requires_payment');
  expect(paymentsFor(id)).toHaveLength(0);
});

test('21F-S4: chain_id must equal the intent-pinned source chain — asserted, never trusted', async () => {
  const id = nextId('pi'); insertIntent(id, { crossChain: true });
  const before = chain.detectCalls.length;
  const t = await browserVerifies(id, ARC_CHAIN, burnHashFor(800 + seq), CROSS_CHAIN_VERIFY_PROFILE);
  expect(t.outcome).toBe('failed');
  expect(chain.detectCalls.length).toBe(before);           // refused BEFORE any detection
  expect(transfersFor(id)).toHaveLength(0);
  expect(t.actions[0]!.type).toBe('FAILED');
});

test('21F-S5: the pay-time receipt email survives the cross-chain branch (merchant value wins)', async () => {
  const id = nextId('pi'); insertIntent(id, { crossChain: true });
  const burn = burnHashFor(900 + seq);
  setPendingBurn(receiptForBurn(9_301n + BigInt(seq)));
  chain.head = 1_003n;

  const t = await browserVerifies(id, BASE_SEPOLIA_CHAIN, burn, CROSS_CHAIN_VERIFY_PROFILE, { receiptEmail: 'Buyer@Example.com' });
  expect(t.outcome).toBe('handed_off');
  expect(intentRow(id).customer_email).toBe('buyer@example.com');

  // A merchant-authored address is never overwritten (COALESCE, as same-chain).
  const kept = nextId('pi'); insertIntent(kept, { crossChain: true, email: 'shop@example.com' });
  await browserVerifies(kept, BASE_SEPOLIA_CHAIN, burnHashFor(910 + seq), CROSS_CHAIN_VERIFY_PROFILE, { receiptEmail: 'hijack@evil.test' });
  expect(intentRow(kept).customer_email).toBe('shop@example.com');
});

// ── E: same-chain verification is untouched ─────────────────────────────────
test('21F-S6: the same-chain profile still runs the FULL unchanged credit path and never enters detection', async () => {
  const id = nextId('pi'); insertIntent(id, { crossChain: false });
  const tx = burnHashFor(1000 + seq);
  const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
  const topics = encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from: DEPOSITOR as `0x${string}`, to: ARC_WALLET as `0x${string}` } });
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockImplementation(((requested: string) => Promise.resolve({
    txHash: requested, status: 'success' as const, blockNumber: 100n,
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)), from: DEPOSITOR, to: ARC_USDC,
    logs: [{ address: ARC_USDC.toLowerCase(), topics: topics as string[], data: encodeAbiParameters([{ type: 'uint256' }], [M]), logIndex: 0 }],
  })) as never);
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockResolvedValue(200n as never);

  const before = chain.detectCalls.length;
  const t = await browserVerifies(id, ARC_CHAIN, tx, SAME_CHAIN_VERIFY_PROFILE);

  expect(t.outcome).toBe('succeeded');
  expect(t.actions[0]!.type).toBe('SUCCEEDED');
  expect(paymentsFor(id)).toHaveLength(1);
  expect(intentRow(id).status).toBe('succeeded');
  expect(transfersFor(id)).toHaveLength(0);
  expect(chain.detectCalls.length).toBe(before);           // the burn detector never ran
});
