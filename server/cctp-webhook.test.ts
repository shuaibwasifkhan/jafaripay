/**
 * CCTP MASTER PHASE 12 — merchant webhooks for the cross-chain lifecycle.
 *
 * The pipeline modules record INTERNAL `payment_events` for every CCTP milestone;
 * PHASE 12 turns the merchant-relevant ones into real, tenant/environment-gated,
 * subscription-filtered webhook DELIVERIES via `emitCrossChainLifecycleWebhook`:
 *   • payment.cross_chain.attestation_received — Circle attested the finalized
 *     source burn; Arc settlement is now pending (a new progress signal).
 *   • payment.cross_chain.failed — a TERMINAL journey failure carrying the exact
 *     machine reason: attestation_timeout | attestation_verification_failed
 *     (PHASE 7) or destination_timeout (PHASE 11 worker).
 *   • payment.succeeded remains the ONE canonical success webhook, now ENRICHED
 *     with a cross_chain detail block (never a second success event).
 *
 * Enqueue-only (status 'pending'): nothing is ever sent to a live URL here. The
 * standard delivery guards are exercised: no subscribed/active endpoint, or an
 * environment mismatch, yields ZERO deliveries — never a cross-tenant leak.
 *
 * ISOLATION: every test gets its OWN merchant + settlement wallet + endpoint so
 * the per-merchant subscription join can never be satisfied by another test's
 * endpoint (the negative tests depend on this). Namespace (*_cctpwk*) + DISJOINT
 * source '0xb3..' / destination '0xb4..' tx families and message nonces (base
 * 300000) — `bun test` shares ONE sqlite DB across every cctp-*.test.ts, so any
 * collision would corrupt another suite.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { keccak256, toBytes, toHex } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctpwebhook_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp-webhook-test-secret';
process.env.EMAIL_TRANSPORT = 'dev';

const { migrate, getDb } = await import('./db/schema.ts');
const { requestAttestation } = await import('./blockchain/cctp-attestation.ts');
const { settleDestination } = await import('./blockchain/cctp-destination.ts');
const { tickCrossChain } = await import('./workers/reconciliation.ts');
// cctp-source.ts statically imports db/schema.ts, so it MUST be a dynamic await
// import here: a static `import { ... } from './blockchain/cctp-source.ts'` is
// hoisted and runs BEFORE the process.env.DATABASE_URL assignment above, which
// would freeze schema.ts DB_PATH to the shared default DB and collide.
const { messageTransmitterFor } = await import('./blockchain/cctp-source.ts');
import type { FetchLike } from './blockchain/cctp-attestation.ts';
import type { DestinationProvider } from './blockchain/cctp-destination.ts';
import type { RawLog, TransactionReceipt } from './blockchain/arc-provider.ts';
import { ARC_CCTP_DOMAIN, addressToBytes32 } from './db/cctp.ts';

// ── Fixed vectors: base_sepolia → arc_testnet (the testnet pilot route) ──────
const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const RELAYER = '0x2222222222222222222222222222222222222222';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TM = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
const MT = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275';
const MT_TESTNET = messageTransmitterFor(true);
const AMOUNT = 5_000_000n;
const AMOUNT_STR = '5000000';
const DOMAIN = 6; // base_sepolia CCTP domain
const SRC_CHAIN = 84532;
const ARC_TESTNET_CHAIN = 5042002;
const NOW = 1_800_000_000;

const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'), 'hex');
const hex32 = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');
const u32 = (n: number) => n.toString(16).padStart(8, '0');
const b32 = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const a32 = (addr: string) => addressToBytes32(addr).slice(2);

// DISJOINT tx families for the shared DB.
const srcHash = (n: number) => '0x' + 'b3'.repeat(31) + (n % 256).toString(16).padStart(2, '0');
const destHash = (n: number) => '0x' + 'b4'.repeat(31) + (n % 256).toString(16).padStart(2, '0');

/** A valid full CCTP message per Circle's published offsets (nonce base 300000). */
function buildMessage(o: {
  sourceDomain?: number; destinationDomain?: number; mintRecipient?: string;
  amount?: bigint; finalityThresholdExecuted?: number; nonce?: bigint;
} = {}): Uint8Array {
  const header =
    u32(1) + u32(o.sourceDomain ?? DOMAIN) + u32(o.destinationDomain ?? ARC_CCTP_DOMAIN) +
    b32(o.nonce ?? 1234n) + a32(TM) + a32(MT) + b32(0) + u32(0) + u32(o.finalityThresholdExecuted ?? 2000);
  const body =
    u32(1) + a32(SRC_USDC) + a32(o.mintRecipient ?? ARC_WALLET) + b32(o.amount ?? AMOUNT) +
    a32(ZERO_ADDR) + b32(0n) + b32(0n) + b32(1_000_000n);
  return toBytes(`0x${header + body}`);
}
const msgHex = (bytes: Uint8Array) => toHex(bytes);
const msgId = (bytes: Uint8Array) => keccak256(toHex(bytes), 'hex');

