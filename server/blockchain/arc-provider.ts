/**
 * JafariPay — BlockchainProvider / ArcProvider
 *
 * Abstractions:
 *   BlockchainProvider  — interface for any chain
 *   ArcProvider         — Arc Testnet + Arc Mainnet implementation
 *   USDCAdapter         — ERC-20 Transfer event decoding
 *   PaymentVerifier     — full 10-point verification pipeline
 */

import { createPublicClient, http, parseAbiItem, decodeEventLog, type PublicClient } from 'viem';
import { getDb } from '../db/schema.js';

/**
 * Bounded settlement grace after a Payment Intent's expiry during which a
 * genuinely settled on-chain payment can still be verified and credited.
 * This ONLY widens the time window — every verification rule
 * (network, receipt success, USDC contract, Transfer event, exact recipient,
 * exact base-unit amount, duplicate/replay protection) remains fully enforced.
 */
export const PI_SETTLEMENT_GRACE_S = 20 * 60; // 20 minutes

// ── Finality modes (Phase 5H) ─────────────────────────────────────────────
// Registry-driven per-network finality POLICY. Each mode names what must be
// true before a receipt may be credited:
//
//   'immediate'  — no gate: a receipt existing on the pinned chain credits.
//                  Correct only for commit-final chains (Arc: BFT <1s, no
//                  reorgs — docs.arc.io "Deterministic finality and settlement").
//   'count'      — required_confirmations child blocks below the `latest` head
//                  (the historical Phase 2 integer gate — unchanged semantics).
//   'safe'       — the tx block is at or below the chain's `safe` head
//                  (batch posted to the parent chain — OP-Stack / Arbitrum).
//   'finalized'  — the tx block is at or below the chain's `finalized` head
//                  (parent-chain finalized — hard finality for L2 deposits).
//
// FAIL-CLOSED CONTRACT (mandatory): a 'safe'/'finalized' row whose RPC does not
// serve that tag (error, null, or any other failure) THROWS — verification
// refuses rather than silently degrading to 'latest', a count, or 'immediate'.
// An unknown/empty mode also throws: there is no default finality.
export type FinalityMode = 'immediate' | 'count' | 'safe' | 'finalized';
export const FINALITY_MODES: ReadonlySet<string> = new Set(['immediate', 'count', 'safe', 'finalized']);

// ── Network config ─────────────────────────────────────────────────────────

export interface NetworkConfig {
  network: string;
  chainId: number;
  rpcUrl: string;
  explorerBase: string;
  usdcAddress: string;
  usdcDecimals: number;
  requiredConfirmations: number;
  finalityMode: FinalityMode;
}

// ── RPC proxy mapping (Phase 2 hardening; deployment model made explicit in 5E) ─
// JafariPay supports exactly TWO RPC deployment models, chosen by server-side
// environment alone. Neither ever takes a URL or a proxy slug from a request,
// a payment intent, or the browser:
//
//   MODEL 1 — direct curated RPC (RPC_PROXY_BASE_URL unset; today's default)
//     resolveRpcUrl returns the registry's network_configs.rpc_url verbatim, so
//     any enabled network works with zero proxy configuration and adding a
//     standard-EVM network is a registry + CSP + frontend change only.
//
//   MODEL 2 — proxy mode (RPC_PROXY_BASE_URL set)
//     A network is proxied only when (a) it has an explicit entry in PROXY_SLUGS
//     AND (b) that proxy slug is listed in RPC_PROXY_CHAINS. Missing (a) THROWS:
//     an unmapped network is never handed a guessed or Arc fallback slug. Missing
//     only (b) leaves that network on its own curated registry URL — a per-network
//     opt-out of the proxy, never a route from one chain to another.
//
// Consequence for expansion: enabling a new network in network_configs suffices
// under MODEL 1; under MODEL 2 it additionally needs an explicit PROXY_SLUGS
// entry. Failing closed until that entry exists is the intended, reviewed
// behavior — this phase deliberately does NOT add mappings for networks that are
// not enabled, so the proxy can never serve one chain for another.
//
// In BOTH models the constructed client still calls eth_chainId and compares it
// with the pinned registry chain_id (ensureChainIdMatches) before any receipt or
// finality read, so a wrong or lying endpoint fails closed either way.
//
// This replaces the old Arc-specific ternary (`network === 'arc_testnet' ?
// 'Arc_Testnet' : 'Arc'`) which silently mapped EVERY unknown network to the Arc
// mainnet proxy slug — a chain-confusion risk.
const PROXY_SLUGS: Readonly<Record<string, string>> = Object.freeze({
  arc_testnet: 'Arc_Testnet',
  arc_mainnet: 'Arc',
});

