/**
 * JafariPay — CCTP CROSS-CHAIN STATUS PROJECTION (MASTER PHASE 13)
 *
 * Turns one authoritative `cross_chain_transfers` row into a normalized,
 * READ-ONLY journey view for the merchant API, the public checkout status poll,
 * and the dashboard. It NEVER touches money or state — it is a pure function of
 * the already-persisted row, so it cannot move a transfer, credit a payment, or
 * contradict the PHASE 9 state machine. The single source of truth stays the
 * `state` column; this module only LABELS and PROJECTS it.
 *
 * Design rules (PHASE 13):
 *   • Additive only — existing endpoints keep their current shape; the journey is
 *     appended as an extra `cross_chain` field when (and only when) the intent is
 *     cross-chain and a transfer row exists. Same-chain payments are untouched.
 *   • No secret leakage — only public blockchain facts (tx hashes, networks, the
 *     pinned mint recipient which the intent already exposes as settlement_address)
 *     and lifecycle metadata are returned. `attestation` (the Circle signature)
 *     and internal back-off bookkeeping are deliberately NOT surfaced.
 *   • Terminality is derived from the PHASE 9 set, so the UI can never offer a
 *     "resume" on a parked journey.
 */

import { isTerminalState } from './cctp-state.js';
import { getDb } from '../db/schema.js';
import { describeCrossChainFees, describeForwardingFees, type CrossChainFeeBreakdown } from '../lib/fees.js';

