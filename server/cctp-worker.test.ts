/**
 * CCTP MASTER PHASE 11 — worker / reconciliation extension.
 *
 * Proves the cross-chain driver added to the reconcile worker, WITHOUT any real
 * Circle/Arc network (every external seam is injected):
 *   • runExpirySweep protects an intent whose cross-chain journey is IN FLIGHT
 *     (non-terminal) yet still expires a same-chain intent and one whose journey
 *     reached a terminal failure — the same-chain path is provably unchanged;
 *   • the attestation sweep calls requestAttestation for DUE, finalized rows and
 *     leaves a not-due row alone (back-off survives a restart);
 *   • the destination sweep settles an attested transfer whose mint tx was
 *     recorded — and credits ONLY when the injected provider proves the on-Arc
 *     mint (a recorded hash with no matching mint never credits);
 *   • recordDestinationClaim is the guarded, non-crediting way to attach a mint
 *     tx (idempotent; refuses bad/absent-attestation/conflicting states);
 *   • the destination-timeout sweep parks an attested transfer that never got a
 *     mint, so a stuck journey can't pin an intent in 'processing' forever.
 *
 * Namespace (*_cctpw*) + DISJOINT tx families for the ONE shared `bun test` DB.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { keccak256, toBytes, type Hex } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctpworker_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp-worker-test-secret';
process.env.EMAIL_TRANSPORT = 'dev';

const { migrate, getDb } = await import('./db/schema.ts');
const worker = await import('./workers/reconciliation.ts');
const { runExpirySweep, tickCrossChain, recordDestinationClaim } = worker;
import type { DestinationProvider } from './blockchain/cctp-destination.ts';
import type { FetchLike } from './blockchain/cctp-attestation.ts';
import { addressToBytes32 } from './db/cctp.ts';
import { messageTransmitterFor } from './blockchain/cctp-source.ts';
import type { SourceBurnProvider } from './blockchain/cctp-source.ts';
import type { RawLog, TransactionReceipt } from './blockchain/arc-provider.ts';

const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TM = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const MT_TESTNET = messageTransmitterFor(true);
const AMOUNT = '5000000';
const CHAIN = 84532;
const ARC_TESTNET_CHAIN = 5042002;
const NOW = 1_800_000_000;

const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'), 'hex');
const hex32 = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');
let seq = 0;
const s = () => ++seq;
const srcHash = (n: number) => '0x' + 'e1'.repeat(31) + (n % 256).toString(16).padStart(2, '0');
const destHash = (n: number) => '0x' + 'e2'.repeat(31) + (n % 256).toString(16).padStart(2, '0');
function fakeMessage(n: number): Hex {
  return (`0x${hex32(BigInt(400000 + n)).slice(2)}${addressToBytes32(ARC_WALLET).slice(2)}`) as Hex;
}
const msgId = (hex: Hex) => keccak256(hex, 'hex');

function transferLog(to: string, value: bigint): RawLog {
  return { address: ARC_USDC, topics: [TRANSFER_TOPIC, addressToBytes32(ZERO_ADDR), addressToBytes32(to)], data: hex32(value), logIndex: 0 };
}
function mintReceipt(txHash: string, recipient: string): TransactionReceipt {
  return { txHash, status: 'success', blockNumber: 33_333n, blockTimestamp: 1_700_000_000n, from: '0x2222222222222222222222222222222222222222', to: MT_TESTNET, logs: [transferLog(recipient, BigInt(AMOUNT))] };
}

function insertIntent(id: string, opts: { status: string; expires: number; crossChain: boolean }): void {
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
      amount_decimal,amount_base_units,environment,status,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, 'merch_cctpw', 'sw_cctpw', ARC_WALLET,
    opts.crossChain ? 'base_sepolia' : 'arc_testnet',
    opts.crossChain ? CHAIN : ARC_TESTNET_CHAIN,
    opts.crossChain ? SRC_USDC : ARC_USDC,
    '5.00', AMOUNT, 'test', opts.status, opts.expires,
    opts.crossChain ? 1 : 0,
    opts.crossChain ? 'base_sepolia' : null,
    opts.crossChain ? 'arc_testnet' : null,
    opts.crossChain ? ARC_TESTNET_CHAIN : null);
}

function seedCct(
  transferId: string, intentId: string, o: {
    state: string; attestationStatus?: string; message?: Hex | null; sourceTx?: string;
    destTx?: string | null; next?: number | null; finalized?: number | null;
    updatedAt: number; attempts?: number; mintRecipient?: string;
  },
): void {
  const message = o.message === null ? null : (o.message ?? fakeMessage(parseInt(transferId.slice(-4), 36) || seq));
  getDb().prepare(
    `INSERT INTO cross_chain_transfers(id,payment_intent_id,source_network,source_chain_id,source_usdc_address,token_messenger,
      source_tx_hash,source_finalized_at,cctp_message_id,cctp_message,destination_network,destination_chain_id,destination_tx_hash,
      mint_recipient,amount_base_units,attestation,attestation_status,attestation_attempts,next_attestation_attempt_at,state,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(transferId, intentId, 'base_sepolia', CHAIN, SRC_USDC, TM,
    o.sourceTx ?? srcHash(seq), o.finalized === undefined ? NOW - 60 : o.finalized,
    message ? msgId(message) : null, message, 'arc_testnet', ARC_TESTNET_CHAIN, o.destTx ?? null,
    o.mintRecipient ?? ARC_WALLET, AMOUNT, '0xc0ffee', o.attestationStatus ?? 'none',
    o.attempts ?? 0, o.next === undefined ? null : o.next, o.state, o.updatedAt);
}

function cct(transferId: string): Record<string, unknown> {
  return getDb().prepare('SELECT * FROM cross_chain_transfers WHERE id=?').get(transferId) as Record<string, unknown>;
}
function piStatus(intentId: string): string {
  return (getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(intentId) as { status: string }).status;
}
function payCount(intentId: string): number {
  return (getDb().prepare('SELECT COUNT(*) c FROM payments WHERE payment_intent_id=?').get(intentId) as { c: number }).c;
}
function hasEvent(intentId: string, type: string): boolean {
  return (getDb().prepare('SELECT COUNT(*) c FROM payment_events WHERE payment_intent_id=? AND event_type=?').get(intentId, type) as { c: number }).c > 0;
}

// A fetch that answers 404 (pending) and records how many times it was called.
function pendingFetch(): { fetch: FetchLike; calls: { n: number } } {
  const calls = { n: 0 };
  const fetch: FetchLike = async () => { calls.n += 1; return { status: 404, ok: false, json: async () => ({}) }; };
  return { fetch, calls };
}
// A provider that mints ONLY for the given tx hash (to the pinned wallet);
// everything else resolves to no receipt — never a spurious credit.
function providerMintingFor(txHash: string): (dest: string) => DestinationProvider {
  return () => ({ async getTransactionReceipt(h) { return h === txHash ? mintReceipt(h, ARC_WALLET) : null; } });
}
const providerNull = (): DestinationProvider => ({ async getTransactionReceipt() { return null; } });
// PHASE 21G: NOW is a FUTURE epoch, so this suite's clock makes every OTHER
// suite's real-timestamped `source_finalizing` row look due. Injecting a source
// provider that answers "no receipt" keeps the new recovery sweep hermetic: it
// resolves to a retryable 'receipt_missing', so state is never advanced and no
// live Base-Sepolia RPC is issued from the test process.
const sourceProviderNull = (): SourceBurnProvider => ({
  async getTransactionReceipt() { return null; },
  async getLatestBlockNumber() { return 0n; },
  async getHeadBlockNumber() { return 0n; },
  // Never reached: this mover stops at the null receipt, so no finality mode is
  // ever consulted here. Throwing keeps that true rather than pretending a config.
  getConfig: () => { throw new Error('21G inert source stub: finality is never evaluated'); },
  async ensureChainIdMatches() { /* inert */ },
});

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctpw', 'P11 worker merchant');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_cctpw', 'merch_cctpw', ARC_WALLET, 'arc_testnet');
});

