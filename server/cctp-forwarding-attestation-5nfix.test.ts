/**
 * STEP 5N-FIX — REAL CCTP Forwarding attestation regression suite.
 *
 * Reproduces the exact application-level false-negative captured on testnet:
 * a Circle Forwarding burn whose SOURCE-chain MessageSent carries
 * `nonce`, `finalityThresholdExecuted` and `feeExecuted` as ZERO while Circle's
 * /v2/messages returns the EXECUTED message with those three fields populated.
 * The old `keccak256(Circle.message) === cctp_message_id` gate therefore hashed
 * two DIFFERENT byte strings and hard-failed every real forwarding attestation
 * (the parked transfer pi_pfatu6mmgzalr4ykyw2kng2z / source tx 0xf7e60730…).
 *
 * These tests lock the corrected behaviour WITHOUT weakening security:
 *   • FORWARDING no longer requires an identical raw hash, but must still satisfy
 *     every semantic invariant AND stay byte-bound to THIS transfer's recorded
 *     source MessageSent on every STABLE field, so an arbitrary / tampered /
 *     substituted Circle message still fails closed.
 *   • DIRECT behaviour (strict hash gate + semantic checks) is unchanged.
 *
 * Test #1 uses the REAL captured message bytes from the parked transfer. The
 * negatives mutate ONE field at a time. Unique fixture namespace (*_cctpn*,
 * txHash 0xf5…, forward tx 0xe9…) — disjoint from every other cctp-*.test.ts
 * because `bun test` shares ONE physical sqlite DB (schema cached at first import).
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { keccak256, toBytes, toHex } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctp5nfix_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp-5nfix-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const { requestAttestation } = await import('./blockchain/cctp-attestation.ts');
import type { FetchLike } from './blockchain/cctp-attestation.ts';
import { ARC_CCTP_DOMAIN, addressToBytes32 } from './db/cctp.ts';

// ── Fixed vectors mirroring the real base_sepolia → arc_testnet pilot route ──
const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const EVIL_WALLET = '0x1111111111111111111111111111111111111111';
const DEPOSITOR = '0x9999999999999999999999999999999999999999';
const OTHER_SENDER = '0x8888888888888888888888888888888888888888';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const EVIL_TOKEN = '0x0000000000000000000000000000000000000A11';
const TM = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'; // testnet TokenMessenger
const MT = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'; // testnet MessageTransmitter
const M = 5_000_000n;        // merchant settlement target
const FEE = 20_380n;         // server-approved Forwarding maxFee
const GROSS = M + FEE;       // gross burn recorded in the attested message
const DOMAIN = 6;            // base_sepolia CCTP domain
const NOW = 1_800_000_000;   // fixed unix clock
const FORWARD_MINT_TX = '0x' + 'e9'.repeat(32);

const u32 = (n: number) => n.toString(16).padStart(8, '0');
const b32 = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const a32 = (addr: string) => addressToBytes32(addr).slice(2);

/** Build a raw CCTP v2 message byte-for-byte per Circle's published offsets. */
function buildMessage(o: {
  sourceDomain?: number; destinationDomain?: number; nonce?: bigint;
  sender?: string; recipient?: string; destinationCaller?: bigint; minFinalityThreshold?: number;
  finalityThresholdExecuted?: number; burnToken?: string; mintRecipient?: string;
  amount?: bigint; messageSender?: string; maxFee?: bigint; feeExecuted?: bigint; expirationBlock?: bigint;
} = {}): Uint8Array {
  const header =
    u32(1) + u32(o.sourceDomain ?? DOMAIN) + u32(o.destinationDomain ?? ARC_CCTP_DOMAIN) +
    b32(o.nonce ?? 0n) + a32(o.sender ?? TM) + a32(o.recipient ?? MT) +
    b32(o.destinationCaller ?? 0n) + u32(o.minFinalityThreshold ?? 2000) + u32(o.finalityThresholdExecuted ?? 2000);
  const body =
    u32(1) + a32(o.burnToken ?? SRC_USDC) + a32(o.mintRecipient ?? ARC_WALLET) + b32(o.amount ?? GROSS) +
    a32(o.messageSender ?? DEPOSITOR) + b32(o.maxFee ?? FEE) + b32(o.feeExecuted ?? 0n) +
    b32(o.expirationBlock ?? 1_000_000n);
  return toBytes(`0x${header + body}`);
}

const msgHex = (bytes: Uint8Array) => toHex(bytes);
const msgId = (bytes: Uint8Array) => keccak256(toHex(bytes), 'hex');