export function resolveRpcUrl(network: string, configuredRpcUrl: string): string {
  if (process.env.RPC_PROXY_BASE_URL) {
    // Own-property check only: `PROXY_SLUGS[network]` would otherwise resolve
    // inherited keys (`constructor`, `toString`, `__proto__`) to a truthy value
    // and silently skip the fail-closed path below.
    const slug = Object.hasOwn(PROXY_SLUGS, network) ? PROXY_SLUGS[network] : undefined;
    // Proxy mode is enabled but this registry network has no explicit,
    // verified proxy mapping → FAIL CLOSED. Do not guess a slug.
    if (!slug) {
      throw new Error(
        `[RPC] Proxy mode is enabled but network "${network}" has no explicit proxy mapping — ` +
        `refusing to route it through an Arc endpoint (chain-confusion risk)`
      );
    }
    const proxyChains = (process.env.RPC_PROXY_CHAINS || '').split(',');
    if (proxyChains.includes(slug)) {
      // A missing token would be interpolated into the URL as the literal string
      // "undefined" — a misconfigured deployment must fail closed before the
      // request is made rather than issue an unauthenticated proxy call.
      if (!process.env.RPC_PROXY_TOKEN) {
        throw new Error(
          `[RPC] Proxy mode is enabled for "${network}" but RPC_PROXY_TOKEN is not set — ` +
          `refusing to call the proxy without credentials`
        );
      }
      return `${process.env.RPC_PROXY_BASE_URL}/api/rpc/${slug}?_rpc_token=${process.env.RPC_PROXY_TOKEN}`;
    }
  }
  return configuredRpcUrl;
}

// ── Registry validation (Phase 2 hardening) ────────────────────────────────
// A registry row is the trust anchor for every downstream verification step,
// so loading it validates the fields that money depends on. Any violation
// throws — the provider refuses to operate (fail closed) rather than run
// against a misconfigured endpoint. JafariPay is USDC-only: no token
// abstraction, decimals must be exactly 6.
export function getNetworkConfig(network: string): NetworkConfig {
  const db = getDb();
  type DbRow = {
    id: string; network: string; chain_id: number; rpc_url: string; explorer_base: string;
    usdc_address: string; usdc_decimals: number; is_enabled: number; required_confirmations: number;
    finality_mode: string;
  };
  // UNIQUE(network) guarantees at most one row per slug; only enabled rows resolve.
  const row = db.prepare('SELECT * FROM network_configs WHERE network = ? AND is_enabled = 1').get(network) as DbRow | undefined;
  if (!row) throw new Error(`Network "${network}" is not configured or not enabled`);

  const problems: string[] = [];
  if (!Number.isInteger(row.chain_id) || row.chain_id <= 0) problems.push(`chain_id=${row.chain_id}`);
  if (typeof row.rpc_url !== 'string' || row.rpc_url.trim() === '') problems.push('rpc_url is missing');
  else { try { new URL(row.rpc_url); } catch { problems.push(`rpc_url is not a valid URL (${row.rpc_url})`); } }
  if (!/^0x[0-9a-fA-F]{40}$/.test(row.usdc_address)) problems.push(`usdc_address=${row.usdc_address}`);
  if (row.usdc_decimals !== 6) problems.push(`usdc_decimals=${row.usdc_decimals} (JafariPay is USDC-only: 6 decimals)`);
  if (!Number.isInteger(row.required_confirmations) || row.required_confirmations < 0) problems.push(`required_confirmations=${row.required_confirmations}`);
  // Phase 5H: the finality mode is part of the money gate — an unknown or
  // missing mode fails closed exactly like a bad chain id or USDC address.
  if (!FINALITY_MODES.has(row.finality_mode)) problems.push(`finality_mode=${JSON.stringify(row.finality_mode)} (allowed: ${[...FINALITY_MODES].join(', ')})`);
  if (problems.length > 0) {
    throw new Error(`Network "${network}" registry config invalid — ${problems.join('; ')} — refusing to operate`);
  }

  // Map snake_case DB columns to camelCase interface
  return {
    network: row.network,
    chainId: row.chain_id,
    rpcUrl: row.rpc_url,
    explorerBase: row.explorer_base,
    usdcAddress: row.usdc_address,
    usdcDecimals: row.usdc_decimals,
    requiredConfirmations: row.required_confirmations,
    finalityMode: row.finality_mode as FinalityMode,
  };
}

