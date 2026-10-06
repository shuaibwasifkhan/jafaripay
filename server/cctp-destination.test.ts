/**
 * CCTP MASTER PHASE 8 — Arc destination settlement.
 *
 * Proves the ONLY crediting stage of the CCTP pipeline. Nothing is credited
 * until a REAL USDC mint is observed ON Arc, called by the registry-pinned
 * MessageTransmitterV2, landing on the merchant's ONE pinned Arc wallet for the
 * EXACT attested amount. An attestation (PHASE 7) alone is NEVER enough.
 *
 * Covers:
 *   • the destination claim calldata carries NO recipient (baked into the
 *     attested message) and targets the registry transmitter + Arc chain id;
 *   • verifyDestinationMint refuses: bad tx hash, provider error, missing/
 *     reverted receipt, a tx that did not call the transmitter, a receipt with
 *     no USDC Transfer, a mint to the wrong wallet, and a wrong amount;
 *   • settleDestination credits EXACTLY like the same-chain verifier (one
 *     payments row + intent 'succeeded' + transfer 'settled' + payment_events +
 *     webhook/receipt side effects), refuses an un-attested transfer with NO
 *     credit, is idempotent (a re-settle adds no second payment), cross-checks
 *     the recorded burn amount/recipient against the intent, and blocks a
 *     storage-layer destination-tx replay.
 *
 * Unique fixture namespace (*_cctpd*) + DISJOINT source/destination tx-hash and
 * message-nonce ranges — `bun test` shares ONE sqlite DB across every
 * cctp-*.test.ts, so any collision would corrupt another suite.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { keccak256, toBytes, type Hex } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctpdest_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp-dest-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const mod = await import('./blockchain/cctp-destination.ts');
const {
  buildReceiveMessageCalldata, destinationClaim, verifyDestinationMint, settleDestination,
  RECEIVE_MESSAGE_SELECTOR, DESTINATION_DOMAIN,
} = mod;
import type { DestinationProvider } from './blockchain/cctp-destination.ts';
import { addressToBytes32 } from './db/cctp.ts';
import { messageTransmitterFor } from './blockchain/cctp-source.ts';
import type { RawLog, TransactionReceipt } from './blockchain/arc-provider.ts';

// ── Fixed vectors (base_sepolia → arc_testnet, the testnet pilot route) ──────
const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const EVIL_WALLET = '0x1111111111111111111111111111111111111111';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const RELAYER = '0x2222222222222222222222222222222222222222';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TM = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';   // testnet TokenMessenger
const MT_TESTNET = messageTransmitterFor(true);            // registry-pinned Arc transmitter (lowercased)
const AMOUNT = 5_000_000n;
const CHAIN = 84532;          // base_sepolia source chain id (fixture)
const ARC_TESTNET_CHAIN = 5042002;
const NOW = 1_800_000_000;

const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'), 'hex');
const hex32 = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');

// A CCTP message payload — its CONTENT is irrelevant to PHASE 8 (the money gate
// is the on-Arc mint Transfer), only that it is present + non-empty. The nonce
// base 700000 keeps the derived cctp_message_id DISJOINT from the PHASE 7 suite.
function fakeMessage(seq: number): Hex {
  const body = hex32(BigInt(700000 + seq)).slice(2) + addressToBytes32(ARC_WALLET).slice(2);
  return (`0x${body}`) as Hex;
}
const msgId = (hex: Hex) => keccak256(hex, 'hex');

// ── USDC Transfer log the same-chain USDCAdapter decodes ───────────────────
function transferLog(from: string, to: string, value: bigint, logIndex = 0): RawLog {
  return {
    address: ARC_USDC,
    topics: [TRANSFER_TOPIC, addressToBytes32(from), addressToBytes32(to)],
    data: hex32(value),
    logIndex,
  };
}

function mintReceipt(over: {
  txHash?: string; status?: 'success' | 'reverted'; callTo?: string;
  logs?: RawLog[]; blockNumber?: bigint;
} = {}): TransactionReceipt {
  return {
    txHash: over.txHash ?? destHash(9999),
    status: over.status ?? 'success',
    blockNumber: over.blockNumber ?? 12_345n,
    blockTimestamp: 1_700_000_000n,
    from: RELAYER,
    to: over.callTo ?? MT_TESTNET,                 // the transmitter call
    logs: over.logs ?? [transferLog(ZERO_ADDR, ARC_WALLET, AMOUNT)], // mint → pinned wallet
  };
}

// DISJOINT hash patterns: source '0xd5..', destination '0xd6..' — the burn/
// attestation suites use small numbered hashes and '0xa7..'; nothing collides
// under uq_cct_source_tx / uq_cct_dest_tx / blockchain_transactions.
const srcHash = (n: number) => '0x' + 'd5'.repeat(31) + (n % 256).toString(16).padStart(2, '0');
const destHash = (n: number) => '0x' + 'd6'.repeat(31) + (n % 256).toString(16).padStart(2, '0');

const providerFor = (receipt: TransactionReceipt | null): DestinationProvider => ({
  async getTransactionReceipt() { return receipt; },
});
const throwingProvider: DestinationProvider = ({
  async getTransactionReceipt() { throw new Error('RPC down'); },
});

// ── Seed an attested, in-flight transfer (post-PHASE-7) for an intent ────────
let seq = 0;
function seedAttestedTransfer(over: Partial<{
  state: string; attestation_status: string; amount: string; intentAmount: string;
  mintRecipient: string; intentRecipient: string; sourceNetwork: string;
  destinationNetwork: string; attestation: Hex | null; message: Hex | null;
}> = {}): { transferId: string; intentId: string } {
  seq += 1;
  const id = `pi_cctpd_${seq}`;
  const tid = `cct_cctpd_${seq}`;
  const srcNet = over.sourceNetwork ?? 'base_sepolia';
  const destNet = over.destinationNetwork ?? 'arc_testnet';
  const intentRecipient = over.intentRecipient ?? ARC_WALLET;
  const intentAmount = over.intentAmount ?? '5000000';
  const message = over.message === undefined ? fakeMessage(seq) : over.message;

  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
      amount_decimal,amount_base_units,environment,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, 'merch_cctpd', 'sw_cctpd', intentRecipient, srcNet, CHAIN, SRC_USDC,
    '5.00', intentAmount, 'test', 9999999999, 1, srcNet, destNet, ARC_TESTNET_CHAIN);

  getDb().prepare(
    `INSERT INTO cross_chain_transfers(id,payment_intent_id,source_network,source_chain_id,source_usdc_address,token_messenger,
      source_tx_hash,cctp_message_id,cctp_message,destination_network,destination_chain_id,mint_recipient,
      amount_base_units,attestation,attestation_status,state)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(tid, id, srcNet, CHAIN, SRC_USDC, TM, srcHash(seq),
    message === null ? null : msgId(message), message, destNet, ARC_TESTNET_CHAIN,
    over.mintRecipient ?? ARC_WALLET, over.amount ?? '5000000',
    over.attestation === undefined ? '0xc0ffee' : over.attestation,
    over.attestation_status ?? 'complete', over.state ?? 'attested');
  return { transferId: tid, intentId: id };
}

function transferRow(tid: string): Record<string, unknown> {
  return getDb().prepare('SELECT * FROM cross_chain_transfers WHERE id=?').get(tid) as Record<string, unknown>;
}
function intentRow(pid: string): Record<string, unknown> {
  return getDb().prepare('SELECT * FROM payment_intents WHERE id=?').get(pid) as Record<string, unknown>;
}
function paymentCount(pid: string): number {
  return (getDb().prepare('SELECT COUNT(*) c FROM payments WHERE payment_intent_id=?').get(pid) as { c: number }).c;
}
function eventTypes(pid: string): string[] {
  return (getDb().prepare('SELECT event_type FROM payment_events WHERE payment_intent_id=? ORDER BY id').all(pid) as Array<{ event_type: string }>).map((e) => e.event_type);
}
// The TransferRow type is internal; cast the seeded row into the shape verifyDestinationMint expects.
function asTransfer(tid: string) {
  return transferRow(tid) as unknown as Parameters<typeof verifyDestinationMint>[0]['transfer'];
}

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctpd', 'P8 destination merchant');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_cctpd', 'merch_cctpd', ARC_WALLET, 'arc_testnet');
});

afterAll(() => {
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ── Destination claim calldata ──────────────────────────────────────────────

test('P8-1: claim calldata is deterministic and carries NO recipient/amount field', () => {
  const message = fakeMessage(1);
  const attestation = '0xc0ffee' as Hex;
  const a = buildReceiveMessageCalldata(message, attestation);
  const b = buildReceiveMessageCalldata(message, attestation);
  expect(a).toBe(b);
  expect(a.startsWith(RECEIVE_MESSAGE_SELECTOR)).toBe(true);
  // receiveMessage takes ONLY (bytes message, bytes attestation) — there is no
  // recipient/amount argument a relayer could edit. The recipient is confined to
  // the opaque `message` (pinned in PHASE 7), embedded verbatim in the calldata.
  expect(a.toLowerCase()).toContain(message.slice(2).toLowerCase());
  expect(RECEIVE_MESSAGE_SELECTOR.length).toBe(10); // 4-byte selector only
});

test('P8-2: destinationClaim targets the registry Arc transmitter + Arc chain id', () => {
  const claim = destinationClaim({ destinationNetwork: 'arc_testnet', message: fakeMessage(2), attestation: '0xc0ffee' as Hex });
  expect(claim.to).toBe(MT_TESTNET);
  expect(claim.chainId).toBe(ARC_TESTNET_CHAIN);
  expect(DESTINATION_DOMAIN).toBe(26);
  // A non-destination slug is refused — never a fabricated claim target.
  expect(() => destinationClaim({ destinationNetwork: 'base_sepolia', message: fakeMessage(3), attestation: '0x00' as Hex })).toThrow();
});

// ── verifyDestinationMint — the pure money-safety gate (no credit) ──────────

test('P8-3: verifyDestinationMint accepts a genuine transmitter mint of the exact amount', async () => {
  const { transferId } = seedAttestedTransfer();
  const res = await verifyDestinationMint({ transfer: asTransfer(transferId), destinationTxHash: destHash(1), provider: providerFor(mintReceipt({ txHash: destHash(1) })) });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error('unexpected');
  expect(res.recipient).toBe(ARC_WALLET.toLowerCase());
  expect(res.amountBaseUnits).toBe('5000000');
});

test('P8-4: verifyDestinationMint refuses a malformed destination tx hash', async () => {
  const { transferId } = seedAttestedTransfer();
  const res = await verifyDestinationMint({ transfer: asTransfer(transferId), destinationTxHash: 'notahash', provider: providerFor(mintReceipt()) });
  expect(!res.ok && res.code).toBe('invalid_tx_hash');
});

test('P8-5: a provider/transport error is a retryable provider_error (never a credit)', async () => {
  const { transferId } = seedAttestedTransfer();
  const res = await verifyDestinationMint({ transfer: asTransfer(transferId), destinationTxHash: destHash(2), provider: throwingProvider });
  expect(!res.ok && res.code).toBe('provider_error');
  expect(!res.ok && res.retryable).toBe(true);
});

test('P8-6: missing / reverted receipts are refused', async () => {
  const a = seedAttestedTransfer();
  const r1 = await verifyDestinationMint({ transfer: asTransfer(a.transferId), destinationTxHash: destHash(3), provider: providerFor(null) });
  expect(!r1.ok && r1.code).toBe('receipt_missing');

  const b = seedAttestedTransfer();
  const r2 = await verifyDestinationMint({ transfer: asTransfer(b.transferId), destinationTxHash: destHash(4), provider: providerFor(mintReceipt({ txHash: destHash(4), status: 'reverted' })) });
  expect(!r2.ok && r2.code).toBe('receipt_reverted');
});

test('P8-7: a receipt that did not call the Arc transmitter is refused', async () => {
  const { transferId } = seedAttestedTransfer();
  const res = await verifyDestinationMint({ transfer: asTransfer(transferId), destinationTxHash: destHash(5), provider: providerFor(mintReceipt({ txHash: destHash(5), callTo: EVIL_WALLET })) });
  expect(!res.ok && res.code).toBe('not_message_transmitter_call');
});

test('P8-8: a receipt with no USDC Transfer log is refused', async () => {
  const { transferId } = seedAttestedTransfer();
  const res = await verifyDestinationMint({ transfer: asTransfer(transferId), destinationTxHash: destHash(6), provider: providerFor(mintReceipt({ txHash: destHash(6), logs: [] })) });
  expect(!res.ok && res.code).toBe('mint_transfer_missing');
});

test('P8-9: a mint to the wrong wallet / wrong amount is refused (never credited)', async () => {
  // right amount, wrong recipient
  const a = seedAttestedTransfer();
  const r1 = await verifyDestinationMint({ transfer: asTransfer(a.transferId), destinationTxHash: destHash(7), provider: providerFor(mintReceipt({ txHash: destHash(7), logs: [transferLog(ZERO_ADDR, EVIL_WALLET, AMOUNT)] })) });
  expect(!r1.ok && r1.code).toBe('wrong_mint_recipient');

  // right recipient, wrong amount
  const b = seedAttestedTransfer();
  const r2 = await verifyDestinationMint({ transfer: asTransfer(b.transferId), destinationTxHash: destHash(8), provider: providerFor(mintReceipt({ txHash: destHash(8), logs: [transferLog(ZERO_ADDR, ARC_WALLET, 4_000_000n)] })) });
  expect(!r2.ok && r2.code).toBe('amount_mismatch');
});

// ── settleDestination — the credit path ─────────────────────────────────────

test('P8-10: a verified mint credits exactly like the same-chain verifier', async () => {
  const { transferId, intentId } = seedAttestedTransfer();
  const tx = destHash(10);
  const res = await settleDestination({ transferId, destinationTxHash: tx, providerFactory: () => providerFor(mintReceipt({ txHash: tx })), nowSeconds: NOW });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error('unexpected');
  expect(res.outcome).toBe('settled');

  expect(intentRow(intentId).status).toBe('succeeded');
  expect(paymentCount(intentId)).toBe(1);
  const t = transferRow(transferId);
  expect(t.state).toBe('settled');
  expect(t.claim_status).toBe('confirmed');
  expect(t.destination_tx_hash).toBe(tx);

  const pay = getDb().prepare('SELECT * FROM payments WHERE payment_intent_id=?').get(intentId) as Record<string, unknown>;
  expect(String(pay.recipient_address)).toBe(ARC_WALLET.toLowerCase());
  expect(pay.amount_base_units).toBe('5000000');
  expect(pay.network).toBe('arc_testnet');

  expect(eventTypes(intentId)).toContain('payment.succeeded');
  expect(eventTypes(intentId)).toContain('payment.cross_chain.settled');
});

test('P8-11: an un-attested transfer is refused with NO credit', async () => {
  const { transferId, intentId } = seedAttestedTransfer({ attestation_status: 'pending', state: 'attestation_pending' });
  const res = await settleDestination({ transferId, destinationTxHash: destHash(11), providerFactory: () => providerFor(mintReceipt()) });
  expect(!res.ok && res.code).toBe('not_attested');
  expect(paymentCount(intentId)).toBe(0);
  expect(intentRow(intentId).status).not.toBe('succeeded');
});

test('P8-12: settle is idempotent — a re-settle never adds a second payment', async () => {
  const { transferId, intentId } = seedAttestedTransfer();
  const tx = destHash(12);
  const first = await settleDestination({ transferId, destinationTxHash: tx, providerFactory: () => providerFor(mintReceipt({ txHash: tx })) });
  expect(first.ok && first.outcome).toBe('settled');
  const second = await settleDestination({ transferId, destinationTxHash: tx, providerFactory: () => providerFor(mintReceipt({ txHash: tx })) });
  expect(second.ok && second.outcome).toBe('already_settled');
  expect(paymentCount(intentId)).toBe(1);
});

test('P8-13: recorded burn amount / recipient are cross-checked against the intent', async () => {
  // transfer amount != intent amount
  const a = seedAttestedTransfer({ amount: '4000000', intentAmount: '5000000' });
  const r1 = await settleDestination({ transferId: a.transferId, destinationTxHash: destHash(13), providerFactory: () => providerFor(mintReceipt()) });
  expect(!r1.ok && r1.code).toBe('amount_mismatch');
  expect(paymentCount(a.intentId)).toBe(0);

  // transfer recipient != intent settlement address
  const b = seedAttestedTransfer({ mintRecipient: EVIL_WALLET, intentRecipient: ARC_WALLET });
  const r2 = await settleDestination({ transferId: b.transferId, destinationTxHash: destHash(14), providerFactory: () => providerFor(mintReceipt()) });
  expect(!r2.ok && r2.code).toBe('wrong_mint_recipient');
  expect(paymentCount(b.intentId)).toBe(0);
});

test('P8-14: a storage-layer destination-tx replay is blocked before credit', async () => {
  const { transferId, intentId } = seedAttestedTransfer();
  const tx = destHash(15);
  // Pre-book the same destination tx on the same network (simulates a prior settle / double claim).
  getDb().prepare(
    'INSERT INTO blockchain_transactions(id,tx_hash,network,chain_id,block_number,block_timestamp,from_address,to_address,usdc_address,amount,log_index,raw_receipt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run('btx_replay_cctpd', tx, 'arc_testnet', ARC_TESTNET_CHAIN, 1, 1, ZERO_ADDR, ARC_WALLET, ARC_USDC, '5000000', 0, '{}');

  const res = await settleDestination({ transferId, destinationTxHash: tx, providerFactory: () => providerFor(mintReceipt({ txHash: tx })) });
  expect(!res.ok && res.code).toBe('destination_replay_detected');
  expect(paymentCount(intentId)).toBe(0);
});

test('P8-15: a missing message payload after attestation is refused', async () => {
  const { transferId, intentId } = seedAttestedTransfer({ message: null });
  const res = await settleDestination({ transferId, destinationTxHash: destHash(16), providerFactory: () => providerFor(mintReceipt()) });
  expect(!res.ok && res.code).toBe('message_missing');
  expect(paymentCount(intentId)).toBe(0);
});

test('P8-16: an unknown transfer id is refused without touching a provider', async () => {
  let called = 0;
  const spy: DestinationProvider = { async getTransactionReceipt() { called += 1; return mintReceipt(); } };
  const res = await settleDestination({ transferId: 'cct_cctpd_does_not_exist', destinationTxHash: destHash(17), providerFactory: () => spy });
  expect(!res.ok && res.code).toBe('transfer_not_found');
  expect(called).toBe(0);
});

// ── STEP 5G/5H — Circle Forwarding settlement (merchant nets EXACTLY M) ──────
// For a Forwarding transfer the Circle forwarder submitted the Arc mint itself; its
// tx hash was captured into destination_tx_hash during attestation (STEP 5F).
// JafariPay NEVER builds or broadcasts receiveMessage here - the DestinationProvider
// exposes ONLY getTransactionReceipt, so settle reads the already-onchain mint. The
// money gate is unchanged: the mint must equal the merchant target M, NOT the gross
// M + F burned on the source. Anything else fails closed with NO credit.
const FEE = 20_380n; // server-approved Forwarding fee; the source burned M + F.

test('S5-DEST-1: Forwarding settle reads the Circle mint tx (receiveMessage NOT called) and credits EXACTLY M', async () => {
  const { transferId, intentId } = seedAttestedTransfer();
  // The merchant target is M even though the source burned M + F.
  getDb().prepare('UPDATE payment_intents SET forwarding_max_fee_base_units=? WHERE id=?').run(String(FEE), intentId);
  const forwardTx = destHash(201);
  getDb().prepare('UPDATE cross_chain_transfers SET destination_tx_hash=? WHERE id=?').run(forwardTx, transferId);

  const calls: string[] = [];
  const provider: DestinationProvider = {
    async getTransactionReceipt() { calls.push('getTransactionReceipt'); return mintReceipt({ txHash: forwardTx }); },
  };
  const res = await settleDestination({ transferId, destinationTxHash: forwardTx, providerFactory: () => provider, nowSeconds: NOW });
  expect(res.ok && res.outcome).toBe('settled');
  // Only a receipt READ happened - there is no send/broadcast method to call.
  expect(calls).toEqual(['getTransactionReceipt']);
  const pay = getDb().prepare('SELECT * FROM payments WHERE payment_intent_id=?').get(intentId) as Record<string, unknown>;
  expect(pay.amount_base_units).toBe('5000000'); // credited M, never M + F
});

test('S5-DEST-2: Forwarding - a destination mint of the GROSS M+F (not M) is refused, never over-credits', async () => {
  const { transferId, intentId } = seedAttestedTransfer();
  getDb().prepare('UPDATE payment_intents SET forwarding_max_fee_base_units=? WHERE id=?').run(String(FEE), intentId);
  const forwardTx = destHash(202);
  // Circle would only ever mint M, but a tampered/wrong gross mint must be refused.
  const provider = providerFor(mintReceipt({ txHash: forwardTx, logs: [transferLog(ZERO_ADDR, ARC_WALLET, AMOUNT + FEE)] }));
  const res = await settleDestination({ transferId, destinationTxHash: forwardTx, providerFactory: () => provider });
  expect(!res.ok && res.code).toBe('amount_mismatch');
  expect(paymentCount(intentId)).toBe(0);
});
