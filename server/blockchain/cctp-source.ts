/**
 * JafariPay — CCTP SOURCE-BURN DETECTION (MASTER PHASE 5)
 *
 * Detects and VERIFIES a customer's Circle CCTP burn on a cross-chain SOURCE
 * network, extracts the CCTP message that Circle's attestation service (Iris)
 * signs, and records the journey in `cross_chain_transfers`.
 *
 * ── What PHASE 5 does and does NOT do ─────────────────────────────────────
 *   DOES: read the source receipt through the registry-pinned provider (so the
 *     endpoint's chain id is proven before any read), decode and BIND the
 *     `DepositForBurn` event to the payment intent, decode the `MessageSent`
 *     message and cross-check it against Circle's published wire layout AND
 *     against the event args, compute the message id, apply the registry
 *     finality gate, and persist an IN-TRANSIT transfer.
 *   DOES NOT: credit anything. A burn is NOT a payment. `payment_intents` is
 *     moved at most to 'processing' (in flight) and NEVER to 'succeeded' here —
 *     settlement happens in PHASE 8, once the mint Transfer to the merchant's
 *     pinned Arc wallet is verified ON Arc.
 *
 * ── Money-safety invariants enforced here ────────────────────────────────
 *   1. Nothing is trusted from the caller except the tx hash. Every expected
 *      value (source network, burn token, mint recipient, destination domain,
 *      TokenMessenger/MessageTransmitter, exact amount) comes from the
 *      persisted intent and the CCTP/network registries.
 *   2. The burn must be emitted BY the registry-pinned TokenMessenger of the
 *      route's environment class, inside a tx that CALLED that contract.
 *   3. `mintRecipient` must equal bytes32(intent.settlement_address) — the
 *      merchant's ONE pinned Arc wallet. A burn pointing anywhere else is
 *      refused: JafariPay never becomes, and never routes to, another recipient.
 *   4. The amount must match EXACTLY (the same rule the same-chain verifier
 *      applies). CCTP mints exactly what was burned, on the destination, so a
 *      mismatch is an under/over-credit by construction — never accepted.
 *   5. Event args and message payload are checked against EACH OTHER as well as
 *      against the intent, so a mismatched or replayed pairing fails.
 *   6. Storage-layer replay protection: UNIQUE(source_tx_hash, source_network),
 *      UNIQUE(burn_message_hash), UNIQUE(cctp_message_id) and one transfer per
 *      intent — a burn can only ever be attached to one journey.
 *   7. Fail closed: an unknown network, an RPC that cannot prove its chain id or
 *      finality tag, an unrecognised message version, or a short message all
 *      ABORT detection. None of them is ever mapped to "paid".
 */

import { decodeEventLog, fromHex, keccak256, parseAbiItem, type AbiEvent } from 'viem';
import { getDb } from '../db/schema.js';
import { generateId } from '../lib/ids.js';
import { ArcProvider, getNetworkConfig, getNetworkMeta, type NetworkConfig, type TransactionReceipt } from './arc-provider.js';
import {
  ARC_CCTP_DOMAIN,
  CCTP_BURN_MESSAGE_BODY_BYTES,
  CCTP_MESSAGE_HEADER_BYTES,
  CCTP_MESSAGE_OFFSETS,
  CCTP_REGISTRY,
  CCTP_SUPPORTED_MESSAGE_VERSIONS,
  addressToBytes32,
  cctpContractsFor,
  cctpDomainOf,
  isCctpSource,
  tokenMessengerFor,
} from '../db/cctp.js';

// ── CCTP v2 source-chain event ABIs ────────────────────────────────────────
// Field names, types and indexed positions taken VERBATIM from Circle's
// published TokenMessengerV2 / MessageTransmitterV2 interfaces (checked against
// the `DepositForBurn` and `MessageSent` parameter tables in the CCTP contract
// interfaces reference during PHASE 5) — never reconstructed from memory. These
// are the only places these two signatures exist in this codebase.

export const DEPOSIT_FOR_BURN_ABI: AbiEvent = parseAbiItem(
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)'
);

export const MESSAGE_SENT_ABI: AbiEvent = parseAbiItem(
  'event MessageSent(bytes message)'
);

/** The MessageTransmitterV2 for a route's environment class (registry-sourced). */
export function messageTransmitterFor(isTestnet: boolean): string {
  return cctpContractsFor(isTestnet).messageTransmitterV2.toLowerCase();
}

// ── Result types ───────────────────────────────────────────────────────────

