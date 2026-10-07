/**
 * PHASE 21G — SOURCE-FINALIZING WORKER RECOVERY.
 *
 * Production gap (found while closing Phase 21F): the browser reports the source
 * burn through POST /checkout/:id/verify, `detectSourceBurn()` writes a
 * `cross_chain_transfers` row, and if the source block has not crossed the
 * registry finality boundary that row is parked as `source_finalizing`. NOTHING
 * server-side ever re-reads finality — the reconciliation worker's attestation
 * sweep selects `state IN ('source_finalized','attestation_pending')` — so the
 * only thing that could promote the row was another browser visit carrying the
 * same burn hash. Close the tab before the source chain finalizes and the paid
 * journey waits indefinitely.
 *
 * These tests prove the browser is no longer part of the lifecycle. They are
 * deliberately integration-shaped, per the Phase 21G instruction:
 *   · the parked row is created by the REAL `detectSourceBurn()`, with the REAL
 *     PHASE 6 finality gate reading a REAL `network_configs` row, writing into a
 *     REAL SQLite database;
 *   · recovery is driven by the REAL `advanceSourceFinality()` and the REAL
 *     `tickCrossChain()` worker sweep, never by a re-submission;
 *   · after recovery, the EXISTING attestation service and the EXISTING
 *     destination settlement do the rest, with their own money checks intact.
 * Only external I/O is canned — the source-chain provider and Circle Iris — using
 * the cctp21f / cctp-finality / cctp-worker technique. Nothing about finality,
 * fees, or settlement is simulated: the finality boundary is READ FROM THE
 * REGISTRY in the test and the head block is moved across that exact boundary.
 *
 * SAFETY (the Phase 21F lesson): `bun test` runs every file in ONE process with
 * ONE schema.ts SQLite singleton, and DB_PATH is frozen at module-eval time. So
 * every DB-reachable module below is loaded with `await import()` AFTER
 * `process.env.DATABASE_URL`, the temp file is purged first, and `beforeAll`
 * asserts via `PRAGMA database_list` that the attached database is a per-run
 * `*_test_<pid>.db`. Fixture ids use `*_cct21g*` and the tx-hash families
 * ('0xd7..', '0xd8..') are disjoint from every other suite's.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { encodeAbiParameters, keccak256, toBytes, toHex } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctp21g_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp21g-test-secret';
process.env.EMAIL_TRANSPORT = 'dev';

const { migrate, getDb } = await import('./db/schema.ts');
const { getNetworkConfig } = await import('./blockchain/arc-provider.ts');
const source = await import('./blockchain/cctp-source.ts');
const { detectSourceBurn, advanceSourceFinality, DEPOSIT_FOR_BURN_ABI, MESSAGE_SENT_ABI } = source;
const worker = await import('./workers/reconciliation.ts');
const { tickCrossChain, recordDestinationClaim } = worker;
const { addressToBytes32, ARC_CCTP_DOMAIN, CCTP_CONTRACTS_TESTNET } = await import('./db/cctp.ts');
const { CCTP_FORWARD_HOOK_DATA } = await import('./blockchain/cctp-forwarding-fee.ts');

import type { SourceBurnProvider } from './blockchain/cctp-source.ts';
import type { FetchLike } from './blockchain/cctp-attestation.ts';
import type { DestinationProvider } from './blockchain/cctp-destination.ts';
import type { RawLog, TransactionReceipt } from './blockchain/arc-provider.ts';

// ── Fixed vectors: the base_sepolia → arc_testnet pilot route ────────────────
// The merchant's pinned Arc settlement wallet (same vector the other CCTP suites
// use), so the destination mint verifies against a real registry-pinned recipient.
const MERCHANT_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const DEPOSITOR = '0x9999999999999999999999999999999999999999';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';     // registry base_sepolia
const TM = CCTP_CONTRACTS_TESTNET.tokenMessengerV2;
const MT = CCTP_CONTRACTS_TESTNET.messageTransmitterV2;
const BASE_SEPOLIA = 'base_sepolia';
const ARC_TESTNET = 'arc_testnet';
const ARC_TESTNET_CHAIN = 5042002;
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const RELAYER = '0x2222222222222222222222222222222222222222';

// Success criterion G: a 1 USDC merchant amount must still settle EXACTLY
// 1,000,000 base units. F is the server-approved Circle Forwarding fee; the
// source burns M + F and the merchant is netted M — unchanged by Phase 21G.
const M = 1_000_000n;
const F = 16_712n;
const GROSS = M + F;

// The finality boundary is NOT hard-coded here: it is read from the registry (in
// beforeAll, once the DB exists), so these tests would follow the policy if it
// changed — and 21G-0 asserts what that policy currently is, making any silent
// weakening loud.
const SRC_BLOCK = 1_000n;
let CFG: ReturnType<typeof getNetworkConfig>;
let FINAL_HEAD: bigint;

const u32 = (n: number) => n.toString(16).padStart(8, '0');
const b32hex = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const addrB32 = (a: string) => addressToBytes32(a).slice(2);
const TOPIC_DEPOSIT_FOR_BURN = keccak256(toBytes(`DepositForBurn(${DEPOSIT_FOR_BURN_ABI.inputs!.map((i) => i.type).join(',')})`));
const TOPIC_MESSAGE_SENT = keccak256(toBytes(`MessageSent(${MESSAGE_SENT_ABI.inputs!.map((i) => i.type).join(',')})`));
const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'), 'hex');
const hex32 = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');

let seq = 0;
const nextId = (p: string) => `${p}_cct21g_${++seq}`;
// Disjoint tx-hash families: 'd7' source burns, 'd8' destination mints.
const burnHash = (n: number) => '0x' + 'd7'.repeat(31) + (n % 256).toString(16).padStart(2, '0');
const destHash = (n: number) => '0x' + 'd8'.repeat(31) + (n % 256).toString(16).padStart(2, '0');

/**
 * REAL clock, plus the one knob the worker needs: its source-finality sweep only
 * re-reads a row that has been parked for at least its re-check window, so the
 * worker is driven slightly ahead of detection. The offset stays well inside the
 * attestation service's own 30-minute window measured from `source_finalized_at`,
 * so nothing here depends on an expired journey.
 */
