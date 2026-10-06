/**
 * CCTP MASTER PHASE 7 — Circle attestation service.
 *
 * Proves the isolated, idempotent, back-off attestation flow WITHOUT any real
 * network or credit, against Circle's VERIFIED /v2/messages response contract:
 *   • the permissionless URL is built for the right environment (sandbox vs
 *     production) with a full 0x tx hash; a bad hash is refused;
 *   • pollCircleAttestation maps 404 / {messages:[]} / {status:pending} /
 *     complete / 429 / non-2xx to the correct outcome and NEVER throws;
 *   • requestAttestation is GATED on source finality, is idempotent (an
 *     already-complete attestation never re-hits the API), backs off under the
 *     stored schedule (surviving a restart), and times out past the window;
 *   • the returned message is NEVER trusted: keccak256(message) must equal the
 *     recorded cctp_message_id and every money field (domains, mint recipient =
 *     the merchant's ONE pinned Arc wallet, exact amount, finalized class) must
 *     match, else a HARD verification_failed parks the transfer — no attestation
 *     is stored and NOTHING is ever credited.
 *
 * Unique fixture namespace (*_cctpa*) — `bun test` shares ONE sqlite DB.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { keccak256, toBytes, toHex } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctpattest_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp-attest-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const mod = await import('./blockchain/cctp-attestation.ts');
const {
  attestationLookupUrl, irisBaseUrl, pollCircleAttestation, requestAttestation, nextAttemptDelaySeconds,
} = mod;
import type { FetchLike } from './blockchain/cctp-attestation.ts';
import { ARC_CCTP_DOMAIN, addressToBytes32 } from './db/cctp.ts';

// ── Fixed vectors (base_sepolia → arc_testnet, the testnet pilot route) ──────
const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const EVIL_WALLET = '0x1111111111111111111111111111111111111111';
const DEPOSITOR = '0x9999999999999999999999999999999999999999';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TM = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'; // testnet TokenMessenger
const MT = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'; // testnet MessageTransmitter
const AMOUNT = 5_000_000n;
const DOMAIN = 6; // base_sepolia CCTP domain
const NOW = 1_800_000_000; // fixed unix clock for deterministic back-off/timeout

const u32 = (n: number) => n.toString(16).padStart(8, '0');
const b32 = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const a32 = (addr: string) => addressToBytes32(addr).slice(2);

/** Build a raw CCTP message byte-for-byte per Circle's published offsets. */
function buildMessage(o: {
  sourceDomain?: number; destinationDomain?: number; mintRecipient?: string;
  amount?: bigint; maxFee?: bigint; finalityThresholdExecuted?: number; expirationBlock?: bigint; nonce?: bigint;
  feeExecuted?: bigint;
} = {}): Uint8Array {
  const header =
    u32(1) + u32(o.sourceDomain ?? DOMAIN) + u32(o.destinationDomain ?? ARC_CCTP_DOMAIN) +
    b32(o.nonce ?? 1234n) + a32(TM) + a32(MT) + b32(0) + u32(0) + u32(o.finalityThresholdExecuted ?? 2000);
  // body maxFee sits at offset 132 (right after messageSender); feeExecuted follows.
  const body =
    u32(1) + a32(SRC_USDC) + a32(o.mintRecipient ?? ARC_WALLET) + b32(o.amount ?? AMOUNT) +
    a32(DEPOSITOR) + b32(o.maxFee ?? 0n) + b32(o.feeExecuted ?? o.maxFee ?? 0n) + b32(o.expirationBlock ?? 1_000_000n);
  return toBytes(`0x${header + body}`);
}

const msgHex = (bytes: Uint8Array) => toHex(bytes);
const msgId = (bytes: Uint8Array) => keccak256(toHex(bytes), 'hex');

// ── Fake Circle fetch (records every call) ─────────────────────────────────
interface FakeRes { status: number; body?: unknown }
function makeFetch(route: (url: string) => FakeRes): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url: string) => {
    calls.push(url);
    const r = route(url);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.body,
    } as Awaited<ReturnType<FetchLike>>;
  };
  return { fetch, calls };
}
const completeBody = (bytes: Uint8Array, attestation = '0xc0ffee') => ({
  messages: [{ status: 'complete', message: msgHex(bytes), attestation, decodedMessage: {} }],
});

