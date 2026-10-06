/**
 * CCTP MASTER PHASE 5 — source burn detection.
 *
 * Proves that a customer's Circle CCTP burn on a SOURCE chain is verified and
 * recorded WITHOUT any credit and WITHOUT any network access:
 *   • the CCTP message wire layout is parsed exactly as Circle publishes it
 *     (header + BurnMessageV2), and the parser FAILS CLOSED on a short message
 *     or an unknown version rather than guessing;
 *   • a burn is accepted only when it is bound to THIS intent — emitted by the
 *     registry-pinned TokenMessenger/MessageTransmitter, destination domain =
 *     Arc 26, mintRecipient = bytes32(merchant's pinned Arc wallet), burn token
 *     = the registry USDC, depositor = tx sender, EXACT amount — and only when
 *     the MessageSent payload agrees with the event args field by field;
 *   • the registry finality_mode of the SOURCE gates 'source_finalizing' vs
 *     'source_finalized' (PHASE 6 semantics, same fail-closed rules as the
 *     same-chain verifier);
 *   • nothing is ever credited: payment_intents moves to 'processing' only and
 *     the journey lives in cross_chain_transfers;
 *   • replay/idempotency: one tx cannot serve two intents, one intent cannot
 *     acquire a second burn, and re-detecting the same burn is a no-op.
 *
 * Fixture ids are uniquely namespaced (*_cctpb*) because `bun test` shares ONE
 * sqlite DB across files — collision here would corrupt other suites.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { encodeAbiParameters, keccak256, toBytes, toHex } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctpburn_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp-burn-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const {
  DEPOSIT_FOR_BURN_ABI,
  MESSAGE_SENT_ABI,
  decodeDepositForBurn,
  detectSourceBurn,
  evaluateSourceFinality,
  messageTransmitterFor,
  nonceMatches,
  parseCctpMessage,
} = await import('./blockchain/cctp-source.ts');
import type { SourceBurnProvider, SourceBurnSuccess, SourceBurnFailure } from './blockchain/cctp-source.ts';
import {
  ARC_CCTP_DOMAIN,
  CCTP_CONTRACTS_MAINNET,
  CCTP_CONTRACTS_TESTNET,
  addressToBytes32,
} from './db/cctp.ts';

// ── Fixed test vectors ─────────────────────────────────────────────────────
const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const EVIL_WALLET = '0x1111111111111111111111111111111111111111';
const DEPOSITOR = '0x9999999999999999999999999999999999999999';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // registry base_sepolia USDC
const TM = CCTP_CONTRACTS_TESTNET.tokenMessengerV2;
const MT = CCTP_CONTRACTS_TESTNET.messageTransmitterV2;
const AMOUNT = 5_000_000n; // 5.00 USDC
const NONCE = 1234n;
const BASE_SEPOLIA_DOMAIN = 6;

const u32 = (n: number) => n.toString(16).padStart(8, '0');
const b32hex = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const addrB32 = (a: string) => addressToBytes32(a).slice(2);

/**
 * Build a CCTP message byte-for-byte per Circle's published offsets, so the
 * test exercises the SAME layout the parser claims to implement (and would
 * catch a layout drift).
 */
function buildCctpMessage(o: {
  version?: number;
  sourceDomain?: number;
  destinationDomain?: number;
  nonce?: bigint;
  sender?: string;
  recipient?: string;
  destinationCaller?: string;
  minFinalityThreshold?: number;
  finalityThresholdExecuted?: number;
  burnToken?: string;
  mintRecipient?: string;
  amount?: bigint;
  messageSender?: string;
  maxFee?: bigint;
  feeExecuted?: bigint;
  expirationBlock?: bigint;
  truncateTo?: number;
}): Uint8Array {
  const header =
    u32(o.version ?? 1) + u32(o.sourceDomain ?? BASE_SEPOLIA_DOMAIN) + u32(o.destinationDomain ?? ARC_CCTP_DOMAIN) +
    b32hex(o.nonce ?? NONCE) +
    addrB32(o.sender ?? TM) +            // MessageTransmitterV2 caller on source = TokenMessenger
    addrB32(o.recipient ?? MT) +         // handler on destination
    (o.destinationCaller ?? b32hex(0)).replace(/^0x/, '').padStart(64, '0') +
    u32(o.minFinalityThreshold ?? 0) +
    u32(o.finalityThresholdExecuted ?? 2000);
  const body =
    u32(1) +
    addrB32(o.burnToken ?? SRC_USDC) +
    addrB32(o.mintRecipient ?? ARC_WALLET) +
    b32hex(o.amount ?? AMOUNT) +
    addrB32(o.messageSender ?? DEPOSITOR) +
    b32hex(o.maxFee ?? 0n) +
    b32hex(o.feeExecuted ?? 0n) +
    b32hex(o.expirationBlock ?? 1_000_000n);
  const full = header + body;
  return toBytes(o.truncateTo !== undefined ? `0x${full.slice(0, o.truncateTo * 2)}` : `0x${full}`);
}

// topic0 = keccak of the canonical event signature, DERIVED from the very ABIs
// the module under test exports (signature = Name(type1,type2,...) over the
// non-indexed-order input list). A signature change therefore cannot silently
// desynchronise this fixture from the implementation.
function topic0Of(abi: { name?: string; inputs?: readonly { type: string }[] }): string {
  const sig = `${abi.name}(${(abi.inputs ?? []).map((i) => i.type).join(',')})`;
  return keccak256(toBytes(sig));
}
const TOPIC_DEPOSIT_FOR_BURN = topic0Of(DEPOSIT_FOR_BURN_ABI);
const TOPIC_MESSAGE_SENT = topic0Of(MESSAGE_SENT_ABI);

