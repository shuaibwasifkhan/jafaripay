/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { arc, arcTestnet } from 'viem/chains'
import { registerChain } from './tracing'
import { SUPPORTED_CHAINS, CURATED_RPC_URLS } from './supported-chains'

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
const transports = Object.fromEntries(
  SUPPORTED_CHAINS.map((chain) => [
    chain.id,
    http(CURATED_RPC_URLS[chain.id]), // undefined → viem uses the chain's curated default RPC
  ]),
) as Record<number, ReturnType<typeof http>>

export const config = createConfig({
  chains: SUPPORTED_CHAINS,
  connectors: [injected()],
  transports,
})