const REAL = Math.floor(Date.now() / 1000);
const DUE = REAL + 360;

// ── Receipt/message builders (the proven cctp21f vectors) ───────────────────
/**
 * Circle CCTP V2 message, byte-for-byte per the published offsets.
 *
 * `feeExecuted` is the field Circle populates at FORWARDING execution time (the
 * source-chain MessageSent leaves it zero). Phase 7 requires
 * `feeExecuted === the server-approved F`, so the recorded burn and the attested
 * message differ in exactly that field — and nothing else.
 */
function buildCctpMessage(nonce: bigint, amount: bigint, maxFee: bigint, minFinality: number, feeExecuted: bigint = 0n): Uint8Array {
  const wire =
    u32(1) + u32(6) + u32(ARC_CCTP_DOMAIN) + b32hex(nonce) +
    addrB32(TM) + addrB32(MT) + b32hex(0) + u32(minFinality) + u32(2000) +
    u32(1) + addrB32(SRC_USDC) + addrB32(MERCHANT_WALLET) + b32hex(amount) +
    addrB32(DEPOSITOR) + b32hex(maxFee) + b32hex(feeExecuted) + b32hex(1_000_000n);
  return toBytes(`0x${wire}`);
}

function receiptForBurn(n: number, over: { status?: 'success' | 'reverted'; to?: string } = {}) {
  const message = buildCctpMessage(BigInt(700000 + n), GROSS, F, 2000);
  const burnData = encodeAbiParameters(
    [
      { name: 'amount', type: 'uint256' }, { name: 'mintRecipient', type: 'bytes32' },
      { name: 'destinationDomain', type: 'uint32' }, { name: 'destinationTokenMessenger', type: 'bytes32' },
      { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' },
      { name: 'hookData', type: 'bytes' },
    ],
    [GROSS, `0x${addrB32(MERCHANT_WALLET)}`, ARC_CCTP_DOMAIN, `0x${addrB32(TM)}`, `0x${b32hex(0)}`, F, CCTP_FORWARD_HOOK_DATA],
  );
  return {
    txHash: burnHash(n),
    status: (over.status ?? 'success') as 'success' | 'reverted',
    blockNumber: SRC_BLOCK,
    blockTimestamp: 1_700_000_000n,
    from: DEPOSITOR.toLowerCase(),
    to: (over.to ?? TM).toLowerCase(),
    logs: [
      {
        address: TM.toLowerCase(), logIndex: 0, data: burnData,
        topics: [TOPIC_DEPOSIT_FOR_BURN, `0x${addrB32(SRC_USDC)}`, `0x${addrB32(DEPOSITOR)}`, `0x${b32hex(2000)}`],
      },
      {
        address: MT.toLowerCase(), logIndex: 1,
        data: encodeAbiParameters([{ name: 'message', type: 'bytes' }], [toHex(message)]),
        topics: [TOPIC_MESSAGE_SENT],
      },
    ],
  };
}
type FakeReceipt = ReturnType<typeof receiptForBurn>;

// ── The one canned source chain, shared and mutable across a test ───────────
const chain = {
  head: SRC_BLOCK,
  receipt: null as FakeReceipt | null,
  receiptThrows: false,
  headThrows: false,
  chainIdThrows: false,
  calls: { receipt: 0, head: 0, chainId: 0 },
};
function resetChain(receipt: FakeReceipt | null, head: bigint) {
  chain.head = head;
  chain.receipt = receipt;
  chain.receiptThrows = false;
  chain.headThrows = false;
  chain.chainIdThrows = false;
  chain.calls = { receipt: 0, head: 0, chainId: 0 };
}
/**
 * Structurally a SourceBurnProvider whose finality-relevant config is the REAL
 * registry row, exactly like cctp-finality.test.ts. `getHeadBlockNumber` exists
 * for 'safe'/'finalized' modes; base_sepolia is 'count', so the live head answers.
 */
const sourceProvider: SourceBurnProvider = {
  async getTransactionReceipt(h) {
    chain.calls.receipt += 1;
    if (chain.receiptThrows) throw new Error('json-rpc connection reset');
    // ONLY the fixture's own burn answers. Every other tx hash — including any
    // other suite's `source_finalizing` row that a future-clock sweep may select
    // in the shared test database — resolves to no receipt, i.e. an inert,
    // state-preserving 'receipt_missing'. This file can therefore never advance a
    // journey it did not create.
    if (!chain.receipt || h.toLowerCase() !== chain.receipt.txHash.toLowerCase()) return null;
    return chain.receipt as never;
  },
  async getLatestBlockNumber() {
    chain.calls.head += 1;
    if (chain.headThrows) throw new Error('json-rpc connection reset');
    return chain.head;
  },
  async getHeadBlockNumber() {
    chain.calls.head += 1;
    if (chain.headThrows) throw new Error('tag unavailable on this endpoint');
    return chain.head;
  },
  getConfig: () => CFG,
  async ensureChainIdMatches() {
    chain.calls.chainId += 1;
    if (chain.chainIdThrows) throw new Error('chain id mismatch');
  },
};
const sourceFactory = () => sourceProvider;
// An inert source provider for sweeps that must never touch the network: a null
// receipt is the retryable 'receipt_missing' path, which changes no state.
const sourceFactoryNull = (): SourceBurnProvider => ({
  async getTransactionReceipt() { return null; },
  async getLatestBlockNumber() { return 0n; },
  async getHeadBlockNumber() { return 0n; },
  getConfig: () => { throw new Error('21G inert stub: finality is never evaluated'); },
  async ensureChainIdMatches() { /* inert */ },
});

// ── Circle + destination fakes ──────────────────────────────────────────────
const irisUrls: string[] = [];
function attestedFetch(message: Uint8Array): FetchLike {
  return async (url) => {
    irisUrls.push(String(url));
    return {
      status: 200, ok: true,
      json: async () => ({ messages: [{ status: 'complete', message: toHex(message), attestation: '0xc0ffee', decodedMessage: {} }] }),
    } as Awaited<ReturnType<FetchLike>>;
  };
}
const pendingIris: FetchLike = async (url) => {
  irisUrls.push(String(url));
  return { status: 404, ok: false, json: async () => ({}) } as Awaited<ReturnType<FetchLike>>;
};
const destNullFactory = (): DestinationProvider => ({ async getTransactionReceipt() { return null; } });
/** Proves an on-Arc mint of EXACTLY the recorded merchant amount to the pinned wallet. */
function mintingProviderFor(txHash: string): () => DestinationProvider {
  const log: RawLog = {
    address: ARC_USDC,
    topics: [TRANSFER_TOPIC, addressToBytes32(RELAYER), addressToBytes32(MERCHANT_WALLET)],
    data: hex32(M), logIndex: 0,
  };
  const receipt: TransactionReceipt = {
    txHash, status: 'success', blockNumber: 33_333n, blockTimestamp: 1_700_000_000n,
    from: RELAYER, to: MT, logs: [log],
  };
  return () => ({ async getTransactionReceipt(h) { return h === txHash ? receipt : null; } });
}

// ── Fixtures / readers ──────────────────────────────────────────────────────
function insertCrossChainIntent(id: string): void {
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
       amount_decimal,amount_base_units,forwarding_max_fee_base_units,environment,status,expires_at,is_cross_chain,
       source_network,settlement_network,settlement_chain_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, 'merch_cct21g', 'sw_cct21g', MERCHANT_WALLET, BASE_SEPOLIA, CFG.chainId, SRC_USDC,
    '1.00', String(M), String(F), 'test', 'requires_payment', 9999999999, 1,
    BASE_SEPOLIA, ARC_TESTNET, ARC_TESTNET_CHAIN,
  );
}