// ── Fake Circle fetches ──────────────────────────────────────────────────────
function completeFetch(bytes: Uint8Array, attestation = '0xc0ffee'): FetchLike {
  return async () => ({
    status: 200, ok: true,
    json: async () => ({ messages: [{ status: 'complete', message: msgHex(bytes), attestation, decodedMessage: {} }] }),
  } as Awaited<ReturnType<FetchLike>>);
}
const pendingFetch: FetchLike = async () => ({ status: 404, ok: false, json: async () => ({}) } as Awaited<ReturnType<FetchLike>>);

// ── Destination mint provider that pays the pinned wallet for ONE tx hash ──────
function transferLog(to: string, value: bigint): RawLog {
  return { address: ARC_USDC, topics: [TRANSFER_TOPIC, addressToBytes32(ZERO_ADDR), addressToBytes32(to)], data: hex32(value), logIndex: 0 };
}
function mintingProviderFor(txHash: string): () => DestinationProvider {
  const receipt: TransactionReceipt = {
    txHash, status: 'success', blockNumber: 33_333n, blockTimestamp: 1_700_000_000n,
    from: RELAYER, to: MT_TESTNET, logs: [transferLog(ARC_WALLET, AMOUNT)],
  };
  return () => ({ async getTransactionReceipt(h) { return h === txHash ? receipt : null; } });
}
const providerNullFactory = (): DestinationProvider => ({ async getTransactionReceipt() { return null; } });

// ── Fixtures (per-test merchant for true subscription isolation) ───────────
let seq = 0;
const s = () => ++seq;

