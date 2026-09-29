/**
 * Pure, UI-free network resolution for the hosted checkout.
 *
 * Everything the checkout screen needs to know about an intent's network is
 * decided here, in one testable place, so the React component can't drift into
 * an Arc-only assumption. The rules this module encodes are the Phase 4 money-
 * safety invariants for the frontend:
 *
 *   - The Payment Intent is the sole authority for chain id and USDC address.
 *     The pinned `usdc_address` is what we display and transfer — never a
 *     registry- or client-derived substitute.
 *   - While the intent is still loading there is NO default network. We must
 *     never fall back to Arc Testnet (or any chain) just to render something.
 *   - A chain the frontend has not allowlisted, or that is missing from the
 *     generated onchain-facts registry, is UNSUPPORTED: payment is disabled and
 *     no explorer link is produced. It must not silently resolve to Arc.
 *   - Explorer URLs come only from the facts registry for the *actual* chain id,
 *     so a non-Arc transaction can never be pointed at an Arc explorer.
 *
 * This file imports only pure data modules (onchain-facts, supported-chains),
 * so it runs unchanged under `bun test` with no wagmi/React/browser present.
 */

import { getChain, buildTxExplorerUrl, buildAddressExplorerUrl } from './onchain-facts';
import { isSupportedChainId } from './supported-chains';

/** The subset of a payment intent that drives network behavior. */
export interface CheckoutIntentNet {
  chain_id: number;
  network: string;
  /** Pinned by the intent at creation — authoritative USDC contract for this payment. */
  usdc_address: string;
  settlement_address: string;
  amount_base_units: string;
}

export type NetworkStatus =
  | 'loading'      // intent not available yet — render a neutral loading state
  | 'unsupported'  // pinned a chain the frontend cannot safely drive — block payment
  | 'ready';       // chain allowlisted + present in facts — safe to render/pay

export interface CheckoutNetworkView {
  status: NetworkStatus;
  /** Null until the intent is known. Never a hardcoded Arc id. */
  chainId: number | null;
  /** Human name from the facts registry; null when unknown. Never 'Arc' by default. */
  displayName: string | null;
  isTestnet: boolean | null;
  /** The PI-pinned USDC address when ready; null otherwise (never another chain's USDC). */
  usdcAddress: string | null;
  /** True only when the chain is allowlisted AND resolvable in onchain-facts. */
  isSupported: boolean;
  /** Explorer links resolve from the real chain id; null when the chain is unknown. */
  txExplorerUrl: (hash: string) => string | null;
  addressExplorerUrl: (addr: string) => string | null;
}

const LOADING_VIEW: CheckoutNetworkView = {
  status: 'loading',
  chainId: null,
  displayName: null,
  isTestnet: null,
  usdcAddress: null,
  isSupported: false,
  txExplorerUrl: () => null,
  addressExplorerUrl: () => null,
};

function explorerOrNull(chainId: number, build: (id: number, v: string) => string, value: string): string | null {
  // getChain already gated `ready`, so build won't throw; guard anyway so an
  // unexpected miss can never fall back to an Arc explorer.
  if (!getChain(chainId)) return null;
  try {
    return build(chainId, value);
  } catch {
    return null;
  }
}

/**
 * Resolve the checkout network view from a payment intent (or null while it is
 * still loading). Pure and total: every input produces a well-defined view, and
 * no branch ever invents an Arc default for a non-Arc or unknown chain.
 */
export function resolveCheckoutNetwork(
  intent: CheckoutIntentNet | null | undefined,
): CheckoutNetworkView {
  if (!intent || !Number.isInteger(intent.chain_id)) {
    return LOADING_VIEW;
  }

  const chainId = intent.chain_id;
  const fact = getChain(chainId);
  const supported = isSupportedChainId(chainId);

  if (!fact || !supported) {
    // Pinned chain we cannot safely drive. Surface the real chain id (so the UI
    // can say which network is unavailable) but expose NO usdc/explorer and keep
    // payment disabled. Crucially, we do not resolve this to Arc.
    return {
      status: 'unsupported',
      chainId,
      displayName: fact?.name ?? null,
      isTestnet: fact ? fact.isTestnet : null,
      usdcAddress: null,
      isSupported: false,
      txExplorerUrl: () => null,
      addressExplorerUrl: () => null,
    };
  }

  return {
    status: 'ready',
    chainId,
    displayName: fact.name,
    isTestnet: fact.isTestnet,
    usdcAddress: intent.usdc_address, // PI-pinned — authoritative, never registry-derived
    isSupported: true,
    txExplorerUrl: (hash) => explorerOrNull(chainId, buildTxExplorerUrl, hash),
    addressExplorerUrl: (addr) => explorerOrNull(chainId, buildAddressExplorerUrl, addr),
  };
}

/**
 * Wrong-wallet-network check. When the intent is not yet known there is no
 * target to compare against — the caller disables payment for the loading state
 * separately, so this returns false rather than guessing an Arc target.
 */
export function isWrongNetwork(
  walletChainId: number | undefined | null,
  intentChainId: number | null,
): boolean {
  if (intentChainId == null || walletChainId == null) return false;
  return walletChainId !== intentChainId;
}

/** Whether the Pay button may act, given resolved network + wallet + expiry. */
export function canAttemptPayment(opts: {
  view: CheckoutNetworkView;
  isConnected: boolean;
  walletChainId: number | undefined | null;
  isExpired: boolean;
}): boolean {
  const { view, isConnected, walletChainId, isExpired } = opts;
  if (view.status !== 'ready' || !view.isSupported) return false;
  if (!isConnected) return false;
  if (isExpired) return false;
  if (isWrongNetwork(walletChainId, view.chainId)) return false;
  return true;
}
