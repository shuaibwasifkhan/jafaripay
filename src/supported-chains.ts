/**
 * Curated, allowlisted set of EVM chains the frontend is *capable* of driving.
 *
 * This is the ONLY source of truth for "which chains may checkout render and
 * switch to". It is a fixed allowlist imported from viem's own chain metadata —
 * a chain id that is NOT listed here can never reach wagmi/viem, and no RPC URL
 * is ever taken from the network, the payment intent, or the client. Transports
 * are built from viem's curated defaults (or an explicit first-party URL below),
 * never from a caller-supplied endpoint.
 *
 * IMPORTANT — frontend capability != production enablement.
 * Adding a chain here does NOT enable it. A network only becomes payable when
 * the *backend* `network_configs` registry marks it enabled AND a merchant's
 * payment intent pins it. As of the MASTER EXPANSION the backend enables Arc
 * Testnet, Arc Mainnet, Base Sepolia, Arbitrum Sepolia, Base Mainnet, Arbitrum
 * One, Polygon PoS, Avalanche, OP Mainnet, Linea, Unichain, ZKsync Era and
 * Celo; a checkout therefore resolves exactly those. (Cronos was briefly
 * enabled during the EXPANSION and then DEMOTED by the PHASE 20 live
 * re-validation — its curated endpoint exposes no observable safe/finalized
 * boundary, so it is fail-closed removed from the payable set.) `mainnet`
 * (Ethereum) is
 * allow-listed here ONLY for ENS resolution and is NOT a payable payment
 * network (operator decision). Each newly enabled chain is added as a payable
 * capability entry — its real money movement stays gated by the backend
 * registry `is_enabled`, the live-class environment check and
 * ENABLE_LIVE_PAYMENTS. Non-EVM and held networks (Monad, Sonic, HyperEVM,
 * Solana, …) remain deliberately absent, so the allowlist stays a fixed curated
 * set derived from viem metadata.
 */

import { arc, arcTestnet, arbitrum, arbitrumSepolia, avalanche, base, baseSepolia, celo, linea, mainnet, optimism, polygon, unichain, zksync } from 'viem/chains';
import type { Chain } from 'viem';

/**
 * Ordered allowlist. The FIRST entry is the wagmi default connection chain, so
 * `arcTestnet` stays first to preserve today's Arc Testnet default behavior.
 * `mainnet` is retained only for ENS resolution (unchanged from before).
 * Typed as a non-empty tuple because wagmi requires at least one chain.
 */
export const SUPPORTED_CHAINS: [Chain, ...Chain[]] = [arcTestnet, arc, baseSepolia, arbitrumSepolia, base, arbitrum, polygon, avalanche, optimism, linea, unichain, zksync, celo, mainnet];

/** Fast membership test used by checkout to decide supported vs. unsupported. */
export const SUPPORTED_CHAIN_IDS: ReadonlySet<number> = new Set(
  SUPPORTED_CHAINS.map((c) => c.id),
);

export function isSupportedChainId(chainId: number): boolean {
  return SUPPORTED_CHAIN_IDS.has(chainId);
}

/**
 * Explicit, first-party RPC overrides for chains whose viem metadata ships an
 * empty/absent default rpcUrls list and therefore need the endpoint stated by
 * hand. This is a fixed map — it is never read from the payment intent or any
 * client input. All other chains use viem's curated default RPC via http().
 */
export const CURATED_RPC_URLS: Readonly<Record<number, string>> = Object.freeze({
  [arc.id]: 'https://rpc.mainnet.arc.io', // arc-studio-allow-onchain-literal — viem `arc` has no default RPC
  // ── MASTER EXPANSION: pin each newly enabled chain to the SAME exact curated
  // host as the backend registry rpc_url and the CSP connect-src entry, so the
  // browser transport, the server verifier and the CSP can never diverge to a
  // different third-party endpoint. These equal viem 2.56.5 curated defaults
  // (REF-14) but are stated explicitly so no default-resolution drift is possible.
  [polygon.id]: 'https://polygon.drpc.org', // arc-studio-allow-onchain-literal
  [avalanche.id]: 'https://api.avax.network/ext/bc/C/rpc', // arc-studio-allow-onchain-literal
  [optimism.id]: 'https://mainnet.optimism.io', // arc-studio-allow-onchain-literal
  [linea.id]: 'https://rpc.linea.build', // arc-studio-allow-onchain-literal
  [unichain.id]: 'https://mainnet.unichain.org', // arc-studio-allow-onchain-literal
  [zksync.id]: 'https://mainnet.era.zksync.io', // arc-studio-allow-onchain-literal
  [celo.id]: 'https://forno.celo.org', // arc-studio-allow-onchain-literal
});