/** A transfer row's subset of columns the projection consumes. */
export interface CrossChainTransferRow {
  id: string;
  payment_intent_id: string;
  source_network: string;
  source_chain_id: number;
  source_tx_hash: string | null;
  source_block_number: number | null;
  source_finalized_at: number | null;
  cctp_message_id: string | null;
  destination_network: string;
  destination_chain_id: number;
  destination_tx_hash: string | null;
  destination_block_number: number | null;
  mint_recipient: string;
  amount_base_units: string;
  fee_base_units: string;
  attestation_status: string;
  claim_status: string;
  state: string;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * PHASE 1 — project the fee breakdown for a STORED transfer row. An observed
 * fee > 0 is only possible on a FORWARDING route (DIRECT Standard burns carry
 * maxFee 0), where the fee is ADDITIVE: the customer burned M + F and the
 * merchant received exactly M. A zero/garbage fee keeps the Standard 1:1
 * description, identical to the pre-forwarding surface.
 */
export function projectStoredFees(amountBaseUnits: string, feeBaseUnits: string | null): CrossChainFeeBreakdown {
  let fee = 0n;
  try {
    const v = BigInt(feeBaseUnits ?? '0');
    fee = v > 0n ? v : 0n;
  } catch { fee = 0n; }
  return fee > 0n
    ? describeForwardingFees({ merchantAmountBaseUnits: amountBaseUnits, forwardingFeeBaseUnits: fee.toString() })
    : describeCrossChainFees({ amountBaseUnits, feeBaseUnits: '0' });
}

/** Coarse lifecycle bucket the UI keys its banner colour off. */
export type CrossChainStatus =
  | 'in_progress'
  | 'awaiting_attestation'
  | 'awaiting_settlement'
  | 'completed'
  | 'failed';

export interface CrossChainMilestone {
  key: string;
  label: string;
  done: boolean;
}

export interface CrossChainStatusView {
  transfer_id: string;
  payment_intent_id: string;
  /** Raw PHASE 9 state — never rewritten, just forwarded for advanced consumers. */
  state: string;
  status: CrossChainStatus;
  /** 0-based index into MILESTONES reached so far. */
  milestone_index: number;
  total_milestones: number;
  /** Ordered milestone timeline, each with a done flag for progress rendering. */
  milestones: CrossChainMilestone[];
  /** Human one-liner, e.g. "Settling on arc_testnet". */
  phase_label: string;
  is_terminal: boolean;
  is_succeeded: boolean;
  is_failed: boolean;
  is_in_progress: boolean;
  source_network: string;
  source_chain_id: number;
  source_tx_hash: string | null;
  source_finalized_at: number | null;
  destination_network: string;
  destination_chain_id: number;
  destination_tx_hash: string | null;
  mint_recipient: string;
  amount_base_units: string;
  fee_base_units: string;
  /** PHASE 14: transparent fee/net-amount breakdown of this transfer. */
  fees: CrossChainFeeBreakdown;
  attestation_status: string;
  claim_status: string;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

export const CROSS_CHAIN_MILESTONE_KEYS = [
  'source_submitted',
  'source_finalized',
  'attestation',
  'arc_settlement',
  'completed',
] as const;

const TOTAL = CROSS_CHAIN_MILESTONE_KEYS.length;

// state → { reached milestone index (exclusive of "completed" unless settled),
// coarse bucket, done-count for the timeline }. The done flags are computed from
// this single table so the timeline and the status can never disagree.
type Stage = { upTo: number; status: CrossChainStatus; label: string };
const STAGES: Record<string, Stage> = {
  source_payment_submitted: { upTo: 1, status: 'in_progress', label: 'Payment detected on {source}' },
  source_finalizing: { upTo: 1, status: 'in_progress', label: 'Confirming on {source}' },
  source_finalized: { upTo: 2, status: 'awaiting_attestation', label: 'Awaiting Circle attestation' },
  attestation_pending: { upTo: 2, status: 'awaiting_attestation', label: 'Awaiting Circle attestation' },
  attested: { upTo: 3, status: 'awaiting_settlement', label: 'Settling on {destination}' },
  destination_pending: { upTo: 3, status: 'awaiting_settlement', label: 'Settling on {destination}' },
  destination_submitted: { upTo: 3, status: 'awaiting_settlement', label: 'Minting on {destination}' },
  destination_confirmed: { upTo: 4, status: 'awaiting_settlement', label: 'Finalizing on {destination}' },
  settled: { upTo: 5, status: 'completed', label: 'Completed on {destination}' },
  // Failures keep the progress they actually reached, plus a failed overlay.
  attestation_timeout: { upTo: 2, status: 'failed', label: 'Circle attestation timed out' },
  verification_failed: { upTo: 2, status: 'failed', label: 'Attestation verification failed' },
  destination_failed: { upTo: 3, status: 'failed', label: 'Settlement on {destination} failed' },
  source_reorg: { upTo: 1, status: 'failed', label: 'Source transaction reorged' },
};

/**
 * Project a persisted transfer row into the read-only journey view. Pure and
 * total: an unknown/foreign `state` string still yields a safe view (no crash),
 * defaulted to 'in_progress' with zero milestones reached, so a schema drift can
 * never throw inside a read endpoint.
 */
export function projectCrossChainStatus(row: CrossChainTransferRow): CrossChainStatusView {
  const stage: Stage = STAGES[row.state] ?? { upTo: 0, status: 'in_progress', label: 'Cross-chain transfer in progress' };
  const terminal = isTerminalState(row.state);
  const failed = stage.status === 'failed';
  const succeeded = row.state === 'settled';

  const milestoneLabels = [
    'Payment submitted',
    'Source finalized',
    'Circle attestation',
    'Arc settlement',
    'Completed',
  ];
  const milestones: CrossChainMilestone[] = CROSS_CHAIN_MILESTONE_KEYS.map((key, i) => ({
    key,
    label: milestoneLabels[i],
    // 'completed' (the final milestone) is only "done" when actually settled.
    done: i < stage.upTo,
  }));

  const phaseLabel = stage.label
    .replace('{source}', row.source_network.replace(/_/g, ' '))
    .replace('{destination}', row.destination_network.replace(/_/g, ' '));

  return {
    transfer_id: row.id,
    payment_intent_id: row.payment_intent_id,
    state: row.state,
    status: stage.status,
    milestone_index: Math.min(stage.upTo, TOTAL),
    total_milestones: TOTAL,
    milestones,
    phase_label: phaseLabel,
    is_terminal: terminal,
    is_succeeded: succeeded,
    is_failed: failed,
    is_in_progress: !terminal,
    source_network: row.source_network,
    source_chain_id: row.source_chain_id,
    source_tx_hash: row.source_tx_hash,
    source_finalized_at: row.source_finalized_at,
    destination_network: row.destination_network,
    destination_chain_id: row.destination_chain_id,
    destination_tx_hash: row.destination_tx_hash,
    mint_recipient: row.mint_recipient,
    amount_base_units: row.amount_base_units,
    fee_base_units: row.fee_base_units,
    // PHASE 1 — MONEY-FACING CORRECTNESS: on this ledger an observed fee > 0 is
    // ONLY possible on a FORWARDING route (DIRECT Standard burns carry maxFee 0),
    // and the fee is ADDITIVE: the customer burned M + F while the merchant
    // received EXACTLY M (row.amount_base_units is the settlement amount, proven
    // against the burn event in cctp-source). Describing F as a deduction would
    // wrongly imply the merchant was short-paid by F.
    fees: projectStoredFees(row.amount_base_units, row.fee_base_units),
    attestation_status: row.attestation_status,
    claim_status: row.claim_status,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Convenience loader: fetch the transfer row for a payment intent and project it.
 * Returns null when the intent has NO cross-chain transfer (i.e. it is a
 * same-chain payment) — callers attach the view only when this is non-null, so
 * the same-chain response shape is never altered.
 */
export function loadCrossChainStatus(paymentIntentId: string): CrossChainStatusView | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT id,payment_intent_id,source_network,source_chain_id,source_tx_hash,source_block_number,source_finalized_at,
            cctp_message_id,destination_network,destination_chain_id,destination_tx_hash,destination_block_number,
            mint_recipient,amount_base_units,fee_base_units,attestation_status,claim_status,state,failure_reason,
            created_at,updated_at
     FROM cross_chain_transfers WHERE payment_intent_id=?`,
  ).get(paymentIntentId) as CrossChainTransferRow | undefined;
  return row ? projectCrossChainStatus(row) : null;
}
