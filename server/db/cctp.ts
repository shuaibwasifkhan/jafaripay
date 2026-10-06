/**
 * JafariPay — CCTP CROSS-CHAIN SETTLEMENT REGISTRY (single source of truth).
 *
 * PHASE 1 artifact. This module is the ONLY place JafariPay's CCTP protocol
 * facts live: no payment-intent / checkout / worker code may hardcode a CCTP
 * domain, contract address, or "is this chain a cross-chain source?" decision.
 * Every such decision must come from here. (Mirrors the network_configs
 * "one registry, one rule" discipline already enforced for multi-chain —
 * see server/db/networks.ts and server/api/settlement-wallets.ts.)
 *
 * AUTHORITATIVE SOURCES (verified during the CROSS-CHAIN SETTLEMENT AUDIT,
 * never guessed, never copied from a blog):
 *   • Domain identifiers + source/destination support:
 *       Circle, "Supported blockchains and domains"
 *       https://developers.circle.com/cctp/concepts/supported-chains-and-domains
 *       — the page states "All blockchains listed below are supported as
 *       destinations." A chain present in the source table with a domain is a
 *       valid CCTP SOURCE; because every listed chain is also a destination, any
 *       listed chain (incl. Arc, domain 26) is a valid DESTINATION.
 *   • Arc-side CCTP contract addresses (used for the destination mint/claim):
 *       Arc Docs, "Contract addresses" https://docs.arc.io/arc/references/contract-addresses
 *       — TokenMessengerV2 / MessageTransmitterV2 (mainnet + testnet), domain 26.
 *   • The SAME TokenMessengerV2/MessageTransmitterV2 byte-for-byte across EVM
 *       chains (CCTP v2 deterministic deployment), and the testnet pair:
 *       src/onchain-facts.ts (Arc-Studio-generated EVM_PROTOCOL_CONTRACTS),
 *       which matches the Arc docs values exactly — cross-checked during the audit.
 *
 * KEY PROTOCOL PROPERTY (drives the shape of this registry):
 *   CCTP v2 deploys MessageTransmitterV2 and TokenMessengerV2 at IDENTICAL
 *   addresses on every EVM chain they support. That is why onchain-facts carries
 *   ONE mainnet pair and ONE testnet pair rather than a per-chain entry. So the
 *   only per-network fact is the numeric `cctpDomain` (a Circle-assigned
 *   identifier that does NOT map to any public chain id) and whether that chain
 *   is a supported source at all. Destination is always Arc (domain 26).
 *
 * NON-CUSTODIAL / SCOPE INVARIANTS (unchanged from the audit; enforced here):
 *   • Destination is ALWAYS arc_mainnet (mainnet route) / arc_testnet (testnet).
 *   • zkSync Era and Celo have native USDC in this repo (same-chain only) but are
 *     NOT in the CCTP supported-source table → they are NOT cross-chain sources.
 *     Callers must refuse to open a cross-chain intent for them (PHASE 3), never
 *     silently fall back to a non-Circle bridge (out of scope by rule).
 *   • Adding a chain here is a data edit, NOT a code change elsewhere. Do not
 *     sprinkle these values into business logic.
 */

// ── CCTP v2 EVM contract pair (deterministic across chains) ────────────────
// Mainnet pair == Arc docs mainnet == onchain-facts mainnet (verified).
// Testnet pair == Arc docs testnet == onchain-facts testnet (verified).
export const CCTP_CONTRACTS_MAINNET = Object.freeze({
  tokenMessengerV2: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', // arc-studio-allow-onchain-literal — CCTP v2 TokenMessenger (cross-chain-constant)
  messageTransmitterV2: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64', // arc-studio-allow-onchain-literal — CCTP v2 MessageTransmitter (cross-chain-constant)
});

export const CCTP_CONTRACTS_TESTNET = Object.freeze({
  tokenMessengerV2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', // arc-studio-allow-onchain-literal — CCTP v2 testnet TokenMessenger
  messageTransmitterV2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', // arc-studio-allow-onchain-literal — CCTP v2 testnet MessageTransmitter
});