// ── Registry reads for non-money network metadata (Phase 5E) ───────────────
// The UI-facing surfaces (settlement wallets, network picker) need the network's
// *class* — which is registry data (`is_testnet`), never a slug-name comparison
// such as `network === 'arc_mainnet' ? 'live' : 'test'`. This is the same
// `network_configs` table that `getNetworkConfig` above gates money against: one
// registry, one source of truth, no second hardcoded network list anywhere.
export interface NetworkMeta {
  network: string;
  chainId: number;
  isTestnet: boolean;
  isEnabled: boolean;
}

export function getNetworkMeta(network: string): NetworkMeta | null {
  const row = getDb()
    .prepare('SELECT network, chain_id, is_testnet, is_enabled FROM network_configs WHERE network = ?')
    .get(network) as { network: string; chain_id: number; is_testnet: number; is_enabled: number } | undefined;
  if (!row) return null; // unknown slug — callers fail closed, there is no default network
  return { network: row.network, chainId: row.chain_id, isTestnet: row.is_testnet === 1, isEnabled: row.is_enabled === 1 };
}

/** Enabled rows only — the list of networks a merchant may actually select. */
export function listEnabledNetworks(): NetworkMeta[] {
  const rows = getDb()
    .prepare('SELECT network, chain_id, is_testnet FROM network_configs WHERE is_enabled = 1 ORDER BY is_testnet DESC, network')
    .all() as { network: string; chain_id: number; is_testnet: number }[];
  return rows.map((r) => ({ network: r.network, chainId: r.chain_id, isTestnet: r.is_testnet === 1, isEnabled: true }));
}

// ── BlockchainProvider interface ───────────────────────────────────────────

export interface TransactionReceipt {
  txHash: string;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockTimestamp: bigint;
  from: string;
  to: string;
  logs: RawLog[];
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
}

export interface BlockchainProvider {
  getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null>;
  getBlockTimestamp(blockNumber: bigint): Promise<bigint>;
  getLatestBlockNumber(): Promise<bigint>;
  getHeadBlockNumber(tag: 'safe' | 'finalized'): Promise<bigint>;
}

// ── ArcProvider ────────────────────────────────────────────────────────────

export class ArcProvider implements BlockchainProvider {
  private client: PublicClient;
  private config: NetworkConfig;
  private chainIdVerified = false;

  constructor(network: string) {
    this.config = getNetworkConfig(network);
    // Registry-driven proxy mapping with fail-closed semantics (Phase 2).
    const rpcUrl = resolveRpcUrl(network, this.config.rpcUrl);
    this.client = createPublicClient({
      transport: http(rpcUrl, {
        timeout: 15_000,
        retryCount: 3,
        retryDelay: 1_000,
      }),
    }) as PublicClient;
  }

