/**
 * JafariPay — CIRCLE CCTP FORWARDING FEE QUOTE (STEP 5B / 5C)
 *
 * Circle's Forwarding fee is DYNAMIC and must be quoted from Circle's own
 * service immediately before the source payment; it is NEVER a client-chosen
 * number and NEVER derived from an observed burn. This module is the single,
 * server-side authority that turns Circle's `/v2/burn/USDC/fees/{src}/{dst}
 * ?forward=true` quote into the approved Forwarding fee F, and (via
 * {@link applyForwardingQuote}) persists it into
 * `payment_intents.forwarding_max_fee_base_units` — the field Step 4B added and
 * locked as server-authored-only.
 *
 * ── Locked business model (DEDUCTED fee), unchanged from Step 4B ──────────
 *   M = payment_intents.amount_base_units           (merchant settlement, NEVER changes)
 *   F = payment_intents.forwarding_max_fee_base_units (server-approved Forwarding maxFee)
 *   source gross burn = M + F,  event/message maxFee = F,  merchant still nets M.
 *
 * ── Exact Circle semantics (REF-1, verified against the LIVE endpoint, not memory)
 *   Circle returns an array with one entry per finality class:
 *     [{ finalityThreshold:1000, minimumFee:1,   forwardFee:{low,med,high} },
 *      { finalityThreshold:2000, minimumFee:0,   forwardFee:{low,med,high} }]
 *   We select ONLY the STANDARD finality entry (finalityThreshold === 2000).
 *   The Fast(1000) entry is deliberately ignored, because JafariPay's existing,
 *   must-not-weaken attestation gate requires finalityThresholdExecuted >= 2000.
 *   Circle's own fee math (copied VERBATIM from the official quickstart — we do
 *   NOT invent fee arithmetic):
 *     forwardFee  = BigInt(entry.forwardFee.med)
 *     protocolFee = (AMOUNT * BigInt(Math.round(entry.minimumFee * 100))) / 1_000_000n
 *     maxFee      = forwardFee + protocolFee      // covers protocol + forwarding
 *     totalAmount = AMOUNT + maxFee               // gross source burn = M + F
 *
 * ── Fail-closed (STEP 5J) ─────────────────────────────────────────────────
 *   missing/malformed response, a non-2xx / network error, NO Standard(2000)
 *   entry, a non-integer / negative forward fee, or a non-finite minimumFee is
 *   a HARD throw. Nothing is ever persisted on failure, and the caller must NOT
 *   proceed with a Forwarding payment on an unknown fee. Zero is NEVER silently
 *   substituted — '0' means DIRECT, and a Forwarding intent must carry a real F.
 */

import { getDb } from '../db/schema.js';
import { ARC_CCTP_DOMAIN } from '../db/cctp.js';
import { irisBaseUrl, type FetchLike } from './cctp-attestation.js';

/** JafariPay only forwards at STANDARD finality; matches the >= 2000 attestation gate. */
export const FORWARDING_FINALITY_STANDARD = 2000;

/**
 * Circle's reserved 24-byte `cctp-forward` magic + a zero uint32 version/length
 * tail — the static v0 forwarding hook blob published by Circle (REF-1). Used
 * verbatim; NEVER hand-modified. Non-empty hookData is what makes Circle's
 * forwarder execute the destination `receiveMessage` on Arc for us.
 */
export const CCTP_FORWARD_HOOK_DATA =
  '0x636374702d666f72776172640000000000000000000000000000000000000000' as const;

export class ForwardingFeeError extends Error {}

/** Signature of {@link applyForwardingQuote}; lets the HTTP create route inject a test seam. */
export type ApplyForwardingQuote = (input: {
  paymentIntentId: string;
  fetchImpl: FetchLike;
  resolveSource: (sourceSlug: string) => { sourceDomain: number; isTestnet: boolean };
}) => Promise<ForwardingFeeAmounts>;

/** One Circle fee entry per finality class, as returned by the fees endpoint. */
export interface ForwardingFeeEntry {
  finalityThreshold: number;
  minimumFee: number;
  forwardFee: { low: number; med: number; high: number };
}

export interface ForwardingFeeAmounts {
  /** M — merchant settlement target (base units). */
  settlementAmountBaseUnits: bigint;
  /** F — server-approved Forwarding maxFee (base units). */
  approvedMaxFeeBaseUnits: bigint;
  /** M + F — the exact gross the source must burn. */
  grossBurnBaseUnits: bigint;
}

/** The exact fees endpoint URL for a route. Ethereum=domain 0, Arc=domain 26. */
export function forwardingFeeUrl(opts: {
  isTestnet: boolean;
  sourceDomain: number;
  destinationDomain?: number;
}): string {
  if (!Number.isInteger(opts.sourceDomain) || opts.sourceDomain < 0) {
    throw new ForwardingFeeError(`invalid source domain: ${opts.sourceDomain}`);
  }
  const dest = opts.destinationDomain ?? ARC_CCTP_DOMAIN;
  return `${irisBaseUrl(opts.isTestnet)}/v2/burn/USDC/fees/${opts.sourceDomain}/${dest}?forward=true`;
}

/**
 * Parse Circle's raw fees response into the STANDARD(2000) entry, failing closed
 * on every shape/value problem. Pure: no network, no DB.
 */