export type SourceBurnFailureCode =
  | 'intent_not_found'
  | 'not_cross_chain'
  | 'intent_not_payable'
  | 'source_not_registered'
  | 'invalid_tx_hash'
  | 'provider_error'
  | 'receipt_missing'
  | 'receipt_reverted'
  | 'not_token_messenger_call'
  | 'burn_event_missing'
  | 'burn_event_ambiguous'
  | 'wrong_destination_domain'
  | 'wrong_mint_recipient'
  | 'wrong_burn_token'
  | 'wrong_depositor'
  | 'wrong_contract'
  | 'amount_mismatch'
  | 'message_event_missing'
  | 'message_version_unsupported'
  | 'message_too_short'
  | 'message_mismatch'
  | 'burn_already_recorded'
  | 'transfer_replay_detected'
  | 'transfer_not_mutable';

export interface SourceBurnFailure {
  ok: false;
  code: SourceBurnFailureCode;
  /** Operator-facing detail. Contains no secrets. */
  reason: string;
  /**
   * True when re-polling the SAME tx later could still succeed (not mined yet,
   * source block not final yet, RPC trouble). False means this tx can NEVER
   * satisfy this intent — the customer must submit a different payment.
   */
  retryable: boolean;
}

export interface SourceBurnSuccess {
  ok: true;
  transferId: string;
  paymentIntentId: string;
  sourceTxHash: string;
  sourceNetwork: string;
  sourceBlockNumber: number;
  /**
   * CCTP message `nonce` (decimal string). The deployed V2 DepositForBurn event
   * carries no nonce, so this is read from the attested message — the same value
   * whose bytes make the message (and therefore this journey) unique.
   */
  cctpNonce: string;
  burnAmountBaseUnits: string;
  /** bytes32 form of the merchant's Arc wallet the burn mints to. */
  mintRecipientBytes32: string;
  destinationDomain: number;
  /** keccak256(message) — the identity of this burn. */
  burnMessageHash: string;
  /** Same hash; Circle's attestation lookup key (`messageHash`). */
  cctpMessageId: string;
  /** Raw CCTP message bytes, hex. Submitted with the attestation in PHASE 8. */
  cctpMessage: string;
  depositor: string;
  maxFee: string;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  /** Registry finality gate result for the source network (PHASE 6). */
  sourceFinalized: boolean;
  /** Persisted `cross_chain_transfers.state` after this call. */
  state: string;
  createdNewTransfer: boolean;
}

export type SourceBurnResult = SourceBurnSuccess | SourceBurnFailure;

const fail = (code: SourceBurnFailureCode, reason: string, retryable: boolean): SourceBurnFailure =>
  ({ ok: false, code, reason, retryable });

// ── CCTP message parser (pure) ─────────────────────────────────────────────

export interface ParsedCctpMessage {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  /** bytes32 hex */ nonce: string;
  /** bytes32 hex — MessageTransmitterV2 caller on the source domain */ sender: string;
  /** bytes32 hex — handler on the destination domain */ recipient: string;
  /** bytes32 hex */ destinationCaller: string;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  /** bytes hex */ messageBody: string;
  // BurnMessageV2 body
  bodyVersion: number;
  /** bytes32 hex */ burnToken: string;
  /** bytes32 hex */ mintRecipient: string;
  amount: bigint;
  /** bytes32 hex — caller of depositForBurn */ messageSender: string;
  maxFee: bigint;
  feeExecuted: bigint;
  expirationBlock: bigint;
}

export class CctpMessageParseError extends Error {}

function u32(b: Uint8Array, off: number): number {
  let v = 0;
  for (let i = 0; i < 4; i++) v = v * 256 + (b[off + i] ?? 0);
  return v;
}