  /**
   * Phase 2 chain-confusion protection: prove the endpoint we are about to
   * verify money against actually serves the chain the registry says it does
   * (network_configs.chain_id). Checked once per provider instance, BEFORE any
   * receipt/finality read. Mismatch or an unreachable endpoint throws — we
   * never silently fall back to another chain/RPC and never verify against a
   * lying endpoint. Today's Arc rows pass (their RPCs serve 5042002/5042).
   */
  async ensureChainIdMatches(): Promise<void> {
    if (this.chainIdVerified) return;
    let onChain: number;
    try {
      onChain = await this.client.getChainId();
    } catch (err) {
      // Fail closed: an RPC that cannot answer eth_chainId cannot be trusted
      // with payment verification either.
      throw new Error(
        `[RPC] Chain verification failed for "${this.config.network}": eth_chainId request failed — refusing to verify payments against this endpoint`,
        { cause: err }
      );
    }
    if (!Number.isInteger(onChain) || onChain !== this.config.chainId) {
      throw new Error(
        `[RPC] Chain mismatch for "${this.config.network}": endpoint reports chain id ${onChain}, ` +
        `registry expects ${this.config.chainId} — refusing to verify payments against this endpoint`
      );
    }
    this.chainIdVerified = true;
  }

  async getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null> {
    // Outside the try/catch below so a mismatch/transport error propagates
    // (fail closed) instead of being mapped to a benign "receipt not found".
    await this.ensureChainIdMatches();
    try {
      const receipt = await this.client.getTransactionReceipt({
        hash: txHash as `0x${string}`,
      });
      if (!receipt) return null;

      const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });

      return {
        txHash: receipt.transactionHash,
        status: receipt.status === 'success' ? 'success' : 'reverted',
        blockNumber: receipt.blockNumber,
        blockTimestamp: block.timestamp,
        from: receipt.from,
        to: receipt.to || '',
        logs: receipt.logs.map((log, i) => ({
          address: log.address,
          topics: log.topics as string[],
          data: log.data,
          logIndex: log.logIndex ?? i,
        })),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // viem throws for not-found receipts instead of returning null
      if (
        msg.includes('could not be found') ||
        msg.includes('not found') ||
        msg.includes('unknown') ||
        msg.includes('TransactionReceiptNotFound') ||
        msg.includes('does not exist')
      ) return null;
      throw err;
    }
  }

  async getBlockTimestamp(blockNumber: bigint): Promise<bigint> {
    await this.ensureChainIdMatches();
    const block = await this.client.getBlock({ blockNumber });
    return block.timestamp;
  }

  /** Current chain head (latest block height) — used by the 'count' finality gate. */
  async getLatestBlockNumber(): Promise<bigint> {
    await this.ensureChainIdMatches();
    return await this.client.getBlockNumber();
  }

  /**
   * Phase 5H: head height for a finality TAG ('safe' | 'finalized'). Used by
   * the tag-driven finality gates. (viem's getBlockNumber takes no blockTag,
   * so the tag head is read via getBlock.) FAIL CLOSED by construction: any
   * RPC error (unsupported tag, unknown block, transport failure) and a null
   * block/height propagate as a thrown Error — a tag-mode network whose RPC
   * cannot serve the tag can never credit, and never silently degrades to
   * 'latest', a confirmation count, or 'immediate'. viem retries at the
   * transport level only for network failures, never for a JSON-RPC error.
   */
  async getHeadBlockNumber(tag: 'safe' | 'finalized'): Promise<bigint> {
    await this.ensureChainIdMatches();
    let head: bigint | null | undefined;
    try {
      head = (await this.client.getBlock({ blockTag: tag })).number;
    } catch (err) {
      throw new Error(
        `[RPC] Network "${this.config.network}" requires the '${tag}' finality tag but the endpoint ` +
        `cannot serve it — refusing to verify payments (no fallback to latest/count/immediate)`,
        { cause: err }
      );
    }
    if (head === null || head === undefined) {
      throw new Error(
        `[RPC] Network "${this.config.network}" requires the '${tag}' finality tag but the endpoint ` +
        `returned no block for it — refusing to verify payments (no fallback to latest/count/immediate)`
      );
    }
    return head;
  }

  getConfig(): NetworkConfig { return this.config; }
}