/** A single decoded-shaped log, as the module's provider seam consumes it. */
type ReceiptLog = { address: string; topics: string[]; data: string; logIndex: number };

/** Unique, well-formed 32-byte tx hash per scenario, so a burn never collides. */
function txHashFor(n: number): string {
  return '0x' + n.toString(16).padStart(64, '0');
}

function burnLog(o: {
  nonce?: bigint;
  burnToken?: string;
  amount?: bigint;
  depositor?: string;
  mintRecipient?: string;
  destinationDomain?: number;
  destinationTokenMessenger?: string;
  destinationCaller?: string;
  maxFee?: bigint;
  minFinalityThreshold?: number;
  hookData?: string;
  address?: string;
}): ReceiptLog {
  // Deployed V2 DepositForBurn layout, confirmed empirically (see cctp-source.ts).
  // Indexed topics, in order: burnToken, depositor, minFinalityThreshold.
  // Non-indexed data, in declaration order: amount, mintRecipient,
  // destinationDomain, destinationTokenMessenger, destinationCaller, maxFee,
  // hookData. There is NO `nonce` in the event — it lives in the CCTP message
  // (buildCctpMessage). The `nonce` option is kept only so existing scenario
  // helpers still compile; it is intentionally unused here.
  const data = encodeAbiParameters(
    [
      { name: 'amount', type: 'uint256' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'destinationTokenMessenger', type: 'bytes32' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'hookData', type: 'bytes' },
    ],
    [
      o.amount ?? AMOUNT,
      `0x${addrB32(o.mintRecipient ?? ARC_WALLET)}`,
      o.destinationDomain ?? ARC_CCTP_DOMAIN,
      `0x${addrB32(o.destinationTokenMessenger ?? CCTP_CONTRACTS_TESTNET.tokenMessengerV2)}`,
      `0x${(o.destinationCaller ?? b32hex(0)).replace(/^0x/, '').padStart(64, '0')}`,
      o.maxFee ?? 0n,
      (o.hookData ?? '0x') as `0x${string}`,
    ],
  );
  return {
    address: (o.address ?? TM).toLowerCase(),
    topics: [
      TOPIC_DEPOSIT_FOR_BURN,
      `0x${addrB32(o.burnToken ?? SRC_USDC)}`,
      `0x${addrB32(o.depositor ?? DEPOSITOR)}`,
      `0x${b32hex(o.minFinalityThreshold ?? 0)}`,
    ],
    data,
    logIndex: 0,
  };
}

function messageLog(message: Uint8Array, address = MT): ReceiptLog {
  return {
    address: address.toLowerCase(),
    topics: [TOPIC_MESSAGE_SENT],
    data: encodeAbiParameters([{ name: 'message', type: 'bytes' }], [toHex(message)]),
    logIndex: 1,
  };
}

interface ReceiptOpts {
  to?: string;
  from?: string;
  status?: 'success' | 'reverted';
  blockNumber?: bigint;
  nonce?: bigint;
  burn?: Parameters<typeof burnLog>[0] | null;
  message?: Uint8Array | null;
  extraLogs?: boolean;
}

function receipt(o: ReceiptOpts = {}) {
  // A single nonce drives BOTH the default DepositForBurn event and the default
  // MessageSent payload, so event and message always agree. Distinct burns get
  // distinct nonces — the DB enforces UNIQUE(cctp_message_id), so two intents
  // can never be paid with the same burn.
  const nonce = o.nonce ?? NONCE;
  const logs: ReceiptLog[] = [];
  if (o.burn !== null) logs.push(burnLog({ nonce, ...o.burn }));
  if (o.message !== null) logs.push(messageLog(o.message ?? buildCctpMessage({ nonce })));
  if (o.extraLogs) logs.push(messageLog(buildCctpMessage({ nonce: 9999n })));
  return {
    txHash: TX_HASH,
    status: o.status ?? 'success',
    blockNumber: o.blockNumber ?? 1_000n,
    blockTimestamp: 1_700_000_000n,
    from: (o.from ?? DEPOSITOR).toLowerCase(),
    to: (o.to ?? TM).toLowerCase(),
    logs,
  };
}

const TX_HASH = '0x' + 'ab'.repeat(32);

/**
 * Structurally satisfies SourceBurnProvider with no network access. The
 * default mirrors the seeded base_sepolia registry row (finality_mode='count',
 * required_confirmations=3) so the finality gate is exercised for real.
 */
function fakeProvider(
  r: ReturnType<typeof receipt> | null,
  opts: {
    network?: string;
    finalityMode?: 'immediate' | 'count' | 'safe' | 'finalized';
    requiredConfirmations?: number;
    latestHead?: bigint;
    tagHead?: bigint | (() => Promise<bigint>);
  } = {},
): SourceBurnProvider {
  const mode = opts.finalityMode ?? 'count';
  const tagHead = opts.tagHead ?? 1_000n;
  return {
    getTransactionReceipt: async () => (r as never) ?? null,
    getLatestBlockNumber: async () => opts.latestHead ?? 1_002n,
    getHeadBlockNumber: async () => (typeof tagHead === 'bigint' ? tagHead : tagHead()),
    getConfig: () => ({
      network: opts.network ?? 'base_sepolia',
      chainId: 84532,
      rpcUrl: 'http://127.0.0.1:1/rpc',
      explorerBase: '',
      usdcAddress: SRC_USDC,
      usdcDecimals: 6,
      requiredConfirmations: opts.requiredConfirmations ?? 3,
      finalityMode: mode,
    }),
    ensureChainIdMatches: async () => { /* the real ArcProvider proves eth_chainId here */ },
  } as unknown as SourceBurnProvider;
}