function newMerchant(): { merchantId: string; walletId: string } {
  const n = s();
  const merchantId = `merch_cctpwk_${n}`;
  const walletId = `sw_cctpwk_${n}`;
  const db = getDb();
  db.prepare('INSERT INTO merchants(id,name) VALUES(?,?)').run(merchantId, `P12 webhook merchant ${n}`);
  db.prepare('INSERT INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run(walletId, merchantId, ARC_WALLET, 'arc_testnet');
  return { merchantId, walletId };
}

function addEndpoint(merchantId: string, events: string[], environment: 'test' | 'live', isActive = 1): string {
  const id = `whe_cctpwk_${s()}`;
  getDb().prepare(
    `INSERT INTO webhook_endpoints(id,merchant_id,url,secret_hash,secret_preview,description,events,environment,is_active)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(id, merchantId, 'https://merchant.example.com/hook', 'hash', 'abcd', 'test', JSON.stringify(events), environment, isActive);
  return id;
}

function insertIntent(merchantId: string, walletId: string, environment: 'test' | 'live'): string {
  const iid = `pi_cctpwk_${s()}`;
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
      amount_decimal,amount_base_units,environment,status,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(iid, merchantId, walletId, ARC_WALLET, 'base_sepolia', SRC_CHAIN, SRC_USDC,
    '5.00', AMOUNT_STR, environment, 'processing', 9_999_999_999, 1, 'base_sepolia', 'arc_testnet', ARC_TESTNET_CHAIN);
  return iid;
}

function seedTransfer(intentId: string, o: {
  state: string; attestationStatus?: string; message?: Uint8Array | null; destTx?: string | null;
  finalized?: number | null; updatedAt?: number; attestation?: string | null;
}): { transferId: string } {
  const bytes = o.message ?? buildMessage({ nonce: BigInt(300000 + seq) });
  const tid = `cct_cctpwk_${seq}`;
  getDb().prepare(
    `INSERT INTO cross_chain_transfers(id,payment_intent_id,source_network,source_chain_id,source_usdc_address,token_messenger,
      source_tx_hash,source_finalized_at,cctp_message_id,cctp_message,destination_network,destination_chain_id,destination_tx_hash,
      mint_recipient,amount_base_units,attestation,attestation_status,state,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(tid, intentId, 'base_sepolia', SRC_CHAIN, SRC_USDC, TM,
    srcHash(seq), o.finalized === undefined ? NOW - 60 : o.finalized,
    o.message === null ? null : msgId(bytes), o.message === null ? null : msgHex(bytes),
    'arc_testnet', ARC_TESTNET_CHAIN, o.destTx ?? null, ARC_WALLET, AMOUNT_STR,
    o.attestation ?? (o.attestationStatus === 'complete' ? '0xc0ffee' : null),
    o.attestationStatus ?? 'none', o.state, o.updatedAt ?? NOW);
  return { transferId: tid };
}

function deliveries(intentId: string, eventType: string): Array<Record<string, unknown>> {
  return getDb().prepare(
    'SELECT event_type, payload FROM webhook_deliveries WHERE payment_intent_id=? AND event_type=?',
  ).all(intentId, eventType) as Array<Record<string, unknown>>;
}
function payloadOf(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(String(rows[0].payload));
}

beforeAll(() => { migrate(); });

afterAll(() => {
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ── P12-1: attestation → progress webhook ────────────────────────────────────
test('P12-1: a verified attestation enqueues payment.cross_chain.attestation_received', async () => {
  const { merchantId, walletId } = newMerchant();
  const iid = insertIntent(merchantId, walletId, 'test');
  const bytes = buildMessage({ nonce: BigInt(300000 + seq) });
  const { transferId } = seedTransfer(iid, { state: 'source_finalized', attestationStatus: 'none', message: bytes });
  addEndpoint(merchantId, ['payment.cross_chain.attestation_received'], 'test');

  const res = await requestAttestation({ transferId, fetchImpl: completeFetch(bytes), nowSeconds: NOW });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.outcome).toBe('attested');

  const rows = deliveries(iid, 'payment.cross_chain.attestation_received');
  expect(rows.length).toBe(1);
  const p = payloadOf(rows);
  expect(p.type).toBe('payment.cross_chain.attestation_received');
  expect((p.data as Record<string, unknown>).transfer_id).toBe(transferId);
  expect((p.data as Record<string, unknown>).mint_recipient).toBe(ARC_WALLET);
});

// ── P12-2: attestation timeout → failed webhook ──────────────────────────────
test('P12-2: an attestation window timeout enqueues payment.cross_chain.failed (attestation_timeout)', async () => {
  const { merchantId, walletId } = newMerchant();
  const iid = insertIntent(merchantId, walletId, 'test');
  // Finalized 2000s ago > the 1800s window → terminal, no poll is made.
  const { transferId } = seedTransfer(iid, { state: 'source_finalized', attestationStatus: 'none', finalized: NOW - 2000 });
  addEndpoint(merchantId, ['payment.cross_chain.failed'], 'test');

  const res = await requestAttestation({ transferId, fetchImpl: pendingFetch, nowSeconds: NOW });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.outcome).toBe('timeout');

  const rows = deliveries(iid, 'payment.cross_chain.failed');
  expect(rows.length).toBe(1);
  expect((payloadOf(rows).data as Record<string, unknown>).reason).toBe('attestation_timeout');
});

// ── P12-3: verification failure → failed webhook ─────────────────────────────
test('P12-3: a message-hash mismatch enqueues payment.cross_chain.failed (attestation_verification_failed)', async () => {
  const { merchantId, walletId } = newMerchant();
  const iid = insertIntent(merchantId, walletId, 'test');
  const recorded = buildMessage({ nonce: BigInt(300000 + seq) });
  const { transferId } = seedTransfer(iid, { state: 'source_finalized', attestationStatus: 'none', message: recorded });
  addEndpoint(merchantId, ['payment.cross_chain.failed'], 'test');

  // Circle returns a DIFFERENT message → keccak(returned) != recorded cctp_message_id.
  const returned = buildMessage({ nonce: BigInt(300000 + 900000 + seq) });
  const res = await requestAttestation({ transferId, fetchImpl: completeFetch(returned), nowSeconds: NOW });
  expect(res.ok).toBe(false);

  const rows = deliveries(iid, 'payment.cross_chain.failed');
  expect(rows.length).toBe(1);
  expect((payloadOf(rows).data as Record<string, unknown>).reason).toBe('attestation_verification_failed');
});

// ── P12-4: no subscribed endpoint → no delivery ──────────────────────────────
test('P12-4: an endpoint NOT subscribed to a cross-chain event receives nothing', async () => {
  const { merchantId, walletId } = newMerchant();
  const iid = insertIntent(merchantId, walletId, 'test');
  const bytes = buildMessage({ nonce: BigInt(300000 + seq) });
  const { transferId } = seedTransfer(iid, { state: 'source_finalized', attestationStatus: 'none', message: bytes });
  addEndpoint(merchantId, ['payment.created'], 'test'); // legacy subscription only

  const res = await requestAttestation({ transferId, fetchImpl: completeFetch(bytes), nowSeconds: NOW });
  expect(res.ok).toBe(true);
  expect(deliveries(iid, 'payment.cross_chain.attestation_received').length).toBe(0);
});

// ── P12-5: environment isolation → no delivery ───────────────────────────────
test('P12-5: a test intent never delivers to a live-environment endpoint', async () => {
  const { merchantId, walletId } = newMerchant();
  const iid = insertIntent(merchantId, walletId, 'test');
  const bytes = buildMessage({ nonce: BigInt(300000 + seq) });
  const { transferId } = seedTransfer(iid, { state: 'source_finalized', attestationStatus: 'none', message: bytes });
  addEndpoint(merchantId, ['payment.cross_chain.attestation_received'], 'live');

  const res = await requestAttestation({ transferId, fetchImpl: completeFetch(bytes), nowSeconds: NOW });
  expect(res.ok).toBe(true);
  expect(deliveries(iid, 'payment.cross_chain.attestation_received').length).toBe(0);
});

// ── P12-6: destination timeout (worker) → failed webhook ─────────────────────
test('P12-6: the worker destination-timeout sweep enqueues payment.cross_chain.failed (destination_timeout)', async () => {
  const { merchantId, walletId } = newMerchant();
  const iid = insertIntent(merchantId, walletId, 'test');
  const bytes = buildMessage({ nonce: BigInt(300000 + seq) });
  // Attested, NO destination mint recorded, updated well past the 1h window.
  seedTransfer(iid, {
    state: 'attested', attestationStatus: 'complete', message: bytes, destTx: null, updatedAt: NOW - 7200,
  });
  addEndpoint(merchantId, ['payment.cross_chain.failed'], 'test');

  // Fakes make the shared-DB sweep inert for every OTHER suite's rows (no network,
  // no credit); only this row's no-dest-mint + stale clock trips the timeout.
  await tickCrossChain({ nowSeconds: NOW, fetchImpl: pendingFetch, providerFactory: providerNullFactory });

  const rows = deliveries(iid, 'payment.cross_chain.failed');
  expect(rows.length).toBe(1);
  expect((payloadOf(rows).data as Record<string, unknown>).reason).toBe('destination_timeout');
});

// ── P12-7: success webhook enriched with cross_chain detail ──────────────────
test('P12-7: settleDestination emits ONE payment.succeeded carrying the cross_chain detail', async () => {
  const { merchantId, walletId } = newMerchant();
  const iid = insertIntent(merchantId, walletId, 'test');
  const bytes = buildMessage({ nonce: BigInt(300000 + seq) });
  const dtx = destHash(seq);
  const { transferId } = seedTransfer(iid, { state: 'attested', attestationStatus: 'complete', message: bytes, destTx: dtx });
  addEndpoint(merchantId, ['payment.succeeded'], 'test');

  const res = await settleDestination({ transferId, destinationTxHash: dtx, providerFactory: mintingProviderFor(dtx), nowSeconds: NOW });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.outcome).toBe('settled');

  const rows = deliveries(iid, 'payment.succeeded');
  expect(rows.length).toBe(1);
  const cc = (payloadOf(rows).data as Record<string, unknown>).cross_chain as Record<string, unknown>;
  expect(cc.source_network).toBe('base_sepolia');
  expect(cc.destination_network).toBe('arc_testnet');
  expect(cc.destination_tx_hash).toBe(dtx);
  expect(cc.mint_recipient).toBe(ARC_WALLET);
});
