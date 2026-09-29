/**
 * JafariPay — Circle-native-USDC NETWORK INVENTORY (single source of truth).
 *
 * PHASE 0/1 artifact: a machine-readable, classified inventory of EVERY network
 * Circle lists with NATIVE USDC, plus its fit against JafariPay's strictly
 * EVM/ERC-20 payment architecture. The registry seed, the CSP host list, the
 * frontend allowlist and the completeness/security tests all derive from here,
 * so a network can never be silently omitted (PHASE 19).
 *
 * AUTHORITATIVE SOURCES (never guessed, never from aggregators):
 *   • Native-USDC existence + token identity + native/bridged distinction:
 *       Circle multichain page (REF-10) https://www.circle.com/multi-chain-usdc
 *       snapshot fetched this phase; the page states "USDC is natively supported
 *       across 38 blockchain networks".
 *   • EVM chain id / RPC / explorer:
 *       viem 2.56.5 curated chain definitions (REF-14). Non-EVM rails have no
 *       viem chain and no 0x[40hex] identifier — see the classification.
 *   • Finality: proven from a LIVE read-only eth_getBlockByNumber probe of each
 *       endpoint this phase (scripts/phase20-live-validate.ts). A network is only
 *       ENABLED when its endpoint serves a distinct safe/finalized boundary;
 *       where it does not (HyperEVM, Sonic) the network is SPECIAL_HANDLING and
 *       is NOT enabled — we never fabricate a finality mode.
 *
 * SECURITY MODEL (unchanged): money is accepted ONLY from the pinned native
 * USDC contract address per network. Bridged/synthetic/wrapped USDC (USDC.e,
 * USDbC, Wormhole/LayerZero USDC, …) are NEVER accepted regardless of recipient
 * or amount — contract address is authoritative, never symbol/name/decimals.
 *
 * STATUS legend:
 *   IMPLEMENTED_ENABLED  registry row present + is_enabled=1 + fully tested + live-read-validated
 *   VERIFIED_NOT_ENABLED EVM + native USDC + finality proven live, but deliberately left
 *                        is_enabled=0 (new/low-info or third-party-default-RPC chains) pending
 *                        an explicit human go-live decision (PHASE 21 production RPC).
 *   SPECIAL_HANDLING     EVM but an unresolved prerequisite (e.g. no distinct finality boundary
 *                        on the curated endpoint) — cannot be safely enabled yet; exact reason given.
 *   BLOCKED_NON_EVM      Circle-native but NOT EVM: cannot pass the provider's
 *                        ^0x[0-9a-fA-F]{40}$ token gate or the integer/unique chain_id registry;
 *                        requires a new PaymentNetworkAdapter rail + wallet + verifier (see PLAN below).
 *   BLOCKED_NO_SOURCE    EVM-family but no viem curated definition (REF-14) — chain id/RPC/explorer
 *                        cannot be sourced authoritatively without guessing, so not enabled.
 */

export type NetworkStatus =
  | 'IMPLEMENTED_ENABLED'
  | 'VERIFIED_NOT_ENABLED'
  | 'SPECIAL_HANDLING'
  | 'BLOCKED_NON_EVM'
  | 'BLOCKED_NO_SOURCE';

export interface InventoryNetwork {
  slug: string;                 // Circle network (canonical key)
  name: string;                 // display name
  protocolFamily: string;       // evm | solana | aptos | sui | stellar | algorand | hedera | near | cosmos | polkadot | xrpl | starknet
  evm: boolean;
  circleNativeUsdc: true;       // every entry here is Circle-NATIVE by construction
  chainId: number | null;       // EVM numeric id; null for non-EVM
  nativeUsdc: string;           // Circle authoritative native identifier (address / asset id / denom)
  decimals: number;
  rpc: string | null;           // viem curated default (REF-14) — curated, never wildcard
  explorer: string | null;
  finalityMode: string | null;  // immediate | count | safe | finalized (EVM only, proven live)
  bridgedUsdc: string | null;   // documented NON-native token that MUST be rejected (negative-test fixture)
  status: NetworkStatus;
  reason: string;
}