// ── Fixtures ───────────────────────────────────────────────────────────────
function insertIntent(id: string, crossChain: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
        amount_decimal,amount_base_units,environment,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id, 'merch_cctpb', 'sw_cctpb', ARC_WALLET,
      crossChain ? 'base_sepolia' : 'arc_testnet',
      crossChain ? 84532 : 5042002,
      crossChain ? SRC_USDC : '0x3600000000000000000000000000000000000000',
      '5.00', '5000000', 'test', 9999999999,
      crossChain ? 1 : 0,
      crossChain ? 'base_sepolia' : null,
      crossChain ? 'arc_testnet' : null,
      crossChain ? 5042002 : null,
    );
}

function transferFor(intentId: string): Record<string, unknown> | undefined {
  // bun:sqlite returns null (not undefined) for a missing row.
  const row = getDb().prepare('SELECT * FROM cross_chain_transfers WHERE payment_intent_id=?').get(intentId);
  return row == null ? undefined : (row as Record<string, unknown>);
}

function intentStatus(intentId: string): string {
  return (getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(intentId) as { status: string }).status;
}

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctpb', 'P5 burn merchant');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_cctpb', 'merch_cctpb', ARC_WALLET, 'arc_testnet');
  insertIntent('pi_cctpb_x', true);
  insertIntent('pi_cctpb_x2', true);
  insertIntent('pi_cctpb_same', false);
});