// ── USDCAdapter — ERC-20 Transfer event decoder ────────────────────────────

const TRANSFER_EVENT_ABI = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

export interface UsdcTransfer {
  from: string;
  to: string;
  value: bigint;
  logIndex: number;
}

export class USDCAdapter {
  private usdcAddress: string;

  constructor(usdcAddress: string) {
    this.usdcAddress = usdcAddress.toLowerCase();
  }

  decodeTransfers(logs: RawLog[]): UsdcTransfer[] {
    const transfers: UsdcTransfer[] = [];
    for (const log of logs) {
      if (log.address.toLowerCase() !== this.usdcAddress) continue;
      try {
        const decoded = decodeEventLog({
          abi: [TRANSFER_EVENT_ABI],
          data: log.data as `0x${string}`,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });
        if (decoded.eventName === 'Transfer') {
          transfers.push({
            from: (decoded.args.from as string).toLowerCase(),
            to: (decoded.args.to as string).toLowerCase(),
            value: decoded.args.value as bigint,
            logIndex: log.logIndex,
          });
        }
      } catch {
        // Not a Transfer event or unrelated log — skip
      }
    }
    return transfers;
  }
}

// ── PaymentVerifier — 10-point verification pipeline ──────────────────────

export interface VerificationInput {
  txHash: string;
  network: string;
  paymentIntentId: string;
  settlementAddress: string;
  expectedAmountBaseUnits: string; // exact, as string representation of BigInt
  usdcAddress: string;
}

export interface VerificationResult {
  success: boolean;
  failureReason?: string;
  txHash?: string;
  sender?: string;
  recipient?: string;
  amountBaseUnits?: string;
  blockNumber?: number;
  blockTimestamp?: number;
  logIndex?: number;
}

