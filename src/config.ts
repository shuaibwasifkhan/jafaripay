/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arc, arcTestnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Arc Mainnet RPC. viem's `arc` chain ships with an empty rpcUrls list, so the
// transport must supply the endpoint explicitly. Independently verified:
//   Arc Mainnet — chain id 5042, RPC https://rpc.mainnet.arc.io, USDC predeploy
//   0x3600000000000000000000000000000000000000 (6 decimals).
const ARC_MAINNET_RPC = 'https://rpc.mainnet.arc.io' // arc-studio-allow-onchain-literal

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(arcTestnet.id, arcTestnet.rpcUrls.default.http[0])
registerChain(arc.id, ARC_MAINNET_RPC)

export const config = createConfig({
  chains: [arcTestnet, arc, mainnet], // arcTestnet + Arc mainnet; ETH mainnet kept for ENS resolution
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http(),
    [arc.id]: http(ARC_MAINNET_RPC), // explicit — viem `arc` has no default RPC
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})