afterAll(() => {
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ── Pure parser tests ──────────────────────────────────────────────────────

test('P5-1: parseCctpMessage reads Circle\'s published header + BurnMessageV2 layout', () => {
  const m = parseCctpMessage(buildCctpMessage({}));
  expect(m.version).toBe(1);
  expect(m.sourceDomain).toBe(BASE_SEPOLIA_DOMAIN);
  expect(m.destinationDomain).toBe(ARC_CCTP_DOMAIN);
  expect(BigInt(m.nonce)).toBe(NONCE);
  expect(m.sender.toLowerCase()).toBe(addressToBytes32(TM).toLowerCase());
  expect(m.recipient.toLowerCase()).toBe(addressToBytes32(MT).toLowerCase());
  expect(m.minFinalityThreshold).toBe(0);
  expect(m.finalityThresholdExecuted).toBe(2000);
  expect(m.burnToken.toLowerCase()).toBe(addressToBytes32(SRC_USDC).toLowerCase());
  expect(m.mintRecipient.toLowerCase()).toBe(addressToBytes32(ARC_WALLET).toLowerCase());
  expect(m.amount).toBe(AMOUNT);
  expect(m.messageSender.toLowerCase()).toBe(addressToBytes32(DEPOSITOR).toLowerCase());
  expect(m.maxFee).toBe(0n);
  expect(m.feeExecuted).toBe(0n);
  expect(m.expirationBlock).toBe(1_000_000n);
});

test('P5-2: the parser fails closed on a truncated message or unknown version', () => {
  expect(() => parseCctpMessage(buildCctpMessage({ truncateTo: 200 }))).toThrow(/too short/);
  expect(() => parseCctpMessage(buildCctpMessage({ version: 7 }))).toThrow(/version/);
});

test('P5-3: nonceMatches compares a uint64 nonce with the bytes32 message nonce', () => {
  expect(nonceMatches(NONCE, b32hex(NONCE) && `0x${b32hex(NONCE)}`)).toBe(true);
  expect(nonceMatches(NONCE + 1n, `0x${b32hex(NONCE)}`)).toBe(false);
  expect(nonceMatches(NONCE, 'not-hex')).toBe(false);
});

// ── STEP 3: corrected CCTP V2 DepositForBurn event ABI / parser ────────────
// Ground truth: Base Sepolia (84532) tx
// 0x08c743f1b12727c6bd83e985e59791d951eb752cd5f6f05465b104ac92f4f59d, emitted by
// TokenMessengerV2 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA with
// topic0 0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5.
const REAL_PHASE16_TOPIC0 = '0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5';
const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000';

test('S3-1: the corrected ABI topic0 equals the REAL Phase 16 on-chain topic0', () => {
  expect(TOPIC_DEPOSIT_FOR_BURN).toBe(REAL_PHASE16_TOPIC0);
});

test('S3-2: the real Phase 16 Base Sepolia DepositForBurn event decodes correctly', () => {
  // Plain depositForBurn(): hookData empty (0x).
  const topics = [
    REAL_PHASE16_TOPIC0,
    `0x${addrB32('0x036CbD53842c5426634e7929541eC2318f3dCF7e')}`,
    `0x${addrB32('0x3Af65566013269a1c2F6EE97d49F93a98D51d220')}`,
    `0x${b32hex(0)}`,
  ];
  const data = encodeAbiParameters(
    [
      { name: 'amount', type: 'uint256' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'destinationTokenMessenger', type: 'bytes32' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'hookData', type: 'bytes' },
    ],
    [
      100000n,
      '0x0000000000000000000000002ebcd5d751c5ea788ebca0032f5bd23daa0564c7',
      26,
      `0x${addrB32(CCTP_CONTRACTS_TESTNET.tokenMessengerV2)}`,
      `0x${b32hex(0)}`,
      0n,
      '0x',
    ],
  );
  const d = decodeDepositForBurn({
    address: CCTP_CONTRACTS_TESTNET.tokenMessengerV2.toLowerCase(),
    topics, data, logIndex: 0,
  });
  expect(d).not.toBeNull();
  if (!d) return;
  expect(d.burnToken).toBe('0x036cbd53842c5426634e7929541ec2318f3dcf7e');
  expect(d.amount).toBe(100000n);
  expect(d.depositor).toBe('0x3af65566013269a1c2f6ee97d49f93a98d51d220');
  expect(d.destinationDomain).toBe(26);
  expect(d.mintRecipient).toBe('0x0000000000000000000000002ebcd5d751c5ea788ebca0032f5bd23daa0564c7');
  expect(d.destinationCaller).toBe(`0x${b32hex(0)}`);
  expect(d.maxFee).toBe(0n);
  expect(d.minFinalityThreshold).toBe(0);
  expect(d.hookData).toBe('0x');
});

test('S3-3: a Forwarding depositForBurnWithHook event with non-empty hookData decodes', () => {
  const topics = [
    TOPIC_DEPOSIT_FOR_BURN,
    `0x${addrB32(SRC_USDC)}`,
    `0x${addrB32(DEPOSITOR)}`,
    `0x${b32hex(0)}`,
  ];
  const data = encodeAbiParameters(
    [
      { name: 'amount', type: 'uint256' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'destinationTokenMessenger', type: 'bytes32' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'hookData', type: 'bytes' },
    ],
    [
      AMOUNT,
      `0x${addrB32(ARC_WALLET)}`,
      ARC_CCTP_DOMAIN,
      `0x${addrB32(CCTP_CONTRACTS_TESTNET.tokenMessengerV2)}`,
      `0x${b32hex(0)}`,
      0n,
      FORWARD_HOOK,
    ],
  );
  const d = decodeDepositForBurn({ address: TM.toLowerCase(), topics, data, logIndex: 0 });
  expect(d).not.toBeNull();
  if (!d) return;
  expect(d.hookData).toBe(FORWARD_HOOK);
  expect(d.amount).toBe(AMOUNT);
  expect(d.destinationDomain).toBe(ARC_CCTP_DOMAIN);
});

test('S3-4: the old nonce-based event topic is REJECTED (V2-only, no fallback)', () => {
  const OLD_TOPIC = keccak256(toBytes('DepositForBurn(uint64,address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32)'));
  expect(OLD_TOPIC).not.toBe(REAL_PHASE16_TOPIC0);
  expect(OLD_TOPIC).not.toBe(TOPIC_DEPOSIT_FOR_BURN);
  // A log still carrying the OLD topic0 must fail to decode — the parser never
  // silently falls back to the nonce-based layout.
  const topics = [OLD_TOPIC, `0x${addrB32(SRC_USDC)}`, `0x${addrB32(DEPOSITOR)}`, `0x${b32hex(NONCE)}`];
  const data = encodeAbiParameters(
    [
      { name: 'amount', type: 'uint256' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'destinationTokenMessenger', type: 'bytes32' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
    ],
    [AMOUNT, `0x${addrB32(ARC_WALLET)}`, ARC_CCTP_DOMAIN, `0x${addrB32(CCTP_CONTRACTS_TESTNET.tokenMessengerV2)}`, `0x${b32hex(0)}`, 0n, 0],
  );
  expect(decodeDepositForBurn({ address: TM.toLowerCase(), topics, data, logIndex: 0 })).toBeNull();
});

// ── Finality gate (PHASE 6 semantics) ──────────────────────────────────────

test('P5-4: source finality uses the registry finality_mode and never degrades', async () => {
  const count3 = fakeProvider(receipt());
  // tx block 1000, head 1002 => 3 confirmations => final
  expect((await evaluateSourceFinality(count3, 1_000n)).final).toBe(true);
  // tx block 1001, head 1002 => 2 confirmations => NOT final (retry later)
  const notYet = await evaluateSourceFinality(count3, 1_001n);
  expect(notYet.final).toBe(false);
  expect(notYet.detail).toMatch(/2 of 3 confirmations/);

  const immediate = fakeProvider(receipt(), { network: 'arc_testnet', finalityMode: 'immediate', requiredConfirmations: 0 });
  expect((await evaluateSourceFinality(immediate, 1n)).final).toBe(true);

  // 'finalized' whose endpoint cannot serve the tag must THROW (fail closed),
  // never fall back to latest / a count / immediate.
  const tagMissing = fakeProvider(receipt(), {
    network: 'base_mainnet', finalityMode: 'finalized', requiredConfirmations: 0,
    tagHead: async () => { throw new Error('tag unsupported'); },
  });
  await expect(evaluateSourceFinality(tagMissing, 1n)).rejects.toThrow(/tag unsupported/);

  // 'finalized' that CAN serve the tag: block above the head is not final.
  const tagOk = fakeProvider(receipt(), { network: 'base_mainnet', finalityMode: 'finalized', requiredConfirmations: 0, tagHead: 999n });
  expect((await evaluateSourceFinality(tagOk, 1_000n)).final).toBe(false);
  const tagOk2 = fakeProvider(receipt(), { network: 'base_mainnet', finalityMode: 'finalized', requiredConfirmations: 0, tagHead: 1_000n });
  expect((await evaluateSourceFinality(tagOk2, 1_000n)).final).toBe(true);

  // An unknown mode has no default: it throws.
  const bogus = fakeProvider(receipt());
  (bogus as unknown as { getConfig: () => unknown }).getConfig = () => ({
    network: 'somewhere', chainId: 1, rpcUrl: '', explorerBase: '', usdcAddress: '', usdcDecimals: 6,
    requiredConfirmations: 1, finalityMode: 'mostly-final',
  });
  await expect(evaluateSourceFinality(bogus, 1n)).rejects.toThrow(/Unknown finality_mode/);
});

/**
 * Every case gets its OWN intent and its OWN tx hash, so a refusal is always
 * about the thing under test — never about a burn a previous test recorded.
 */
let seq = 0;
async function scenario(r: ReturnType<typeof receipt> | null = receipt(), opts: Parameters<typeof fakeProvider>[1] = {}): Promise<{ id: string; tx: string; res: SourceBurnSuccess | SourceBurnFailure }> {
  const id = `pi_cctpb_s${++seq}`;
  insertIntent(id, true);
  const tx = txHashFor(seq);
  const res = await detectSourceBurn({ paymentIntentId: id, sourceTxHash: tx, providerFactory: () => fakeProvider(r, opts) });
  return { id, tx, res };
}

// ── Happy path ─────────────────────────────────────────────────────────────

test('P5-5: a valid bound burn is recorded as IN TRANSIT and nothing is credited', async () => {
  const { id, tx, res } = await scenario(receipt({ nonce: 105n }));
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.destinationDomain).toBe(ARC_CCTP_DOMAIN);
  expect(res.mintRecipientBytes32).toBe(addressToBytes32(ARC_WALLET).toLowerCase());
  expect(res.burnAmountBaseUnits).toBe('5000000');
  expect(res.sourceNetwork).toBe('base_sepolia');
  expect(res.createdNewTransfer).toBe(true);
  expect(res.sourceFinalized).toBe(true);            // 3 confirmations available in the fixture
  expect(res.state).toBe('source_finalized');
  expect(res.maxFee).toBe('0');                      // STANDARD free transfer, never Fast
  expect(res.finalityThresholdExecuted).toBe(2000);  // the finalized class PHASE 8 requires
  expect(res.cctpMessageId).toBe(keccak256(res.cctpMessage as `0x${string}`));
  expect(res.burnMessageHash).toBe(res.cctpMessageId);

  const t = transferFor(id)!;
  expect(t.source_tx_hash).toBe(tx);
  expect(t.source_network).toBe('base_sepolia');
  expect(t.destination_network).toBe('arc_testnet');
  expect(t.destination_chain_id).toBe(5042002);
  expect(t.mint_recipient).toBe(ARC_WALLET);
  expect(t.token_messenger).toBe(TM.toLowerCase());
  expect(t.source_usdc_address).toBe(SRC_USDC.toLowerCase());
  expect(t.amount_base_units).toBe('5000000');
  expect(t.state).toBe('source_finalized');
  expect(t.attestation_status).toBe('none');         // PHASE 7 has not run
  expect(t.claim_status).toBe('none');               // PHASE 8 has not run
  expect(typeof t.source_finalized_at).toBe('number');

  // THE core PHASE 5 rule: a burn is not a payment.
  expect(intentStatus(id)).toBe('processing');
  expect(getDb().prepare('SELECT COUNT(*) c FROM payments WHERE payment_intent_id=?').get(id)).toEqual({ c: 0 });
  const ev = getDb().prepare("SELECT event_type FROM payment_events WHERE payment_intent_id=? AND event_type='payment.cross_chain.source_burn_detected'").all(id);
  expect(ev.length).toBe(1);
});

test('P5-6: re-detecting the same burn is idempotent (no second row, no second event)', async () => {
  const first = await scenario(receipt({ nonce: 106n }));
  expect(first.res.ok).toBe(true);
  const again = await detectSourceBurn({ paymentIntentId: first.id, sourceTxHash: first.tx, providerFactory: () => fakeProvider(receipt({ nonce: 106n })) });
  expect(again.ok).toBe(true);
  if (!again.ok || !first.res.ok) return;
  expect(again.createdNewTransfer).toBe(false);
  expect(again.transferId).toBe(first.res.transferId);
  expect(getDb().prepare('SELECT COUNT(*) c FROM cross_chain_transfers WHERE payment_intent_id=?').get(first.id)).toEqual({ c: 1 });
  expect(getDb().prepare("SELECT COUNT(*) c FROM payment_events WHERE payment_intent_id=? AND event_type='payment.cross_chain.source_burn_detected'").get(first.id)).toEqual({ c: 2 });
});

test('P5-7: an unfinal source burn is recorded as source_finalizing, never finalized', async () => {
  // 2 of the 3 confirmations the registry requires for base_sepolia.
  const { id, res } = await scenario(receipt({ blockNumber: 1_001n, nonce: 107n }));
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.sourceFinalized).toBe(false);
  expect(res.state).toBe('source_finalizing');
  const t = transferFor(id)!;
  expect(t.state).toBe('source_finalizing');
  expect(t.source_finalized_at).toBeNull();
  expect(intentStatus(id)).toBe('processing');
  expect(getDb().prepare('SELECT COUNT(*) c FROM payments WHERE payment_intent_id=?').get(id)).toEqual({ c: 0 });
});

test('P5-7b: the same burn becomes source_finalized once confirmations accrue', async () => {
  const first = await scenario(receipt({ blockNumber: 1_001n, nonce: 1071n }));
  expect(first.res.ok).toBe(true);
  const second = await detectSourceBurn({ paymentIntentId: first.id, sourceTxHash: first.tx, providerFactory: () => fakeProvider(receipt({ blockNumber: 1_001n, nonce: 1071n }), { latestHead: 1_003n }) });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.state).toBe('source_finalized');
  expect(second.createdNewTransfer).toBe(false);
  expect(transferFor(first.id)!.state).toBe('source_finalized');
});