function b32(b: Uint8Array, off: number): string {
  const slice = b.subarray(off, off + 32);
  if (slice.length !== 32) throw new CctpMessageParseError(`CCTP message truncated at offset ${off}`);
  return '0x' + Array.from(slice).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function u256(b: Uint8Array, off: number): bigint {
  return BigInt(b32(b, off));
}

function toHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse a raw CCTP message into its header + BurnMessageV2 body using Circle's
 * PUBLISHED offsets (`CCTP_MESSAGE_OFFSETS`). Pure: no DB, no RPC.
 *
 * FAILS CLOSED on a message shorter than the documented fixed layout, or a
 * `version` outside the layout this parser understands. Both mean "we cannot
 * know what this message says", which must never be reinterpreted as a credit.
 */
export function parseCctpMessage(bytes: Uint8Array): ParsedCctpMessage {
  const header = CCTP_MESSAGE_OFFSETS.header;
  const body = CCTP_MESSAGE_OFFSETS.body;
  const minimum = CCTP_MESSAGE_HEADER_BYTES + CCTP_BURN_MESSAGE_BODY_BYTES;
  if (bytes.length < minimum) {
    throw new CctpMessageParseError(`CCTP message too short: ${bytes.length} bytes < ${minimum} (header + BurnMessageV2 fixed layout)`);
  }
  const version = u32(bytes, header.version);
  if (!CCTP_SUPPORTED_MESSAGE_VERSIONS.includes(version)) {
    throw new CctpMessageParseError(`Unsupported CCTP message version ${version} — the wire layout may have changed, refusing to parse`);
  }
  const messageBody = bytes.subarray(header.messageBody);
  return {
    version,
    sourceDomain: u32(bytes, header.sourceDomain),
    destinationDomain: u32(bytes, header.destinationDomain),
    nonce: b32(bytes, header.nonce),
    sender: b32(bytes, header.sender),
    recipient: b32(bytes, header.recipient),
    destinationCaller: b32(bytes, header.destinationCaller),
    minFinalityThreshold: u32(bytes, header.minFinalityThreshold),
    finalityThresholdExecuted: u32(bytes, header.finalityThresholdExecuted),
    messageBody: toHex(messageBody),
    bodyVersion: u32(messageBody, body.version),
    burnToken: b32(messageBody, body.burnToken),
    mintRecipient: b32(messageBody, body.mintRecipient),
    amount: u256(messageBody, body.amount),
    messageSender: b32(messageBody, body.messageSender),
    maxFee: u256(messageBody, body.maxFee),
    feeExecuted: u256(messageBody, body.feeExecuted),
    expirationBlock: u256(messageBody, body.expirationBlock),
  };
}

/**
 * The CCTP message carries the nonce as bytes32. Compare a uint64-style nonce
 * against it numerically, never by formatting.
 *
 * NOTE: the deployed V2 `DepositForBurn` event exposes NO nonce, so this helper
 * is no longer used for an event<->message cross-check. Message uniqueness and
 * replay protection come from keccak256(message), persisted as
 * `burn_message_hash` / `cctp_message_id` under the DB's UNIQUE constraints.
 */
export function nonceMatches(eventNonce: bigint, messageNonceBytes32: string): boolean {
  try {
    return BigInt(messageNonceBytes32) === eventNonce;
  } catch {
    return false;
  }
}

/** 20-byte address -> bytes32 form, via the registry's single conversion. */
function asBytes32Address(address: string): string | null {
  try {
    return addressToBytes32(address).toLowerCase();
  } catch {
    return null;
  }
}

function sameBytes32(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ── Log decoders ───────────────────────────────────────────────────────────

export interface BurnLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
}

interface DepositForBurnArgs {
  burnToken: string;
  amount: bigint;
  depositor: string;
  mintRecipient: string;
  destinationDomain: number;
  destinationTokenMessenger: string;
  destinationCaller: string;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: string;
}

export function decodeDepositForBurn(log: BurnLog): DepositForBurnArgs | null {
  try {
    const decoded = decodeEventLog({
      abi: [DEPOSIT_FOR_BURN_ABI],
      data: log.data as `0x${string}`,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    if (decoded.eventName !== 'DepositForBurn') return null;
    const a = decoded.args as Record<string, unknown>;
    return {
      burnToken: String(a.burnToken).toLowerCase(),
      amount: a.amount as bigint,
      depositor: String(a.depositor).toLowerCase(),
      mintRecipient: String(a.mintRecipient).toLowerCase(),
      destinationDomain: Number(a.destinationDomain),
      destinationTokenMessenger: String(a.destinationTokenMessenger).toLowerCase(),
      destinationCaller: String(a.destinationCaller).toLowerCase(),
      maxFee: a.maxFee as bigint,
      minFinalityThreshold: Number(a.minFinalityThreshold),
      hookData: String(a.hookData),
    };
  } catch {
    return null;
  }
}

export function decodeMessageSent(log: BurnLog): Uint8Array | null {
  try {
    const decoded = decodeEventLog({
      abi: [MESSAGE_SENT_ABI],
      data: log.data as `0x${string}`,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    if (decoded.eventName !== 'MessageSent') return null;
    return fromHex(decoded.args.message as `0x${string}`, 'bytes');
  } catch {
    return null;
  }
}

// ── Persisted rows ─────────────────────────────────────────────────────────

interface CrossChainIntentRow {
  id: string;
  merchant_id: string;
  status: string;
  network: string;
  chain_id: number;
  usdc_address: string;
  amount_base_units: string;
  /** STEP 4B — server-approved CCTP Forwarding maxFee (0 = DIRECT). Never caller-set. */
  forwarding_max_fee_base_units: string;
  settlement_address: string;
  environment: string;
  is_cross_chain: number;
  source_network: string | null;
  settlement_network: string | null;
  settlement_chain_id: number | null;
}

interface TransferRow {
  id: string;
  payment_intent_id: string;
  state: string;
  source_tx_hash: string | null;
  burn_message_hash: string | null;
  cctp_message_id: string | null;
  amount_base_units: string;
  token_messenger: string;
}

/**
 * States in which a transfer may still accept burn-detection writes. Anything
 * past attestation belongs to PHASE 7/8 and is never rewound from here.
 */
const DETECTION_MUTABLE_STATES: readonly string[] = Object.freeze([
  'source_payment_submitted',
  'source_finalizing',
  'source_finalized',
  'attestation_pending',
]);

/** Early lifecycle ordering, so the state only ever moves forward. */
const DETECTION_STATE_ORDER: readonly string[] = Object.freeze([
  'source_payment_submitted',
  'source_finalizing',
  'source_finalized',
  'attestation_pending',
]);

function pickForwardState(current: string | undefined, target: string): string {
  if (!current) return target;
  if (!DETECTION_MUTABLE_STATES.includes(current)) return current;
  const cur = DETECTION_STATE_ORDER.indexOf(current);
  const next = DETECTION_STATE_ORDER.indexOf(target);
  if (cur === -1 || next === -1) return current;
  return next > cur ? target : current;
}

// ── Provider seam ──────────────────────────────────────────────────────────

/**
 * The subset of ArcProvider this detector needs. Declared structurally so a
 * test can inject a fabricated receipt WITHOUT any network access, while
 * production uses the registry-pinned ArcProvider — which proves eth_chainId
 * against network_configs.chain_id before reading anything (fail closed).
 */
export interface SourceBurnProvider {
  getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null>;
  getLatestBlockNumber(): Promise<bigint>;
  getHeadBlockNumber(tag: 'safe' | 'finalized'): Promise<bigint>;
  getConfig(): NetworkConfig;
  ensureChainIdMatches?(): Promise<void>;
}

export type SourceBurnProviderFactory = (network: string) => SourceBurnProvider | Promise<SourceBurnProvider>;

const defaultProviderFactory: SourceBurnProviderFactory = (network) => new ArcProvider(network);

// ── Source finality (PHASE 6 gate, registry-driven, fail closed) ────────────

export interface FinalityVerdict {
  final: boolean;
  detail: string;
}

/**
 * Apply the SOURCE network's registry `finality_mode` to a tx block. Same
 * semantics as the same-chain verifier — re-used, not re-invented:
 *   'immediate'          — receipt present on the pinned chain is final.
 *   'count'              — required_confirmations child blocks below `latest`.
 *   'safe' / 'finalized' — tx block at or below that tag's head; an endpoint
 *                          that cannot serve the tag THROWS (never degrades).
 * Any other mode throws: there is no default finality for a cross-chain source.
 */
export async function evaluateSourceFinality(provider: SourceBurnProvider, blockNumber: bigint): Promise<FinalityVerdict> {
  const cfg = provider.getConfig();
  const mode = cfg.finalityMode;
  const network = cfg.network;
  if (mode === 'immediate') {
    return { final: true, detail: `finality_mode=immediate on "${network}"` };
  }
  if (mode === 'count') {
    if (cfg.requiredConfirmations <= 0) {
      return { final: true, detail: `finality_mode=count with 0 confirmations required on "${network}"` };
    }
    const head = await provider.getLatestBlockNumber();
    const confirmations = head - blockNumber + 1n; // a tx in the head block has 1
    if (confirmations < BigInt(cfg.requiredConfirmations)) {
      return {
        final: false,
        detail: `only ${confirmations.toString()} of ${cfg.requiredConfirmations} confirmations on "${network}" (tx block ${blockNumber.toString()}, head ${head.toString()})`,
      };
    }
    return { final: true, detail: `${confirmations.toString()} confirmations >= ${cfg.requiredConfirmations} on "${network}"` };
  }
  if (mode === 'safe' || mode === 'finalized') {
    const head = await provider.getHeadBlockNumber(mode);
    if (blockNumber > head) {
      return { final: false, detail: `tx block ${blockNumber.toString()} > ${mode} head ${head.toString()} on "${network}"` };
    }
    return { final: true, detail: `tx block ${blockNumber.toString()} <= ${mode} head ${head.toString()} on "${network}"` };
  }
  throw new Error(`[CCTP] Unknown finality_mode "${mode}" for cross-chain source "${network}" — refusing to assume finality`);
}

// ── Main entry point ───────────────────────────────────────────────────────

export interface DetectSourceBurnInput {
  paymentIntentId: string;
  sourceTxHash: string;
  /** Test seam. Production omits it and gets the registry-pinned ArcProvider. */
  providerFactory?: SourceBurnProviderFactory;
}

/**
 * Verify a source-chain CCTP burn for a cross-chain intent and record it.
 *
 * Idempotent: re-detecting the same tx for the same intent re-validates and
 * returns the same journey without duplicating rows. Attaching a SECOND,
 * different burn to an intent that already recorded one is refused, and a tx
 * already claimed by another intent is refused as a replay.
 */
export async function detectSourceBurn(input: DetectSourceBurnInput): Promise<SourceBurnResult> {
  const db = getDb();
  const txHash = (input.sourceTxHash ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
    return fail('invalid_tx_hash', 'source_tx_hash must be a 32-byte hex transaction hash', false);
  }

  const pi = db
    .prepare(
      `SELECT id,merchant_id,status,network,chain_id,usdc_address,amount_base_units,forwarding_max_fee_base_units,settlement_address,
              environment,is_cross_chain,source_network,settlement_network,settlement_chain_id
         FROM payment_intents WHERE id=?`,
    )
    .get(input.paymentIntentId) as CrossChainIntentRow | undefined;

  if (!pi) return fail('intent_not_found', 'Payment intent not found', false);
  if (pi.is_cross_chain !== 1) {
    return fail('not_cross_chain', 'Payment intent is not a cross-chain intent — use the same-chain verify path', false);
  }
  // A burn may only be recorded while the intent can still be paid for.
  if (!['requires_payment', 'processing'].includes(pi.status)) {
    return fail('intent_not_payable', `Payment intent is in "${pi.status}" state and can no longer accept a source burn`, false);
  }

  // ── Expected values, ALL derived from the persisted intent + registries ──
  const sourceSlug = (pi.source_network ?? pi.network) as string;
  if (!isCctpSource(sourceSlug)) {
    return fail('source_not_registered', `Source network "${sourceSlug}" is not a registered Circle CCTP cross-chain source`, false);
  }
  const sourceDomain = cctpDomainOf(sourceSlug);
  if (sourceDomain === null) {
    return fail('source_not_registered', `No Circle CCTP domain registered for "${sourceSlug}"`, false);
  }
  let sourceCfg: NetworkConfig;
  try {
    sourceCfg = getNetworkConfig(sourceSlug);
  } catch (err) {
    return fail('source_not_registered', `Source network "${sourceSlug}" registry invalid: ${err instanceof Error ? err.message : String(err)}`, false);
  }
  // Environment class comes from the CCTP registry, never from the slug's
  // spelling — and it must AGREE with network_configs, or the route would burn
  // against the wrong contract pair. Two registries disagreeing is a deployment
  // error, so detection fails closed instead of picking one.
  const sourceIsTestnet = CCTP_REGISTRY[sourceSlug]?.isTestnet === true;
  const networkIsTestnet = getNetworkMeta(sourceSlug)?.isTestnet === true;
  if (sourceIsTestnet !== networkIsTestnet) {
    return fail(
      'source_not_registered',
      `Environment class conflict for "${sourceSlug}": CCTP registry says isTestnet=${sourceIsTestnet} but network_configs says isTestnet=${networkIsTestnet} — refusing to guess the contract pair`,
      false,
    );
  }
  const expectedTokenMessenger = tokenMessengerFor(sourceIsTestnet).toLowerCase();
  const expectedTransmitter = messageTransmitterFor(sourceIsTestnet);
  const expectedMintRecipient = asBytes32Address(pi.settlement_address);
  if (!expectedMintRecipient) {
    return fail('wrong_mint_recipient', `Settlement address "${pi.settlement_address}" is not a 20-byte Arc address`, false);
  }
  const expectedBurnToken = sourceCfg.usdcAddress.toLowerCase();
  // STEP 4B — merchant settlement target (M) is the intent amount and NEVER
  // changes; the approved Forwarding fee (F) is the SERVER-authored intent column
  // forwarding_max_fee_base_units (0 for DIRECT). The source must burn EXACTLY
  // M + F and declare maxFee EXACTLY F. Nothing is trusted from the caller: both M
  // and F come from the persisted intent. This is an EXACT match, never a >= floor,
  // so neither under- nor over-payment (nor an arbitrary self-reported fee) passes.
  const settlementAmount = BigInt(pi.amount_base_units);
  const approvedFee = BigInt(pi.forwarding_max_fee_base_units ?? '0');
  const expectedBurnAmount = settlementAmount + approvedFee;

  // ── Existing journey: idempotency + replay protection ───────────────────
  const byIntent = db
    .prepare('SELECT id,payment_intent_id,state,source_tx_hash,burn_message_hash,cctp_message_id,amount_base_units,token_messenger FROM cross_chain_transfers WHERE payment_intent_id=?')
    .get(pi.id) as TransferRow | undefined;
  const byTx = db
    .prepare('SELECT id,payment_intent_id,state,source_tx_hash,burn_message_hash,cctp_message_id,amount_base_units,token_messenger FROM cross_chain_transfers WHERE source_tx_hash=? AND source_network=?')
    .get(txHash, sourceSlug) as TransferRow | undefined;

  if (byTx && byIntent && byTx.id !== byIntent.id) {
    return fail('transfer_replay_detected', 'Source transaction and intent map to two different transfers — refusing', false);
  }
  if (byTx && !byIntent) {
    return fail('transfer_replay_detected', 'This source transaction is already recorded against a different payment intent — possible replay', false);
  }
  const transfer = byIntent;
  if (transfer && !DETECTION_MUTABLE_STATES.includes(transfer.state)) {
    return fail('transfer_not_mutable', `Cross-chain transfer is already in non-detectable state "${transfer.state}"`, false);
  }
  if (transfer && transfer.source_tx_hash && transfer.source_tx_hash.toLowerCase() !== txHash) {
    return fail(
      'burn_already_recorded',
      `This intent already recorded source tx ${transfer.source_tx_hash}; refusing to attach a second burn (${txHash})`,
      false,
    );
  }
  const transferId = transfer?.id ?? generateId('cct');
  const createdNewTransfer = !transfer;

  // ── Read the SOURCE receipt (registry-pinned RPC, chain id proven first) ─
  const factory = input.providerFactory ?? defaultProviderFactory;
  let provider: SourceBurnProvider;
  try {
    provider = await factory(sourceSlug);
    // ArcProvider does this internally before every read; called explicitly so
    // an injected provider that has not done it cannot slip past.
    await provider.ensureChainIdMatches?.();
  } catch (err) {
    return fail('provider_error', `Source provider unavailable for "${sourceSlug}": ${err instanceof Error ? err.message : String(err)}`, true);
  }

  let receipt: TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return fail('provider_error', `Source receipt read failed on "${sourceSlug}": ${err instanceof Error ? err.message : String(err)}`, true);
  }
  if (!receipt) {
    return fail('receipt_missing', 'Source transaction not found on the source network yet', true);
  }
  if (receipt.status !== 'success') {
    return fail('receipt_reverted', 'Source transaction reverted', false);
  }
  // The burn tx must have CALLED the registry-pinned TokenMessenger.
  if (receipt.to.toLowerCase() !== expectedTokenMessenger) {
    return fail(
      'not_token_messenger_call',
      `Transaction was sent to ${receipt.to}, not the CCTP TokenMessenger ${expectedTokenMessenger} pinned for "${sourceSlug}"`,
      false,
    );
  }

  // ── DepositForBurn: emitted BY the pinned TokenMessenger ────────────────
  const burnLogs = receipt.logs
    .filter((log) => log.address.toLowerCase() === expectedTokenMessenger)
    .map((log) => ({ log, args: decodeDepositForBurn(log) }))
    .filter((entry): entry is { log: BurnLog; args: DepositForBurnArgs } => entry.args !== null);

  if (burnLogs.length === 0) {
    return fail('burn_event_missing', 'No DepositForBurn event from the pinned TokenMessenger in this transaction', false);
  }
  // Two burns in one tx is legitimate CCTP usage, but ambiguous for ONE intent:
  // refuse rather than guess which burn the customer meant for this payment.
  if (burnLogs.length > 1) {
    return fail('burn_event_ambiguous', `Transaction contains ${burnLogs.length} DepositForBurn events; one payment intent must be paid with exactly one burn`, false);
  }
  const burn = burnLogs[0]!.args;

  // ── Bind the burn to THIS intent (the anti-redirect checks) ─────────────
  if (burn.destinationDomain !== ARC_CCTP_DOMAIN) {
    return fail('wrong_destination_domain', `Burn destination domain ${burn.destinationDomain} is not Arc (${ARC_CCTP_DOMAIN})`, false);
  }
  if (burn.mintRecipient !== expectedMintRecipient) {
    return fail('wrong_mint_recipient', `Burn mints to ${burn.mintRecipient}, not this merchant's pinned Arc wallet ${expectedMintRecipient}`, false);
  }
  if (burn.burnToken !== expectedBurnToken) {
    return fail('wrong_burn_token', `Burn token ${burn.burnToken} is not the USDC contract pinned for "${sourceSlug}" (${expectedBurnToken})`, false);
  }
  if (burn.depositor !== receipt.from.toLowerCase()) {
    return fail('wrong_depositor', 'DepositForBurn depositor does not match the transaction sender', false);
  }
  if (burn.amount !== expectedBurnAmount) {
    return fail('amount_mismatch', `Burned ${burn.amount.toString()} base units; this intent requires exactly ${expectedBurnAmount.toString()} (settlement ${settlementAmount.toString()} + approved Forwarding fee ${approvedFee.toString()})`, false);
  }
  // STEP 4B — the burn's maxFee must equal the SERVER-approved fee, not merely
  // agree with the message. This is what stops an attacker who self-reports any
  // (even self-consistent) fee: only the intent-pinned F is honoured.
  if (burn.maxFee !== approvedFee) {
    return fail('amount_mismatch', `DepositForBurn maxFee ${burn.maxFee.toString()} is not the server-approved Forwarding fee ${approvedFee.toString()}`, false);
  }

  // ── MessageSent: the exact bytes Circle attests ─────────────────────────
  const messageLogs = receipt.logs
    .map((log) => ({ log, message: decodeMessageSent(log) }))
    .filter((entry): entry is { log: BurnLog; message: Uint8Array } => entry.message !== null);
  if (messageLogs.length === 0) {
    return fail('message_event_missing', 'No MessageSent event in this transaction — nothing for Circle to attest', true);
  }
  if (messageLogs.length > 1) {
    return fail('burn_event_ambiguous', `Transaction contains ${messageLogs.length} MessageSent events; one intent must map to exactly one burn message`, false);
  }
  const messageBytes = messageLogs[0]!.message;
  // The message must come from the MessageTransmitter the TokenMessenger
  // delegates to — the same cross-chain-constant address on this chain.
  if (messageLogs[0]!.log.address.toLowerCase() !== expectedTransmitter) {
    return fail(
      'wrong_contract',
      `MessageSent was emitted by ${messageLogs[0]!.log.address}, not the pinned MessageTransmitter ${expectedTransmitter}`,
      false,
    );
  }

  let parsed: ParsedCctpMessage;
  try {
    parsed = parseCctpMessage(messageBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CctpMessageParseError && message.includes('version')) {
      return fail('message_version_unsupported', message, false);
    }
    return fail('message_too_short', message, false);
  }

  // ── Cross-check message payload against event args AND the intent ───────
  const mismatch = (field: string, got: string, want: string): SourceBurnFailure =>
    fail('message_mismatch', `CCTP message ${field} is ${got} but expected ${want} — event and message disagree`, false);
  if (parsed.sourceDomain !== sourceDomain) return mismatch('sourceDomain', String(parsed.sourceDomain), String(sourceDomain));
  if (parsed.destinationDomain !== ARC_CCTP_DOMAIN) return mismatch('destinationDomain', String(parsed.destinationDomain), String(ARC_CCTP_DOMAIN));
  // The deployed V2 DepositForBurn event carries NO nonce, so there is no
  // event-vs-message nonce to cross-check. Message uniqueness (and therefore
  // replay protection) is still fully enforced: keccak256(message) is persisted
  // as burn_message_hash / cctp_message_id under UNIQUE() constraints, and the
  // message nonce is part of those bytes. All other event<->message cross-checks
  // below are unchanged.
  if (!sameBytes32(parsed.mintRecipient, expectedMintRecipient)) return mismatch('mintRecipient', parsed.mintRecipient, expectedMintRecipient);
  const burnTokenB32 = asBytes32Address(sourceCfg.usdcAddress);
  if (!burnTokenB32 || !sameBytes32(parsed.burnToken, burnTokenB32)) return mismatch('burnToken', parsed.burnToken, String(burnTokenB32));
  if (parsed.amount !== expectedBurnAmount) return mismatch('amount', parsed.amount.toString(), expectedBurnAmount.toString());
  const depositorB32 = asBytes32Address(receipt.from);
  if (!depositorB32 || !sameBytes32(parsed.messageSender, depositorB32)) return mismatch('messageSender', parsed.messageSender, String(depositorB32));
  if (parsed.minFinalityThreshold !== burn.minFinalityThreshold) return mismatch('minFinalityThreshold', String(parsed.minFinalityThreshold), String(burn.minFinalityThreshold));
  if (parsed.maxFee !== burn.maxFee) return mismatch('maxFee', parsed.maxFee.toString(), burn.maxFee.toString());
  // STEP 4B — the message maxFee is bound to the SERVER-approved fee too, so
  // event maxFee == message maxFee == payment_intents.forwarding_max_fee_base_units.
  if (parsed.maxFee !== approvedFee) return mismatch('maxFee', parsed.maxFee.toString(), approvedFee.toString());

  const cctpMessageHex = toHex(messageBytes);
  const burnMessageHash = keccak256(messageBytes);

  // If a journey already exists, what we just re-derived must match what was
  // stored — never silently overwrite an existing burn binding.
  if (transfer) {
    if (transfer.burn_message_hash && !sameBytes32(transfer.burn_message_hash, burnMessageHash)) {
      return fail('message_mismatch', 'Recorded burn_message_hash does not match the re-derived message', false);
    }
    if (transfer.token_messenger.toLowerCase() !== expectedTokenMessenger) {
      return fail('wrong_contract', 'Recorded transfer token_messenger does not match the registry-pinned TokenMessenger', false);
    }
    if (transfer.amount_base_units !== settlementAmount.toString()) {
      return fail('amount_mismatch', 'Recorded transfer amount does not match the intent settlement amount', false);
    }
  }

  // ── Source finality (PHASE 6 gate). Recorded — never a credit. ──────────
  let finality: FinalityVerdict;
  try {
    finality = await evaluateSourceFinality(provider, receipt.blockNumber);
  } catch (err) {
    return fail('provider_error', `Source finality cannot be proven for "${sourceSlug}": ${err instanceof Error ? err.message : String(err)}`, true);
  }

  const now = Math.floor(Date.now() / 1000);
  const nextState = pickForwardState(transfer?.state, finality.final ? 'source_finalized' : 'source_finalizing');

  const destSlug = (pi.settlement_network ?? '') as string;
  let destChainId: number;
  try {
    destChainId = pi.settlement_chain_id ?? getNetworkConfig(destSlug).chainId;
  } catch (err) {
    return fail('source_not_registered', `Arc destination "${destSlug}" registry invalid: ${err instanceof Error ? err.message : String(err)}`, false);
  }

  db.transaction(() => {
    if (createdNewTransfer) {
      db.prepare(
        `INSERT INTO cross_chain_transfers(
           id,payment_intent_id,source_network,source_chain_id,source_usdc_address,token_messenger,
           source_tx_hash,source_block_number,source_finalized_at,burn_message_hash,cctp_message_id,
           cctp_message,destination_network,destination_chain_id,mint_recipient,amount_base_units,state,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        transferId, pi.id, sourceSlug, sourceCfg.chainId, expectedBurnToken, expectedTokenMessenger,
        txHash, Number(receipt.blockNumber), finality.final ? now : null, burnMessageHash, burnMessageHash,
        cctpMessageHex, destSlug, destChainId, pi.settlement_address, settlementAmount.toString(), nextState, now, now,
      );
    } else {
      db.prepare(
        `UPDATE cross_chain_transfers
            SET source_tx_hash=?, source_block_number=?, burn_message_hash=?, cctp_message_id=?,
                cctp_message=COALESCE(cctp_message, ?),
                state=?, updated_at=?, source_finalized_at=COALESCE(source_finalized_at, ?)
          WHERE id=?`,
      ).run(
        txHash, Number(receipt.blockNumber), burnMessageHash, burnMessageHash,
        cctpMessageHex, nextState, now, finality.final ? now : null, transferId,
      );
    }
    // In flight — this path NEVER writes 'succeeded'.
    if (pi.status === 'requires_payment') {
      db.prepare("UPDATE payment_intents SET status='processing',updated_at=unixepoch() WHERE id=? AND status='requires_payment'").run(pi.id);
    }
    db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,to_status,data) VALUES(?,?,?,?,?)').run(
      generateId('pe'), pi.id, 'payment.cross_chain.source_burn_detected', pi.status,
      JSON.stringify({
        transfer_id: transferId, source_tx_hash: txHash, source_network: sourceSlug,
        burn_message_hash: burnMessageHash, cctp_message_id: burnMessageHash,
        amount_base_units: settlementAmount.toString(), mint_recipient: expectedMintRecipient,
        destination_domain: ARC_CCTP_DOMAIN, source_finalized: finality.final,
        finality_detail: finality.detail, state: nextState,
      }),
    );
  })();

  return {
    ok: true,
    transferId,
    paymentIntentId: pi.id,
    sourceTxHash: txHash,
    sourceNetwork: sourceSlug,
    sourceBlockNumber: Number(receipt.blockNumber),
    cctpNonce: BigInt(parsed.nonce).toString(),
    burnAmountBaseUnits: burn.amount.toString(),
    mintRecipientBytes32: burn.mintRecipient,
    destinationDomain: burn.destinationDomain,
    burnMessageHash,
    cctpMessageId: burnMessageHash,
    cctpMessage: cctpMessageHex,
    depositor: burn.depositor,
    maxFee: burn.maxFee.toString(),
    minFinalityThreshold: burn.minFinalityThreshold,
    finalityThresholdExecuted: parsed.finalityThresholdExecuted,
    sourceFinalized: finality.final,
    state: nextState,
    createdNewTransfer,
  };
}