// ── REAL captured message bytes from the parked transfer pi_pfatu6mmgzalr4ykyw2kng2z ──
// Recorded SOURCE MessageSent (nonce / finalityThresholdExecuted / feeExecuted = 0).
const REAL_SOURCE_HEX =
  '0x00000001000000060000001a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000000000000000000000000000000000000000000000000007d00000000000000001000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e0000000000000000000000002ebcd5d751c5ea788ebca0032f5bd23daa0564c700000000000000000000000000000000000000000000000000000000000f88dd0000000000000000000000003af65566013269a1c2f6ee97d49f93a98d51d220000000000000000000000000000000000000000000000000000000000000469d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000636374702d666f72776172640000000000000000000000000000000000000000';
// Circle's EXECUTED message for the SAME burn (nonce populated, finality=2000, feeExecuted=18077).
const REAL_CIRCLE_HEX =
  '0x00000001000000060000001a1c2eef6ba8210f41019acbf5c8389293fd90ccd7b172a74c6276ce74b086b8980000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000000000000000000000000000000000000000000000000007d0000007d000000001000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e0000000000000000000000002ebcd5d751c5ea788ebca0032f5bd23daa0564c700000000000000000000000000000000000000000000000000000000000f88dd0000000000000000000000003af65566013269a1c2f6ee97d49f93a98d51d220000000000000000000000000000000000000000000000000000000000000469d000000000000000000000000000000000000000000000000000000000000469d0000000000000000000000000000000000000000000000000000000000000000636374702d666f72776172640000000000000000000000000000000000000000';
const REAL_MERCHANT = '0x2Ebcd5d751C5ea788EbcA0032F5Bd23dAa0564c7';
const REAL_M = 1_000_000n;      // Arc merchant mint
const REAL_F = 18_077n;         // forwarding fee
const REAL_FORWARD = '0x8d60aa0b25cd8913ff7206d605967dce8419828bac5dca78b586e31c6e492dd9';

// ── Fake Circle fetch (records every call) ─────────────────────────────────
interface FakeRes { status: number; body?: unknown }
function makeFetch(route: (url: string) => FakeRes): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url: string) => {
    calls.push(url);
    const r = route(url);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body } as Awaited<ReturnType<FetchLike>>;
  };
  return { fetch, calls };
}
const completeBody = (messageHex: string, forwardTxHash?: unknown, attestation = '0xc0ffee') => ({
  messages: [{ status: 'complete', message: messageHex, attestation, decodedMessage: {}, ...(forwardTxHash ? { forwardTxHash } : {}) }],
});