// ── The 38 Circle-native-USDC networks, classified. ────────────────────────
export const CIRCLE_INVENTORY: readonly InventoryNetwork[] = Object.freeze([
  // ===== EVM — IMPLEMENTED + ENABLED (pre-existing 6) =====
  { slug: 'arbitrum_one', name: 'Arbitrum One', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 42161, nativeUsdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io', finalityMode: 'finalized', bridgedUsdc: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', status: 'IMPLEMENTED_ENABLED', reason: 'Pre-existing (MASTER 5J).' },
  { slug: 'arc_mainnet', name: 'Arc Mainnet', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 5042, nativeUsdc: '0x3600000000000000000000000000000000000000', decimals: 6, rpc: 'https://rpc.mainnet.arc.io', explorer: 'https://explorer.arc.io', finalityMode: 'immediate', bridgedUsdc: null, status: 'IMPLEMENTED_ENABLED', reason: 'Pre-existing (Arc).' },
  { slug: 'arc_testnet', name: 'Arc Testnet', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 5042002, nativeUsdc: '0x3600000000000000000000000000000000000000', decimals: 6, rpc: 'https://rpc.testnet.arc.io', explorer: 'https://explorer.testnet.arc.io', finalityMode: 'immediate', bridgedUsdc: null, status: 'IMPLEMENTED_ENABLED', reason: 'Pre-existing (Arc testnet).' },
  { slug: 'base_mainnet', name: 'Base', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 8453, nativeUsdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', finalityMode: 'finalized', bridgedUsdc: '0xd9aAEc86B65D86f6AAB73B82deEFb0OilpDA0c13', status: 'IMPLEMENTED_ENABLED', reason: 'Pre-existing (MASTER 5J); legacy USDbC rejected.' },
  { slug: 'base_sepolia', name: 'Base Sepolia', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 84532, nativeUsdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org', finalityMode: 'count', bridgedUsdc: null, status: 'IMPLEMENTED_ENABLED', reason: 'Pre-existing (5B testnet).' },
  { slug: 'arbitrum_sepolia', name: 'Arbitrum Sepolia', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 421614, nativeUsdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', decimals: 6, rpc: 'https://sepolia-rollup.arbitrum.io/rpc', explorer: 'https://sepolia.arbiscan.io', finalityMode: 'count', bridgedUsdc: null, status: 'IMPLEMENTED_ENABLED', reason: 'Pre-existing (5F testnet).' },

  // ===== EVM — NEW THIS PHASE: conservative subset, IMPLEMENTED + ENABLED (7) =====
  // NOTE: Ethereum mainnet is DELIBERATELY NOT a payable network. Per the operator's
  // explicit decision it stays ENS-resolution-only (see src/supported-chains.ts), so
  // it is classified VERIFIED_NOT_ENABLED and excluded from the enabled seed set even
  // though its native USDC + `finalized` boundary were live-validated this phase.
  { slug: 'polygon_pos', name: 'Polygon PoS', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 137, nativeUsdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6, rpc: 'https://polygon.drpc.org', explorer: 'https://polygonscan.com', finalityMode: 'finalized', bridgedUsdc: '0x2791Bca1f2de4661ED44A3336CfB7c24A1a20b72', status: 'IMPLEMENTED_ENABLED', reason: 'Native Circle USDC; USDC.e bridged MUST be rejected. finalized tag live-confirmed.' },
  { slug: 'avalanche_c', name: 'Avalanche', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 43114, nativeUsdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6, rpc: 'https://api.avax.network/ext/bc/C/rpc', explorer: 'https://snowtrace.io', finalityMode: 'finalized', bridgedUsdc: '0xA7D70a7245192083D987bb1a891ec9fa13f8628d', status: 'IMPLEMENTED_ENABLED', reason: 'Native Circle USDC (Whale bridged USDC.e must be rejected). finalized tag live-confirmed.' },
  { slug: 'op_mainnet', name: 'OP Mainnet', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 10, nativeUsdc: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', decimals: 6, rpc: 'https://mainnet.optimism.io', explorer: 'https://optimistic.etherscan.io', finalityMode: 'finalized', bridgedUsdc: null, status: 'IMPLEMENTED_ENABLED', reason: 'Native Circle USDC; OP-stack parent finality live-confirmed.' },
  { slug: 'linea', name: 'Linea', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 59144, nativeUsdc: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', decimals: 6, rpc: 'https://rpc.linea.build', explorer: 'https://lineascan.build', finalityMode: 'finalized', bridgedUsdc: null, status: 'IMPLEMENTED_ENABLED', reason: 'Native Circle USDC; zkEVM finalized tag live-confirmed.' },
  { slug: 'unichain', name: 'Unichain', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 130, nativeUsdc: '0x078d782b760474a361dda0af3839290b0ef57ad6', decimals: 6, rpc: 'https://mainnet.unichain.org', explorer: 'https://uniscan.xyz', finalityMode: 'finalized', bridgedUsdc: null, status: 'IMPLEMENTED_ENABLED', reason: 'Native Circle USDC; OP-stack finalized tag live-confirmed.' },
  { slug: 'zksync_era', name: 'ZKsync Era', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 324, nativeUsdc: '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4', decimals: 6, rpc: 'https://mainnet.era.zksync.io', explorer: 'https://explorer.zksync.io', finalityMode: 'finalized', bridgedUsdc: null, status: 'IMPLEMENTED_ENABLED', reason: 'Native Circle USDC (EVM-compat); finalized tag live-confirmed. Wallet gas = L1+L2 fee model — see checkout caveat.' },
  { slug: 'celo', name: 'Celo', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 42220, nativeUsdc: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6, rpc: 'https://forno.celo.org', explorer: 'https://celoscan.io', finalityMode: 'finalized', bridgedUsdc: null, status: 'IMPLEMENTED_ENABLED', reason: 'Native Circle USDC; finalized tag live-confirmed (BFT).' },
  // NOTE: Cronos was DEMOTED out of the enabled set by the PHASE 20 live
  // read-only re-validation. Its curated endpoint answers eth_chainId and its
  // native USDC is a real 6-decimal contract, but eth_getBlockByNumber('safe')
  // and ('finalized') return NO block on evm.cronos.org, so there is currently no
  // OBSERVABLE irreversible boundary to credit against. Fail closed (see the
  // SPECIAL_HANDLING block) — we never fabricate a finality mode or a count.

  // ===== EVM — VERIFIED but DELIBERATELY NOT ENABLED (conservative subset) =====
  { slug: 'ethereum_mainnet', name: 'Ethereum', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 1, nativeUsdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, rpc: 'https://ethereum.reth.rs/rpc', explorer: 'https://etherscan.io', finalityMode: 'finalized', bridgedUsdc: null, status: 'VERIFIED_NOT_ENABLED', reason: 'Operator chose to keep Ethereum ENS-resolution-only, NOT payable. Native USDC + finalized boundary live-validated, but deliberately excluded from the enabled seed set.' },
  { slug: 'monad', name: 'Monad', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 143, nativeUsdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', decimals: 6, rpc: 'https://rpc.monad.xyz', explorer: 'https://monadscan.com', finalityMode: 'finalized', bridgedUsdc: null, status: 'VERIFIED_NOT_ENABLED', reason: 'Live-read validated but new chain — held for human go-live.' },
  { slug: 'morph', name: 'Morph', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 2818, nativeUsdc: '0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B', decimals: 6, rpc: 'https://rpc.morphl2.io', explorer: 'https://explorer.morphl2.io', finalityMode: 'finalized', bridgedUsdc: null, status: 'VERIFIED_NOT_ENABLED', reason: 'Newer L2 — held for human go-live.' },
  { slug: 'ink', name: 'Ink', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 57073, nativeUsdc: '0x2D270e6886d130D724215A266106e6832161EAEd', decimals: 6, rpc: 'https://rpc-gel.inkonchain.com', explorer: 'https://explorer.inkonchain.com', finalityMode: 'finalized', bridgedUsdc: null, status: 'VERIFIED_NOT_ENABLED', reason: 'Newer OP-stack L2 — held for human go-live.' },
  { slug: 'worldchain', name: 'World Chain', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 480, nativeUsdc: '0x79A02482A880bCe3F13E09da970dC34dB4cD24D1', decimals: 6, rpc: 'https://worldchain-mainnet.g.alchemy.com/public', explorer: 'https://worldscan.org', finalityMode: 'finalized', bridgedUsdc: null, status: 'VERIFIED_NOT_ENABLED', reason: 'Default RPC is third-party (Alchemy public) — held pending dedicated RPC (PHASE 21).' },
  { slug: 'xlayer', name: 'X Layer', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 196, nativeUsdc: '0xb6ceceab302e2e4948951ee7843fc24e92933061', decimals: 6, rpc: 'https://xlayerrpc.okx.com', explorer: 'https://www.oklink.com/xlayer', finalityMode: 'finalized', bridgedUsdc: null, status: 'VERIFIED_NOT_ENABLED', reason: 'New (Aug-2026 native USDC) — held for human go-live.' },
  { slug: 'xdc', name: 'XDC', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 50, nativeUsdc: '0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1', decimals: 6, rpc: 'https://rpc.xdcrpc.com', explorer: 'https://xdcscan.com', finalityMode: 'finalized', bridgedUsdc: null, status: 'VERIFIED_NOT_ENABLED', reason: 'XRC-20 endpoint `safe` absent; held pending finality-policy review.' },
  { slug: 'sei_evm', name: 'Sei', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 1329, nativeUsdc: '0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392', decimals: 6, rpc: 'https://evm-rpc.sei-apis.com', explorer: 'https://seiscan.io', finalityMode: 'safe', bridgedUsdc: null, status: 'VERIFIED_NOT_ENABLED', reason: 'Sei EVM is new; default RPC third-party (sei-apis) — held.' },
  { slug: 'injective_evm', name: 'Injective', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 1776, nativeUsdc: '0xa00C59fF5a080D2b954d0c75e46E22a0c371235a', decimals: 6, rpc: 'https://sentry.evm-rpc.injective.network', explorer: 'https://blockscout.injective.network', finalityMode: 'safe', bridgedUsdc: null, status: 'VERIFIED_NOT_ENABLED', reason: 'Injective EVM is new — held for human go-live.' },
  { slug: 'plume', name: 'Plume', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 98866, nativeUsdc: '0x222365EF19F7947e5484218551B56bb3965Aa7aF', decimals: 6, rpc: 'https://rpc.plume.org', explorer: 'https://explorer.plume.org', finalityMode: 'finalized', bridgedUsdc: null, status: 'VERIFIED_NOT_ENABLED', reason: 'Use plumeMainnet (98866) NOT legacy plue (98865); newer chain — held.' },
  { slug: 'plasma', name: 'Plasma', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 9745, nativeUsdc: '0x2d661C89D812261039AF9764eceaAee884f5F67F', decimals: 6, rpc: 'https://rpc.plasma.to', explorer: 'https://plasmascan.to', finalityMode: 'finalized', bridgedUsdc: null, status: 'VERIFIED_NOT_ENABLED', reason: 'New (Aug-2026 native USDC) — held for human go-live.' },
  { slug: 'codex', name: 'Codex', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 81224, nativeUsdc: '0xd996633a415985DBd7D6D12f4A4343E31f5037cf', decimals: 6, rpc: 'https://rpc.codex.xyz', explorer: 'https://explorer.codex.xyz', finalityMode: 'finalized', bridgedUsdc: null, status: 'VERIFIED_NOT_ENABLED', reason: 'Low-info/new chain — held for human go-live.' },

  // ===== EVM — SPECIAL HANDLING (cannot be safely enabled yet) =====
  { slug: 'hyperevm', name: 'HyperEVM (Hyperliquid)', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 999, nativeUsdc: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', decimals: 6, rpc: 'https://rpc.hyperliquid.xyz/evm', explorer: 'https://hyperevmscan.io', finalityMode: null, bridgedUsdc: null, status: 'SPECIAL_HANDLING', reason: 'Live probe: `safe`=null, `finalized`==latest+1 — endpoint exposes NO distinct irreversible boundary. FAIL CLOSED: not enabled until per-chain finality (REF-13) is established. Never fabricate a mode.' },
  { slug: 'sonic', name: 'Sonic', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 146, nativeUsdc: '0x29219dd400f2bf60e5a23d13be72b486d4038894', decimals: 6, rpc: 'https://rpc.soniclabs.com', explorer: 'https://sonicscan.org', finalityMode: null, bridgedUsdc: null, status: 'SPECIAL_HANDLING', reason: 'Live probe: `safe`/`finalized`==latest+1 (no lag) — no distinct boundary; finality policy unresolved. Not enabled (fail closed).' },
  { slug: 'cronos', name: 'Cronos', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: 25, nativeUsdc: '0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D', decimals: 6, rpc: 'https://evm.cronos.org', explorer: 'https://explorer.cronos.org', finalityMode: null, bridgedUsdc: null, status: 'SPECIAL_HANDLING', reason: 'PHASE 20 live re-probe: curated endpoint serves chain id 25 + native USDC (6 decimals) but eth_getBlockByNumber(`safe`/`finalized`) returns NO block — no OBSERVABLE irreversible boundary to credit against. DEMOTED from enabled (fail closed); never fabricate a mode/count.' },
  { slug: 'edge_chain', name: 'EDGE Chain', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: null, nativeUsdc: '0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c', decimals: 6, rpc: null, explorer: 'https://pro.edgex.exchange', finalityMode: null, bridgedUsdc: null, status: 'BLOCKED_NO_SOURCE', reason: 'No viem curated definition (REF-14): chain id / RPC cannot be sourced without guessing. Blocked.' },
  { slug: 'pharos', name: 'Pharos', protocolFamily: 'evm', evm: true, circleNativeUsdc: true, chainId: null, nativeUsdc: '0xC879C018dB60520F4355C26eD1a6D572cdAC1815', decimals: 6, rpc: null, explorer: 'https://pharos.socialscan.io', finalityMode: null, bridgedUsdc: null, status: 'BLOCKED_NO_SOURCE', reason: 'No viem curated definition (REF-14): chain id / RPC cannot be sourced without guessing. Blocked.' },

  // ===== NON-EVM — BLOCKED, require a PaymentNetworkAdapter rail (see PLAN) =====
  { slug: 'solana', name: 'Solana', protocolFamily: 'solana', evm: false, circleNativeUsdc: true, chainId: null, nativeUsdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, rpc: 'https://api.mainnet-beta.solana.com', explorer: 'https://solscan.io', finalityMode: null, bridgedUsdc: null, status: 'BLOCKED_NON_EVM', reason: 'SPL token + non-EVM tx model. Needs SPL Transfer verifier, Phantom/wallet-adapter rail, and a non-0x[40hex] identity in registry.' },
  { slug: 'aptos', name: 'Aptos', protocolFamily: 'aptos', evm: false, circleNativeUsdc: true, chainId: null, nativeUsdc: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b', decimals: 6, rpc: 'https://fullnode.mainnet.aptoslabs.com/v1', explorer: 'https://explorer.aptoslabs.com', finalityMode: null, bridgedUsdc: null, status: 'BLOCKED_NON_EVM', reason: 'Dispatchable Fungible Asset; Move VM. Needs Aptos verifier + Petra/Pontem wallet rail.' },
  { slug: 'sui', name: 'Sui', protocolFamily: 'sui', evm: false, circleNativeUsdc: true, chainId: null, nativeUsdc: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', decimals: 6, rpc: 'https://fullnode.mainnet.sui.io', explorer: 'https://suiscan.xyz', finalityMode: null, bridgedUsdc: null, status: 'BLOCKED_NON_EVM', reason: 'RegulatedCoin type; Move VM, object model. Needs Sui verifier + Sui Wallet rail.' },
  { slug: 'stellar', name: 'Stellar', protocolFamily: 'stellar', evm: false, circleNativeUsdc: true, chainId: null, nativeUsdc: 'USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', decimals: 7, rpc: 'https://horizon.stellar.org', explorer: 'https://stellar.expert', finalityMode: null, bridgedUsdc: null, status: 'BLOCKED_NON_EVM', reason: 'Classic asset code+issuer; 7 decimals. Breaks USDC-only 6-decimal invariant + needs Stellar verifier + wallet rail.' },
  { slug: 'algorand', name: 'Algorand', protocolFamily: 'algorand', evm: false, circleNativeUsdc: true, chainId: null, nativeUsdc: '31566704', decimals: 6, rpc: 'https://mainnet-api.algonode.cloud', explorer: 'https://allo.info', finalityMode: null, bridgedUsdc: null, status: 'BLOCKED_NON_EVM', reason: 'ASA numeric asset id (not 0x[40hex]); needs Algorand verifier + Pera/AlgoWallet rail.' },
  { slug: 'hedera', name: 'Hedera', protocolFamily: 'hedera', evm: false, circleNativeUsdc: true, chainId: null, nativeUsdc: '0.0.456858', decimals: 6, rpc: 'https://mainnet-public.mirrornode.hedera.com', explorer: 'https://hashscan.io', finalityMode: null, bridgedUsdc: null, status: 'BLOCKED_NON_EVM', reason: 'Native USDC is an HTS token (0.0.456858), NOT the EVM ERC-20 — Hedera EVM does not expose it as 0x[40hex]. Needs HTS verifier + hashpack wallet rail.' },
  { slug: 'near', name: 'NEAR', protocolFamily: 'near', evm: false, circleNativeUsdc: true, chainId: null, nativeUsdc: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6, rpc: 'https://rpc.mainnet.near.org', explorer: 'https://nearblocks.io', finalityMode: null, bridgedUsdc: null, status: 'BLOCKED_NON_EVM', reason: 'NEP-141 ft.near contract account id; needs NEAR verifier + NEAR wallet rail.' },
  { slug: 'noble', name: 'Noble', protocolFamily: 'cosmos', evm: false, circleNativeUsdc: true, chainId: null, nativeUsdc: 'uusdc', decimals: 6, rpc: 'https://mainnet.noble.strange.love', explorer: 'https://mintscan.io/noble', finalityMode: null, bridgedUsdc: null, status: 'BLOCKED_NON_EVM', reason: 'Cosmos SDK bank denom (ibc/native uusdc); needs IBC/Cosmos verifier + Keplr/Leap rail.' },
  { slug: 'polkadot', name: 'Polkadot', protocolFamily: 'polkadot', evm: false, circleNativeUsdc: true, chainId: null, nativeUsdc: '1337', decimals: 6, rpc: 'https://polkadot-asset-hub-rpc.polkadot.io', explorer: 'https://assethub-polkadot.subscan.io', finalityMode: null, bridgedUsdc: null, status: 'BLOCKED_NON_EVM', reason: 'Asset Hub asset id 1337 (foreign asset); needs Polkadot verifier + talisman/substrate-connect rail.' },
  { slug: 'xrpl', name: 'XRPL', protocolFamily: 'xrpl', evm: false, circleNativeUsdc: true, chainId: null, nativeUsdc: '5553444300000000000000000000000000000000.rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE', decimals: 6, rpc: 'https://s.xrpl.org', explorer: 'https://livenet.xrpl.org', finalityMode: null, bridgedUsdc: null, status: 'BLOCKED_NON_EVM', reason: 'XRPL fungible token (currency+issuer); needs XRPL verifier + Xaman/XrplWallet rail.' },
  { slug: 'starknet', name: 'Starknet', protocolFamily: 'starknet', evm: false, circleNativeUsdc: true, chainId: null, nativeUsdc: '0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb', decimals: 6, rpc: 'https://starknet-mainnet.public.blastapi.io', explorer: 'https://voyager.online', finalityMode: null, bridgedUsdc: null, status: 'BLOCKED_NON_EVM', reason: 'Cairo VM; token id is a 32-byte felt (NOT 20-byte EVM addr — fails provider 0x[40hex] gate). Needs Starknet verifier + Argent/Braavos rail. (Note: this is the Cairo Starknet, not the EVM ZKsync Era.)' },
]);

/** Enabled registry rows ONLY — the seedable, payable EVM set. */
export function enabledEvmRows(): InventoryNetwork[] {
  return CIRCLE_INVENTORY.filter((n) => n.status === 'IMPLEMENTED_ENABLED' && n.evm && n.chainId != null);
}

/** The NEW (non-pre-existing) enabled EVM rows the PHASE-6 registry block must seed. */
export function newlyEnabledEvmRows(): InventoryNetwork[] {
  return enabledEvmRows().filter((n) => !['arbitrum_one', 'arc_mainnet', 'arc_testnet', 'base_mainnet', 'base_sepolia', 'arbitrum_sepolia'].includes(n.slug));
}

export const CIRCLE_SNAPSHOT = {
  source: 'https://www.circle.com/multi-chain-usdc',
  asOf: '2026-09-29',
  claimedNativeNetworks: 38,
  viemVersion: '2.56.5',
} as const;

/*
 * ── PHASE 2/3 PLAN: non-EVM payment-rail abstraction (NOT implemented this
 * phase; the current provider is strictly EVM/ERC-20 and faking the rest would
 * accept unverifiable "payments"). To safely add any non-EVM rail:
 *   1. Registry: add protocol_family + a nullable chain_id (drop the
 *      chain_id UNIQUE/NOT-NULL coupling) and a canonical native-identifier
 *      column that accepts non-0x[40hex] ids (asset ids, denoms, felts).
 *   2. PaymentNetworkAdapter interface: getNetworkIdentity / getNativeUsdc /
 *      getDecimals / getTransaction / verifyTransaction / verifyFinality /
 *      verifyRecipient / verifyAmount / verifyToken / buildExplorerUrl.
 *      The EXISTING EVM provider becomes the first adapter (no duplication).
 *   3. A per-protocol verifier that reads a canonical, FINALIZED transaction
 *      and decodes that chain's native USDC transfer primitive (SPL transfer,
 *      Aptos event, HTS transfer, IBC bank transfer, etc.), then applies the
 *      SAME invariants: pinned native token id, exact recipient, exact base
 *      units, (tx-identity, network) replay scope, expiry, env class.
 *   4. A protocol-native wallet connector (never EIP-1193/MetaMask for these)
 *      + a distinct CSP host per verified RPC + a real-money E2E gate.
 *   5. Finality must be that protocol's irreversible commitment point (e.g.
 *      Solana finalized commitment, Tendermint/Noble commit, XRPL validated),
 *      proven by live read-only validation before enablement — else fail closed.
 * Until all five exist and pass, every BLOCKED_NON_EVM / SPECIAL_HANDLING /
 * BLOCKED_NO_SOURCE network is intentionally is_enabled=0 (or absent), NOT faked.
 */