// ── Anti-redirect / anti-replay refusals ───────────────────────────────────

test('P5-8: a burn minting to anyone but the merchant\'s pinned Arc wallet is refused', async () => {
  const { id, res } = await scenario(receipt({ burn: { mintRecipient: EVIL_WALLET }, message: buildCctpMessage({ mintRecipient: EVIL_WALLET }) }));
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.code).toBe('wrong_mint_recipient');
  expect(res.retryable).toBe(false);
  expect(transferFor(id)).toBeUndefined();          // nothing recorded at all
  expect(intentStatus(id)).toBe('requires_payment');
});

test('P5-9: amount, token, destination-domain and depositor drift are each refused', async () => {
  const short = await scenario(receipt({ burn: { amount: 4_999_999n }, message: buildCctpMessage({ amount: 4_999_999n }) }));
  expect(short.res.ok).toBe(false); if (!short.res.ok) expect(short.res.code).toBe('amount_mismatch');

  const over = await scenario(receipt({ burn: { amount: 5_000_001n }, message: buildCctpMessage({ amount: 5_000_001n }) }));
  expect(over.res.ok).toBe(false); if (!over.res.ok) expect(over.res.code).toBe('amount_mismatch');

  const wrongToken = await scenario(receipt({ burn: { burnToken: EVIL_WALLET }, message: buildCctpMessage({ burnToken: EVIL_WALLET }) }));
  expect(wrongToken.res.ok).toBe(false); if (!wrongToken.res.ok) expect(wrongToken.res.code).toBe('wrong_burn_token');

  const wrongDomain = await scenario(receipt({ burn: { destinationDomain: 0 }, message: buildCctpMessage({ destinationDomain: 0 }) }));
  expect(wrongDomain.res.ok).toBe(false); if (!wrongDomain.res.ok) expect(wrongDomain.res.code).toBe('wrong_destination_domain');

  // depositor topic != tx sender
  const wrongDepositor = await scenario(receipt({ burn: { depositor: EVIL_WALLET }, message: buildCctpMessage({}) }));
  expect(wrongDepositor.res.ok).toBe(false); if (!wrongDepositor.res.ok) expect(wrongDepositor.res.code).toBe('wrong_depositor');
});

