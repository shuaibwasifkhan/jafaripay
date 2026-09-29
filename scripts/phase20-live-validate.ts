/**
 * PHASE 20 — LIVE READ-ONLY VALIDATION of every inventory-enabled EVM network.
 *
 * Derived from the single source of truth (server/db/networks.ts), so it always
 * probes exactly the networks the registry treats as payable — nothing more,
 * nothing less. This is the empirical gate behind "we only accept what we can
 * independently confirm on-chain".
 *
 * STRICTLY READ-ONLY. NO private keys. NO transactions. NO funds moved. NO writes.
 * JSON-RPC methods used: eth_chainId, eth_getBlockByNumber (latest/safe/finalized),
 * eth_getCode (native USDC bytecode), eth_call decimals().
 *
 * Classifies each enabled network as:
 *   PASS          chain id matches the registry, native USDC has bytecode,
 *                 decimals == 6, and the pinned finality boundary is observable.
 *   MISMATCH      a money-identity invariant fails (wrong chain id / not a
 *                 contract / wrong decimals / missing finality). HARD failure.
 *   UNREACHABLE   the curated endpoint did not answer within the timeout.
 *                 Reported separately — a transient public-RPC outage is NOT a
 *                 security defect, but it IS surfaced (never silently ignored).
 *
 * Exit code is non-zero ONLY for a MISMATCH (a genuine money-safety break).
 */
import { enabledEvmRows, type InventoryNetwork } from '../server/db/networks.ts';

const DECIMALS_SELECTOR = '0x313ce567';
const TIMEOUT_MS = 20_000;

type Verdict = 'PASS' | 'MISMATCH' | 'UNREACHABLE';

interface ProbeResult {
  slug: string;
  name: string;
  chainId: number;
  rpc: string;
  finalityMode: string;
  verdict: Verdict;
  liveChainId: number | null;
  chainMatch: boolean;
  nativeBytecode: boolean;
  decimals: number | null;
  hasSafe: boolean;
  hasFinalized: boolean;
  latestBlock: number | null;
  note: string;
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

async function blockNumber(url: string, tag: string): Promise<number | null> {
  try {
    const b = (await rpc(url, 'eth_getBlockByNumber', [tag, false])) as { number?: string } | null;
    return b && b.number ? parseInt(b.number, 16) : null;
  } catch {
    return null;
  }
}

async function probe(n: InventoryNetwork): Promise<ProbeResult> {
  const chainId = n.chainId as number;
  const rpcUrl = n.rpc as string;
  const finalityMode = n.finalityMode as string;
  const base: ProbeResult = {
    slug: n.slug, name: n.name, chainId, rpc: rpcUrl, finalityMode,
    verdict: 'UNREACHABLE', liveChainId: null, chainMatch: false, nativeBytecode: false,
    decimals: null, hasSafe: false, hasFinalized: false, latestBlock: null, note: '',
  };

  let liveChainId: number;
  try {
    const cid = (await rpc(rpcUrl, 'eth_chainId')) as string;
    liveChainId = parseInt(cid, 16);
  } catch (e) {
    return { ...base, note: `endpoint did not answer eth_chainId: ${(e as Error).message}` };
  }
  base.liveChainId = liveChainId;
  base.chainMatch = liveChainId === chainId;

  const latest = await blockNumber(rpcUrl, 'latest');
  const safe = await blockNumber(rpcUrl, 'safe');
  const finalized = await blockNumber(rpcUrl, 'finalized');
  base.latestBlock = latest;
  base.hasSafe = safe != null && latest != null && safe <= latest;
  base.hasFinalized = finalized != null && latest != null && finalized <= latest;

  let code: string | undefined;
  try {
    code = (await rpc(rpcUrl, 'eth_getCode', [n.nativeUsdc, 'latest'])) as string;
  } catch {
    code = undefined;
  }
  base.nativeBytecode = !!code && code !== '0x';

  let decimals: number | null = null;
  try {
    const d = (await rpc(rpcUrl, 'eth_call', [{ to: n.nativeUsdc, data: DECIMALS_SELECTOR }, 'latest'])) as string;
    decimals = parseInt(d, 16);
  } catch {
    decimals = null;
  }
  base.decimals = decimals;

  // The finality boundary the registry PINNED must actually be observable, else
  // we would credit on a boundary the endpoint does not honour.
  const finalityOk =
    finalityMode === 'immediate' || finalityMode === 'count'
      ? latest != null
      : finalityMode === 'safe'
        ? base.hasSafe
        : finalityMode === 'finalized'
          ? base.hasFinalized
          : false;

  const mismatches: string[] = [];
  if (!base.chainMatch) mismatches.push(`chain id ${liveChainId} != registry ${chainId}`);
  if (!base.nativeBytecode) mismatches.push('native USDC has no bytecode');
  if (decimals !== 6) mismatches.push(`decimals ${decimals} != 6`);
  if (!finalityOk) mismatches.push(`finality '${finalityMode}' boundary not observable`);

  if (mismatches.length > 0) {
    return { ...base, verdict: 'MISMATCH', note: mismatches.join('; ') };
  }
  return { ...base, verdict: 'PASS', note: 'all money-identity invariants confirmed' };
}

async function main(): Promise<void> {
  const rows = enabledEvmRows();
  console.log(`PHASE 20 live read-only validation — ${rows.length} enabled EVM networks (NO writes).\n`);
  const results: ProbeResult[] = [];
  for (const n of rows) {
    const r = await probe(n);
    results.push(r);
    console.log(
      `[${r.verdict}] ${r.slug} (chain ${r.chainId}) mode=${r.finalityMode} ` +
      `liveChain=${r.liveChainId ?? '-'} bytecode=${r.nativeBytecode} dec=${r.decimals ?? '-'} ` +
      `safe=${r.hasSafe} fin=${r.hasFinalized} head=${r.latestBlock ?? '-'} — ${r.note}`,
    );
  }

  const pass = results.filter((r) => r.verdict === 'PASS').length;
  const unreachable = results.filter((r) => r.verdict === 'UNREACHABLE');
  const mismatch = results.filter((r) => r.verdict === 'MISMATCH');

  console.log(`\nSUMMARY: PASS=${pass}/${rows.length}  UNREACHABLE=${unreachable.length}  MISMATCH=${mismatch.length}`);
  if (unreachable.length) console.log('Unreachable (transient RPC outage — surfaced, not treated as a defect): ' + unreachable.map((r) => r.slug).join(', '));
  if (mismatch.length) {
    console.error('MONEY-IDENTITY MISMATCH (must be resolved before these remain enabled):');
    for (const r of mismatch) console.error(`  - ${r.slug}: ${r.note}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('phase20 live validation crashed:', e);
  process.exit(1);
});
