/**
 * JafariPay — CCTP CROSS-CHAIN STATE MACHINE (MASTER PHASE 9)
 *
 * The single authoritative definition of the cross-chain journey's lifecycle:
 * the 13 states (byte-for-byte the `cross_chain_transfers.state` CHECK in the
 * schema), the ONLY legal transitions between them, and a race-safe router the
 * worker (PHASE 11) uses to advance a transfer.
 *
 * WHY A SEPARATE MODULE (and why it never touches money):
 *   PHASE 5/6/7/8 each already forward-guard the states THEY own. PHASE 9 does
 *   not rewrite those paths — it centralizes the WHOLE graph so no future caller
 *   can invent an illegal edge (e.g. credit a 'settled' from 'source_finalizing',
 *   resurrect a terminal transfer, or move BACKWARD after a reorg). This is the
 *   contract the reconciliation worker drives against.
 *
 * HARD RULES ENCODED HERE:
 *   • Monotonic happy path: source_payment_submitted → source_finalizing →
 *     source_finalized → (attestation_pending) → attested → destination_pending →
 *     destination_submitted → destination_confirmed → settled. The attestation
 *     poll may land the attestation straight from source_finalized, and a
 *     settle may confirm from any post-attestation state, so those shortcuts are
 *     legal — but NEVER a backward or terminal-reviving move.
 *   • Self-loops for the poll/retry states (attestation_pending, destination_*)
 *     so a worker tick that re-observes the same phase is idempotent.
 *   • Terminal states (settled, attestation_timeout, destination_failed,
 *     source_reorg, verification_failed) have NO outgoing edges — a parked
 *     journey is never silently resumed; a re-detected burn is a NEW transfer.
 *   • 'settled' appears as a legal GRAPH edge (it is the real PHASE 8 outcome),
 *     but is NOT reachable through this ROUTER: crediting is the atomic PHASE 8
 *     responsibility (verifyDestinationMint + ledger write in one transaction).
 *     advanceTransferState therefore refuses any target of 'settled' — a generic
 *     state advance can never stamp a payout without a mint.
 */

import { getDb } from '../db/schema.js';

// ── The canonical state set (MUST equal the schema CHECK list exactly) ──────
export const CCTP_STATES = [
  'source_payment_submitted',
  'source_finalizing',
  'source_finalized',
  'attestation_pending',
  'attested',
  'destination_pending',
  'destination_submitted',
  'destination_confirmed',
  'settled',
  'attestation_timeout',
  'destination_failed',
  'source_reorg',
  'verification_failed',
] as const;

export type CctpState = (typeof CCTP_STATES)[number];

const IS_STATE: ReadonlySet<string> = new Set<string>(CCTP_STATES);

export const INITIAL_CCTP_STATE: CctpState = 'source_payment_submitted';

/** States from which no further transition is ever allowed. */
export const TERMINAL_STATES: ReadonlySet<CctpState> = new Set<CctpState>([
  'settled', 'attestation_timeout', 'destination_failed', 'source_reorg', 'verification_failed',
]);

/**
 * The ONLY legal edges. Every value is a CctpState; the keys cover all 13 so a
 * typo in a state name is a compile error, not a silently-missing edge.
 */
export const CCTP_TRANSITIONS: Readonly<Record<CctpState, readonly CctpState[]>> = Object.freeze({
  source_payment_submitted: ['source_finalizing', 'source_reorg'],
  source_finalizing: ['source_finalizing', 'source_finalized', 'source_reorg'],
  // A first-try attestation lands 'attested' straight from the finalized state;
  // a hard verification failure during that poll parks it as verification_failed.
  source_finalized: ['attestation_pending', 'attested', 'verification_failed'],
  attestation_pending: ['attestation_pending', 'attested', 'attestation_timeout', 'verification_failed'],
  // settleDestination confirms from any post-attestation state; it never sits in
  // 'attested' forever, so attested → destination_pending AND the direct
  // operational edges are legal. 'settled' is a legal GRAPH edge (the PHASE 8
  // outcome) but the ROUTER blocks it — see advanceTransferState below. An
  // attested leg whose destination mint never lands parks as destination_failed
  // (used by the PHASE 11 destination-timeout sweep).
  attested: ['destination_pending', 'settled', 'destination_failed', 'verification_failed'],
  destination_pending: ['destination_pending', 'destination_submitted', 'settled', 'destination_failed'],
  destination_submitted: ['destination_submitted', 'destination_confirmed', 'settled', 'destination_failed'],
  destination_confirmed: ['settled', 'destination_failed'],
  settled: [],
  attestation_timeout: [],
  destination_failed: [],
  source_reorg: [],
  verification_failed: [],
});