// ── The destination is fixed by the product goal ───────────────────────────
// Arc Mainnet (domain 26) for live routes; Arc Testnet (domain 26) for the
// testnet pilot. Same numeric domain on both — Circle assigns Arc 26 for its
// mainnet and its testnet uses the same identifier in onchain-facts (verified).
export const ARC_MAINNET_SLUG = 'arc_mainnet';
export const ARC_TESTNET_SLUG = 'arc_testnet';
export const ARC_CCTP_DOMAIN = 26;

// ── Finality threshold class (Circle CCTP v2, verified) ────────────────────
// Circle encodes the finality CLASS of a burn message as a uint32 threshold and
// documents `finalityThresholdExecuted` >= 2000 as the finalized class (the ABI
// for IMessageHandlerV2#handleReceiveFinalizedMessage requires >= 2000, while
// handleReceiveUnfinalizedMessage covers < 2000). JafariPay only ever settles a
// FINALIZED burn, so this is the hard lower bound enforced in PHASE 8.
// Values above 2000 are treated by Circle as 2000, so `>=` is the correct test.
export const CCTP_FINALITY_THRESHOLD_FINALIZED = 2000;

// ── CCTP message wire layout (Circle technical guide "Message format") ─────
// VERBATIM offsets from developers.circle.com/cctp/references/technical-guide.
// Header is fixed-size (148 bytes) followed by the dynamically sized body; for
// a burn, TokenMessengerV2 puts a BurnMessageV2 there, whose fixed prefix runs
// to offset 228 (before the dynamic `hookData`). These offsets are the ONLY
// place the byte layout is encoded (PHASE 5 parser reads them).
export const CCTP_MESSAGE_HEADER_BYTES = 148;
export const CCTP_BURN_MESSAGE_BODY_BYTES = 228;
export const CCTP_MESSAGE_OFFSETS = Object.freeze({
  header: Object.freeze({
    version: 0,                     // uint32
    sourceDomain: 4,                // uint32
    destinationDomain: 8,           // uint32
    nonce: 12,                      // bytes32
    sender: 44,                     // bytes32 — MessageTransmitterV2 caller on source
    recipient: 76,                  // bytes32 — handler on destination
    destinationCaller: 108,         // bytes32
    minFinalityThreshold: 140,      // uint32
    finalityThresholdExecuted: 144, // uint32
    messageBody: 148,               // bytes (dynamic)
  }),
  body: Object.freeze({             // BurnMessageV2, relative to messageBody
    version: 0,                     // uint32
    burnToken: 4,                   // bytes32
    mintRecipient: 36,              // bytes32
    amount: 68,                     // uint256
    messageSender: 100,             // bytes32 — depositor of depositForBurn
    maxFee: 132,                    // uint256
    feeExecuted: 164,               // uint256
    expirationBlock: 196,           // uint256
    hookData: 228,                  // bytes (dynamic)
  }),
});

/**
 * The CCTP v2 message version(s) whose byte layout is pinned by
 * CCTP_MESSAGE_OFFSETS. Circle's docs state "use 1 for CCTP"; 2 is accepted
 * because the version is an explicit uint32 field, so an unrecognised value
 * here means Circle changed the layout and this parser MUST be re-reviewed
 * rather than silently mis-decoding a real customer burn.
 */
export const CCTP_SUPPORTED_MESSAGE_VERSIONS: readonly number[] = Object.freeze([1, 2]);

// ── Per-network CCTP classification ────────────────────────────────────────
export interface CctpNetworkConfig {
  slug: string;                 // MUST equal the network_configs.network slug
  cctpDomain: number;           // Circle-assigned domain (NOT a chain id)
  supportedAsSource: boolean;   // can a customer pay here and settle to Arc?
  supportedAsDestination: boolean; // (Arc only) destination of the route
  isTestnet: boolean;           // environment class, mirrors registry is_testnet
}

