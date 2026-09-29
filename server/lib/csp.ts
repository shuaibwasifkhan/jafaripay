/**
 * JafariPay — Curated Content-Security-Policy connect sources.
 *
 * Extracted so the exact host allow-list is a single, testable source of truth
 * shared by the server (helmet) and the CSP tests. This is intentionally a
 * FIXED, curated list: no wildcards beyond the pre-existing Arc/Circle service
 * domains, and NEVER an arbitrary or client/PI-supplied origin. Each entry is a
 * first-party RPC/endpoint host for a network the app actually talks to.
 *
 * SECURITY: the checkout browser fetches each supported network's RPC via the
 * wagmi/viem transport, so that network's RPC host must be allow-listed here for
 * the frontend to read balances / submit. Only the EXACT curated host is added —
 * never `*.base.org` or a generic third-party RPC domain. Explorer URLs are
 * plain <a href> navigations and are therefore NOT governed by connect-src.
 */

// arc-studio-allow-onchain-literal — curated first-party RPC/endpoint hosts only.
export const CSP_CONNECT_SRC: readonly string[] = Object.freeze([
  "'self'",
  'https://*.arc.io',      // Arc RPC + explorer service domains (existing, preserved)
  'https://*.arc.network', // Arc infra (existing, preserved)
  'https://*.circle.com',  // Circle endpoints (existing, preserved)
  'https://sepolia.base.org', // Phase 5B: Base Sepolia official public RPC (curated single host)
  'https://sepolia-rollup.arbitrum.io', // Phase 5F: Arbitrum Sepolia official public RPC (curated single host, from docs.arbitrum.io RPC table)
  'https://mainnet.base.org', // MASTER PHASE: Base Mainnet official public RPC (curated single host, docs.base.org connect-to-base)
  'https://arb1.arbitrum.io', // MASTER PHASE: Arbitrum One official public RPC (curated single host, from docs.arbitrum.io RPC table)
  // ── MASTER EXPANSION (PHASE 15): the exact viem-curated default host for each
  // newly enabled EVM mainnet (REF-14). One precise host per network — never a
  // wildcard, never `*.drpc.org`/`*.io`. Each MUST match the registry rpc_url and
  // the frontend CURATED_RPC_URLS pin, so the browser fetch is the SAME audited
  // endpoint the server verifies against. Explorer URLs are <a href> navigations
  // and are intentionally NOT listed here (connect-src does not govern them).
  'https://polygon.drpc.org',      // Polygon PoS (137) viem-curated default
  'https://api.avax.network',      // Avalanche C-Chain (43114) official
  'https://mainnet.optimism.io',   // OP Mainnet (10) official
  'https://rpc.linea.build',       // Linea (59144) official
  'https://mainnet.unichain.org',  // Unichain (130) official
  'https://mainnet.era.zksync.io', // ZKsync Era (324) official
  'https://forno.celo.org',        // Celo (42220) official
  // Cronos (25) was enabled earlier in the EXPANSION and then DEMOTED by the
  // PHASE 20 live re-validation (no observable safe/finalized boundary on the
  // curated endpoint). Its CSP host is REMOVED with the demotion: connect-src
  // stays exactly-inventory-minimal — a held-chain host must never be
  // allowlisted (guarded by the phase5c readiness test). Re-enabling Cronos
  // later means re-adding this line deliberately, with the live evidence.
]);
