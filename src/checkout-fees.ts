/**
 * JafariPay — CHECKOUT FEE DISCLOSURE (PRODUCT PHASE 1, money-facing correctness)
 *
 * The checkout used to show "Pay M" while a FORWARDING payment actually makes
 * the wallet approve/burn M + F. This module closes that gap WITHOUT becoming a
 * second fee system: it reads the server-authored `fees` breakdown already
 * returned by GET /checkout/:id (see server/lib/fees.ts) and selects the three
 * display lines. It NEVER parses, recomputes, guesses or accepts a fee — if the
 * server says this is a Forwarding route, the numbers shown are exactly the
 * numbers the server persisted, and the gross line is exactly what
 * buildCctpCheckoutPlan puts into approve.amount and the burn call's first arg.
 *
 * Same-chain and DIRECT cross-chain (F = 0) payments return null: their clean,
 * single-amount UX is unchanged and no misleading "forwarding fee" row appears.
 */

/** Structural mirror of the server CrossChainFeeBreakdown (wire shape only —
 *  the frontend must not import server runtime code). */
export interface CheckoutFeesView {
  model?: string;
  currency?: string;
  gross_amount_base_units?: string;
  gross_amount_decimal?: string;
  net_amount_base_units?: string;
  net_amount_decimal?: string;
  is_one_to_one?: boolean;
  forwarding_fee_base_units?: string;
  forwarding_fee_decimal?: string;
  merchant_amount_base_units?: string;
  merchant_amount_decimal?: string;
}

export interface CheckoutAmountLines {
  /** What the merchant is paid on Arc (M) — decimal string from the server. */
  merchantAmount: string;
  /** The server-approved Circle Forwarding fee (F) — decimal string. */
  forwardingFee: string;
  /** What the customer actually approves/burns on the source (M + F). */
  total: string;
  /** Base-unit gross the wallet must approve/burn — equals plan.approve.amount. */
  totalBaseUnits: bigint;
}

/**
 * Return the three honest display lines for a FORWARDING checkout intent, or
 * null for same-chain / DIRECT (F = 0) intents. Pure and synchronous so the
 * checkout UI and the test suite share ONE implementation.
 */
export function describeCheckoutAmounts(intent: {
  cross_chain?: boolean;
  forwarding?: boolean;
  fees?: CheckoutFeesView | null;
} | null | undefined): CheckoutAmountLines | null {
  // Only the additive Forwarding model earns a fee row. A DIRECT Standard
  // transfer (model 'cctp_standard_1to1') and any same-chain payment render
  // exactly one amount, as before.
  if (!intent || intent.cross_chain !== true) return null;
  const fees = intent.fees;
  if (!fees || fees.model !== 'cctp_forwarding_additive') return null;

  const merchant = fees.merchant_amount_decimal ?? fees.net_amount_decimal;
  const fee = fees.forwarding_fee_decimal;
  const total = fees.gross_amount_decimal;
  const totalBaseRaw = fees.gross_amount_base_units;
  if (merchant == null || fee == null || total == null || totalBaseRaw == null) return null;

  let totalBaseUnits: bigint;
  try {
    totalBaseUnits = BigInt(totalBaseRaw);
  } catch {
    return null; // a garbage server value must never reach a money label
  }
  if (totalBaseUnits <= 0n) return null;

  return { merchantAmount: merchant, forwardingFee: fee, total, totalBaseUnits };
}