export function selectStandardForwardingQuote(raw: unknown): ForwardingFeeEntry {
  if (!Array.isArray(raw)) throw new ForwardingFeeError('forwarding fee response is not an array');
  const entry = raw.find(
    (e): e is ForwardingFeeEntry =>
      !!e && typeof e === 'object' && (e as ForwardingFeeEntry).finalityThreshold === FORWARDING_FINALITY_STANDARD,
  );
  if (!entry) throw new ForwardingFeeError('no Standard (finalityThreshold=2000) forwarding quote available');
  // Validate the money-critical fields before any BigInt conversion.
  if (!Number.isFinite(entry.minimumFee) || entry.minimumFee < 0) {
    throw new ForwardingFeeError(`malformed minimumFee: ${String(entry.minimumFee)}`);
  }
  const ff = entry.forwardFee;
  if (!ff || typeof ff !== 'object' || !Number.isInteger(ff.med) || ff.med < 0) {
    throw new ForwardingFeeError(`malformed forwardFee.med: ${String(ff?.med)}`);
  }
  return entry;
}

/**
 * Apply Circle's EXACT documented fee formula to derive F and the gross burn.
 * Pure and side-effect free given an already-selected quote entry.
 */
export function computeForwardingAmounts(entry: ForwardingFeeEntry, settlementAmountBaseUnits: bigint): ForwardingFeeAmounts {
  if (settlementAmountBaseUnits <= 0n) throw new ForwardingFeeError('settlement amount must be positive');
  // Verbatim from Circle's quickstart (REF-1). minimumFee is a float factor; the
  // protocol fee is scaled by 1e6. We do NOT reinterpret this math.
  const forwardFee = BigInt(entry.forwardFee.med);
  const protocolFee = (settlementAmountBaseUnits * BigInt(Math.round(entry.minimumFee * 100))) / 1_000_000n;
  const approvedMaxFeeBaseUnits = forwardFee + protocolFee;
  const grossBurnBaseUnits = settlementAmountBaseUnits + approvedMaxFeeBaseUnits;
  if (approvedMaxFeeBaseUnits < 0n || grossBurnBaseUnits <= settlementAmountBaseUnits) {
    throw new ForwardingFeeError('computed forwarding fee is invalid');
  }
  return { settlementAmountBaseUnits, approvedMaxFeeBaseUnits, grossBurnBaseUnits };
}

/**
 * Quote Circle and compute the approved fee for a settlement amount. Throws
 * (fail closed) on any transport / shape / value problem — the caller must treat
 * an absent quote as "cannot forward", never as "forward with fee 0".
 */
export async function quoteForwardingFee(opts: {
  isTestnet: boolean;
  sourceDomain: number;
  settlementAmountBaseUnits: bigint;
  fetchImpl: FetchLike;
}): Promise<ForwardingFeeAmounts> {
  const url = forwardingFeeUrl({ isTestnet: opts.isTestnet, sourceDomain: opts.sourceDomain });
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await opts.fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new ForwardingFeeError(`forwarding fee fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new ForwardingFeeError(`forwarding fee endpoint returned ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new ForwardingFeeError(`forwarding fee response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entry = selectStandardForwardingQuote(body);
  return computeForwardingAmounts(entry, opts.settlementAmountBaseUnits);
}

interface IntentFeeRow {
  id: string;
  amount_base_units: string;
  source_network: string | null;
  network: string;
  environment: string;
}

/**
 * SERVER-OWNED persistence of the approved fee (STEP 5C). Reads M from the
 * intent, quotes Circle, and writes F into
 * `payment_intents.forwarding_max_fee_base_units`. This is the ONLY place F is
 * set for a Forwarding payment; a browser / checkout / metadata path can never
 * reach it (proven in cctp-intents.test.ts). Fails closed: on any quote error
 * nothing is written and the error propagates, so no Forwarding payment proceeds
 * with an unknown fee.
 *
 * @param sourceDomainFn resolves a source slug to its Circle CCTP domain + env
 *   class; injected so this stays pure-DB and unit-testable without the registry.
 */
export async function applyForwardingQuote(input: {
  paymentIntentId: string;
  fetchImpl: FetchLike;
  resolveSource: (sourceSlug: string) => { sourceDomain: number; isTestnet: boolean };
}): Promise<ForwardingFeeAmounts> {
  const db = getDb();
  const pi = db
    .prepare('SELECT id,amount_base_units,source_network,network,environment FROM payment_intents WHERE id=?')
    .get(input.paymentIntentId) as IntentFeeRow | undefined;
  if (!pi) throw new ForwardingFeeError(`payment intent ${input.paymentIntentId} not found`);

  const sourceSlug = (pi.source_network ?? pi.network) as string;
  const { sourceDomain, isTestnet } = input.resolveSource(sourceSlug);
  const settlementAmountBaseUnits = BigInt(pi.amount_base_units);

  const amounts = await quoteForwardingFee({ isTestnet, sourceDomain, settlementAmountBaseUnits, fetchImpl: input.fetchImpl });

  // Persist the server-approved F. The merchant target M (amount_base_units) is
  // NEVER touched — only the fee column changes.
  db.prepare('UPDATE payment_intents SET forwarding_max_fee_base_units=? WHERE id=?').run(
    amounts.approvedMaxFeeBaseUnits.toString(),
    pi.id,
  );
  return amounts;
}
