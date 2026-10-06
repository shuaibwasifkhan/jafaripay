/**
 * JafariPay — CROSS-CHAIN FEE MODEL EXPOSURE (MASTER PHASE 14)
 *
 * A PURE, READ-ONLY description of what a customer actually pays versus what the
 * merchant's pinned Arc wallet actually receives. It does NOT charge anything,
 * move money, or decide any amount — the intent's stored `amount_base_units` and
 * the transfer's stored `fee_base_units` remain authoritative. This module only
 * makes the ALREADY-TRUE economics legible to the merchant API, the checkout and
 * the dashboard, so no party has to reverse-engineer the contract.
 *
 * THE MODEL (verified, not invented — see db/cctp.ts cctpSourceRoutePlan):
 *   JafariPay mandates the Circle CCTP **Standard transfer**: maxFee = 0. Fast
 *   Transfer is deliberately avoided because its bps fee is deducted from the
 *   minted principal and would break the merchant exact-amount guarantee. So for
 *   every supported route:
 *     gross burned on the source chain == net minted to the merchant on Arc (1:1).
 *   JafariPay levies no per-transaction protocol fee on the transfer amount in
 *   this model, so `platform_fee` is 0 and reported as such (an additive field a
 *   future fee tier can populate — never a silent deduction the client can't see).
 *
 * SAFETY: net is derived by BigInt subtraction and clamped at zero; a malformed
 * or negative stored string degrades to a safe 0-fee, gross==net view rather
 * than ever throwing inside a read path or implying the merchant receives less
 * than is recorded. The ground-truth credit is still ONLY PHASE 8's verified mint.
 */

import { formatBaseUnitsToDecimal } from './money.js';

export type CrossChainFeeModel = 'cctp_standard_1to1';

export interface CrossChainFeeBreakdown {
  /** Which fee regime this transfer is under (single value today). */
  model: CrossChainFeeModel;
  currency: 'USDC';
  /** What the customer sends / burns on the source chain. */
  gross_amount_base_units: string;
  gross_amount_decimal: string;
  /** JafariPay's own fee on the transfer (0 in the current mandated model). */
  platform_fee_base_units: string;
  platform_fee_decimal: string;
  /** The CCTP Fast-Transfer fee REQUESTED (mandated '0' = Standard transfer). */
  cctp_max_fee_base_units: string;
  /** The CCTP fee actually OBSERVED (from the transfer row; 0 for Standard). */
  cctp_fee_executed_base_units: string;
  /** What the merchant's pinned Arc wallet is credited (gross - platform - executed). */
  net_amount_base_units: string;
  net_amount_decimal: string;
  /** True when the merchant receives the full customer amount (Standard, no fee). */
  is_one_to_one: boolean;
}

/** Parse a stored base-units string defensively to a non-negative BigInt. */
function safeBaseUnits(raw: string | null | undefined): bigint {
  if (raw === null || raw === undefined) return 0n;
  try {
    const v = BigInt(raw);
    return v > 0n ? v : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Project the fee breakdown for a cross-chain transfer. `feeBaseUnits` is the
 * observed CCTP burn fee persisted on the transfer row (0 for Standard); it is
 * optional so the same helper can describe the model at INTENT-CREATION time
 * (before any transfer row exists) as well as in the settled/status views.
 */
export function describeCrossChainFees(opts: {
  amountBaseUnits: string;
  feeBaseUnits?: string | null;
  platformFeeBaseUnits?: string | null;
}): CrossChainFeeBreakdown {
  const gross = safeBaseUnits(opts.amountBaseUnits);
  const cctpFeeExecuted = safeBaseUnits(opts.feeBaseUnits);
  const platformFee = safeBaseUnits(opts.platformFeeBaseUnits);

  // Clamp so a corrupt/negative ledger value can never imply a negative payout.
  let net = gross - cctpFeeExecuted - platformFee;
  if (net < 0n) net = 0n;

  return {
    model: 'cctp_standard_1to1',
    currency: 'USDC',
    gross_amount_base_units: gross.toString(),
    gross_amount_decimal: formatBaseUnitsToDecimal(gross),
    platform_fee_base_units: platformFee.toString(),
    platform_fee_decimal: formatBaseUnitsToDecimal(platformFee),
    // Standard transfer is mandated; the requested Fast fee is always 0.
    cctp_max_fee_base_units: '0',
    cctp_fee_executed_base_units: cctpFeeExecuted.toString(),
    net_amount_base_units: net.toString(),
    net_amount_decimal: formatBaseUnitsToDecimal(net),
    is_one_to_one: net === gross,
  };
}