afterAll(() => {
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ── Expiry sweep + in-flight protection ────────────────────────────────────

test('W1: runExpirySweep expires same-chain + terminal journeys but NOT an in-flight one', () => {
  const overdue = NOW - 2000; // < NOW - PI_SETTLEMENT_GRACE_S(1200)

  const iSame = `pi_cctpw_${s()}`; insertIntent(iSame, { status: 'processing', expires: overdue, crossChain: false });
  const iFlight = `pi_cctpw_${s()}`; insertIntent(iFlight, { status: 'processing', expires: overdue, crossChain: true });
  seedCct(`cct_cctpw_f_${seq}`, iFlight, { state: 'attested', attestationStatus: 'complete', updatedAt: NOW });
  const iTerminal = `pi_cctpw_${s()}`; insertIntent(iTerminal, { status: 'processing', expires: overdue, crossChain: true });
  seedCct(`cct_cctpw_t_${seq}`, iTerminal, { state: 'attestation_timeout', attestationStatus: 'timeout', updatedAt: NOW });

  runExpirySweep(NOW);
  expect(piStatus(iSame)).toBe('expired');           // same-chain unchanged
  expect(piStatus(iFlight)).toBe('processing');      // in-flight journey protected
  expect(piStatus(iTerminal)).toBe('expired');       // terminal journey releases the guard
});

// ── Attestation sweep ──────────────────────────────────────────────────────

test('W2: the attestation sweep advances a due, finalized transfer (poll → pending)', async () => {
  const iid = `pi_cctpw_${s()}`; insertIntent(iid, { status: 'processing', expires: NOW + 9999, crossChain: true });
  const tid = `cct_cctpw_a_${seq}`;
  seedCct(tid, iid, { state: 'source_finalized', attestationStatus: 'none', finalized: NOW - 60, next: null, updatedAt: NOW });
  const { fetch, calls } = pendingFetch();
  const before = calls.n;
  const stats = await tickCrossChain({ fetchImpl: fetch, providerFactory: providerNull, sourceProviderFactory: sourceProviderNull, nowSeconds: NOW });
  expect(calls.n).toBeGreaterThan(before);           // the due row WAS polled
  expect(cct(tid).state).toBe('attestation_pending');
  expect(Number(cct(tid).attestation_attempts)).toBe(1);
  expect(Number(cct(tid).next_attestation_attempt_at)).toBeGreaterThan(NOW); // scheduled back-off
  expect(stats.attested).toBeGreaterThanOrEqual(1);
});

test('W3: a not-due transfer is left untouched by the sweep (back-off survives a restart)', async () => {
  const iid = `pi_cctpw_${s()}`; insertIntent(iid, { status: 'processing', expires: NOW + 9999, crossChain: true });
  const tid = `cct_cctpw_nd_${seq}`;
  seedCct(tid, iid, { state: 'attestation_pending', attestationStatus: 'pending', finalized: NOW - 60, next: NOW + 500, attempts: 3, updatedAt: NOW });
  const { fetch } = pendingFetch();
  await tickCrossChain({ fetchImpl: fetch, providerFactory: providerNull, sourceProviderFactory: sourceProviderNull, nowSeconds: NOW });
  expect(cct(tid).attestation_attempts).toBe(3);      // not polled
  expect(cct(tid).state).toBe('attestation_pending'); // unchanged
});

// ── Destination settlement sweep + recordDestinationClaim ──────────────────

test('W4: recordDestinationClaim attaches the mint tx WITHOUT crediting (guarded + idempotent)', async () => {
  const iid = `pi_cctpw_${s()}`; insertIntent(iid, { status: 'processing', expires: NOW + 9999, crossChain: true });
  const tid = `cct_cctpw_rc_${seq}`;
  seedCct(tid, iid, { state: 'attested', attestationStatus: 'complete', updatedAt: NOW });
  const tx = destHash(6000 + seq);

  // Bad hash refused.
  expect(!recordDestinationClaim(tid, 'nope').ok).toBe(true);
  // Records + advances to destination_submitted; NO payment yet.
  const r1 = recordDestinationClaim(tid, tx, NOW);
  expect(r1.ok && r1.outcome).toBe('recorded');
  expect(cct(tid).state).toBe('destination_submitted');
  expect(cct(tid).destination_tx_hash).toBe(tx);
  expect(payCount(iid)).toBe(0);                      // recording NEVER credits
  // Idempotent re-record of the same tx.
  const r2 = recordDestinationClaim(tid, tx, NOW);
  expect(r2.ok && r2.outcome).toBe('already_recorded');

  // Now the sweep settles it, crediting ONLY because the provider proves the mint.
  const stats = await tickCrossChain({ fetchImpl: pendingFetch().fetch, providerFactory: providerMintingFor(tx), sourceProviderFactory: sourceProviderNull, nowSeconds: NOW });
  expect(stats.settled).toBeGreaterThanOrEqual(1);
  expect(payCount(iid)).toBe(1);
  expect(cct(tid).state).toBe('settled');
  expect(piStatus(iid)).toBe('succeeded');
});

test('W5: a recorded hash with NO matching on-Arc mint never credits', async () => {
  const iid = `pi_cctpw_${s()}`; insertIntent(iid, { status: 'processing', expires: NOW + 9999, crossChain: true });
  const tid = `cct_cctpw_nm_${seq}`;
  const tx = destHash(7000 + seq);
  seedCct(tid, iid, { state: 'destination_submitted', attestationStatus: 'complete', destTx: tx, updatedAt: NOW });
  const stats = await tickCrossChain({ fetchImpl: pendingFetch().fetch, providerFactory: providerNull, sourceProviderFactory: sourceProviderNull, nowSeconds: NOW });
  expect(stats.settled).toBe(0);
  expect(payCount(iid)).toBe(0);                      // attested+recorded but no mint ⇒ NO credit
  expect(cct(tid).state).toBe('destination_submitted');
});

test('W6: recordDestinationClaim refuses a non-attested transfer and a conflicting tx', () => {
  const iid1 = `pi_cctpw_${s()}`; insertIntent(iid1, { status: 'processing', expires: NOW + 9999, crossChain: true });
  const tid1 = `cct_cctpw_na_${seq}`;
  seedCct(tid1, iid1, { state: 'source_finalized', attestationStatus: 'none', updatedAt: NOW });
  const r1 = recordDestinationClaim(tid1, destHash(8000 + seq), NOW);
  expect(!r1.ok && r1.code).toBe('not_attested');

  // Two attested transfers cannot bind the same mint tx (uq_cct_dest_tx).
  const iidA = `pi_cctpw_${s()}`; insertIntent(iidA, { status: 'processing', expires: NOW + 9999, crossChain: true });
  const tidA = `cct_cctpw_cA_${seq}`;
  seedCct(tidA, iidA, { state: 'attested', attestationStatus: 'complete', updatedAt: NOW });
  const shared = destHash(8500 + seq);
  expect(recordDestinationClaim(tidA, shared, NOW).ok).toBe(true);
  const iidB = `pi_cctpw_${s()}`; insertIntent(iidB, { status: 'processing', expires: NOW + 9999, crossChain: true });
  const tidB = `cct_cctpw_cB_${seq}`;
  seedCct(tidB, iidB, { state: 'attested', attestationStatus: 'complete', updatedAt: NOW });
  const conflict = recordDestinationClaim(tidB, shared, NOW);
  expect(!conflict.ok && (conflict.code === 'destination_conflict')).toBe(true);
});

// ── Destination-timeout sweep ──────────────────────────────────────────────

test('W7: an attested transfer that never gets a mint is parked destination_failed', async () => {
  const iid = `pi_cctpw_${s()}`; insertIntent(iid, { status: 'processing', expires: NOW + 9999, crossChain: true });
  const tid = `cct_cctpw_to_${seq}`;
  // updated_at far in the past (older than the destination-timeout window), no dest tx.
  seedCct(tid, iid, { state: 'attested', attestationStatus: 'complete', destTx: null, updatedAt: NOW - 60 * 60 - 10 });
  const stats = await tickCrossChain({ fetchImpl: pendingFetch().fetch, providerFactory: providerNull, sourceProviderFactory: sourceProviderNull, nowSeconds: NOW });
  expect(cct(tid).state).toBe('destination_failed');
  expect(String(cct(tid).failure_reason)).toContain('destination');
  expect(hasEvent(iid, 'payment.cross_chain.destination_failed')).toBe(true);
  expect(stats.timedOut).toBeGreaterThanOrEqual(1);
});

test('W8: a recently-attested transfer is NOT timed out (window not elapsed)', async () => {
  const iid = `pi_cctpw_${s()}`; insertIntent(iid, { status: 'processing', expires: NOW + 9999, crossChain: true });
  const tid = `cct_cctpw_recent_${seq}`;
  seedCct(tid, iid, { state: 'attested', attestationStatus: 'complete', destTx: null, updatedAt: NOW - 10 });
  await tickCrossChain({ fetchImpl: pendingFetch().fetch, providerFactory: providerNull, sourceProviderFactory: sourceProviderNull, nowSeconds: NOW });
  expect(cct(tid).state).toBe('attested');            // still within the window
});