test('P5-10: logs from the wrong contract, a missing burn, or a reverted tx are refused', async () => {
  const wrongEmitter = await scenario(receipt({ burn: { address: EVIL_WALLET } }));
  expect(wrongEmitter.res.ok).toBe(false); if (!wrongEmitter.res.ok) expect(wrongEmitter.res.code).toBe('burn_event_missing');

  const wrongTo = await scenario(receipt({ to: EVIL_WALLET }));
  expect(wrongTo.res.ok).toBe(false); if (!wrongTo.res.ok) expect(wrongTo.res.code).toBe('not_token_messenger_call');

  // mainnet contract pair on a testnet route = wrong environment class
  const mainnetTM = await scenario(receipt({ to: CCTP_CONTRACTS_MAINNET.tokenMessengerV2, burn: { address: CCTP_CONTRACTS_MAINNET.tokenMessengerV2 } }));
  expect(mainnetTM.res.ok).toBe(false); if (!mainnetTM.res.ok) expect(mainnetTM.res.code).toBe('not_token_messenger_call');

  const noBurn = await scenario(receipt({ burn: null }));
  expect(noBurn.res.ok).toBe(false); if (!noBurn.res.ok) expect(noBurn.res.code).toBe('burn_event_missing');

  const noMessage = await scenario(receipt({ message: null }));
  expect(noMessage.res.ok).toBe(false); if (!noMessage.res.ok) expect(noMessage.res.code).toBe('message_event_missing');

  const reverted = await scenario(receipt({ status: 'reverted' }));
  expect(reverted.res.ok).toBe(false); if (!reverted.res.ok) expect(reverted.res.code).toBe('receipt_reverted');

  // MessageSent emitted by something other than the pinned MessageTransmitter
  const msg = buildCctpMessage({});
  const badMT = await scenario({ ...receipt({}), logs: [burnLog({}), { ...messageLog(msg), address: EVIL_WALLET.toLowerCase() }] });
  expect(badMT.res.ok).toBe(false); if (!badMT.res.ok) expect(badMT.res.code).toBe('wrong_contract');

  // two burns in one tx: ambiguous, never guessed
  const ambiguous = await scenario({ ...receipt({}), logs: [burnLog({}), burnLog({ nonce: 4242n }), messageLog(msg)] });
  expect(ambiguous.res.ok).toBe(false); if (!ambiguous.res.ok) expect(ambiguous.res.code).toBe('burn_event_ambiguous');
});

test('P5-11: event args that disagree with the message payload are refused', async () => {
  // Event says minFinalityThreshold 1, message says 0 — a spliced/replayed
  // pairing. (The corrected V2 event has no nonce, so this replaces the old
  // event-vs-message nonce splice; the remaining cross-check is
  // minFinalityThreshold, now an indexed topic.)
  const fin = await scenario(receipt({ burn: { minFinalityThreshold: 1 }, message: buildCctpMessage({ minFinalityThreshold: 0, nonce: 5678n }) }));
  expect(fin.res.ok).toBe(false);
  if (fin.res.ok) return;
  expect(fin.res.code).toBe('message_mismatch');
  expect(fin.res.reason).toMatch(/minFinalityThreshold/);

  // message destination domain moved off Arc while the event looks right
  const dest = await scenario(receipt({ burn: {}, message: buildCctpMessage({ destinationDomain: 0 }) }));
  expect(dest.res.ok).toBe(false); if (!dest.res.ok) expect(dest.res.code).toBe('message_mismatch');

  // wrong source domain in the message
  const src = await scenario(receipt({ burn: {}, message: buildCctpMessage({ sourceDomain: 99 }) }));
  expect(src.res.ok).toBe(false); if (!src.res.ok) expect(src.res.code).toBe('message_mismatch');

  // an unrecognised message version fails closed rather than being guessed
  const ver = await scenario(receipt({ burn: {}, message: buildCctpMessage({ version: 7 }) }));
  expect(ver.res.ok).toBe(false); if (!ver.res.ok) expect(ver.res.code).toBe('message_version_unsupported');

  const truncated = await scenario(receipt({ burn: {}, message: buildCctpMessage({ truncateTo: 200 }) }));
  expect(truncated.res.ok).toBe(false); if (!truncated.res.ok) expect(truncated.res.code).toBe('message_too_short');
});