// The production sources named by the master plan, plus Arc (destination +
// same-chain), plus the testnets required for the PHASE 16 pilot. Domains are
// copied VERBATIM from the Circle supported-chains table; a chain with no
// verified CCTP entry is intentionally absent (=> not a cross-chain source).
export const CCTP_REGISTRY: Readonly<Record<string, CctpNetworkConfig>> = Object.freeze({
  // ── Destination (Arc) ──
  [ARC_MAINNET_SLUG]: { slug: ARC_MAINNET_SLUG, cctpDomain: 26, supportedAsSource: false, supportedAsDestination: true, isTestnet: false },
  [ARC_TESTNET_SLUG]: { slug: ARC_TESTNET_SLUG, cctpDomain: 26, supportedAsSource: false, supportedAsDestination: true, isTestnet: true },

  // ── Production CCTP-supported source mainnets (Circle domains, verified) ──
  base_mainnet: { slug: 'base_mainnet', cctpDomain: 6, supportedAsSource: true, supportedAsDestination: false, isTestnet: false },
  arbitrum_one: { slug: 'arbitrum_one', cctpDomain: 3, supportedAsSource: true, supportedAsDestination: false, isTestnet: false },
  polygon_pos: { slug: 'polygon_pos', cctpDomain: 7, supportedAsSource: true, supportedAsDestination: false, isTestnet: false },
  avalanche_c: { slug: 'avalanche_c', cctpDomain: 1, supportedAsSource: true, supportedAsDestination: false, isTestnet: false },
  op_mainnet: { slug: 'op_mainnet', cctpDomain: 2, supportedAsSource: true, supportedAsDestination: false, isTestnet: false },
  linea: { slug: 'linea', cctpDomain: 11, supportedAsSource: true, supportedAsDestination: false, isTestnet: false },
  unichain: { slug: 'unichain', cctpDomain: 10, supportedAsSource: true, supportedAsDestination: false, isTestnet: false },

  // ── Testnet sources for the PHASE 16 pilot (only the verified-domain ones) ──
  // Base Sepolia domain 6 is confirmed in src/onchain-facts.ts (Arc Studio
  // generated). Arbitrum Sepolia and the other testnets have NO verified domain
  // in onchain-facts and are therefore NOT registered as cross-chain sources
  // here — do not guess a testnet domain. The pilot only needs Base Sepolia.
  base_sepolia: { slug: 'base_sepolia', cctpDomain: 6, supportedAsSource: true, supportedAsDestination: false, isTestnet: true },
});

// Chains present in this repo's payable set that are NOT Circle-native cross-
// chain sources. Kept explicit so "unsupported" is a stated fact, not an
// absence that could be misread as "not yet looked up." zkSync Era & Celo have
// native USDC (same-chain only) but no CCTP/Gateway route to Arc (audit §6).
export const NOT_A_CCTP_SOURCE: readonly string[] = Object.freeze(['zksync_era', 'celo']);

// ── Accessors (the only sanctioned way business logic reads these facts) ─────

/** True iff `slug` is a registry-enabled CCTP SOURCE (pay here → settle Arc). */
export function isCctpSource(slug: string): boolean {
  return CCTP_REGISTRY[slug]?.supportedAsSource === true;
}

/** True iff `slug` is the cross-chain DESTINATION (Arc mainnet/testnet). */
export function isCctpDestination(slug: string): boolean {
  return CCTP_REGISTRY[slug]?.supportedAsDestination === true;
}

/**
 * True iff `slug` is a registered network (source OR destination). Used to
 * reject unknown/typo slugs before any on-chain read. A chain that is merely
 * present in network_configs but absent HERE is never a cross-chain source.
 */
export function isCctpRegistered(slug: string): boolean {
  return Object.hasOwn(CCTP_REGISTRY, slug);
}

/** Circle domain id for a registered network, or null if unknown. */
export function cctpDomainOf(slug: string): number | null {
  return CCTP_REGISTRY[slug]?.cctpDomain ?? null;
}

/**
 * Resolve the CCTP contract pair to use for a route, chosen by environment
 * class (testnet vs mainnet) — NOT per chain, because CCTP v2 addresses are
 * cross-chain-constant. Source burns use the pair on the SOURCE chain; the
 * destination claim uses the SAME pair on Arc.
 */
export function cctpContractsFor(isTestnet: boolean): { tokenMessengerV2: string; messageTransmitterV2: string } {
  return isTestnet ? CCTP_CONTRACTS_TESTNET : CCTP_CONTRACTS_MAINNET;
}

/**
 * The Arc destination slug + domain for a new cross-chain intent, chosen by the
 * intent's environment class. Test-class intents settle on Arc Testnet, live
 * on Arc Mainnet. (Used by PHASE 3+; defined here so the mapping is centralized.)
 */
