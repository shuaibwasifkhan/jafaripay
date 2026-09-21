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

// ── Network config ─────────────────────────────────────────────────────────

export interface NetworkConfig {
  network: string;
  chainId: number;
  rpcUrl: string;
  explorerBase: string;
  usdcAddress: string;
  usdcDecimals: number;
}

function buildRpcUrl(compassChain: string, publicFallback: string): string {
  const proxyChains = (process.env.RPC_PROXY_CHAINS || '').split(',');
  if (process.env.RPC_PROXY_BASE_URL && proxyChains.includes(compassChain)) {
    return `${process.env.RPC_PROXY_BASE_URL}/api/rpc/${compassChain}?_rpc_token=${process.env.RPC_PROXY_TOKEN}`;
  }
  return publicFallback; // arc-studio-allow-onchain-literal
}

export function getNetworkConfig(network: string): NetworkConfig {
  const db = getDb();
  type DbRow = { id: string; network: string; chain_id: number; rpc_url: string; explorer_base: string; usdc_address: string; usdc_decimals: number; is_enabled: number };
  const row = db.prepare('SELECT * FROM network_configs WHERE network = ? AND is_enabled = 1').get(network) as DbRow | undefined;
  if (!row) throw new Error(`Network "${network}" is not configured or not enabled`);
  // Map snake_case DB columns to camelCase interface
  return {
    network: row.network,
    chainId: row.chain_id,
    rpcUrl: row.rpc_url,
    explorerBase: row.explorer_base,
    usdcAddress: row.usdc_address,
    usdcDecimals: row.usdc_decimals,
  };
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
}

// ── ArcProvider ────────────────────────────────────────────────────────────

export class ArcProvider implements BlockchainProvider {
  private client: PublicClient;
  private config: NetworkConfig;

  constructor(network: string) {
    this.config = getNetworkConfig(network);
    const rpcUrl = buildRpcUrl(
      network === 'arc_testnet' ? 'Arc_Testnet' : 'Arc',
      this.config.rpcUrl
    );
    this.client = createPublicClient({
      transport: http(rpcUrl, {
        timeout: 15_000,
        retryCount: 3,
        retryDelay: 1_000,
      }),
    }) as PublicClient;
  }

  async getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null> {
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
    const block = await this.client.getBlock({ blockNumber });
    return block.timestamp;
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

  // 2. Correct Arc network — verified implicitly: the provider is constructed from the
  // network config so if the tx resolves on this RPC it belongs to this network.

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

  // Check expiration
  const piRow = db.prepare('SELECT expires_at FROM payment_intents WHERE id = ?').get(input.paymentIntentId) as { expires_at: number } | undefined;
  if (piRow && piRow.expires_at < Math.floor(Date.now() / 1000)) {
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