test('P5-12: a tx already claimed by another intent is refused as a replay', async () => {
  const owner = await scenario(receipt({ nonce: 112n }));
  expect(owner.res.ok).toBe(true);
  const victim = await scenario(null); // fresh intent, no receipt yet
  expect(victim.res.ok).toBe(false); if (!victim.res.ok) expect(victim.res.code).toBe('receipt_missing');

  // the victim now submits the OWNER's burn tx
  const hijack = await detectSourceBurn({ paymentIntentId: victim.id, sourceTxHash: owner.tx, providerFactory: () => fakeProvider(receipt()) });
  expect(hijack.ok).toBe(false);
  if (hijack.ok) return;
  expect(hijack.code).toBe('transfer_replay_detected');
  expect(hijack.retryable).toBe(false);
  expect(transferFor(victim.id)).toBeUndefined();
});

test('P5-12b: an intent that already recorded a burn cannot acquire a second one', async () => {
  const first = await scenario(receipt({ nonce: 1121n }));
  expect(first.res.ok).toBe(true);
  const second = await detectSourceBurn({ paymentIntentId: first.id, sourceTxHash: txHashFor(9000 + seq), providerFactory: () => fakeProvider(receipt()) });
  expect(second.ok).toBe(false);
  if (second.ok) return;
  expect(second.code).toBe('burn_already_recorded');
  expect(transferFor(first.id)!.source_tx_hash).toBe(first.tx);
});

test('P5-13: a same-chain intent and an unknown intent are both refused', async () => {
  const same = await detectSourceBurn({ paymentIntentId: 'pi_cctpb_same', sourceTxHash: TX_HASH, providerFactory: () => fakeProvider(receipt()) });
  expect(same.ok).toBe(false); if (!same.ok) expect(same.code).toBe('not_cross_chain');

  const missing = await detectSourceBurn({ paymentIntentId: 'pi_cctpb_does_not_exist', sourceTxHash: TX_HASH, providerFactory: () => fakeProvider(receipt()) });
  expect(missing.ok).toBe(false); if (!missing.ok) expect(missing.code).toBe('intent_not_found');

  const badHash = await detectSourceBurn({ paymentIntentId: 'pi_cctpb_x', sourceTxHash: '0x1234' });
  expect(badHash.ok).toBe(false); if (!badHash.ok) expect(badHash.code).toBe('invalid_tx_hash');
});

test('P5-14: an RPC failure is retryable and NEVER looks like a payment', async () => {
  const { id, tx } = await scenario(null);
  const res = await detectSourceBurn({
    paymentIntentId: id,
    sourceTxHash: tx,
    providerFactory: () => { throw new Error('eth_chainId mismatch'); },
  });
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.code).toBe('provider_error');
  expect(res.retryable).toBe(true);
  expect(transferFor(id)).toBeUndefined();
  expect(intentStatus(id)).toBe('requires_payment');

  const gone = await detectSourceBurn({ paymentIntentId: id, sourceTxHash: tx, providerFactory: () => fakeProvider(null) });
  expect(gone.ok).toBe(false); if (!gone.ok) expect(gone.code).toBe('receipt_missing');

  // a finality tag the endpoint cannot serve aborts detection — fail closed
  const tagFail = await scenario(receipt(), { network: 'base_sepolia', finalityMode: 'finalized', requiredConfirmations: 0, tagHead: async () => { throw new Error('tag unsupported'); } });
  expect(tagFail.res.ok).toBe(false); if (!tagFail.res.ok) expect(tagFail.res.code).toBe('provider_error');
  expect(transferFor(tagFail.id)).toBeUndefined();
});

test('P5-15: messageTransmitterFor pins the pair by environment class', () => {
  expect(messageTransmitterFor(true)).toBe(CCTP_CONTRACTS_TESTNET.messageTransmitterV2.toLowerCase());
  expect(messageTransmitterFor(false)).toBe(CCTP_CONTRACTS_MAINNET.messageTransmitterV2.toLowerCase());
});

// ── STEP 4B: Forwarding fee-inflation — EXACT amount + maxFee binding ──────
// Merchant settlement target (M) is ALWAYS payment_intents.amount_base_units and is
// NEVER credited M + F. The server-approved Forwarding fee (F) lives in
// payment_intents.forwarding_max_fee_base_units (client cannot set it — proven in
// cctp-intents.test.ts). The source must burn EXACTLY M + F with maxFee EXACTLY F;
// a >- floor, an under/over-burn, or a self-reported fee is refused. DIRECT is F = 0.
const M = 5_000_000n; // merchant settlement target (5.00 USDC)
const F = 20_380n;    // server-approved Forwarding maxFee for these scenarios