// ── Seed a finalized in-flight transfer for an intent ──────────────────────
let seq = 0;
function seedTransfer(over: Partial<{
  source_network: string; destination_network: string; state: string;
  attestation_status: string; attestation_attempts: number; next: number | null;
  finalized: number | null; message: Uint8Array; cctp_message_id: string | null;
  amount_base_units: string; mint_recipient: string; fee: bigint;
}> = {}): { transferId: string; intentId: string; bytes: Uint8Array } {
  const bytes = over.message ?? buildMessage({ nonce: BigInt(1000 + seq) });
  const id = `pi_cctpa_${++seq}`;
  const tid = `cct_cctpa_${seq}`;
  // A hash pattern DISJOINT from every other cctp-*.test.ts (they all share ONE
  // physical DB because the schema module is cached at first import): 31 bytes
  // of 0xa7 + a per-row counter byte. The burn suite's small numbered hashes can
  // never collide with this under uq_cct_source_tx.
  const txHash = '0x' + 'a7'.repeat(31) + (seq % 256).toString(16).padStart(2, '0');
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
      amount_decimal,amount_base_units,environment,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, 'merch_cctpa', 'sw_cctpa', ARC_WALLET, over.source_network ?? 'base_sepolia', 84532, SRC_USDC,
    '5.00', '5000000', 'test', 9999999999, 1, over.source_network ?? 'base_sepolia', over.destination_network ?? 'arc_testnet', 5042002);
  // STEP 4B — server-authored Forwarding fee (F). Written ONLY here by the server,
  // never derived from the message. Default remains '0' (DIRECT) when unset.
  if (over.fee !== undefined) {
    getDb().prepare('UPDATE payment_intents SET forwarding_max_fee_base_units=? WHERE id=?').run(String(over.fee), id);
  }

  const srcNet = over.source_network ?? 'base_sepolia';
  const destNet = over.destination_network ?? 'arc_testnet';
  getDb().prepare(
    `INSERT INTO cross_chain_transfers(id,payment_intent_id,source_network,source_chain_id,source_usdc_address,token_messenger,
      source_tx_hash,source_finalized_at,cctp_message_id,cctp_message,destination_network,destination_chain_id,mint_recipient,
      amount_base_units,attestation_status,attestation_attempts,next_attestation_attempt_at,state)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(tid, id, srcNet, 84532, SRC_USDC, TM, txHash,
    over.finalized === undefined ? NOW - 60 : over.finalized,
    over.cctp_message_id === undefined ? msgId(bytes) : over.cctp_message_id,
    msgHex(bytes), destNet, 5042002, over.mint_recipient ?? ARC_WALLET,
    over.amount_base_units ?? '5000000', over.attestation_status ?? 'none',
    over.attestation_attempts ?? 0, over.next ?? null, over.state ?? 'source_finalized');
  return { transferId: tid, intentId: id, bytes };
}

function row(transferId: string): Record<string, unknown> {
  return getDb().prepare('SELECT * FROM cross_chain_transfers WHERE id=?').get(transferId) as Record<string, unknown>;
}
function intentStatus(intentId: string): string {
  return (getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(intentId) as { status: string }).status;
}
function eventTypes(intentId: string): string[] {
  return (getDb().prepare('SELECT event_type FROM payment_events WHERE payment_intent_id=? ORDER BY id').all(intentId) as Array<{ event_type: string }>).map((e) => e.event_type);
}

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctpa', 'P7 attestation merchant');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_cctpa', 'merch_cctpa', ARC_WALLET, 'arc_testnet');
});

afterAll(() => {
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ── Pure URL / env-class helpers ───────────────────────────────────────────

test('P7-1: irisBaseUrl + attestationLookupUrl pick sandbox vs production from the env class', () => {
  expect(irisBaseUrl(true)).toBe('https://iris-api-sandbox.circle.com');
  expect(irisBaseUrl(false)).toBe('https://iris-api.circle.com');
  const url = attestationLookupUrl({ isTestnet: true, sourceDomain: 6, sourceTxHash: '0x' + 'ab'.repeat(32) });
  expect(url).toBe(`https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=0x${'ab'.repeat(32)}`);
});

test('P7-2: attestationLookupUrl refuses a non 0x-32-byte tx hash (would 404 forever)', () => {
  expect(() => attestationLookupUrl({ isTestnet: true, sourceDomain: 6, sourceTxHash: 'deadbeef' })).toThrow();
  expect(() => attestationLookupUrl({ isTestnet: true, sourceDomain: 6, sourceTxHash: '0x123' })).toThrow();
});

// ── Pure poll mapping ──────────────────────────────────────────────────────

test('P7-3: pollCircleAttestation maps 404 / empty / pending / complete / 429 without throwing', async () => {
  const bytes = buildMessage();
  const cases: Array<[FakeRes, string, string]> = [
    [{ status: 404 }, 'pending', 'not_observed'],
    [{ status: 200, body: { messages: [] } }, 'pending', 'unprocessed'],
    [{ status: 200, body: { status: 'pending' } }, 'pending', 'awaiting_confirmations'],
    [{ status: 429 }, 'rate_limited', ''],
    [{ status: 500 }, 'http_error', ''],
  ];
  for (const [res, kind, reason] of cases) {
    const { fetch } = makeFetch(() => res);
    const out = await pollCircleAttestation({ isTestnet: true, sourceDomain: 6, sourceTxHash: '0x' + 'cd'.repeat(32), fetchImpl: fetch });
    expect(out.kind).toBe(kind);
    if (reason) expect((out as { reason: string }).reason).toBe(reason);
  }
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(bytes) }));
  const done = await pollCircleAttestation({ isTestnet: true, sourceDomain: 6, sourceTxHash: '0x' + 'cd'.repeat(32), fetchImpl: fetch });
  expect(done.kind).toBe('attested');
});

// ── Happy path: verified attestation, NO credit ────────────────────────────

test('P7-4: a verified attestation is stored, state → attested, and NOTHING is credited', async () => {
  const { transferId, intentId, bytes } = seedTransfer();
  const { fetch, calls } = makeFetch(() => ({ status: 200, body: completeBody(bytes) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error('unexpected');
  expect(res.outcome).toBe('attested');
  expect(calls.length).toBe(1);
  const r = row(transferId);
  expect(r.attestation_status).toBe('complete');
  expect(r.state).toBe('attested');
  expect(r.attestation).toBe('0xc0ffee');
  expect(r.next_attestation_attempt_at).toBeNull();
  // The money is NEVER touched: no payment credited, intent not 'succeeded'.
  expect(intentStatus(intentId)).not.toBe('succeeded');
  expect(getDb().prepare('SELECT COUNT(*) c FROM payments WHERE payment_intent_id=?').get(intentId)).toEqual({ c: 0 });
  expect(eventTypes(intentId)).toContain('payment.cross_chain.attestation_received');
});

test('P7-5: pending / rate-limited schedule back-off and keep the transfer in flight', async () => {
  // 404 → pending, first delay = max(5, min(5*2,300)) = 10s, state attestation_pending.
  const a = seedTransfer();
  const fa = makeFetch(() => ({ status: 404 }));
  const ra = await requestAttestation({ transferId: a.transferId, fetchImpl: fa.fetch, nowSeconds: NOW });
  expect(ra.ok && ra.outcome).toBe('pending');
  expect(row(a.transferId).state).toBe('attestation_pending');
  expect(row(a.transferId).attestation_status).toBe('pending');
  expect(row(a.transferId).attestation_attempts).toBe(1);
  expect(row(a.transferId).next_attestation_attempt_at).toBe(NOW + nextAttemptDelaySeconds(1, false));

  // 429 → jumps to the rate-limit window (300s).
  const b = seedTransfer();
  const fb = makeFetch(() => ({ status: 429 }));
  await requestAttestation({ transferId: b.transferId, fetchImpl: fb.fetch, nowSeconds: NOW });
  expect(row(b.transferId).next_attestation_attempt_at).toBe(NOW + nextAttemptDelaySeconds(1, true));
  expect(row(b.transferId).next_attestation_attempt_at).toBe(NOW + 300);
});

test('P7-6: idempotent — an already-complete attestation never re-hits the API', async () => {
  const { transferId } = seedTransfer({ attestation_status: 'complete', state: 'attested' });
  const { fetch, calls } = makeFetch(() => ({ status: 500 }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(res.ok && res.outcome).toBe('already_attested');
  expect(calls.length).toBe(0);
});

test('P7-7: back-off respects the stored schedule — not_due without a fetch', async () => {
  const { transferId } = seedTransfer({ next: NOW + 50 });
  const { fetch, calls } = makeFetch(() => ({ status: 200, body: { messages: [] } }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(res.ok && res.outcome).toBe('not_due');
  expect(calls.length).toBe(0);
});

test('P7-8: attestation is GATED on source finality — an unfinalized/ineligible state is refused', async () => {
  const sub = seedTransfer({ state: 'source_payment_submitted' });
  const f1 = makeFetch(() => ({ status: 200, body: { messages: [] } }));
  const r1 = await requestAttestation({ transferId: sub.transferId, fetchImpl: f1.fetch, nowSeconds: NOW });
  expect(!r1.ok && r1.code).toBe('state_not_eligible');

  const unfinal = seedTransfer({ finalized: null });
  const f2 = makeFetch(() => ({ status: 200, body: { messages: [] } }));
  const r2 = await requestAttestation({ transferId: unfinal.transferId, fetchImpl: f2.fetch, nowSeconds: NOW });
  expect(!r2.ok && r2.code).toBe('source_not_finalized');
});

test('P7-9: past the attestation window the transfer times out (no fetch, no credit)', async () => {
  const { transferId, intentId } = seedTransfer({ finalized: NOW - 1801 });
  const { fetch, calls } = makeFetch(() => ({ status: 200, body: { messages: [] } }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(res.ok && res.outcome).toBe('timeout');
  expect(calls.length).toBe(0);
  expect(row(transferId).attestation_status).toBe('timeout');
  expect(row(transferId).state).toBe('attestation_timeout');
  expect(intentStatus(intentId)).not.toBe('succeeded');
});

// ── Never trust Circle: hard verification failures park the transfer ───────

test('P7-10: a message whose hash ≠ the recorded cctp_message_id fails verification and stores nothing', async () => {
  const good = buildMessage();
  const { transferId } = seedTransfer({ message: good, cctp_message_id: '0x' + 'ee'.repeat(32) }); // id mismatch
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(good) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('verification_failed');
  const r = row(transferId);
  expect(r.state).toBe('verification_failed');
  expect(r.attestation_status).toBe('failed');
  expect(r.attestation).toBeNull(); // the bad signature is NEVER stored
});

test('P7-11: mismatched money fields (recipient / amount / domain / sub-finalized) are refused', async () => {
  const cases: Array<Parameters<typeof buildMessage>[0]> = [
    { mintRecipient: EVIL_WALLET },                      // redirects the mint
    { amount: 4_000_000n },                              // under-mints the principal
    { destinationDomain: 99 },                           // not Arc
    { sourceDomain: 99 },                                // wrong source domain
    { finalityThresholdExecuted: 1000 },                 // unfinalized class
  ];
  for (const c of cases) {
    const bad = buildMessage(c);
    const { transferId } = seedTransfer({ message: bad }); // id matches the bad msg, fields don't match the transfer
    const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(bad) }));
    const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
    expect(!res.ok && res.code).toBe('verification_failed');
    expect(row(transferId).attestation).toBeNull();
  }
});

// ── Structural guards ──────────────────────────────────────────────────────

test('P7-12: an unknown transfer or a non-cross-chain route is refused without a fetch', async () => {
  const missing = await requestAttestation({ transferId: 'cct_does_not_exist', fetchImpl: makeFetch(() => ({ status: 404 })).fetch, nowSeconds: NOW });
  expect(!missing.ok && missing.code).toBe('transfer_not_found');

  const zksync = seedTransfer({ source_network: 'zksync_era' });
  const f = makeFetch(() => ({ status: 404 }));
  const res = await requestAttestation({ transferId: zksync.transferId, fetchImpl: f.fetch, nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('not_cross_chain');
  expect(f.calls.length).toBe(0);
});

test('P7-13: a network error is a retryable pending, never a failure or credit', async () => {
  const { transferId } = seedTransfer();
  const throwing: FetchLike = async () => { throw new Error('socket hang up'); };
  const res = await requestAttestation({ transferId, fetchImpl: throwing, nowSeconds: NOW });
  expect(res.ok && res.outcome).toBe('pending');
  expect(row(transferId).state).toBe('attestation_pending');
  expect(String(row(transferId).attestation_error)).toContain('network_error');
});

// ── STEP 4B — server-authored Forwarding fee in the attested message ───────
// Locked DEDUCTED model: merchant target M = transfer.amount_base_units (NEVER
// changes); the server-approved Forwarding fee F = intent.forwarding_max_fee_base_units.
// The attested message.amount is the GROSS burn M + F and its maxFee must equal F
// EXACTLY (message == server approval). Anything else fails closed. The finality
// >= 2000 gate is untouched. Each message uses a unique nonce so its keccak256
// (cctp_message_id / burn_message_hash) never collides under the UNIQUE indexes.

const FEE = 20_380n; // server-approved Forwarding maxFee for these fixtures

test('S4A-1: FORWARDING attestation — message.amount = M+F, maxFee = F, merchant target stays M', async () => {
  const bytes = buildMessage({ amount: AMOUNT + FEE, maxFee: FEE, nonce: 90001n });
  const { transferId, intentId } = seedTransfer({ fee: FEE, message: bytes });
  // Merchant settlement target is M, NOT M + F.
  expect(row(transferId).amount_base_units).toBe('5000000');
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(bytes) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(res.ok && res.outcome).toBe('attested');
  expect(row(transferId).state).toBe('attested');
  expect(row(transferId).attestation).toBe('0xc0ffee');
  // Nothing credited — the merchant target is still M.
  expect(intentStatus(intentId)).not.toBe('succeeded');
});

test('S4A-2: FORWARDING attestation — message.amount missing the fee (M, not M+F) fails', async () => {
  const bytes = buildMessage({ amount: AMOUNT, maxFee: FEE, nonce: 90002n });
  const { transferId } = seedTransfer({ fee: FEE, message: bytes });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(bytes) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('verification_failed');
  expect(row(transferId).attestation).toBeNull();
});

test('S4A-3: FORWARDING attestation — message.maxFee ≠ server-approved F fails', async () => {
  const bytes = buildMessage({ amount: AMOUNT + FEE, maxFee: FEE + 1n, nonce: 90003n });
  const { transferId } = seedTransfer({ fee: FEE, message: bytes });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(bytes) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(!res.ok && res.code).toBe('verification_failed');
  expect(row(transferId).attestation).toBeNull();
});

test('S4A-4: FINALITY gate unchanged for Forwarding messages — 1999 fails, 2000 passes', async () => {
  const bad = buildMessage({ amount: AMOUNT + FEE, maxFee: FEE, finalityThresholdExecuted: 1999, nonce: 90004n });
  const t1 = seedTransfer({ fee: FEE, message: bad });
  const f1 = makeFetch(() => ({ status: 200, body: completeBody(bad) }));
  const r1 = await requestAttestation({ transferId: t1.transferId, fetchImpl: f1.fetch, nowSeconds: NOW });
  expect(!r1.ok && r1.code).toBe('verification_failed');

  const good = buildMessage({ amount: AMOUNT + FEE, maxFee: FEE, finalityThresholdExecuted: 2000, nonce: 90005n });
  const t2 = seedTransfer({ fee: FEE, message: good });
  const f2 = makeFetch(() => ({ status: 200, body: completeBody(good) }));
  const r2 = await requestAttestation({ transferId: t2.transferId, fetchImpl: f2.fetch, nowSeconds: NOW });
  expect(r2.ok && r2.outcome).toBe('attested');
});

test('S4A-5: DIRECT (fee 0) regression — message.amount = M, maxFee 0 still attests', async () => {
  const bytes = buildMessage({ amount: AMOUNT, maxFee: 0n, nonce: 90006n });
  const { transferId } = seedTransfer({ fee: 0n, message: bytes });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBody(bytes) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(res.ok && res.outcome).toBe('attested');
});

// ── STEP 5F/5H — Circle Forwarding forwardTxHash → destination_tx_hash ──────
// A forwarded burn's Circle message carries `forwardTxHash` (the Arc mint tx
// Circle's forwarder submitted). JafariPay NEVER executes receiveMessage itself
// for forwarding; capturing that hash into destination_tx_hash lets the EXISTING
// settle sweep verify the on-Arc mint of EXACTLY M. The merchant target stays M
// (never M + F). A direct burn carries no forwardTxHash and is unchanged.
const FORWARD_MINT_TX = '0x' + 'b7'.repeat(32);
const completeBodyForward = (bytes: Uint8Array, forwardTxHash: unknown, attestation = '0xc0ffee') => ({
  messages: [{ status: 'complete', message: msgHex(bytes), attestation, decodedMessage: {}, forwardTxHash }],
});

test('S5-ATT-1: Forwarding attestation captures forwardTxHash → destination_tx_hash; merchant target stays M', async () => {
  const bytes = buildMessage({ amount: AMOUNT + FEE, maxFee: FEE, finalityThresholdExecuted: 2000, nonce: 90101n });
  const { transferId, intentId } = seedTransfer({ fee: FEE, message: bytes });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBodyForward(bytes, FORWARD_MINT_TX) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(res.ok && res.outcome).toBe('attested');
  if (!res.ok) return;
  expect(res.forwardTxHash).toBe(FORWARD_MINT_TX);
  const r = row(transferId);
  expect(r.state).toBe('attested');
  // Circle's Arc mint tx is now recorded so the settle sweep can verify it.
  expect(r.destination_tx_hash).toBe(FORWARD_MINT_TX);
  // The merchant settlement target is M, NOT M + F.
  expect(r.amount_base_units).toBe('5000000');
  // The attestation event carries the forward tx for the audit trail.
  const ev = getDb().prepare("SELECT data FROM payment_events WHERE payment_intent_id=? AND event_type='payment.cross_chain.attestation_received' ORDER BY id DESC LIMIT 1").get(intentId) as { data: string };
  expect(JSON.parse(ev.data).forward_tx_hash).toBe(FORWARD_MINT_TX);
});

test('S5-ATT-2: Direct attestation has NO forwardTxHash — destination_tx_hash stays unset (path unchanged)', async () => {
  const bytes = buildMessage({ amount: AMOUNT, maxFee: 0n, nonce: 90102n });
  const { transferId } = seedTransfer({ fee: 0n, message: bytes });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBodyForward(bytes, undefined) }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(res.ok && res.outcome).toBe('attested');
  if (!res.ok) return;
  expect(res.forwardTxHash).toBeUndefined();
  expect(row(transferId).destination_tx_hash).toBeNull();
});

test('S5-ATT-3: a malformed forwardTxHash is IGNORED (never persisted) but the attestation still stands', async () => {
  const bytes = buildMessage({ amount: AMOUNT + FEE, maxFee: FEE, finalityThresholdExecuted: 2000, nonce: 90103n });
  const { transferId } = seedTransfer({ fee: FEE, message: bytes });
  const { fetch } = makeFetch(() => ({ status: 200, body: completeBodyForward(bytes, '0xnotahash') }));
  const res = await requestAttestation({ transferId, fetchImpl: fetch, nowSeconds: NOW });
  expect(res.ok && res.outcome).toBe('attested');
  if (!res.ok) return;
  expect(res.forwardTxHash).toBeUndefined();
  expect(row(transferId).destination_tx_hash).toBeNull();
});

test('S5-ATT-4: forwardTxHash is idempotent — an already-recorded destination_tx_hash is never overwritten', async () => {
  const bytes = buildMessage({ amount: AMOUNT + FEE, maxFee: FEE, finalityThresholdExecuted: 2000, nonce: 90104n });
  const { transferId } = seedTransfer({ fee: FEE, message: bytes, attestation_status: 'none', state: 'source_finalized' });
  const first = '0x' + 'c1'.repeat(32);
  const f1 = makeFetch(() => ({ status: 200, body: completeBodyForward(bytes, first) }));
  await requestAttestation({ transferId, fetchImpl: f1.fetch, nowSeconds: NOW });
  expect(row(transferId).destination_tx_hash).toBe(first);
  // A second attestation with a DIFFERENT forward hash must not clobber the first.
  getDb().prepare("UPDATE cross_chain_transfers SET attestation_status='none', state='source_finalized' WHERE id=?").run(transferId);
  const second = '0x' + 'd2'.repeat(32);
  const f2 = makeFetch(() => ({ status: 200, body: completeBodyForward(bytes, second) }));
  await requestAttestation({ transferId, fetchImpl: f2.fetch, nowSeconds: NOW });
  expect(row(transferId).destination_tx_hash).toBe(first);
});