export function arcDestinationForEnvironment(env: 'test' | 'live'): { slug: string; domain: number } {
  return env === 'test'
    ? { slug: ARC_TESTNET_SLUG, domain: ARC_CCTP_DOMAIN }
    : { slug: ARC_MAINNET_SLUG, domain: ARC_CCTP_DOMAIN };
}

/**
 * The source-chain TokenMessengerV2 the customer's `depositForBurn` is called on.
 * CCTP v2 addresses are cross-chain-CONSTANT, so this is chosen purely by the
 * route's environment class (testnet vs mainnet), never per chain. (PHASE 4+)
 */
export function tokenMessengerFor(isTestnet: boolean): string {
  return cctpContractsFor(isTestnet).tokenMessengerV2;
}

/**
 * Left-pad a 20-byte EVM address into the 32-byte `bytes32` form CCTP v2
 * expects for `mintRecipient` / `destinationCaller` (circle doc: "prefix with
 * zeros if needed"). Non-20-byte input is rejected — never silently truncated.
 */
export function addressToBytes32(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error(`addressToBytes32: not a 20-byte hex address: ${address}`);
  }
  return '0x' + hex.padStart(64, '0');
}

/**
 * Server-authoritative CCTP SOURCE-leg route plan for a cross-chain checkout
 * (PHASE 4). The checkout UI must NEVER derive these itself — it only relays
 * what the server pins from the registry, so a client can never redirect the
 * mint recipient or change the destination domain/contract.
 *
 * Standard (free, 1:1) transfer is the mandated default: maxFee=0.
 *
 * minFinalityThreshold=0 — VERIFIED AGAINST Circle's CCTP technical guide
 * (developers.circle.com/cctp/references/technical-guide), not guessed:
 *   • `minFinalityThreshold` is a FLOOR: "Minimum finality threshold before
 *     allowed to attest". 0 therefore does NOT mean "no finality" — Circle's
 *     Iris service still waits its own "sufficient block confirmations" policy
 *     before signing (technical guide §For EVM chains).
 *   • The threshold ACTUALLY achieved is carried in the message as
 *     `finalityThresholdExecuted`, and Circle's contract ABI states values
 *     >= 2000 are the "finalized" class (handler `handleReceiveFinalizedMessage`
 *     requires finalityThresholdExecuted >= 2000; < 2000 is unfinalized).
 * So the real money-safety gate lives on OUR side of the attestation: no Arc
 * settlement (PHASE 8) and no credit may happen unless the parsed message has
 * `finality_threshold_executed >= CCTP_FINALITY_THRESHOLD_FINALIZED`. Source
 * finality is additionally gated independently by the registry finality_mode
 * (PHASE 6). Requesting 0 also avoids Fast Transfer, whose bps fee would
 * deduct from the minted principal and break the merchant exact-amount
 * guarantee — hence maxFee=0 as well.
 *
 * @throws if `sourceSlug` is not a registry CCTP source.
 */
export function cctpSourceRoutePlan(opts: {
  sourceSlug: string;
  mintRecipientAddress: string;
  burnTokenAddress: string;
}): {
  token_messenger: string;
  destination_domain: number;
  mint_recipient_bytes32: string;
  destination_caller_bytes32: string;
  burn_token: string;
  max_fee: string;
  min_finality_threshold: number;
  /**
   * STEP 5 — present ONLY for a Forwarding route (server-approved fee F > 0).
   * The default DIRECT plan omits it; the checkout handler layers the server-
   * authored `cctp-forward` hook + gross fee onto a route that is being
   * forwarded. A browser never supplies this — it is relayed only from here.
   */
  hook_data?: string;
} {
  const cfg = CCTP_REGISTRY[opts.sourceSlug];
  if (!cfg || cfg.supportedAsSource !== true) {
    throw new Error(`cctpSourceRoutePlan: not a CCTP source: ${opts.sourceSlug}`);
  }
  return {
    token_messenger: tokenMessengerFor(cfg.isTestnet),
    destination_domain: ARC_CCTP_DOMAIN,
    mint_recipient_bytes32: addressToBytes32(opts.mintRecipientAddress),
    // bytes32(0): anyone (our relayer / Forwarding) may execute receiveMessage.
    destination_caller_bytes32: '0x' + '0'.repeat(64),
    burn_token: opts.burnTokenAddress,
    max_fee: '0',
    min_finality_threshold: 0,
  };
}
