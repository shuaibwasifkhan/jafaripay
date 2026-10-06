/**
 * JafariPay — CIRCLE CCTP ATTESTATION SERVICE (MASTER PHASE 7)
 *
 * Retrieves the signature Circle's Iris service issues for a customer's source
 * burn, VERIFIES it cryptographically against the burn we already recorded in
 * PHASE 5, and stores it so the destination claim (PHASE 8) can be made later.
 *
 * ── What PHASE 7 does and does NOT do ─────────────────────────────────────
 *   DOES: poll the permissionless Circle attestation API for a finalized source
 *     burn, respect its rate limit with exponential back-off that survives a
 *     process restart, cross-check the returned message bytes, and record the
 *     attestation on `cross_chain_transfers`.
 *   DOES NOT: credit the merchant, mint anything, or move `payment_intents` off
 *     'processing'. An attestation is only PROOF that Circle observed and signed
 *     the burn — the money only exists on Arc after PHASE 8 verifies a real
 *     destination mint Transfer into the merchant's pinned Arc wallet.
 *
 * ── Isolation / idempotency / safety invariants ──────────────────────────
 *   1. A transfer whose attestation_status is already 'complete' is a NO-OP:
 *      the API is never re-hit for a burn we already attested (also avoids
 *      Circle's per-transaction double-polling rate hazard).
 *   2. Polling is GATED on our OWN source-finality (PHASE 6): we only ask
 *      Circle once `state` is 'source_finalized'/'attestation_pending' and
 *      `source_finalized_at` is set. An unfinalized burn is never attested.
 *   3. Rate-limit back-off lives in the DB (attestation_attempts,
 *      next_attestation_attempt_at) — a worker restart cannot hammer Circle.
 *   4. The returned message is NEVER trusted: we re-parse its RAW bytes with
 *      our own pinned wire layout and require keccak256(message) to equal the
 *      cctp_message_id recorded from the on-chain MessageSent event, plus an
 *      EXACT match on source/destination domain, mint recipient (the merchant's
 *      one pinned Arc wallet) and amount. A mismatch is a HARD verification
 *      failure (state 'verification_failed'), never a silent accept.
 *   5. Non-secret operator detail only. The signature/message are money-critical
 *      payloads stored in their dedicated columns; `attestation_error` NEVER
 *      contains an API key (this API needs none) or any secret.
 *
 * ── Authoritative API contract (verified, not guessed) ───────────────────
 *   Circle "Resolve attestation issues"
 *   https://developers.circle.com/cctp/howtos/resolve-stuck-attestation
 *   GET {base}/v2/messages/{sourceDomain}?transactionHash={full 0x hash}
 *     base = https://iris-api.circle.com (mainnet) |
 *            https://iris-api-sandbox.circle.com (testnet)
 *   • Permissionless — NO API key.
 *   • HTTP 404               = not yet observed            -> keep polling
 *   • { messages: [] }       = found but unprocessed        -> keep polling
 *   • { status: "pending" }  = awaiting confirmations       -> keep polling
 *   • { messages: [ { status:"complete", message, attestation, decodedMessage } ] }
 *                            = attestation ready           -> verify + store
 *   • HTTP 429               = rate limited (35/s, 5-min block) -> back off
 *   Guidance: >=5s interval, exponential back-off on 429, never poll one tx from
 *   several clients. Poll cadence and terminal timeout are policy below.
 */

import { fromHex, keccak256, type Hex } from 'viem';
import { getDb } from '../db/schema.js';
import { generateId } from '../lib/ids.js';
import { emitCrossChainLifecycleWebhook } from '../webhooks/delivery.js';
import { CctpMessageParseError, parseCctpMessage, type ParsedCctpMessage } from './cctp-source.js';
import {
  ARC_CCTP_DOMAIN,
  CCTP_FINALITY_THRESHOLD_FINALIZED,
  CCTP_REGISTRY,
  addressToBytes32,
  cctpDomainOf,
  isCctpDestination,
  isCctpSource,
} from '../db/cctp.js';

