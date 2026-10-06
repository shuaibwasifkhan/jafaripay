/**
 * CCTP MASTER PHASE 6 — source finality, per network.
 *
 * PHASE 5 added the finality GATE (evaluateSourceFinality). PHASE 6 proves that
 * gate is driven by REAL, per-network registry data and that the two registries
 * can never disagree about a cross-chain source:
 *
 *   1. REGISTRY CONSISTENCY — every network the CCTP registry claims is a
 *      cross-chain SOURCE must exist as an ENABLED network_configs row, carry a
 *      deliberate finality_mode (one of the four the provider understands), and
 *      AGREE with the CCTP registry on environment class (testnet vs mainnet).
 *      A source that is registered for Circle but missing/disabled in the
 *      network registry would make detectSourceBurn fail closed as
 *      'source_not_registered' — this test turns that into a boot-time red flag.
 *   2. The finality verdict for each real source comes from its OWN registry
 *      config: 'finalized' sources wait the `finalized` tag head (and FAIL CLOSED
 *      if the endpoint cannot serve the tag), the testnet 'count' source waits
 *      its required_confirmations depth. No source silently degrades to
 *      'immediate'/latest.
 *
 * Fixture ids / DB are uniquely namespaced (*_cctpf*) to avoid colliding with
 * other suites that share one sqlite file under `bun test`.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctpfinality_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp-finality-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const { getNetworkConfig, getNetworkMeta } = await import('./blockchain/arc-provider.ts');
const { evaluateSourceFinality } = await import('./blockchain/cctp-source.ts');
import type { SourceBurnProvider } from './blockchain/cctp-source.ts';
import { CCTP_REGISTRY, isCctpSource } from './db/cctp.ts';

const ALLOWED_MODES = new Set(['immediate', 'count', 'safe', 'finalized']);

/** The list of slugs the CCTP registry claims are valid cross-chain sources. */
const cctpSourceSlugs = Object.keys(CCTP_REGISTRY).filter(isCctpSource);

/**
 * A provider whose finality-relevant config is the REAL registry row for
 * `slug`, with an RPC that can serve head reads. `opts.canServeTag=false`
 * models an endpoint whose `safe`/`finalized` tag is unavailable (fail closed).
 */
function providerForNetwork(
  slug: string,
  opts: { latest?: bigint; tagHead?: bigint | null } = {},
): SourceBurnProvider {
  const cfg = getNetworkConfig(slug);
  return {
    getTransactionReceipt: async () => null,
    getLatestBlockNumber: async () => opts.latest ?? 1_000_000n,
    getHeadBlockNumber: async (_tag: 'safe' | 'finalized') => {
      if (opts.tagHead === null) throw new Error('tag unsupported by endpoint');
      return opts.tagHead ?? 1_000_000n;
    },
    getConfig: () => cfg,
  } as unknown as SourceBurnProvider;
}

beforeAll(() => {
  migrate();
});

afterAll(() => {
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ── 1. Registry consistency: a declared CCTP source is a real, enabled row ──

test('P6-1: at least the Base Sepolia pilot source + all named production sources are registered', () => {
  // Guards against a registry edit that quietly drops a source the product promises.
  expect(cctpSourceSlugs).toContain('base_sepolia');
  for (const s of ['base_mainnet', 'arbitrum_one', 'polygon_pos', 'avalanche_c', 'op_mainnet', 'linea', 'unichain']) {
    expect(cctpSourceSlugs).toContain(s);
  }
});

test('P6-2: every CCTP source has an ENABLED network_configs row with a valid finality_mode', () => {
  for (const slug of cctpSourceSlugs) {
    const meta = getNetworkMeta(slug);
    expect(meta, `network_configs row missing for source ${slug}`).not.toBeNull();
    expect(meta!.isEnabled, `source ${slug} is registered for Circle but disabled in network_configs`).toBe(true);

    const cfg = getNetworkConfig(slug); // throws if the row is not a valid money registry
    expect(ALLOWED_MODES.has(cfg.finalityMode), `source ${slug} has non-enforceable finality_mode=${cfg.finalityMode}`).toBe(true);
    expect(cfg.chainId).toBe(meta!.chainId);
  }
});

test('P6-3: the CCTP registry and network_configs AGREE on a source environment class', () => {
  // A disagreement (e.g. a testnet slug with a mainnet is_testnet) means the
  // route would burn against the wrong contract pair — detectSourceBurn fails
  // closed on it, and so does this invariant at test time.
  for (const slug of cctpSourceSlugs) {
    const cctpIsTestnet = CCTP_REGISTRY[slug].isTestnet === true;
    const netIsTestnet = getNetworkMeta(slug)?.isTestnet === true;
    expect(netIsTestnet, `env-class conflict for ${slug}: CCTP=${cctpIsTestnet} network_configs=${netIsTestnet}`).toBe(cctpIsTestnet);
  }
});

// ── 2. The verdict comes from the network's OWN registry config ─────────────

test('P6-4: a finalized-mode source is final at/below the finalized head, not above it', async () => {
  const finalizedSources = cctpSourceSlugs.filter((s) => getNetworkConfig(s).finalityMode === 'finalized');
  expect(finalizedSources.length).toBeGreaterThan(0); // production sources use 'finalized'

  for (const slug of finalizedSources) {
    // tx block at the finalized head => final
    const atHead = await evaluateSourceFinality(providerForNetwork(slug, { tagHead: 5_000n }), 5_000n);
    expect(atHead.final, `${slug}: block == finalized head must be final`).toBe(true);
    // tx block above the finalized head => not final yet
    const above = await evaluateSourceFinality(providerForNetwork(slug, { tagHead: 5_000n }), 5_001n);
    expect(above.final, `${slug}: block > finalized head must NOT be final`).toBe(false);
    // An endpoint that cannot serve the tag FAILS CLOSED — never degrades.
    await expect(evaluateSourceFinality(providerForNetwork(slug, { tagHead: null }), 1n)).rejects.toThrow(/tag unsupported/);
  }
});

test('P6-5: the count-mode testnet source waits its registry required_confirmations depth', async () => {
  const slug = 'base_sepolia';
  const cfg = getNetworkConfig(slug);
  expect(cfg.finalityMode).toBe('count');
  const need = cfg.requiredConfirmations; // seeded value (3)
  expect(need).toBeGreaterThan(0);

  // exactly `need` confirmations (latest = block + need - 1) => final
  const final = await evaluateSourceFinality(providerForNetwork(slug, { latest: BigInt(need) - 1n }), 0n);
  expect(final.final).toBe(true);
  // one confirmation short => NOT final, and the detail reports the shortfall
  const short = await evaluateSourceFinality(providerForNetwork(slug, { latest: BigInt(need) - 2n }), 0n);
  expect(short.final).toBe(false);
  expect(short.detail).toMatch(/confirmations/);
});

test('P6-6: a finalized production source NEVER inherits the testnet count policy', async () => {
  // The whole point of per-network finality: Base Mainnet must gate on the
  // `finalized` tag even though Base Sepolia (same family) uses a shallow count.
  expect(getNetworkConfig('base_mainnet').finalityMode).toBe('finalized');
  expect(getNetworkConfig('base_sepolia').finalityMode).toBe('count');

  // base_mainnet with a finalized head BELOW the tx block is not final — proving
  // it is not being treated as an immediate/always-final chain.
  const notFinal = await evaluateSourceFinality(providerForNetwork('base_mainnet', { tagHead: 100n }), 101n);
  expect(notFinal.final).toBe(false);
});