/** True iff `from → to` is a legal edge in the canonical graph. */
export function canTransition(from: string, to: string): boolean {
  if (!IS_STATE.has(from) || !IS_STATE.has(to)) return false;
  return (CCTP_TRANSITIONS[from as CctpState] as readonly string[]).includes(to);
}

/** The legal next states from `from` (empty for terminal/unknown states). */
export function legalNextStates(from: string): readonly CctpState[] {
  return IS_STATE.has(from) ? CCTP_TRANSITIONS[from as CctpState] : [];
}

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state as CctpState);
}

// ── Router result ───────────────────────────────────────────────────────────
export type AdvanceFailureCode =
  | 'transfer_not_found'
  | 'unknown_state'
  | 'illegal_transition'
  | 'settled_requires_credit_path'
  | 'concurrent_modification';

export interface AdvanceSuccess {
  ok: true;
  from: CctpState;
  to: CctpState;
  transferId: string;
}
export interface AdvanceFailure {
  ok: false;
  code: AdvanceFailureCode;
  reason: string;
}
export type AdvanceResult = AdvanceSuccess | AdvanceFailure;

/**
 * Atomically advance ONE transfer along a legal edge. Race-safe: the UPDATE's
 * WHERE clause pins the FROM state, so a concurrent advance that already moved
 * the row makes this a no-op reported as `concurrent_modification` (never a
 * blind overwrite). `settled` is deliberately unreachable here — see the module
 * header; crediting is PHASE 8's atomic job.
 */
export function advanceTransferState(
  transferId: string,
  to: string,
  opts?: { nowSeconds?: number; reason?: string | null },
): AdvanceResult {
  const db = getDb();

  if (!IS_STATE.has(to)) return { ok: false, code: 'unknown_state', reason: `target "${to}" is not a CCTP state` };
  if (to === 'settled') {
    return { ok: false, code: 'settled_requires_credit_path', reason: "'settled' is written only by the atomic PHASE 8 credit path (settleDestination), never by a generic state advance" };
  }

  const row = db.prepare('SELECT state FROM cross_chain_transfers WHERE id=?').get(transferId) as { state: string } | undefined;
  if (!row) return { ok: false, code: 'transfer_not_found', reason: `cross_chain_transfers "${transferId}" not found` };
  const from = row.state;
  if (!IS_STATE.has(from)) return { ok: false, code: 'unknown_state', reason: `stored state "${from}" is not a CCTP state` };
  if (!canTransition(from, to)) {
    return { ok: false, code: 'illegal_transition', reason: `illegal transition ${from} → ${to}` };
  }

  const now = Math.floor(opts?.nowSeconds ?? Date.now() / 1000);
  // Record the reason on a failure/park transition; leave failure_reason intact
  // for ordinary forward moves (a null reason must never erase a prior cause).
  const res = opts?.reason !== undefined
    ? db.prepare('UPDATE cross_chain_transfers SET state=?, updated_at=?, failure_reason=? WHERE id=? AND state=?')
        .run(to, now, opts.reason, transferId, from)
    : db.prepare('UPDATE cross_chain_transfers SET state=?, updated_at=? WHERE id=? AND state=?')
        .run(to, now, transferId, from);

  if (res.changes === 0) {
    return { ok: false, code: 'concurrent_modification', reason: `transfer moved off "${from}" before this advance landed` };
  }
  return { ok: true, from: from as CctpState, to: to as CctpState, transferId };
}