// ── Seed a finalized in-flight FORWARDING (or DIRECT) transfer for an intent ─
let seq = 0;
function seedTransfer(over: {
  recorded: Uint8Array; fee: bigint; amountBaseUnits: bigint; mintRecipient?: string; isTestnet?: boolean;
  attestationStatus?: string; state?: string;
}): { transferId: string; intentId: string } {
  const bytes = over.recorded;
  const id = `pi_cctpn_${++seq}`;
  const tid = `cct_cctpn_${seq}`;
  const txHash = '0x' + 'f5'.repeat(31) + (seq % 256).toString(16).padStart(2, '0');
  const merchant = over.mintRecipient ?? ARC_WALLET;
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
      amount_decimal,amount_base_units,environment,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id,forwarding_max_fee_base_units)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, 'merch_cctpn', 'sw_cctpn', merchant, 'base_sepolia', 84532, SRC_USDC,
    '5.00', over.amountBaseUnits.toString(), 'test', 9999999999, 1, 'base_sepolia', 'arc_testnet', 5042002,
    over.fee.toString());
  getDb().prepare(
    `INSERT INTO cross_chain_transfers(id,payment_intent_id,source_network,source_chain_id,source_usdc_address,token_messenger,
      source_tx_hash,source_finalized_at,cctp_message_id,cctp_message,destination_network,destination_chain_id,mint_recipient,
      amount_base_units,attestation_status,attestation_attempts,next_attestation_attempt_at,state)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(tid, id, 'base_sepolia', 84532, SRC_USDC, TM, txHash, NOW - 60,
    msgId(bytes), msgHex(bytes), 'arc_testnet', 5042002, merchant,
    over.amountBaseUnits.toString(), over.attestationStatus ?? 'none', 0, null, over.state ?? 'source_finalized');
  return { transferId: tid, intentId: id };
}

function row(transferId: string): Record<string, unknown> {
  return getDb().prepare('SELECT * FROM cross_chain_transfers WHERE id=?').get(transferId) as Record<string, unknown>;
}
function intentStatus(intentId: string): string {
  return (getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(intentId) as { status: string }).status;
}

/**
 * A FORWARDING pair: the recorded SOURCE message (fee/finality/nonce = 0) plus
 * Circle's EXECUTED message (those three populated). Both share every STABLE
 * field; `circleOverride` mutates ONE field of the executed message to model a
 * specific tampered / mismatched substitution. The `tag` keeps each recorded
 * message byte-unique so the shared-DB UNIQUE indexes never collide.
 */
function fwdPair(tag: number, circleOverride: Parameters<typeof buildMessage>[0] = {}) {
  const expiration = BigInt(2_000_000 + tag);
  const base: Parameters<typeof buildMessage>[0] = {
    amount: GROSS, maxFee: FEE, mintRecipient: ARC_WALLET, expirationBlock: expiration,
  };
  const recorded = buildMessage({ ...base, nonce: 0n, finalityThresholdExecuted: 0, feeExecuted: 0n });
  const circle = buildMessage({ ...base, nonce: BigInt(90000 + tag), finalityThresholdExecuted: 2000, feeExecuted: FEE, ...circleOverride });
  return { recorded, circle };
}

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctpn', '5N-FIX forwarding merchant');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_cctpn', 'merch_cctpn', ARC_WALLET, 'arc_testnet');
});

afterAll(() => {
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ── Sanity: the REAL bytes reproduce the verified defect ────────────────────
test('S5N-0: the real source & circle messages differ ONLY in the 3 mutable fields and hash apart', () => {
  const src = toBytes(REAL_SOURCE_HEX);
  const circle = toBytes(REAL_CIRCLE_HEX);
  expect(src.length).toBe(408);
  expect(circle.length).toBe(408);
  expect(msgId(src)).toBe('0x05a30d70213cdc32e6a86e0a401794365df624c482a676e00365b7215424ae04');
  // The OLD gate compared keccak(circle) to keccak(source) — provably different, which is the false-negative.
  expect(msgId(circle)).not.toBe(msgId(src));
});

// ── (1) THE REAL FORWARDING CASE MUST NOW PASS ──────────────────────────────
test('S5N-1: REAL Forwarding source MessageSent + Circle executed message (populated nonce/finality/feeExecuted) attests', async () => {
  const { transferId } = seedTransfer({
    recorded: toBytes(REAL_SOURCE_HEX), fee: REAL_F, amountBaseUnits: REAL_M, mintRecipient: REAL_MERCHANT,
  });
  const { fetch, calls } = makeFetch(() => ({ status: 200, body: completeBody(REAL_CIRCLE_HEX, REAL_FORWARD) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(res.ok && res.outcome).toBe('attested');
  if (!res.ok) return;
  expect(calls.length).toBe(1);
  const r = row(transferId);
  expect(r.state).toBe('attested');
  expect(r.attestation).toBe('0xc0ffee');
  // forwardTxHash → destination_tx_hash; merchant target stays M (never M + F).
  expect(res.forwardTxHash).toBe(REAL_FORWARD);
  expect(r.destination_tx_hash).toBe(REAL_FORWARD);
  expect(r.amount_base_units).toBe('1000000');
});

// ── (2) DIRECT behaviour must remain PASS (strict hash gate intact) ─────────
test('S5N-2: DIRECT attestation still verifies via the strict hash gate and attests', async () => {
  const bytes = buildMessage({ amount: M, maxFee: 0n, feeExecuted: 0n, finalityThresholdExecuted: 2000, nonce: 1234n });
  const { transferId } = seedTransfer({ recorded: bytes, fee: 0n, amountBaseUnits: M });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(msgHex(bytes)) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(res.ok && res.outcome).toBe('attested');
});

test('S5N-2b: DIRECT hash gate still rejects a mismatched hash (unchanged strict behaviour)', async () => {
  const recorded = buildMessage({ amount: M, maxFee: 0n, feeExecuted: 0n, nonce: 4321n });
  const circleDifferent = buildMessage({ amount: M, maxFee: 0n, feeExecuted: 0n, nonce: 4322n }); // only nonce differs → different hash
  const { transferId } = seedTransfer({ recorded, fee: 0n, amountBaseUnits: M });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(msgHex(circleDifferent)) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('verification_failed');
  expect(row(transferId).attestation).toBeNull();
});

// ── Negative semantic invariants on the FORWARDING executed message ─────────

test('S5N-3: wrong SOURCE domain fails', async () => {
  const { recorded, circle } = fwdPair(301, { sourceDomain: 7 });
  const { transferId } = seedTransfer({ recorded, fee: FEE, amountBaseUnits: M });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(msgHex(circle)) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('verification_failed');
  expect(row(transferId).attestation).toBeNull();
});

test('S5N-4: wrong DESTINATION domain (not Arc 26) fails', async () => {
  const { recorded, circle } = fwdPair(302, { destinationDomain: 99 });
  const { transferId } = seedTransfer({ recorded, fee: FEE, amountBaseUnits: M });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(msgHex(circle)) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('verification_failed');
});

test('S5N-5: wrong MINT RECIPIENT fails', async () => {
  const { recorded, circle } = fwdPair(303, { mintRecipient: EVIL_WALLET });
  const { transferId } = seedTransfer({ recorded, fee: FEE, amountBaseUnits: M });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(msgHex(circle)) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('verification_failed');
});

test('S5N-6: wrong GROSS amount (≠ M + F) fails', async () => {
  const { recorded, circle } = fwdPair(304, { amount: GROSS + 1n });
  const { transferId } = seedTransfer({ recorded, fee: FEE, amountBaseUnits: M });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(msgHex(circle)) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('verification_failed');
});

test('S5N-7: wrong MAXFEE (≠ server-approved F) fails', async () => {
  const { recorded, circle } = fwdPair(305, { maxFee: FEE + 1n });
  const { transferId } = seedTransfer({ recorded, fee: FEE, amountBaseUnits: M });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(msgHex(circle)) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('verification_failed');
});

test('S5N-8: finalityThresholdExecuted < 2000 fails (finality gate untouched)', async () => {
  const { recorded, circle } = fwdPair(306, { finalityThresholdExecuted: 1000 });
  const { transferId } = seedTransfer({ recorded, fee: FEE, amountBaseUnits: M });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(msgHex(circle)) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('verification_failed');
});

test('S5N-9: wrong FEEEXECUTED (Circle charged ≠ F) fails — merchant must net exactly M', async () => {
  // feeExecuted is a CIRCLE-MUTABLE field, so the stable binding does not cover it —
  // this money-critical invariant is enforced ONLY by the dedicated feeExecuted === F
  // check, proving the corrected path did not silently drop it.
  for (const bad of [FEE + 1n, FEE - 1n, 0n]) {
    const { recorded, circle } = fwdPair(310 + Number(bad), { feeExecuted: bad });
    const { transferId } = seedTransfer({ recorded, fee: FEE, amountBaseUnits: M });
    const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(msgHex(circle)) }));
    const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
    expect(!res.ok && res.code).toBe('verification_failed');
    expect(row(transferId).attestation).toBeNull();
  }
});

test('S5N-10: a TAMPERED executed message (burn token redirected) fails via the stable binding', async () => {
  // All money fields still match the intent; only the (stable) burn token was tampered,
  // so this can only be caught by binding Circle's message to THIS transfer's recorded source.
  const { recorded, circle } = fwdPair(311, { burnToken: EVIL_TOKEN });
  const { transferId } = seedTransfer({ recorded, fee: FEE, amountBaseUnits: M });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(msgHex(circle)) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('verification_failed');
});

test('S5N-11: an arbitrary message from a DIFFERENT burn (substituted sender) fails via the binding', async () => {
  // A well-formed forwarding execution whose messageSender belongs to another transfer.
  const { recorded, circle } = fwdPair(312, { messageSender: OTHER_SENDER });
  const { transferId } = seedTransfer({ recorded, fee: FEE, amountBaseUnits: M });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(msgHex(circle)) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('verification_failed');
});

// ── (12) Replay / idempotency protections remain ───────────────────────────
test('S5N-12: replay after a successful FORWARDING attestation is idempotent (no re-fetch, no new credit, hash never clobbered)', async () => {
  const { recorded, circle } = fwdPair(320);
  const { transferId, intentId } = seedTransfer({ recorded, fee: FEE, amountBaseUnits: M });
  const f1 = makeFetch(() => ({ status: 200, body: completeBody(msgHex(circle), FORWARD_MINT_TX) }));
  const r1 = await requestAttestation({ transferId, fetchImpl: f1.fetch, nowSeconds: NOW });
  expect(r1.ok && r1.outcome).toBe('attested');
  const firstHash = row(transferId).destination_tx_hash;
  expect(firstHash).toBe(FORWARD_MINT_TX);

  // Replay: already-attested short-circuits with ZERO further Circle calls.
  const f2 = makeFetch(() => ({ status: 200, body: completeBody(msgHex(circle), '0x' + 'aa'.repeat(32)) }));
  const r2 = await requestAttestation({ transferId, fetchImpl: f2.fetch, nowSeconds: NOW });
  expect(r2.ok && r2.outcome).toBe('already_attested');
  expect(f2.calls.length).toBe(0);
  expect(row(transferId).destination_tx_hash).toBe(firstHash); // never overwritten
  // Money is NEVER credited by attestation.
  expect(intentStatus(intentId)).not.toBe('succeeded');
  expect(getDb().prepare('SELECT COUNT(*) c FROM payments WHERE payment_intent_id=?').get(intentId)).toEqual({ c: 0 });
});