function insertIntentWithFee(id: string, fee: bigint, amount: bigint = M): void {
  getDb()
    .prepare(
      `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
        amount_decimal,amount_base_units,environment,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id,forwarding_max_fee_base_units)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id, 'merch_cctpb', 'sw_cctpb', ARC_WALLET, 'base_sepolia', 84532, SRC_USDC,
      '5.00', amount.toString(), 'test', 9999999999, 1, 'base_sepolia', 'arc_testnet', 5042002, fee.toString(),
    );
}

let s4 = 0;
async function detectFee(id: string, r: ReturnType<typeof receipt> | null) {
  const tx = txHashFor(30000 + (++s4)); // disjoint from the numbered P5 tx hashes
  return detectSourceBurn({ paymentIntentId: id, sourceTxHash: tx, providerFactory: () => fakeProvider(r) });
}

/** A fee-inflated burn + message whose amount/maxFee we can skew independently. */
function forwardReceipt(nonce: bigint, o: { amount?: bigint; eventMaxFee?: bigint; messageMaxFee?: bigint } = {}) {
  const amount = o.amount ?? M + F;
  const eventMaxFee = o.eventMaxFee ?? F;
  const messageMaxFee = o.messageMaxFee ?? F;
  return receipt({
    nonce,
    burn: { amount, maxFee: eventMaxFee },
    message: buildCctpMessage({ nonce, amount, maxFee: messageMaxFee }),
  });
}

test('S4-1 (DIRECT): fee 0, burn == intent amount passes', async () => {
  const id = 'pi_cctpb_s4_direct';
  insertIntentWithFee(id, 0n);
  const res = await detectFee(id, forwardReceipt(40001n, { amount: M, eventMaxFee: 0n, messageMaxFee: 0n }));
  expect(res.ok).toBe(true);
});

test('S4-2 (FORWARDING EXACT): burn == M + F with maxFee == F passes', async () => {
  const id = 'pi_cctpb_s4_exact';
  insertIntentWithFee(id, F);
  const res = await detectFee(id, forwardReceipt(40002n));
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.burnAmountBaseUnits).toBe((M + F).toString());
});

test('S4-3 (UNDERPAYMENT): burn == M + F - 1 fails', async () => {
  const id = 'pi_cctpb_s4_under';
  insertIntentWithFee(id, F);
  const res = await detectFee(id, forwardReceipt(40003n, { amount: M + F - 1n }));
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.code).toBe('amount_mismatch');
});

test('S4-4 (OVERPAYMENT): burn == M + F + 1 fails — never a >= floor', async () => {
  const id = 'pi_cctpb_s4_over';
  insertIntentWithFee(id, F);
  const res = await detectFee(id, forwardReceipt(40004n, { amount: M + F + 1n }));
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.code).toBe('amount_mismatch');
});

test('S4-5 (WRONG EVENT maxFee): event+message agree but != approved fee → refused', async () => {
  const id = 'pi_cctpb_s4_evfee';
  insertIntentWithFee(id, F);
  // amount is the approved M + F; both event and message report maxFee F+1 (they
  // agree with EACH OTHER) — the only violation is against the server approval.
  const res = await detectFee(id, forwardReceipt(40005n, { eventMaxFee: F + 1n, messageMaxFee: F + 1n }));
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.code).toBe('amount_mismatch');
});

test('S4-6 (WRONG MESSAGE maxFee): message disagrees with event + approved → refused', async () => {
  const id = 'pi_cctpb_s4_msfee';
  insertIntentWithFee(id, F);
  const res = await detectFee(id, forwardReceipt(40006n, { messageMaxFee: F + 1n }));
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.code).toBe('message_mismatch');
});

test('S4-7 (FEE CONSISTENCY): inflating event+message+amount together is still refused', async () => {
  const id = 'pi_cctpb_s4_inflate';
  insertIntentWithFee(id, F);
  // caller tries to smuggle a larger fee by burning M + 25000 and declaring 25000
  // everywhere — but the approved fee is F, so the gross amount no longer matches.
  const res = await detectFee(id, forwardReceipt(40007n, { amount: M + 25000n, eventMaxFee: 25000n, messageMaxFee: 25000n }));
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.code).toBe('amount_mismatch');
});

test('S4-8 (MERCHANT TARGET): a forwarding burn records settlement M, never M + F', async () => {
  const id = 'pi_cctpb_s4_target';
  insertIntentWithFee(id, F);
  const res = await detectFee(id, forwardReceipt(40008n));
  expect(res.ok).toBe(true);
  const t = transferFor(id)!;
  expect(t.amount_base_units).toBe(M.toString());            // merchant owed M
  expect(t.amount_base_units).not.toBe((M + F).toString());  // NOT the inflated burn
});

test('S4-9 (RECIPIENT / TOKEN / DOMAIN stay bound under a fee)', async () => {
  const recipId = 'pi_cctpb_s4_recip';
  insertIntentWithFee(recipId, F);
  const recip = await detectFee(recipId, receipt({ nonce: 40009n, burn: { amount: M + F, maxFee: F, mintRecipient: EVIL_WALLET }, message: buildCctpMessage({ nonce: 40009n, amount: M + F, maxFee: F, mintRecipient: EVIL_WALLET }) }));
  expect(recip.ok).toBe(false); if (!recip.ok) expect(recip.code).toBe('wrong_mint_recipient');

  const tokenId = 'pi_cctpb_s4_token';
  insertIntentWithFee(tokenId, F);
  const tok = await detectFee(tokenId, receipt({ nonce: 40010n, burn: { amount: M + F, maxFee: F, burnToken: EVIL_WALLET }, message: buildCctpMessage({ nonce: 40010n, amount: M + F, maxFee: F, burnToken: EVIL_WALLET }) }));
  expect(tok.ok).toBe(false); if (!tok.ok) expect(tok.code).toBe('wrong_burn_token');

  const domId = 'pi_cctpb_s4_domain';
  insertIntentWithFee(domId, F);
  const dom = await detectFee(domId, receipt({ nonce: 40011n, burn: { amount: M + F, maxFee: F, destinationDomain: 0 }, message: buildCctpMessage({ nonce: 40011n, amount: M + F, maxFee: F, destinationDomain: 0 }) }));
  expect(dom.ok).toBe(false); if (!dom.ok) expect(dom.code).toBe('wrong_destination_domain');
});
