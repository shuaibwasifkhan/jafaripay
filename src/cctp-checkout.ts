/**
 * Pure, UI-free builder for the CCTP cross-chain checkout source leg (PHASE 4).
 *
 * The customer pays on a SOURCE chain (Base/Arbitrum/…) and the funds settle on
 * Arc via Circle CCTP. The money-safety invariant mirrors `checkout-network.ts`:
 * every on-chain parameter for the burn comes from the SERVER-authoritative
 * `cctp_source_route` object the checkout GET returns — this module NEVER
 * derives a contract address, destination domain or mint recipient itself. If
 * the server did not pin them, we refuse to build a plan (fail closed) rather
 * than guess, so a client can never redirect customer funds.
 *
 * The two source transactions are:
 *   1. ERC-20 `approve(spender=tokenMessenger, amount)` on the SOURCE USDC.
 *   2. `depositForBurn(amount, destinationDomain, mintRecipient, burnToken,
 *      destinationCaller, maxFee, minFinalityThreshold)` on the SOURCE
 *      TokenMessengerV2 (CCTP v2 ABI — verified against Circle's contract
 *      interfaces, not from memory).
 *
 * Imports nothing with a runtime/browser dependency, so it runs under `bun test`.
 */

// CCTP v2 TokenMessengerV2 `depositForBurn` — the exact 7-arg signature from
// Circle's contract-interfaces reference (uint256,uint32,bytes32,address,bytes32,uint256,uint32).
// STEP 5 adds `depositForBurnWithHook` — the exact 8-arg signature (the 7 above
// + trailing `bytes hookData`) from Circle's official Forwarding quickstart.
export const tokenMessengerV2Abi = [
  {
    type: 'function',
    name: 'depositForBurn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
    ],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

// Circle's Standard finality class (>= 2000). A Forwarding burn MUST request it,
// matching JafariPay's un-changeable attestation gate (finalityThresholdExecuted
// >= 2000). The Fast(1000) class is never used here.
const FORWARDING_MIN_FINALITY = 2000;

// Hex-bytes shape (even-length, 0x-prefixed) for the server-authored hookData.
const BYTES_RE = /^0x([0-9a-fA-F]{2})+$/;

export interface CctpSourceRoute {
  token_messenger: string;
  destination_domain: number;
  mint_recipient_bytes32: string;
  destination_caller_bytes32: string;
  burn_token: string;
  max_fee: string;
  min_finality_threshold: number;
  /** STEP 5 — server-authored `cctp-forward` hookData; present only for Forwarding routes. */
  hook_data?: string;
}

export interface CctpCheckoutIntent {
  cross_chain?: boolean;
  is_cross_chain?: number;
  chain_id: number;
  usdc_address: string;
  amount_base_units: string;
  cctp_source_route?: CctpSourceRoute;
  /** STEP 5 — server-approved Forwarding fee F (0/absent = DIRECT). Never client-set. */
  forwarding_max_fee_base_units?: string;
}

export type CctpPlan =
  | { status: 'not_cross_chain' }
  | { status: 'missing_route'; error: string }
  | { status: 'invalid_route'; error: string }
  | {
      status: 'ready';
      /** True only for a Forwarding route (server-approved fee F > 0). */
      forwarding: boolean;
      // Step 1 — approve the TokenMessenger to pull the GROSS burn (M for direct, M + F for Forwarding).
      approve: { to: string; spender: string; amount: bigint };
      // Step 2 — depositForBurn on the source TokenMessenger. For a Forwarding route the
      // args mirror the WithHook burn (gross / maxFee F / Standard finality) minus the
      // hook; the caller MUST use depositForBurnWithHook (below) so Circle forwards it.
      depositForBurn: { to: string; args: readonly [
        bigint, number, `0x${string}`, string, `0x${string}`, bigint, number,
      ] };
      // STEP 5 — present ONLY when forwarding. depositForBurnWithHook (8 args, hookData last).
      depositForBurnWithHook?: { to: string; args: readonly [
        bigint, number, `0x${string}`, string, `0x${string}`, bigint, number, `0x${string}`,
      ] };
    };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function isCrossChain(intent: CctpCheckoutIntent): boolean {
  return intent.cross_chain === true || intent.is_cross_chain === 1;
}

/**
 * Build the two-step source plan for a cross-chain intent, or a typed refusal.
 * Total and side-effect free: every input yields a well-defined outcome and no
 * branch ever invents a chain/contract/domain the server did not pin.
 */
export function buildCctpCheckoutPlan(intent: CctpCheckoutIntent): CctpPlan {
  if (!isCrossChain(intent)) return { status: 'not_cross_chain' };

  const route = intent.cctp_source_route;
  // Fail closed: a cross-chain intent whose server route plan is absent must
  // NEVER fall back to a client-derived burn — that would let the caller pick
  // the recipient/domain and is a fund-loss vector.
  if (!route) return { status: 'missing_route', error: 'Checkout did not receive a server-authoritative CCTP route.' };

  // Shape validation of the server-pinned values (defense in depth). Any
  // malformed value is refused rather than passed to a real money tx.
  if (!ADDRESS_RE.test(route.token_messenger)) return { status: 'invalid_route', error: 'Invalid TokenMessenger address.' };
  if (!ADDRESS_RE.test(route.burn_token)) return { status: 'invalid_route', error: 'Invalid burn token address.' };
  if (!BYTES32_RE.test(route.mint_recipient_bytes32)) return { status: 'invalid_route', error: 'Invalid mint recipient (bytes32).' };
  if (!BYTES32_RE.test(route.destination_caller_bytes32)) return { status: 'invalid_route', error: 'Invalid destination caller (bytes32).' };
  if (!Number.isInteger(route.destination_domain) || route.destination_domain < 0) {
    return { status: 'invalid_route', error: 'Invalid destination domain.' };
  }

  // The burn token MUST be the intent's pinned source USDC — never a
  // server-supplied value that drifted from what the customer sees as the price.
  if (route.burn_token.toLowerCase() !== intent.usdc_address.toLowerCase()) {
    return { status: 'invalid_route', error: 'Burn token does not match the intent-pinned USDC address.' };
  }

  let amount: bigint;
  let routeMaxFee: bigint;
  let fee: bigint;
  try {
    amount = BigInt(intent.amount_base_units);
    routeMaxFee = BigInt(route.max_fee);
    // STEP 5 — the SERVER-approved Forwarding fee F. Absent/0 => a DIRECT route.
    // A client can never set this: it is persisted only by server code (see
    // server/blockchain/cctp-forwarding-fee.ts + the cctp-intents ownership test).
    fee = BigInt(intent.forwarding_max_fee_base_units ?? '0');
  } catch {
    return { status: 'invalid_route', error: 'Amount / fee is not a valid integer.' };
  }
  if (amount <= 0n) return { status: 'invalid_route', error: 'Amount must be positive.' };
  if (routeMaxFee < 0n) return { status: 'invalid_route', error: 'Fee cap must be non-negative.' };
  if (fee < 0n) return { status: 'invalid_route', error: 'Forwarding fee must be non-negative.' };

  const forwarding = fee > 0n;
  // The approve ALWAYS covers exactly the gross the TokenMessenger will pull:
  // M for DIRECT (fee 0), M + F for FORWARDING — never more, never an unlimited
  // approval. Circle deducts F from the burn, so the merchant still nets M.
  const gross = amount + fee;

  // ── FORWARDING route (server-approved fee F > 0) ──
  if (forwarding) {
    // Fail closed: a Forwarding intent MUST carry the server-authored cctp-forward
    // hook. Without it we would silently build a DIRECT burn for M + F and either
    // Circle rejects the fee or the merchant is short-paid — so we refuse rather
    // than guess the hook bytes (STEP 5D “DO NOT invent or manually modify the hook”).
    if (!route.hook_data || !BYTES_RE.test(route.hook_data)) {
      return { status: 'invalid_route', error: 'Forwarding route is missing its server-authored hook data.' };
    }
    // amount = M + F, maxFee = F, minFinalityThreshold = 2000 (Standard) — the
    // un-changeable JafariPay attestation gate. FORWARDING_MIN_FINALITY is used
    // directly (NOT route.min_finality_threshold) so a route can never downgrade it.
    const burnArgs: [bigint, number, `0x${string}`, string, `0x${string}`, bigint, number] = [
      gross,
      route.destination_domain,
      route.mint_recipient_bytes32 as `0x${string}`,
      route.burn_token,
      route.destination_caller_bytes32 as `0x${string}`,
      fee,
      FORWARDING_MIN_FINALITY,
    ];
    return {
      status: 'ready',
      forwarding: true,
      approve: { to: intent.usdc_address, spender: route.token_messenger, amount: gross },
      // The hook-less mirror of the same burn (kept so a caller can inspect the
      // gross/fee/finality); the WITH-HOOK entry is the one that must be sent.
      depositForBurn: { to: route.token_messenger, args: burnArgs },
      depositForBurnWithHook: {
        to: route.token_messenger,
        args: [
          burnArgs[0],
          burnArgs[1],
          burnArgs[2],
          burnArgs[3],
          burnArgs[4],
          burnArgs[5],
          burnArgs[6],
          route.hook_data as `0x${string}`,
        ],
      },
    };
  }

  // ── DIRECT route — byte-identical to the pre-STEP-5 plan (regression-safe) ──
  return {
    status: 'ready',
    forwarding: false,
    approve: { to: intent.usdc_address, spender: route.token_messenger, amount },
    depositForBurn: {
      to: route.token_messenger,
      args: [
        amount,
        route.destination_domain,
        route.mint_recipient_bytes32 as `0x${string}`,
        route.burn_token,
        route.destination_caller_bytes32 as `0x${string}`,
        routeMaxFee,
        route.min_finality_threshold,
      ],
    },
  };
}