// ── Endpoint policy (verified constants) ───────────────────────────────────
export const IRIS_PRODUCTION_BASE = 'https://iris-api.circle.com'; // arc-studio-allow-onchain-literal — Circle production Iris
export const IRIS_SANDBOX_BASE = 'https://iris-api-sandbox.circle.com'; // arc-studio-allow-onchain-literal — Circle sandbox Iris (testnet)

/** Circle Iris base URL for a route's environment class (testnet vs mainnet). */
export function irisBaseUrl(isTestnet: boolean): string {
  return isTestnet ? IRIS_SANDBOX_BASE : IRIS_PRODUCTION_BASE;
}

/**
 * The exact GET URL for one burn. The tx hash MUST carry its 0x prefix for EVM
 * (per the Circle guide) — a bare hash 404s forever, so we validate the shape.
 */
export function attestationLookupUrl(opts: {
  isTestnet: boolean;
  sourceDomain: number;
  sourceTxHash: string;
}): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(opts.sourceTxHash)) {
    throw new Error(`attestationLookupUrl: source tx hash must be a full 0x-prefixed 32-byte hash: ${opts.sourceTxHash}`);
  }
  return `${irisBaseUrl(opts.isTestnet)}/v2/messages/${opts.sourceDomain}?transactionHash=${opts.sourceTxHash}`;
}

// ── Polling policy (all in seconds; back-off + terminal timeout) ────────────
const POLL_BASE_BACKOFF_S = 5;      // Circle minimum recommended interval
const POLL_MAX_BACKOFF_S = 300;     // Circle 429 block is ~5 min — cap there
const RATE_LIMIT_BACKOFF_S = 300;   // a 429 means back off the full window
const MAX_ATTESTATION_WINDOW_S = 1800; // 30 min after source finality to give up

/** The minimal fetch surface this module needs, so tests inject a fake. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
}>;

// ── Pure poll result ────────────────────────────────────────────────────────
export type PollOutcome =
  | {
      kind: 'attested';
      message: Hex;
      attestation: Hex;
      decodedMessage?: unknown;
      /**
       * STEP 5F — present for a CIRCLE FORWARDING burn. This is the Arc destination
       * mint transaction that Circle's forwarder submitted (REF-1: polled from the
       * SAME `/v2/messages` endpoint, field `forwardTxHash`). A DIRECT burn never
       * carries it. JafariPay does NOT execute receiveMessage itself for forwarding;
       * this hash is the completion signal the existing settle sweep verifies.
       */
      forwardTxHash?: string;
    }
  | { kind: 'pending'; reason: 'not_observed' | 'unprocessed' | 'awaiting_confirmations' }
  | { kind: 'rate_limited' }
  | { kind: 'http_error'; status: number }
  | { kind: 'network_error'; detail: string };

/**
 * Read Circle's answer for one burn. PURE: no DB, no state, injectable fetch.
 * Never throws — every expected branch maps to a PollOutcome so callers decide
 * policy. A complete attestation is returned UNVERIFIED; verification (matching
 * it to our recorded burn) is the caller's money-safety responsibility.
 */
