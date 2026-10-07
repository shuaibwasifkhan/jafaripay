/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { createTransport } from 'viem'
import type { Transport } from 'viem'
import { injected } from 'wagmi/connectors'
import { arc, arcTestnet } from 'viem/chains'
import { registerChain } from './tracing'
import { SUPPORTED_CHAINS, CURATED_RPC_URLS, ENS_ONLY_NO_BROWSER_RPC_CHAIN_IDS } from './supported-chains'

// Arc Mainnet RPC. viem's `arc` chain ships with an empty rpcUrls list, so the
// transport must supply the endpoint explicitly. Independently verified:
//   Arc Mainnet — chain id 5042, RPC https://rpc.mainnet.arc.io, USDC predeploy
//   0x3600000000000000000000000000000000000000 (6 decimals).
const ARC_MAINNET_RPC = CURATED_RPC_URLS[arc.id] ?? 'https://rpc.mainnet.arc.io' // arc-studio-allow-onchain-literal

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(arcTestnet.id, arcTestnet.rpcUrls.default.http[0])
registerChain(arc.id, ARC_MAINNET_RPC)

// Chains and transports derive from the single curated allowlist
// (@/supported-chains) — never from client/network input. A chain outside that
// allowlist can never be added here, so an arbitrary RPC URL cannot enter viem.
// `arcTestnet` stays first, preserving the existing default-connection behavior.
//
// ENS-only capability chains (Ethereum/1) get an INERT transport: wagmi
// requires a transport for every allowlisted chain, but the browser must never
// contact an Ethereum JSON-RPC during checkout. Un-pinned, viem would resolve
// http(undefined) for mainnet to the curated default https://ethereum.reth.rs/rpc
// and wallet-UI ENS lookups would fire a CSP-blocked fetch on every connect.
// The inert transport rejects any request WITHOUT touching the network, so
// those decorative queries fail closed exactly as production CSP already did;
// the payable-chain transports (Base, Arc, every curated mainnet) are
// untouched. See ENS_ONLY_NO_BROWSER_RPC_CHAIN_IDS in @/supported-chains.
function inertCapabilityTransport(chainId: number): Transport {
  const factory = () =>
    createTransport({
      key: `jafariInertChain${chainId}`,
      name: `Inert (chain ${chainId} is capability metadata only — no browser RPC)`,
      type: 'custom',
      request: () =>
        Promise.reject(
          new Error(
            `JafariPay: chain ${chainId} has no browser RPC (ENS-only capability; wire an explicit CSP-allowlisted endpoint to use it)`,
          ),
        ),
      retryCount: 0,
    })
  return factory as unknown as Transport
}

// Exported (and reused by createConfig below) so tests can assert the exact
// per-chain transports wagmi actually got — no re-derivation, no internals.
export const transports = Object.fromEntries(
  SUPPORTED_CHAINS.map((chain) => [
    chain.id,
    ENS_ONLY_NO_BROWSER_RPC_CHAIN_IDS.has(chain.id)
      ? inertCapabilityTransport(chain.id)
      : http(CURATED_RPC_URLS[chain.id]), // undefined → viem uses the chain's curated default RPC
  ]),
) as Record<number, Transport>

export const config = createConfig({
  chains: SUPPORTED_CHAINS,
  connectors: [injected()],
  transports,
})