function insertSameChainIntent(id: string, opts: { status: string; expires: number }): void {
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
       amount_decimal,amount_base_units,environment,status,expires_at,is_cross_chain)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)`,
  ).run(
    id, 'merch_cct21g', 'sw_cct21g', MERCHANT_WALLET, ARC_TESTNET, ARC_TESTNET_CHAIN, ARC_USDC,
    '1.00', String(M), 'test', opts.status, opts.expires,
  );
}

const db = () => getDb();
const transferRow = (tid: string) => db().prepare('SELECT * FROM cross_chain_transfers WHERE id=?').get(tid) as Record<string, unknown>;
const transfersFor = (iid: string) => db().prepare('SELECT * FROM cross_chain_transfers WHERE payment_intent_id=?').all(iid) as Record<string, unknown>[];
const intentRow = (iid: string) => db().prepare('SELECT * FROM payment_intents WHERE id=?').get(iid) as Record<string, unknown>;
const countEvents = (iid: string, type: string) => (db().prepare('SELECT COUNT(*) c FROM payment_events WHERE payment_intent_id=? AND event_type=?').get(iid, type) as { c: number }).c;
const paymentsFor = (iid: string) => db().prepare('SELECT * FROM payments WHERE payment_intent_id=?').all(iid) as Record<string, unknown>[];

/**
 * The Phase 21F hand-off, reproduced for real: the browser has submitted the burn
 * while the source chain was still short of the boundary, the detector recorded
 * the journey and parked it. The returned row is the exact production artefact
 * Phase 21G has to recover from — with NO further browser involvement.
 */
async function parkedJourney(): Promise<{ iid: string; tid: string; message: Uint8Array; attested: Uint8Array; tx: string; n: number }> {
  const n = ++seq;
  const iid = nextId('pi');
  insertCrossChainIntent(iid);
  const tx = burnHash(n);
  const message = buildCctpMessage(BigInt(700000 + n), GROSS, F, 2000);
  resetChain(receiptForBurn(n), FINAL_HEAD - 1n);      // one confirmation short
  const res = await detectSourceBurn({ paymentIntentId: iid, sourceTxHash: tx, providerFactory: sourceFactory });
  if (!res.ok) throw new Error(`fixture detection failed: ${res.code} ${res.reason}`);
  if (res.state !== 'source_finalizing') throw new Error(`fixture must park the journey, got ${res.state}`);
  return { iid, tid: res.transferId, message, attested: attestedMessageFor(n), tx, n };
}

/**
 * The message Circle answers with for THIS journey: the recorded burn with the
 * server-approved fee executed. Phase 7 re-parses these bytes and refuses any
 * message whose fee differs, so a fake that omitted F would be (correctly) parked
 * as verification_failed instead of attested.
 */
const attestedMessageFor = (n: number) => buildCctpMessage(BigInt(700000 + n), GROSS, F, 2000, F);

const purgeTmpDb = () => {
  for (const suffix of ['', '-shm', '-wal']) {
    try { if (existsSync(TMP_DB + suffix)) rmSync(TMP_DB + suffix); } catch { /* Windows may still hold the handle */ }
  }
};

beforeAll(() => {
  purgeTmpDb();
  migrate();
  CFG = getNetworkConfig(BASE_SEPOLIA);
  FINAL_HEAD = SRC_BLOCK + BigInt(CFG.requiredConfirmations) - 1n;
  const d = getDb();
  const [{ file: openDbFile }] = d.query('PRAGMA database_list').all() as { file: string }[];
  if (!/_test_\d+\.db$/.test(openDbFile)) {
    throw new Error(`refusing to run: SQLite is attached to ${openDbFile}, which is not a per-run *_test_<pid>.db database`);
  }
  d.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cct21g', '21G merchant');
  d.prepare('INSERT INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_cct21g', 'merch_cct21g', MERCHANT_WALLET.toLowerCase(), ARC_TESTNET);
});

afterAll(() => {
  try { getDb().close(); } catch { /* already closed */ }
  purgeTmpDb();
});

// ── 21G-0: the boundary the worker must honour is the registry's, not a new one ─
test('21G-0: the pilot source finalizes on its registry count depth, and nothing in 21G changes that', () => {
  expect(CFG.finalityMode).toBe('count');
  expect(CFG.requiredConfirmations).toBe(3);
  // A mainnet source is 'finalized'-tagged: the recovery must not flatten that.
  expect(getNetworkConfig('base_mainnet').finalityMode).toBe('finalized');
});

// ── 21G-1: not final yet ⇒ parked, unchanged, and NOT handed to attestation ──
test('21G-1: a source_finalizing transfer whose tx is NOT final stays source_finalizing', async () => {
  const { iid, tid } = await parkedJourney();
  const before = transferRow(tid);
  expect(before.state).toBe('source_finalizing');
  expect(before.source_finalized_at).toBeNull();

  const headsBefore = chain.calls.head;
  // A clock strictly ahead of `detectSourceBurn()`'s own stamp, so the re-check
  // stamp below is asserted as an EXACT value instead of "different from before"
  // — that looser form could collide with a detection timestamp landing in the
  // same wall-clock second as module load.
  const RECHECK = REAL + 10;
  const res = await advanceSourceFinality({ transferId: tid, providerFactory: sourceFactory, nowSeconds: RECHECK });
  expect(res.ok && res.outcome).toBe('not_final');

  const after = transferRow(tid);
  expect(after.state).toBe('source_finalizing');                 // not promoted
  expect(after.source_finalized_at).toBeNull();                  // never faked
  expect(after.source_tx_hash).toBe(before.source_tx_hash);      // binding untouched
  // The refusal is throttled (stamp = the clock we passed), so a parked row is
  // re-read on the re-check interval rather than hammered on every tick.
  expect(Number(after.updated_at)).toBe(RECHECK);
  expect(chain.calls.head).toBe(headsBefore + 1);                  // finality really evaluated
  // The worker sweep, driven past the row's re-check window, still cannot promote
  // it — and it must NOT hand an unfinalized burn to Circle either.
  irisUrls.length = 0;
  await tickCrossChain({ nowSeconds: DUE, fetchImpl: pendingIris, providerFactory: destNullFactory, sourceProviderFactory: sourceFactory });
  expect(transferRow(tid).state).toBe('source_finalizing');
  expect(irisUrls.filter((u) => u.includes(String(before.source_tx_hash)))).toHaveLength(0);
  expect(transfersFor(iid)).toHaveLength(1);
});

// ── 21G-2: final ⇒ advanced by the worker alone, with the attestation timestamp ─
test('21G-2: once the source tx is final the worker advances it to source_finalized', async () => {
  const { iid, tid } = await parkedJourney();
  // The source chain moves on its own; no browser re-submits anything.
  chain.head = FINAL_HEAD;

  const res = await advanceSourceFinality({ transferId: tid, providerFactory: sourceFactory, nowSeconds: REAL });
  expect(res.ok && res.outcome).toBe('finalized');
  if (res.ok && res.outcome === 'finalized') expect(res.state).toBe('source_finalized');

  const after = transferRow(tid);
  expect(after.state).toBe('source_finalized');
  // Not just the label: `source_finalized_at` must be written with the state, or
  // the existing attestation service refuses the row forever.
  expect(after.source_finalized_at).toBe(REAL);
  expect(transfersFor(iid)).toHaveLength(1);
  expect(countEvents(iid, 'payment.cross_chain.source_burn_detected')).toBe(1);
});

// ── 21G-3: the EXISTING attestation sweep then picks it up, same tick ─────────
test('21G-3: after source_finalized the existing attestation pipeline continues without the browser', async () => {
  const { iid, tid, attested, tx } = await parkedJourney();
  chain.head = FINAL_HEAD;
  const advanced = await advanceSourceFinality({ transferId: tid, providerFactory: sourceFactory, nowSeconds: REAL });
  expect(advanced.ok && advanced.outcome).toBe('finalized');

  irisUrls.length = 0;
  await tickCrossChain({
    nowSeconds: DUE, fetchImpl: attestedFetch(attested),
    providerFactory: destNullFactory, sourceProviderFactory: sourceFactoryNull,
  });
  const after = transferRow(tid);
  // The row left the source stage entirely: attestation was requested and granted
  // by the unchanged PHASE 7 service (a null source_finalized_at would have been
  // rejected as 'source_not_finalized' instead).
  expect(after.state).toBe('attested');
  expect(after.attestation_status).toBe('complete');
  expect(Number(after.attestation_attempts)).toBe(1);
  expect(irisUrls.some((u) => u.includes(tx))).toBe(true);
  expect(paymentsFor(iid)).toHaveLength(0);                      // attestation never credits
  expect(countEvents(iid, 'payment.cross_chain.source_burn_detected')).toBe(1);
});

// ── 21G-3b: the recovery itself is what the sweep performs (no direct call) ───
test('21G-3b: the worker sweep finalizes a parked row on its own, then attests it in the same tick', async () => {
  const { iid, tid, attested } = await parkedJourney();
  chain.head = FINAL_HEAD;                                       // source chain caught up

  const stats = await tickCrossChain({
    nowSeconds: DUE, fetchImpl: attestedFetch(attested),
    providerFactory: destNullFactory, sourceProviderFactory: sourceFactory,
  });
  expect(stats.finalized).toBe(1);                               // exactly this row recovered
  expect(stats.attested).toBeGreaterThanOrEqual(1);
  const after = transferRow(tid);
  expect(after.state).toBe('attested');
  expect(after.source_finalized_at).toBe(DUE);                   // set atomically with the state
  expect(transfersFor(iid)).toHaveLength(1);
});

// ── 21G-4: repeated ticks duplicate nothing ──────────────────────────────────
test('21G-4: running the worker repeatedly never duplicates the transfer or the source event', async () => {
  const { iid, tid, attested } = await parkedJourney();
  chain.head = FINAL_HEAD;

  const runs = [
    () => tickCrossChain({ nowSeconds: DUE, fetchImpl: attestedFetch(attested), providerFactory: destNullFactory, sourceProviderFactory: sourceFactory }),
    () => tickCrossChain({ nowSeconds: DUE, fetchImpl: attestedFetch(attested), providerFactory: destNullFactory, sourceProviderFactory: sourceFactory }),
    () => tickCrossChain({ nowSeconds: DUE + 1, fetchImpl: attestedFetch(attested), providerFactory: destNullFactory, sourceProviderFactory: sourceFactory }),
  ];
  const first = await runs[0]();
  expect(first.finalized).toBe(1);
  await runs[1]();
  await runs[2]();

  // Re-entering the mover on a row it no longer owns is a no-op, not a rewrite.
  const again = await advanceSourceFinality({ transferId: tid, providerFactory: sourceFactory, nowSeconds: DUE + 2 });
  expect(again.ok && again.outcome).toBe('not_eligible');

  expect(transfersFor(iid)).toHaveLength(1);
  expect(countEvents(iid, 'payment.cross_chain.source_burn_detected')).toBe(1);
  expect(countEvents(iid, 'payment.cross_chain.attestation_received')).toBeLessThanOrEqual(1);
  const after = transferRow(tid);
  expect(after.state).toBe('attested');
  expect(after.source_finalized_at).toBe(DUE);                   // never re-stamped
  expect(Number(after.attestation_attempts)).toBe(1);            // never re-polled
  expect(paymentsFor(iid)).toHaveLength(0);
});

// ── 21G-5: a transient RPC outage is safe and retries ────────────────────────
test('21G-5: temporary provider failure leaves the transfer intact and retryable', async () => {
  const { iid, tid } = await parkedJourney();
  const before = transferRow(tid);

  // (a) receipt read blows up
  chain.receiptThrows = true;
  let res = await advanceSourceFinality({ transferId: tid, providerFactory: sourceFactory, nowSeconds: REAL });
  expect(!res.ok && res.code).toBe('provider_error');
  if (!res.ok) expect(res.retryable).toBe(true);

  // (b) the head block blows up (so finality cannot be proven at all)
  chain.receiptThrows = false;
  chain.headThrows = true;
  res = await advanceSourceFinality({ transferId: tid, providerFactory: sourceFactory, nowSeconds: REAL + 1 });
  expect(!res.ok && res.code).toBe('provider_error');
  if (!res.ok) expect(res.retryable).toBe(true);

  // (c) the endpoint stops serving the finality tag
  chain.headThrows = false;
  chain.chainIdThrows = true;
  res = await advanceSourceFinality({ transferId: tid, providerFactory: sourceFactory, nowSeconds: REAL + 2 });
  expect(!res.ok && res.code).toBe('provider_error');

  for (let i = 0; i < 3; i += 1) {
    const row = transferRow(tid);
    expect(row.state).toBe('source_finalizing');                   // no fabricated progress
    expect(row.source_finalized_at).toBeNull();
    expect(row.source_tx_hash).toBe(before.source_tx_hash);
  }
  // Failures are throttled rather than retried instantly on every tick.
  expect(Number(transferRow(tid).updated_at)).toBe(REAL + 2);
  expect(transfersFor(iid)).toHaveLength(1);

  // ...and the very next healthy look still recovers the journey.
  chain.chainIdThrows = false;
  chain.head = FINAL_HEAD;
  res = await advanceSourceFinality({ transferId: tid, providerFactory: sourceFactory, nowSeconds: REAL + 3 });
  expect(res.ok && res.outcome).toBe('finalized');
  expect(transferRow(tid).state).toBe('source_finalized');
});

// ── 21G-6: a reverted / mis-pointed source tx follows the existing semantics ──
test('21G-6: a reverted or non-TokenMessenger source tx is refused, never finalized', async () => {
  const { iid, tid, n } = await parkedJourney();

  // The recorded tx now answers as REVERTED (e.g. the burn was never mined valid).
  resetChain(receiptForBurn(n, { status: 'reverted' }), FINAL_HEAD + 10n);
  let res = await advanceSourceFinality({ transferId: tid, providerFactory: sourceFactory, nowSeconds: REAL });
  expect(!res.ok && res.code).toBe('receipt_reverted');
  if (!res.ok) expect(res.retryable).toBe(false);                // existing semantics: not retryable
  expect(transferRow(tid).state).toBe('source_finalizing');      // and nothing is manufactured
  expect(transferRow(tid).source_finalized_at).toBeNull();

  // A receipt for a tx sent somewhere ELSE is refused too — this mover cannot be
  // pointed at an arbitrary transaction.
  resetChain(receiptForBurn(n, { to: '0x1111111111111111111111111111111111111111' }), FINAL_HEAD + 10n);
  res = await advanceSourceFinality({ transferId: tid, providerFactory: sourceFactory, nowSeconds: REAL });
  expect(!res.ok && res.code).toBe('not_token_messenger_call');
  expect(transferRow(tid).state).toBe('source_finalizing');

  // A vanished tx is NOT an error either: it just is not final yet.
  resetChain(null, FINAL_HEAD + 10n);
  res = await advanceSourceFinality({ transferId: tid, providerFactory: sourceFactory, nowSeconds: REAL });
  expect(!res.ok && res.code).toBe('receipt_missing');
  if (!res.ok) expect(res.retryable).toBe(true);
  expect(transferRow(tid).state).toBe('source_finalizing');

  // No failure path ever created a second journey or a payment.
  expect(transfersFor(iid)).toHaveLength(1);
  expect(paymentsFor(iid)).toHaveLength(0);
  expect(intentRow(iid).status).toBe('processing');
});

// ── 21G-7: the same-chain flow is untouched ──────────────────────────────────
test('21G-7: a same-chain intent is neither swept nor written by the cross-chain tick', async () => {
  const iid = nextId('pi');
  insertSameChainIntent(iid, { status: 'requires_payment', expires: REAL + 3600 });
  resetChain(null, FINAL_HEAD + 10n);

  await tickCrossChain({ nowSeconds: DUE, fetchImpl: pendingIris, providerFactory: destNullFactory, sourceProviderFactory: sourceFactoryNull });

  expect(intentRow(iid).status).toBe('requires_payment');        // unchanged
  expect(transfersFor(iid)).toHaveLength(0);                     // never a cross-chain row
  expect(paymentsFor(iid)).toHaveLength(0);

  // The same-chain expiry sweep is still exactly itself (unmodified code path).
  const overdue = nextId('pi');
  insertSameChainIntent(overdue, { status: 'requires_payment', expires: REAL - 7200 });
  worker.runExpirySweep(REAL);
  expect(intentRow(overdue).status).toBe('expired');
});

// ── 21G-8: the recovered journey settles for exactly the merchant amount ──────
test('21G-8: a browser-less recovery settles the full journey and credits M exactly once', async () => {
  const { iid, tid, attested } = await parkedJourney();
  chain.head = FINAL_HEAD;

  // Worker finishes the source leg and requests attestation.
  await tickCrossChain({ nowSeconds: DUE, fetchImpl: attestedFetch(attested), providerFactory: destNullFactory, sourceProviderFactory: sourceFactory });
  expect(transferRow(tid).state).toBe('attested');

  // The unchanged destination pipeline takes over: record the claim, then let the
  // worker verify the on-Arc mint before crediting anything.
  const dtx = destHash(seq);
  expect(recordDestinationClaim(tid, dtx, DUE).ok).toBe(true);
  const stats = await tickCrossChain({
    nowSeconds: DUE + 1, fetchImpl: attestedFetch(attested),
    providerFactory: mintingProviderFor(dtx), sourceProviderFactory: sourceFactoryNull,
  });
  expect(stats.settled).toBe(1);

  const paid = paymentsFor(iid);
  expect(paid).toHaveLength(1);
  expect(paid[0]!.amount_base_units).toBe('1000000');            // criterion G: exactly 1 USDC
  expect(transferRow(tid).state).toBe('settled');
  expect(transferRow(tid).amount_base_units).toBe('1000000');    // M, never M + F
  expect(intentRow(iid).status).toBe('succeeded');
  expect(countEvents(iid, 'payment.cross_chain.source_burn_detected')).toBe(1);

  // A further tick cannot double-credit, and the mover cannot revisit a terminal row.
  await tickCrossChain({ nowSeconds: DUE + 2, fetchImpl: attestedFetch(attested), providerFactory: mintingProviderFor(dtx), sourceProviderFactory: sourceFactoryNull });
  expect(paymentsFor(iid)).toHaveLength(1);
  expect(transferRow(tid).state).toBe('settled');
  const revisited = await advanceSourceFinality({ transferId: tid, providerFactory: sourceFactory, nowSeconds: DUE + 3 });
  expect(revisited.ok && revisited.outcome).toBe('not_eligible');
  expect(transferRow(tid).state).toBe('settled');
});