export async function pollCircleAttestation(opts: {
  isTestnet: boolean;
  sourceDomain: number;
  sourceTxHash: string;
  fetchImpl: FetchLike;
}): Promise<PollOutcome> {
  const url = attestationLookupUrl(opts);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await opts.fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    return { kind: 'network_error', detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 404) return { kind: 'pending', reason: 'not_observed' };
  if (res.status === 429) return { kind: 'rate_limited' };
  if (!res.ok) return { kind: 'http_error', status: res.status };

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    return { kind: 'network_error', detail: `malformed JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const obj = (data ?? {}) as { status?: string; messages?: unknown };
  const messages = Array.isArray(obj.messages) ? (obj.messages as Array<Record<string, unknown>>) : null;
  // { messages: [] } OR a bare { status: "pending" } (no array) → still waiting.
  if (!messages || messages.length === 0) {
    return { kind: 'pending', reason: obj.status === 'pending' ? 'awaiting_confirmations' : 'unprocessed' };
  }
  const first = messages[0] ?? {};
  if (
    first.status === 'complete'
    && typeof first.attestation === 'string' && first.attestation.length > 0
    && typeof first.message === 'string' && first.message.length > 0
  ) {
    return {
      kind: 'attested',
      message: first.message as Hex,
      attestation: first.attestation as Hex,
      decodedMessage: first.decodedMessage,
      // Circle's forwarding message exposes `forwardTxHash` (its Arc mint tx).
      // Absent for a direct burn → undefined, and the direct path is unchanged.
      forwardTxHash:
        typeof first.forwardTxHash === 'string' && first.forwardTxHash.length > 0
          ? first.forwardTxHash
          : undefined,
    };
  }
  return { kind: 'pending', reason: 'awaiting_confirmations' };
}

// ── Persisted transfer row (subset relevant here) ───────────────────────────
interface TransferRow {
  id: string;
  payment_intent_id: string;
  source_network: string;
  destination_network: string;
  source_tx_hash: string | null;
  source_finalized_at: number | null;
  cctp_message_id: string | null;
  cctp_message: string | null;
  mint_recipient: string;
  amount_base_units: string;
  attestation_status: string;
  attestation_attempts: number;
  next_attestation_attempt_at: number | null;
  state: string;
}

const SELECT_TRANSFER = `SELECT id,payment_intent_id,source_network,destination_network,source_tx_hash,
  source_finalized_at,cctp_message_id,cctp_message,mint_recipient,amount_base_units,
  attestation_status,attestation_attempts,next_attestation_attempt_at,state
  FROM cross_chain_transfers WHERE id=?`;

// States from which requesting/holding an attestation is meaningful.
const ATTESTABLE_STATES: ReadonlySet<string> = new Set(['source_finalized', 'attestation_pending']);
// States already past attestation — an attestation request is a no-op.
const POST_ATTESTATION_STATES: ReadonlySet<string> = new Set([
  'attested', 'destination_pending', 'destination_submitted', 'destination_confirmed', 'settled',
]);

export type AttestationFailureCode =
  | 'transfer_not_found'
  | 'not_cross_chain'
  | 'network_mismatch'
  | 'state_not_eligible'
  | 'source_not_finalized'
  | 'message_missing'
  | 'verification_failed';

export interface AttestationFailure {
  ok: false;
  code: AttestationFailureCode;
  reason: string;
  /** True when a later poll of the same transfer could still succeed. */
  retryable: boolean;
}

export interface AttestationSuccess {
  ok: true;
  transferId: string;
  paymentIntentId: string;
  /**
   * already_attested — idempotent no-op (attestation already stored complete).
   * not_due           — exponential back-off has not elapsed; nothing fetched.
   * pending           — queried Circle; not ready; scheduled for next poll.
   * timeout           — the attestation window elapsed with no signature.
   * attested          — verified signature stored; ready for PHASE 8.
   */
  outcome: 'already_attested' | 'not_due' | 'pending' | 'timeout' | 'attested';
  /** Persisted attestation_status after this call. */
  attestationStatus: string;
  /** Persisted state after this call. */
  state: string;
  /** Poll attempts recorded for this transfer. */
  attempts: number;
  /** Earliest next poll (unixepoch seconds), when still pending. */
  nextAttemptAt?: number;
  /**
   * STEP 5F — the Circle Forwarding destination mint tx recorded on this transfer
   * during this call (also persisted as `destination_tx_hash`). Present ONLY when
   * the attested message carried a `forwardTxHash`; a direct burn leaves it unset.
   */
  forwardTxHash?: string;
  /** Only for outcome 'pending'/'timeout'/'rate-limit' insight. Never a secret. */
  detail?: string;
}

export type AttestationResult = AttestationSuccess | AttestationFailure;

const fail = (code: AttestationFailureCode, reason: string, retryable: boolean): AttestationFailure =>
  ({ ok: false, code, reason, retryable });

/** Exponential back-off with a hard cap; a 429 immediately jumps to the cap. */
export function nextAttemptDelaySeconds(attemptsAfterThisPoll: number, rateLimited: boolean): number {
  if (rateLimited) return RATE_LIMIT_BACKOFF_S;
  const exp = Math.min(attemptsAfterThisPoll, 8);
  const delay = POLL_BASE_BACKOFF_S * Math.pow(2, exp);
  return Math.max(POLL_BASE_BACKOFF_S, Math.min(delay, POLL_MAX_BACKOFF_S));
}

/**
 * Drive ONE attestation step for one transfer: idempotently decide whether to
 * poll Circle, poll under the injected fetch, verify the answer against the
 * recorded burn, and persist progress. This is a single tick — the reconcile
 * worker (PHASE 11) calls it repeatedly; it never loops or sleeps internally, so
 * it is fully testable and re-entrant.
 */
export async function requestAttestation(input: {
  transferId: string;
  fetchImpl: FetchLike;
  /** Injectable clock (unixepoch seconds) for deterministic back-off/timeout. */
  nowSeconds?: number;
}): Promise<AttestationResult> {
  const db = getDb();
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  const row = db.prepare(SELECT_TRANSFER).get(input.transferId) as TransferRow | undefined;
  if (!row) return fail('transfer_not_found', `cross_chain_transfers row "${input.transferId}" not found`, false);

  // Idempotency: never re-hit Circle for an already-attested journey.
  if (row.attestation_status === 'complete' || POST_ATTESTATION_STATES.has(row.state)) {
    return {
      ok: true, transferId: row.id, paymentIntentId: row.payment_intent_id,
      outcome: 'already_attested', attestationStatus: row.attestation_status,
      state: row.state, attempts: row.attestation_attempts,
    };
  }

  // Must be a genuine cross-chain journey (source registered + Arc destination).
  if (!isCctpSource(row.source_network) || !isCctpDestination(row.destination_network)) {
    return fail('not_cross_chain', `"${row.source_network}" → "${row.destination_network}" is not a registered CCTP route`, false);
  }
  const sourceDomain = cctpDomainOf(row.source_network);
  if (sourceDomain === null) {
    return fail('network_mismatch', `source "${row.source_network}" has no CCTP domain`, false);
  }

  // Environment class: the sandbox vs production Iris base is chosen purely from
  // the CCTP registry entry for the source slug — a mainnet burn is never looked
  // up on sandbox and vice versa (single source of truth, no slug special-casing).
  const isTestnet = CCTP_REGISTRY[row.source_network]?.isTestnet === true;

  // Only attest a burn whose SOURCE leg we've finalized ourselves (PHASE 6).
  if (!ATTESTABLE_STATES.has(row.state)) {
    return fail('state_not_eligible', `state "${row.state}" is not attestation-eligible`, row.state === 'source_payment_submitted' || row.state === 'source_finalizing');
  }
  if (row.source_finalized_at === null || row.source_finalized_at === undefined) {
    return fail('source_not_finalized', 'source_finalized_at is not set; refusing to attest an unfinalized burn', true);
  }

  // Back-off gate: do nothing until the scheduled next attempt (survives restart).
  if (row.next_attestation_attempt_at !== null && now < row.next_attestation_attempt_at) {
    return {
      ok: true, transferId: row.id, paymentIntentId: row.payment_intent_id,
      outcome: 'not_due', attestationStatus: row.attestation_status, state: row.state,
      attempts: row.attestation_attempts, nextAttemptAt: row.next_attestation_attempt_at,
    };
  }

  // Terminal window: if Circle has not attested this long after finality, stop.
  if (now - row.source_finalized_at > MAX_ATTESTATION_WINDOW_S) {
    db.transaction(() => {
      db.prepare(
        `UPDATE cross_chain_transfers SET attestation_status='timeout', state='attestation_timeout',
           failure_reason=?, next_attestation_attempt_at=NULL, updated_at=? WHERE id=?`,
      ).run('attestation window elapsed', now, row.id);
      db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,to_status,data) VALUES(?,?,?,?,?)').run(
        generateId('pe'), row.payment_intent_id, 'payment.cross_chain.attestation_timeout', 'processing',
        JSON.stringify({ transfer_id: row.id, source_tx_hash: row.source_tx_hash, window_seconds: MAX_ATTESTATION_WINDOW_S }),
      );
    })();
    // PHASE 12: terminal for this journey — Circle never attested within the
    // window. Surface the specific cause to the merchant (the intent is released
    // to payment.expired by the worker once this in-flight guard lifts).
    emitCrossChainLifecycleWebhook(row.payment_intent_id, 'payment.cross_chain.failed', {
      payment_intent_id: row.payment_intent_id,
      transfer_id: row.id,
      reason: 'attestation_timeout',
      detail: 'attestation window elapsed',
      source_network: row.source_network,
      source_tx_hash: row.source_tx_hash,
      amount_base_units: row.amount_base_units,
    });
    return {
      ok: true, transferId: row.id, paymentIntentId: row.payment_intent_id,
      outcome: 'timeout', attestationStatus: 'timeout', state: 'attestation_timeout',
      attempts: row.attestation_attempts, detail: 'attestation window elapsed',
    };
  }

  // We must have the raw message recorded (PHASE 5) to verify Circle's answer.
  if (!row.source_tx_hash || !row.cctp_message || !row.cctp_message_id) {
    return fail('message_missing', 'transfer has no recorded source tx / CCTP message to attest against', true);
  }

  const poll = await pollCircleAttestation({
    isTestnet, sourceDomain, sourceTxHash: row.source_tx_hash, fetchImpl: input.fetchImpl,
  });

  const attemptsAfter = row.attestation_attempts + 1;

  if (poll.kind === 'attested') {
    // ── Verify Circle's message against OUR recorded burn — never trust it. ──
    let circleBytes: Uint8Array;
    try {
      circleBytes = fromHex(poll.message, 'bytes');
    } catch (err) {
      return fail('verification_failed', `returned message is not valid hex: ${err instanceof Error ? err.message : String(err)}`, false);
    }

    // STEP 4B — the server-approved Forwarding fee F, read ONLY from the INTENT
    // (never from the message or the caller). F > 0 is the existing, authoritative
    // signal that this journey used Circle Forwarding; F == 0 is a DIRECT burn. No
    // second configuration flag is introduced — the intent already carries the truth.
    const intentFee = db
      .prepare('SELECT forwarding_max_fee_base_units FROM payment_intents WHERE id=?')
      .get(row.payment_intent_id) as { forwarding_max_fee_base_units: string | null } | undefined;
    const approvedFee = BigInt(intentFee?.forwarding_max_fee_base_units ?? '0');
    const isForwarding = approvedFee > 0n;

    if (!isForwarding) {
      // DIRECT / non-Forwarding — PRESERVE the existing strict behavior verbatim.
      // Circle's message is byte-identical to the on-chain MessageSent we recorded,
      // so it must hash to the recorded cctp_message_id. This gate is scoped to the
      // DIRECT path only, because a Forwarding burn is NOT byte-identical (below).
      const computedId = keccak256(circleBytes, 'hex');
      if (computedId.toLowerCase() !== row.cctp_message_id.toLowerCase()) {
        return hardFail(row, now, 'attestation message hash does not match the recorded burn');
      }
    }
    // STEP 5N-FIX — FORWARDING deliberately does NOT require
    // keccak256(Circle.message) === cctp_message_id. The SOURCE-chain MessageSent
    // representation carries `nonce`, `finalityThresholdExecuted` and `feeExecuted`
    // as ZERO, while Circle returns the EXECUTED message with exactly those three
    // fields populated (and signed). Requiring an identical hash false-rejects every
    // real Forwarding burn. Security is preserved WITHOUT weakening it: the semantic
    // invariants below are checked against the authoritative payment_intent + transfer
    // row, `feeExecuted === approvedFee` guarantees the merchant nets EXACTLY M, and
    // the returned message is BOUND to THIS transfer's recorded source MessageSent on
    // every field OTHER than the three Circle mutates at execution, so an arbitrary /
    // tampered / substituted Circle message from a different burn fails. Nothing here
    // is trusted from Circle; the transfer row (and its source tx) stays the anchor.
    let parsed;
    try {
      parsed = parseCctpMessage(circleBytes);
    } catch (err) {
      const detail = err instanceof CctpMessageParseError ? err.message : String(err);
      return hardFail(row, now, `attestation message failed layout parse: ${detail}`);
    }
    let recordedParsed: ParsedCctpMessage | null = null;
    if (isForwarding) {
      try {
        recordedParsed = parseCctpMessage(fromHex(row.cctp_message as Hex, 'bytes'));
      } catch (err) {
        const detail = err instanceof CctpMessageParseError ? err.message : String(err);
        return hardFail(row, now, `recorded source message failed layout parse: ${detail}`);
      }
    }
    const expectedRecipient = addressToBytes32(row.mint_recipient).toLowerCase();
    // The attested message.amount is the GROSS burn (settlement M + the server-approved
    // Forwarding fee F). DIRECT (F=0) reduces to the prior exact match against the
    // recorded settlement. The merchant target M (row.amount_base_units) is unchanged —
    // the fee inflates only the burn, never what the merchant is owed. The finality
    // >= 2000 gate below stays untouched.
    const settlementAmount = BigInt(row.amount_base_units);
    const mismatches: string[] = [];
    if (parsed.sourceDomain !== sourceDomain) mismatches.push(`sourceDomain ${parsed.sourceDomain}!=${sourceDomain}`);
    if (parsed.destinationDomain !== ARC_CCTP_DOMAIN) mismatches.push(`destinationDomain ${parsed.destinationDomain}!=${ARC_CCTP_DOMAIN}`);
    if (parsed.mintRecipient.toLowerCase() !== expectedRecipient) mismatches.push('mintRecipient mismatch');
    if (parsed.amount !== settlementAmount + approvedFee) mismatches.push(`amount ${parsed.amount}!=${(settlementAmount + approvedFee).toString()}`);
    if (parsed.maxFee !== approvedFee) mismatches.push(`maxFee ${parsed.maxFee}!=${approvedFee.toString()}`);
    if (parsed.finalityThresholdExecuted < CCTP_FINALITY_THRESHOLD_FINALIZED) {
      mismatches.push(`finalityThresholdExecuted ${parsed.finalityThresholdExecuted}<${CCTP_FINALITY_THRESHOLD_FINALIZED}`);
    }
    // FORWARDING money-safety: Circle deducts `feeExecuted` from the gross burn and
    // mints `amount - feeExecuted` on Arc. The merchant nets EXACTLY M only when
    // `feeExecuted === approvedFee`. Any other executed fee means Circle charged a
    // different amount than the server approved, which would break the exact-M
    // destination guarantee, so it fails closed here (never silently under/over-credited).
    if (isForwarding && parsed.feeExecuted !== approvedFee) {
      mismatches.push(`feeExecuted ${parsed.feeExecuted}!=${approvedFee.toString()}`);
    }
    // FORWARDING substitution guard: bind Circle's executed message to the source
    // MessageSent recorded for THIS transfer on every stable field. This also carries
    // the burn-token / expected-USDC context and message-structure/version bindings
    // that detectSourceBurn already validated on the recorded message.
    if (isForwarding && recordedParsed) {
      for (const m of forwardingStableFieldMismatches(parsed, recordedParsed)) mismatches.push(m);
    }
    if (mismatches.length > 0) {
      return hardFail(row, now, `attestation does not match recorded burn: ${mismatches.join('; ')}`);
    }

    // STEP 5F/5H — a forwarded burn's Circle message carries the Arc mint tx that
    // Circle's forwarder submitted (`forwardTxHash`). JafariPay NEVER calls
    // receiveMessage itself for a Forwarding transfer; recording Circle's tx as
    // destination_tx_hash lets the EXISTING worker settle sweep (settleDestination
    // → verifyDestinationMint) independently confirm the on-Arc mint of EXACTLY M
    // and credit M. A DIRECT burn has no forwardTxHash and is unchanged here.
    const forwardTx = poll.forwardTxHash && /^0x[0-9a-fA-F]{64}$/.test(poll.forwardTxHash)
      ? poll.forwardTxHash
      : null;
    db.transaction(() => {
      db.prepare(
        `UPDATE cross_chain_transfers SET attestation_status='complete', attestation=?, state='attested',
           attestation_attempts=?, next_attestation_attempt_at=NULL, attestation_error=NULL, updated_at=?
         WHERE id=? AND attestation_status<>'complete'`,
      ).run(poll.attestation, attemptsAfter, now, row.id);
      if (forwardTx) {
        // Idempotent: only fill it if not already recorded (never overwrite a prior
        // observation). A cross-journey collision trips the UNIQUE index and rolls
        // the whole transaction back — a replay is fail-closed, never a double credit.
        db.prepare(
          `UPDATE cross_chain_transfers SET destination_tx_hash=?, updated_at=? WHERE id=? AND destination_tx_hash IS NULL`,
        ).run(forwardTx, now, row.id);
      }
      db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,to_status,data) VALUES(?,?,?,?,?)').run(
        generateId('pe'), row.payment_intent_id, 'payment.cross_chain.attestation_received', 'processing',
        JSON.stringify({ transfer_id: row.id, cctp_message_id: row.cctp_message_id, destination_domain: ARC_CCTP_DOMAIN, ...(forwardTx ? { forward_tx_hash: forwardTx } : {}) }),
      );
    })();
    // PHASE 12: notify the merchant that the source leg is confirmed and Circle
    // has attested — settlement on Arc is now pending. Enqueued only after the
    // commit, so a rolled-back attestation can never emit a phantom webhook.
    emitCrossChainLifecycleWebhook(row.payment_intent_id, 'payment.cross_chain.attestation_received', {
      payment_intent_id: row.payment_intent_id,
      transfer_id: row.id,
      source_network: row.source_network,
      source_tx_hash: row.source_tx_hash,
      cctp_message_id: row.cctp_message_id,
      amount_base_units: row.amount_base_units,
      mint_recipient: row.mint_recipient,
      destination_network: row.destination_network,
    });
    return {
      ok: true, transferId: row.id, paymentIntentId: row.payment_intent_id,
      outcome: 'attested', attestationStatus: 'complete', state: 'attested', attempts: attemptsAfter,
      forwardTxHash: forwardTx ?? undefined,
    };
  }

  // pending / rate_limited / http_error / network_error → schedule next poll.
  const rateLimited = poll.kind === 'rate_limited';
  const delay = nextAttemptDelaySeconds(attemptsAfter, rateLimited);
  const nextAt = now + delay;
  const detail =
    poll.kind === 'pending' ? `pending:${poll.reason}`
      : poll.kind === 'rate_limited' ? 'rate_limited'
        : poll.kind === 'http_error' ? `http_error:${poll.status}`
          : `network_error:${poll.detail}`;
  const errText = poll.kind === 'http_error' || poll.kind === 'network_error' ? detail : null;

  db.transaction(() => {
    db.prepare(
      `UPDATE cross_chain_transfers SET attestation_status='pending', state='attestation_pending',
         attestation_attempts=?, next_attestation_attempt_at=?, attestation_error=?, updated_at=?
       WHERE id=? AND attestation_status<>'complete'`,
    ).run(attemptsAfter, nextAt, errText, now, row.id);
  })();

  return {
    ok: true, transferId: row.id, paymentIntentId: row.payment_intent_id,
    outcome: 'pending', attestationStatus: 'pending', state: 'attestation_pending',
    attempts: attemptsAfter, nextAttemptAt: nextAt, detail,
  };
}

/**
 * STEP 5N-FIX — the fields Circle legitimately MUTATES between the source-chain
 * MessageSent representation and the executed message it returns (and signs) for a
 * FORWARDING burn. Verified against the real testnet burn: `nonce`, `finalityThresholdExecuted`
 * and `feeExecuted` are ZERO on the source event and populated in Circle's executed
 * message. Everything else is byte-identical and forms the substitution-binding set.
 */
const FORWARDING_MUTABLE_FIELDS: readonly string[] = ['nonce', 'finalityThresholdExecuted', 'feeExecuted'];

/**
 * Bind Circle's executed Forwarding message to the source MessageSent recorded for the
 * SAME transfer, comparing every STABLE field (i.e. all fields EXCEPT the three in
 * `FORWARDING_MUTABLE_FIELDS`). Returns a human-readable mismatch list; empty means the
 * returned message is provably the same burn we detected from this transfer's source tx.
 * It never inspects the three Circle-mutated fields, so a real executed message passes
 * while an arbitrary / tampered / substituted message (different domains, recipient,
 * burn token, amount, maxFee, sender, structure, …) fails closed.
 */
function forwardingStableFieldMismatches(circle: ParsedCctpMessage, recorded: ParsedCctpMessage): string[] {
  void FORWARDING_MUTABLE_FIELDS; // documents the excluded set; comparison omits those three.
  const out: string[] = [];
  const num = (name: string, a: number, b: number): void => { if (a !== b) out.push(`stable ${name} ${a}!=${b}`); };
  const big = (name: string, a: bigint, b: bigint): void => { if (a !== b) out.push(`stable ${name} ${a}!=${b}`); };
  const hex = (name: string, a: string, b: string): void => { if (a.toLowerCase() !== b.toLowerCase()) out.push(`stable ${name} mismatch`); };
  num('version', circle.version, recorded.version);
  num('sourceDomain', circle.sourceDomain, recorded.sourceDomain);
  num('destinationDomain', circle.destinationDomain, recorded.destinationDomain);
  hex('sender', circle.sender, recorded.sender);
  hex('recipient', circle.recipient, recorded.recipient);
  hex('destinationCaller', circle.destinationCaller, recorded.destinationCaller);
  num('minFinalityThreshold', circle.minFinalityThreshold, recorded.minFinalityThreshold);
  num('bodyVersion', circle.bodyVersion, recorded.bodyVersion);
  hex('burnToken', circle.burnToken, recorded.burnToken);
  hex('mintRecipient', circle.mintRecipient, recorded.mintRecipient);
  big('amount', circle.amount, recorded.amount);
  hex('messageSender', circle.messageSender, recorded.messageSender);
  big('maxFee', circle.maxFee, recorded.maxFee);
  big('expirationBlock', circle.expirationBlock, recorded.expirationBlock);
  return out;
}

/**
 * Record a HARD verification failure — Circle returned a signature whose message
 * does not match our recorded burn. This is never retried into a credit: the
 * transfer is parked in 'verification_failed' for operator review. No attestation
 * is stored (a mismatched signature must never reach receiveMessage).
 */
function hardFail(row: TransferRow, now: number, reason: string): AttestationFailure {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE cross_chain_transfers SET attestation_status='failed', state='verification_failed',
         failure_reason=?, attestation_error=?, next_attestation_attempt_at=NULL, updated_at=? WHERE id=?`,
    ).run(reason, reason, now, row.id);
    db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,to_status,data) VALUES(?,?,?,?,?)').run(
      generateId('pe'), row.payment_intent_id, 'payment.cross_chain.attestation_verification_failed', 'processing',
      JSON.stringify({ transfer_id: row.id, reason }),
    );
  })();
  // PHASE 12: a signature whose message does not match the recorded burn is a
  // security-critical terminal failure — notify the merchant with the reason.
  emitCrossChainLifecycleWebhook(row.payment_intent_id, 'payment.cross_chain.failed', {
    payment_intent_id: row.payment_intent_id,
    transfer_id: row.id,
    reason: 'attestation_verification_failed',
    detail: reason,
    source_network: row.source_network,
    source_tx_hash: row.source_tx_hash,
    amount_base_units: row.amount_base_units,
  });
  return fail('verification_failed', reason, false);
}
