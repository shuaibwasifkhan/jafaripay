/**
 * CCTP MASTER PHASE 15 — cross-chain LIFECYCLE INTEGRATION.
 *
 * The per-phase unit suites (PHASE 5/6/7/8/9/12/13/14) each test ONE module in
 * isolation. This file stitches the REAL modules together and drives a single
 * transfer all the way from an already-finalized source burn to a credited,
 * receipted, webhooked, settled cross-chain payment — proving the seams:
 *   attestation (PHASE 7) → state machine (PHASE 9) → destination settlement +
 *   credit (PHASE 8) → webhook (PHASE 12) → status projection (PHASE 13) →
 *   fee exposure (PHASE 14) — then the two money-safety invariants:
 *   • IDEMPOTENCY: settling the same transfer twice never double-credits;
 *   • EARLY-SETTLEMENT GUARD: an un-attested burn can NEVER be credited.
 *
 * NO real network: Circle is a fabricated fetch, the Arc mint a fabricated
 * provider — but the CODE UNDER TEST is the same production entry points.
 *
 * Namespace (*_cctp15_*) + disjoint '0xf3..'(source)/'0xf4..'(destination) tx
 * families + message-nonce base 400000 — `bun test` shares ONE sqlite DB, so a
 * collision would corrupt another suite.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { keccak256, toBytes, toHex } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctp15_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp15-test-secret';
process.env.EMAIL_TRANSPORT = 'dev';

const { migrate, getDb } = await import('./db/schema.ts');
const { requestAttestation } = await import('./blockchain/cctp-attestation.ts');
const { settleDestination } = await import('./blockchain/cctp-destination.ts');
const { loadCrossChainStatus } = await import('./blockchain/cctp-status.ts');
// cctp-source.ts statically imports db/schema.ts → dynamic await import.
const { messageTransmitterFor } = await import('./blockchain/cctp-source.ts');
import type { FetchLike } from './blockchain/cctp-attestation.ts';
import type { DestinationProvider } from './blockchain/cctp-destination.ts';
import type { RawLog, TransactionReceipt } from './blockchain/arc-provider.ts';
import { ARC_CCTP_DOMAIN, addressToBytes32 } from './db/cctp.ts';

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
const DOMAIN = 6;
const SRC_CHAIN = 84532;
const ARC_TESTNET_CHAIN = 5042002;
const NOW = 1_800_000_000;

const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'), 'hex');
const hex32 = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');
const u32 = (n: number) => n.toString(16).padStart(8, '0');
const b32 = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const a32 = (addr: string) => addressToBytes32(addr).slice(2);

const srcHash = (n: number) => '0x' + 'f3'.repeat(31) + (n % 256).toString(16).padStart(2, '0');
const destHash = (n: number) => '0x' + 'f4'.repeat(31) + (n % 256).toString(16).padStart(2, '0');

function buildMessage(nonce: bigint): Uint8Array {
  const header =
    u32(1) + u32(DOMAIN) + u32(ARC_CCTP_DOMAIN) + b32(nonce) + a32(TM) + a32(MT) + b32(0) + u32(0) + u32(2000);
  const body =
    u32(1) + a32(SRC_USDC) + a32(ARC_WALLET) + b32(AMOUNT) + a32(ZERO_ADDR) + b32(0n) + b32(0n) + b32(1_000_000n);
  return toBytes(`0x${header + body}`);
}
const msgHex = (b: Uint8Array) => toHex(b);
const msgId = (b: Uint8Array) => keccak256(toHex(b), 'hex');

function completeFetch(bytes: Uint8Array): FetchLike {
  return async () => ({
    status: 200, ok: true,
    json: async () => ({ messages: [{ status: 'complete', message: msgHex(bytes), attestation: '0x' + 'f5'.repeat(32), decodedMessage: {} }] }),
  } as Awaited<ReturnType<FetchLike>>);
}
function transferLog(to: string, value: bigint): RawLog {
  return { address: ARC_USDC, topics: [TRANSFER_TOPIC, addressToBytes32(ZERO_ADDR), addressToBytes32(to)], data: hex32(value), logIndex: 0 };
}
function mintingProviderFor(txHash: string): () => DestinationProvider {
  const receipt: TransactionReceipt = {
    txHash, status: 'success', blockNumber: 44_444n, blockTimestamp: 1_700_000_000n,
    from: RELAYER, to: MT_TESTNET, logs: [transferLog(ARC_WALLET, AMOUNT)],
  };
  return () => ({ async getTransactionReceipt(h) { return h === txHash ? receipt : null; } });
}

let seq = 0;
const s = () => ++seq;

/** A cross-chain merchant whose ONLY wallet is the pinned Arc testnet address. */
function newMerchant(): { merchantId: string; walletId: string } {
  const n = s();
  const merchantId = `merch_cctp15_${n}`;
  const walletId = `sw_cctp15_${n}`;
  const db = getDb();
  db.prepare('INSERT INTO merchants(id,name) VALUES(?,?)').run(merchantId, `P15 merchant ${n}`);
  db.prepare('INSERT INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run(walletId, merchantId, ARC_WALLET, 'arc_testnet');
  return { merchantId, walletId };
}
function addEndpoint(merchantId: string, events: string[]): void {
  getDb().prepare(
    `INSERT INTO webhook_endpoints(id,merchant_id,url,secret_hash,secret_preview,description,events,environment,is_active)
     VALUES(?,?,?,?,?,?,?,?,1)`,
  ).run(`whe_cctp15_${s()}`, merchantId, 'https://merchant.example.com/hook', 'hash', 'abcd', 'p15', JSON.stringify(events), 'test');
}
function insertIntent(merchantId: string, walletId: string): string {
  const iid = `pi_cctp15_${s()}`;
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
      amount_decimal,amount_base_units,environment,status,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(iid, merchantId, walletId, ARC_WALLET, 'base_sepolia', SRC_CHAIN, SRC_USDC, '5.00', AMOUNT_STR,
    'test', 'processing', 9_999_999_999, 1, 'base_sepolia', 'arc_testnet', ARC_TESTNET_CHAIN);
  return iid;
}
/** Record a transfer already past burn-detection + source finality (PHASE 5/6). */
function seedFinalizedTransfer(intentId: string, nonceBase: number): { transferId: string; bytes: Uint8Array } {
  const bytes = buildMessage(BigInt(nonceBase + seq));
  const tid = `cct_cctp15_${seq}`;
  getDb().prepare(
    `INSERT INTO cross_chain_transfers(id,payment_intent_id,source_network,source_chain_id,source_usdc_address,token_messenger,
      source_tx_hash,source_finalized_at,cctp_message_id,cctp_message,destination_network,destination_chain_id,mint_recipient,
      amount_base_units,attestation_status,state,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(tid, intentId, 'base_sepolia', SRC_CHAIN, SRC_USDC, TM, srcHash(seq), NOW - 60,
    msgId(bytes), msgHex(bytes), 'arc_testnet', ARC_TESTNET_CHAIN, ARC_WALLET, AMOUNT_STR, 'none', 'source_finalized', NOW);
  return { transferId: tid, bytes };
}
function countWhere(sql: string, ...p: (string | number)[]): number {
  return (getDb().prepare(sql).get(...p) as { n: number }).n;
}

beforeAll(() => { migrate(); });
afterAll(() => {
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ── P15-1: the full happy-path lifecycle, seam by seam ───────────────────────
test('P15-1: finalized burn → attestation → destination settlement → credit + webhook + receipt + status', async () => {
  const { merchantId, walletId } = newMerchant();
  const iid = insertIntent(merchantId, walletId);
  const { transferId, bytes } = seedFinalizedTransfer(iid, 400000);
  addEndpoint(merchantId, ['payment.cross_chain.attestation_received', 'payment.succeeded']);
  const dtx = destHash(seq);

  // PHASE 7 — Circle attests the finalized burn (fabricated fetch, real parser).
  const att = await requestAttestation({ transferId, fetchImpl: completeFetch(bytes), nowSeconds: NOW });
  expect(att.ok).toBe(true);
  if (att.ok) expect(att.outcome).toBe('attested');
  const afterAtt = getDb().prepare('SELECT state,attestation_status FROM cross_chain_transfers WHERE id=?').get(transferId) as { state: string; attestation_status: string };
  expect(afterAtt.state).toBe('attested');
  expect(afterAtt.attestation_status).toBe('complete');
  expect(countWhere("SELECT count(*) n FROM webhook_deliveries WHERE payment_intent_id=? AND event_type='payment.cross_chain.attestation_received'", iid)).toBe(1);
  expect(loadCrossChainStatus(iid)!.status).toBe('awaiting_settlement');

  // PHASE 8 — verify the real Arc mint and atomically credit the merchant.
  const settle = await settleDestination({ transferId, destinationTxHash: dtx, providerFactory: mintingProviderFor(dtx), nowSeconds: NOW });
  expect(settle.ok).toBe(true);
  if (settle.ok) expect(settle.outcome).toBe('settled');

  // The journey is terminal + the intent is a canonical succeeded payment.
  expect(loadCrossChainStatus(iid)!.status).toBe('completed');
  expect(getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(iid)).toEqual({ status: 'succeeded' });
  expect(countWhere('SELECT count(*) n FROM payments WHERE payment_intent_id=?', iid)).toBe(1);

  // PHASE 12 — exactly ONE canonical success webhook, enriched with the tx.
  const succeeded = getDb().prepare("SELECT payload FROM webhook_deliveries WHERE payment_intent_id=? AND event_type='payment.succeeded'").all(iid) as Array<{ payload: string }>;
  expect(succeeded.length).toBe(1);
  const cc = ((JSON.parse(succeeded[0].payload).data) as Record<string, unknown>).cross_chain as Record<string, unknown>;
  expect(cc.destination_tx_hash).toBe(dtx);
  expect(cc.mint_recipient).toBe(ARC_WALLET);

  // Receipt was issued off the credited payment (PHASE F seam).
  expect(countWhere('SELECT count(*) n FROM receipts WHERE payment_intent_id=?', iid)).toBe(1);

  // PHASE 14 — the settled view reports the Standard 1:1 fee model honestly.
  const fees = loadCrossChainStatus(iid)!.fees;
  expect(fees.net_amount_base_units).toBe(AMOUNT_STR);
  expect(fees.is_one_to_one).toBe(true);
});

// ── P15-2: idempotent re-settlement never double-credits ─────────────────────
test('P15-2: settling an already-settled transfer is idempotent (no second payment, no re-credit)', async () => {
  const { merchantId, walletId } = newMerchant();
  const iid = insertIntent(merchantId, walletId);
  const { transferId, bytes } = seedFinalizedTransfer(iid, 410000);
  const dtx = destHash(seq);
  await requestAttestation({ transferId, fetchImpl: completeFetch(bytes), nowSeconds: NOW });
  const first = await settleDestination({ transferId, destinationTxHash: dtx, providerFactory: mintingProviderFor(dtx), nowSeconds: NOW });
  expect(first.ok).toBe(true);

  const again = await settleDestination({ transferId, destinationTxHash: dtx, providerFactory: mintingProviderFor(dtx), nowSeconds: NOW });
  expect(again.ok).toBe(true);
  if (again.ok) expect(again.outcome).toBe('already_settled');
  // Still exactly one credited payment and one success webhook.
  expect(countWhere('SELECT count(*) n FROM payments WHERE payment_intent_id=?', iid)).toBe(1);
  expect(countWhere("SELECT count(*) n FROM webhook_deliveries WHERE payment_intent_id=? AND event_type='payment.succeeded'", iid)).toBe(0);
});

// ── P15-3: an un-attested burn can NEVER be credited (early-settlement guard) ─
test('P15-3: settling a source_finalized (not-yet-attested) transfer is refused with no credit', async () => {
  const { merchantId, walletId } = newMerchant();
  const iid = insertIntent(merchantId, walletId);
  const { transferId } = seedFinalizedTransfer(iid, 420000); // state stays source_finalized
  const res = await settleDestination({ transferId, destinationTxHash: destHash(seq), providerFactory: mintingProviderFor(destHash(seq)), nowSeconds: NOW });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.code).toBe('not_attested');
  expect(countWhere('SELECT count(*) n FROM payments WHERE payment_intent_id=?', iid)).toBe(0);
  expect(getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(iid)).toEqual({ status: 'processing' });
});