export async function verifyPayment(input: VerificationInput): Promise<VerificationResult> {
  const db = getDb();

  // 1. Fetch receipt from chain
  const provider = new ArcProvider(input.network);
  const receipt = await provider.getTransactionReceipt(input.txHash);

  if (!receipt) {
    return { success: false, failureReason: 'Transaction not found on chain' };
  }

  // 2. Correct network — now verified EXPLICITLY (Phase 2): the provider
  // checks eth_chainId against network_configs.chain_id before any receipt
  // read, so a tx from another chain can never resolve here.

  // 2b. Finality gate (Phase 2 integer gate; Phase 5H registry-driven MODE).
  // network_configs.finality_mode names the policy, enforced against the
  // PI-pinned network's own endpoint (ensureChainIdMatches already ran):
  //   'immediate' — no gate (Arc: receipt-exists credits; zero extra RPC calls,
  //                 exactly today's production behavior).
  //   'count'     — required_confirmations child blocks below the latest head.
  //                 Arithmetic is the unchanged Phase 2 code path — bigint only.
  //   'safe'/'finalized' — the tx block must be at or below that tag's head.
  //                 The tag read FAILS CLOSED: an RPC that cannot serve the
  //                 tag throws out of verification; there is never a silent
  //                 fallback to latest, a count, or immediate.
  // Unknown modes cannot reach here (getNetworkConfig fails closed), but the
  // switch default refuses again — defense in depth, no implicit finality.
  const { requiredConfirmations, finalityMode } = provider.getConfig();
  if (finalityMode === 'count' && requiredConfirmations > 0) {
    const head = await provider.getLatestBlockNumber();
    const confirmations = head - receipt.blockNumber + 1n; // tx in the head block has 1 confirmation
    if (confirmations < BigInt(requiredConfirmations)) {
      return {
        success: false,
        failureReason:
          `Insufficient confirmations: ${confirmations.toString()} < required ${requiredConfirmations} ` +
          `(tx block ${receipt.blockNumber.toString()}, chain head ${head.toString()})`,
      };
    }
  } else if (finalityMode === 'safe' || finalityMode === 'finalized') {
    // getHeadBlockNumber throws (fail closed) if the endpoint cannot answer
    // this exact tag — verification then never credits and never degrades.
    const head = await provider.getHeadBlockNumber(finalityMode);
    if (receipt.blockNumber > head) {
      return {
        success: false,
        failureReason:
          `Transaction not ${finalityMode} yet: block ${receipt.blockNumber.toString()} ` +
          `> ${finalityMode} head ${head.toString()} on "${input.network}"`,
      };
    }
  } else if (finalityMode !== 'immediate' && !(finalityMode === 'count' && requiredConfirmations === 0)) {
    throw new Error(`[Finality] Unknown finality_mode "${finalityMode}" for "${input.network}" — refusing to credit`);
  }

  // 3. Successful receipt
  if (receipt.status !== 'success') {
    return { success: false, failureReason: 'Transaction receipt status is "reverted"' };
  }

  // 4+5. Decode USDC Transfer events from correct contract
  const adapter = new USDCAdapter(input.usdcAddress);
  const transfers = adapter.decodeTransfers(receipt.logs);

  if (transfers.length === 0) {
    return { success: false, failureReason: 'No USDC Transfer event found in transaction logs' };
  }

  // 6+7. Find transfer to correct settlement wallet with exact amount
  const expectedAmount = BigInt(input.expectedAmountBaseUnits);
  const matching = transfers.find(
    t =>
      t.to === input.settlementAddress.toLowerCase() &&
      t.value === expectedAmount
  );

  if (!matching) {
    return {
      success: false,
      failureReason: `No Transfer to settlement address ${input.settlementAddress} for exact amount ${input.expectedAmountBaseUnits}`,
    };
  }

  // 8. Transaction has not already been used (duplicate protection)
  const existingTx = db.prepare(
    'SELECT id FROM blockchain_transactions WHERE tx_hash = ? AND network = ?'
  ).get(input.txHash, input.network);

  if (existingTx) {
    return { success: false, failureReason: 'Transaction hash already recorded — possible replay' };
  }

  // 9. Payment intent has not already succeeded
  const pi = db.prepare(
    'SELECT status FROM payment_intents WHERE id = ?'
  ).get(input.paymentIntentId) as { status: string } | undefined;

  if (!pi) return { success: false, failureReason: 'Payment intent not found' };
  if (pi.status === 'succeeded') return { success: false, failureReason: 'Payment intent already succeeded' };
  if (pi.status === 'cancelled') return { success: false, failureReason: 'Payment intent is cancelled' };
  if (pi.status === 'failed') return { success: false, failureReason: 'Payment intent is in failed state' };

  // Check expiration — allow verification up to expires_at + settlement grace,
  // so a genuinely settled payment landing shortly after expiry can still be
  // credited. All other verification rules above remain fully enforced.
  const piRow = db.prepare('SELECT expires_at FROM payment_intents WHERE id = ?').get(input.paymentIntentId) as { expires_at: number } | undefined;
  if (piRow && piRow.expires_at + PI_SETTLEMENT_GRACE_S < Math.floor(Date.now() / 1000)) {
    return { success: false, failureReason: 'Payment intent has expired' };
  }

  return {
    success: true,
    txHash: receipt.txHash,
    sender: matching.from,
    recipient: matching.to,
    amountBaseUnits: matching.value.toString(),
    blockNumber: Number(receipt.blockNumber),
    blockTimestamp: Number(receipt.blockTimestamp),
    logIndex: matching.logIndex,
  };
}
