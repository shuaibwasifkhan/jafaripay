/**
 * CCTP MASTER PHASE 10 — idempotency & replay security (integration gate).
 *
 * The per-stage suites already exercise each module in isolation. This suite
 * proves the CROSS-CUTTING fund-integrity guarantees that only hold when the
 * real pipeline stages are composed and the storage-layer UNIQUE indexes are
 * relied upon together. It asserts the invariants the master plan names as the
 * acceptance criteria for the whole CCTP money path:
 *
 *   • ONE transfer per intent, ONE burn per transfer, ONE mint settles ONE
 *     journey — enforced at the DB layer (payment_intent_id UNIQUE + the four
 *     partial UNIQUE indexes) and re-checked in code;
 *   • a source tx recorded for intent A can never be re-used for intent B;
 *   • attestation and settlement are IDEMPOTENT (a repeat never re-calls Circle
 *     and never double-credits);
 *   • a destination mint tx can settle exactly one journey — replaying it for a
 *     second transfer is blocked BEFORE any credit;
 *   • a mint that landed on some OTHER wallet can never settle a transfer whose
 *     pinned Arc wallet differs (no cross-transfer message theft).
 *
 * Namespace (*_cctpr*) + DISJOINT source/destination/message families so nothing
 * collides in the ONE sqlite DB shared across the whole `bun test` run.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { keccak256, toBytes, type Hex } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctpreplay_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp-replay-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const { settleDestination } = await import('./blockchain/cctp-destination.ts');
const { requestAttestation } = await import('./blockchain/cctp-attestation.ts');
import type { DestinationProvider } from './blockchain/cctp-destination.ts';
import type { FetchLike } from './blockchain/cctp-attestation.ts';
import { addressToBytes32 } from './db/cctp.ts';
import { messageTransmitterFor } from './blockchain/cctp-source.ts';
import type { RawLog, TransactionReceipt } from './blockchain/arc-provider.ts';

const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const OTHER_WALLET = '0x4242424242424242424242424242424242424242';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TM = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
const MT_TESTNET = messageTransmitterFor(true);
const AMOUNT = '5000000';
const CHAIN = 84532;
const ARC_TESTNET_CHAIN = 5042002;
const NOW = 1_800_000_000;

const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'), 'hex');
const hex32 = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');

// DISJOINT hash / nonce families for this suite.
let seq = 0;
const nextSeq = () => ++seq;
const srcHash = (n: number) => '0x' + 'f1'.repeat(31) + (n % 256).toString(16).padStart(2, '0');
const destHash = (n: number) => '0x' + 'f2'.repeat(31) + (n % 256).toString(16).padStart(2, '0');
function fakeMessage(n: number): Hex {
  return (`0x${hex32(BigInt(300000 + n)).slice(2)}${addressToBytes32(ARC_WALLET).slice(2)}`) as Hex;
}
const msgId = (hex: Hex) => keccak256(hex, 'hex');

function transferLog(from: string, to: string, value: bigint): RawLog {
  return { address: ARC_USDC, topics: [TRANSFER_TOPIC, addressToBytes32(from), addressToBytes32(to)], data: hex32(value), logIndex: 0 };
}
function mintReceipt(txHash: string, recipient: string, value = AMOUNT): TransactionReceipt {
  return {
    txHash, status: 'success', blockNumber: 22_222n, blockTimestamp: 1_700_000_000n,
    from: '0x2222222222222222222222222222222222222222', to: MT_TESTNET,
    logs: [transferLog(ZERO_ADDR, recipient, BigInt(value))],
  };
}
const providerFor = (receipt: TransactionReceipt | null): DestinationProvider => ({ async getTransactionReceipt() { return receipt; } });

function insertIntent(id: string, recipient: string): void {
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
      amount_decimal,amount_base_units,environment,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, 'merch_cctpr', 'sw_cctpr', recipient, 'base_sepolia', CHAIN, SRC_USDC, '5.00', AMOUNT, 'test', 9999999999, 1, 'base_sepolia', 'arc_testnet', ARC_TESTNET_CHAIN);
}

/** Seed an ATTENDED, settle-eligible transfer with explicit unique fields. */
function seedTransfer(o: {
  intentId: string; transferId: string; sourceTx: string; message: Hex;
  mintRecipient?: string; destinationTx?: string | null; attestationStatus?: string; state?: string;
}): void {
  getDb().prepare(
    `INSERT INTO cross_chain_transfers(id,payment_intent_id,source_network,source_chain_id,source_usdc_address,token_messenger,
      source_tx_hash,source_finalized_at,cctp_message_id,cctp_message,destination_network,destination_chain_id,destination_tx_hash,
      mint_recipient,amount_base_units,attestation,attestation_status,claim_status,state)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(o.transferId, o.intentId, 'base_sepolia', CHAIN, SRC_USDC, TM, o.sourceTx, NOW - 60,
    msgId(o.message), o.message, 'arc_testnet', ARC_TESTNET_CHAIN, o.destinationTx ?? null,
    o.mintRecipient ?? ARC_WALLET, AMOUNT, '0xc0ffee', o.attestationStatus ?? 'complete',
    'none', o.state ?? 'attested');
}

function payCount(intentId: string): number {
  return (getDb().prepare('SELECT COUNT(*) c FROM payments WHERE payment_intent_id=?').get(intentId) as { c: number }).c;
}
function transferRow(tid: string): Record<string, unknown> {
  return getDb().prepare('SELECT * FROM cross_chain_transfers WHERE id=?').get(tid) as Record<string, unknown>;
}

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctpr', 'P10 replay merchant');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_cctpr', 'merch_cctpr', ARC_WALLET, 'arc_testnet');
});

afterAll(() => {
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ── Storage-layer replay (the four partial UNIQUE indexes + intent uniqueness) ─

test('R1: one transfer per intent (payment_intent_id UNIQUE)', () => {
  const iid = `pi_cctpr_${nextSeq()}`;
  insertIntent(iid, ARC_WALLET);
  seedTransfer({ intentId: iid, transferId: `cct_cctpr_A_${iid}`, sourceTx: srcHash(seq), message: fakeMessage(seq) });
  expect(() => seedTransfer({ intentId: iid, transferId: `cct_cctpr_B_${iid}`, sourceTx: srcHash(seq + 1000), message: fakeMessage(seq + 1000) })).toThrow();
});

test('R2: the same source tx cannot back two transfers (uq_cct_source_tx)', () => {
  const s = nextSeq();
  const tx = srcHash(5000 + s);
  const i1 = `pi_cctpr_${s}`; insertIntent(i1, ARC_WALLET);
  seedTransfer({ intentId: i1, transferId: `cct_cctpr_r2a`, sourceTx: tx, message: fakeMessage(6000 + s) });
  const i2 = `pi_cctpr_${nextSeq()}`; insertIntent(i2, ARC_WALLET);
  expect(() => seedTransfer({ intentId: i2, transferId: `cct_cctpr_r2b`, sourceTx: tx, message: fakeMessage(7000 + s) })).toThrow();
});

test('R3: the same burn message cannot back two transfers (uq_cct_message_id)', () => {
  const s = nextSeq();
  const shared = fakeMessage(8000 + s); // same bytes ⇒ same cctp_message_id
  const i1 = `pi_cctpr_${s}`; insertIntent(i1, ARC_WALLET);
  seedTransfer({ intentId: i1, transferId: 'cct_cctpr_r3a', sourceTx: srcHash(9000 + s), message: shared });
  const i2 = `pi_cctpr_${nextSeq()}`; insertIntent(i2, ARC_WALLET);
  expect(() => seedTransfer({ intentId: i2, transferId: 'cct_cctpr_r3b', sourceTx: srcHash(9500 + s), message: shared })).toThrow();
});

test('R4: the same destination mint tx cannot be recorded on two transfers (uq_cct_dest_tx)', () => {
  const s = nextSeq();
  const dt = destHash(10000 + s);
  const i1 = `pi_cctpr_${s}`; insertIntent(i1, ARC_WALLET);
  seedTransfer({ intentId: i1, transferId: 'cct_cctpr_r4a', sourceTx: srcHash(11000 + s), message: fakeMessage(12000 + s), destinationTx: dt, state: 'settled' });
  const i2 = `pi_cctpr_${nextSeq()}`; insertIntent(i2, ARC_WALLET);
  expect(() => seedTransfer({ intentId: i2, transferId: 'cct_cctpr_r4b', sourceTx: srcHash(13000 + s), message: fakeMessage(14000 + s), destinationTx: dt, state: 'settled' })).toThrow();
});

// ── Settlement idempotency + cross-transfer replay (composed money path) ─────

test('R5: settlement is idempotent — a repeat settle never double-credits', async () => {
  const s = nextSeq();
  const iid = `pi_cctpr_${s}`; insertIntent(iid, ARC_WALLET);
  const tid = `cct_cctpr_r5`;
  seedTransfer({ intentId: iid, transferId: tid, sourceTx: srcHash(s), message: fakeMessage(s) });
  const tx = destHash(s);
  const r1 = await settleDestination({ transferId: tid, destinationTxHash: tx, providerFactory: () => providerFor(mintReceipt(tx, ARC_WALLET)), nowSeconds: NOW });
  expect(r1.ok && r1.outcome).toBe('settled');
  const r2 = await settleDestination({ transferId: tid, destinationTxHash: tx, providerFactory: () => providerFor(mintReceipt(tx, ARC_WALLET)), nowSeconds: NOW });
  expect(r2.ok && r2.outcome).toBe('already_settled');
  expect(payCount(iid)).toBe(1);
});

test('R6: one destination mint settles exactly one journey (replay blocked before credit)', async () => {
  const sA = nextSeq();
  const idA = `pi_cctpr_${sA}`; insertIntent(idA, ARC_WALLET);
  const tidA = 'cct_cctpr_r6a';
  seedTransfer({ intentId: idA, transferId: tidA, sourceTx: srcHash(20000 + sA), message: fakeMessage(21000 + sA) });

  const sB = nextSeq();
  const idB = `pi_cctpr_${sB}`; insertIntent(idB, ARC_WALLET);
  const tidB = 'cct_cctpr_r6b';
  seedTransfer({ intentId: idB, transferId: tidB, sourceTx: srcHash(22000 + sB), message: fakeMessage(23000 + sB) });

  // The SAME mint tx X settles A first.
  const txX = destHash(24000 + sA);
  const first = await settleDestination({ transferId: tidA, destinationTxHash: txX, providerFactory: () => providerFor(mintReceipt(txX, ARC_WALLET)), nowSeconds: NOW });
  expect(first.ok && first.outcome).toBe('settled');

  // Replaying txX to settle B is blocked before any credit (blockchain_transactions replay).
  const replay = await settleDestination({ transferId: tidB, destinationTxHash: txX, providerFactory: () => providerFor(mintReceipt(txX, ARC_WALLET)), nowSeconds: NOW });
  expect(!replay.ok && replay.code).toBe('destination_replay_detected');
  expect(payCount(idB)).toBe(0);
  expect(payCount(idA)).toBe(1);
  expect(transferRow(tidB).state).toBe('attested'); // B untouched
});

test('R7: a mint to a different wallet never settles a transfer pinned elsewhere (no message theft)', async () => {
  const s = nextSeq();
  const iid = `pi_cctpr_${s}`; insertIntent(iid, OTHER_WALLET);
  const tid = 'cct_cctpr_r7';
  // Transfer + intent pin OTHER_WALLET, but the observed mint pays ARC_WALLET.
  seedTransfer({ intentId: iid, transferId: tid, sourceTx: srcHash(30000 + s), message: fakeMessage(31000 + s), mintRecipient: OTHER_WALLET });
  const tx = destHash(32000 + s);
  const res = await settleDestination({ transferId: tid, destinationTxHash: tx, providerFactory: () => providerFor(mintReceipt(tx, ARC_WALLET)), nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('wrong_mint_recipient');
  expect(payCount(iid)).toBe(0);
  expect(transferRow(tid).state).toBe('attested');
});

test('R8: attestation is idempotent — an attested transfer never re-hits Circle', async () => {
  const s = nextSeq();
  const iid = `pi_cctpr_${s}`; insertIntent(iid, ARC_WALLET);
  const tid = 'cct_cctpr_r8';
  // Already settled past attestation → requestAttestation short-circuits.
  seedTransfer({ intentId: iid, transferId: tid, sourceTx: srcHash(40000 + s), message: fakeMessage(41000 + s), attestationStatus: 'complete', state: 'attested' });
  let calls = 0;
  const fetchImpl: FetchLike = async () => { calls += 1; return { status: 200, ok: true, json: async () => ({ messages: [] }) } as Awaited<ReturnType<FetchLike>>; };
  const res = await requestAttestation({ transferId: tid, fetchImpl, nowSeconds: NOW });
  expect(res.ok && res.outcome).toBe('already_attested');
  expect(calls).toBe(0);
});

test('R9: a non-attested transfer can never be settled (money gate 1 holds)', async () => {
  const s = nextSeq();
  const iid = `pi_cctpr_${s}`; insertIntent(iid, ARC_WALLET);
  const tid = 'cct_cctpr_r9';
  seedTransfer({ intentId: iid, transferId: tid, sourceTx: srcHash(50000 + s), message: fakeMessage(51000 + s), attestationStatus: 'pending', state: 'attestation_pending' });
  const tx = destHash(52000 + s);
  const res = await settleDestination({ transferId: tid, destinationTxHash: tx, providerFactory: () => providerFor(mintReceipt(tx, ARC_WALLET)), nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('not_attested');
  expect(payCount(iid)).toBe(0);
});
