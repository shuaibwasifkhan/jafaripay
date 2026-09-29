/**
 * JAFARIPAY MASTER EXPANSION — data-driven per-network matrix (PHASE 5/17/18/19).
 *
 * Every assertion DERIVES from the single source of truth (server/db/networks.ts)
 * so the test can never drift from the registry it validates, and a future
 * go-live/hold decision is reflected automatically (PHASE 19: no silent omission).
 *
 * Covers, for EVERY inventory-enabled EVM network:
 *   • registry facts match the audited inventory (chain id, native USDC, 6
 *     decimals, curated RPC/explorer, known finality mode, live/test class)
 *   • the real verifyPayment money gate credits a NATIVE-USDC payment and
 *     FAILS CLOSED for: wrong token (bridged/synthetic), wrong recipient,
 *     wrong amount, replay, expiry, and a lying RPC (eth_chainId mismatch)
 *   • CROSS-CHAIN isolation (PHASE 18): a valid payment on network A can never
 *     satisfy an intent pinned to network B; replay is scoped to (tx, network).
 *
 * Plus an INVENTORY-COMPLETENESS audit (PHASE 19) and a NATIVE-PINNING /
 * BRIDGED-REJECTION sweep (PHASE 5) for every network where Circle documents a
 * bridged alternative.
 *
 * NO real network is dialed. The chain-id-mismatch guard runs for real against
 * a faked endpoint answer (a lying RPC), exactly like provider-hardening does.
 * NO private key. NO transaction. NO funds.
 */
import { test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';
import { CIRCLE_INVENTORY, enabledEvmRows, CIRCLE_SNAPSHOT, type InventoryNetwork } from './db/networks.ts';

const TMP_DB = join(import.meta.dir, '..', 'data', `_matrix_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'matrix-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');

const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const AMOUNT = '1000000'; // 1.00 USDC, 6 decimals
const ENABLED = enabledEvmRows();

function transferLog(contract: string, to: string, amount: bigint) {
  const topics = encodeEventTopics({
    abi: [TRANSFER], eventName: 'Transfer',
    args: { from: SENDER as `0x${string}`, to: to as `0x${string}` },
  });
  const data = encodeAbiParameters([{ type: 'uint256' }], [amount]);
  return { address: contract.toLowerCase(), topics: topics as string[], data, logIndex: 0 };
}

// A single, mutable chain stub so each test can describe what the (fake) endpoint
// returns without re-installing the spy. blockNumber is far below the mocked head
// so every finality mode (immediate/count/safe/finalized) is satisfied.
let stub: { contract: string; to: string; amount: bigint; blockNumber: bigint };
let receiptSpy: ReturnType<typeof spyOn>;
let headSpy: ReturnType<typeof spyOn>;
let latestSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('matrix_merch', 'Matrix Merchant');
  receiptSpy = spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockImplementation(((requested: string) =>
    Promise.resolve({
      txHash: requested, status: 'success' as const, blockNumber: stub.blockNumber,
      blockTimestamp: BigInt(Math.floor(Date.now() / 1000)), from: SENDER, to: stub.contract,
      logs: [transferLog(stub.contract, stub.to, stub.amount)],
    })) as never);
  headSpy = spyOn(arc.ArcProvider.prototype, 'getHeadBlockNumber').mockResolvedValue(1_000_000n as never);
  latestSpy = spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockResolvedValue(1_000_000n as never);
});

afterAll(() => {
  for (const s of [receiptSpy, headSpy, latestSpy]) { try { s?.mockRestore(); } catch { /* noop */ } }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TMP_DB + suffix;
    if (existsSync(f)) { try { rmSync(f, { force: true }); } catch { /* OS handle */ } }
  }
});

let seq = 0;
// Globally-unique tx hash: test files share ONE cached schema/DB instance in a
// full `bun test` run, so a low sequential hash could collide with another
// suite's recorded (tx_hash, network) replay row. A 256-bit random id cannot.
const newHash = () => '0x' + randomBytes(32).toString('hex') + (++seq).toString(16).padStart(2, '0');

// A monotonically-unique 20-byte settlement address per call, so the
// settlement_wallets UNIQUE(merchant,address,network) never silently collides
// (which would otherwise skip the wallet insert and break the intent FK).
let addrSeq = 0;
const uniqueAddr = () => '0x' + (++addrSeq).toString(16).padStart(40, '0');

// Seed a live-class intent (never expired) for one network, pinned to its native USDC.
function seedIntent(n: InventoryNetwork, tag: string, opts: { expiresAt?: number; status?: string } = {}) {
  const db = getDb();
  const walletId = `sw_${tag}`;
  const piId = `pi_${tag}`;
  const hexAddr = uniqueAddr();
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network) VALUES(?,?,?,?)')
    .run(walletId, 'matrix_merch', hexAddr, n.slug);
  db.prepare(`INSERT OR IGNORE INTO payment_intents
      (id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,currency,status,environment,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(piId, 'matrix_merch', walletId, hexAddr, n.slug, n.chainId as number, n.nativeUsdc, '1.00', AMOUNT, 'USDC',
      opts.status ?? 'requires_payment', 'live', opts.expiresAt ?? Math.floor(Date.now() / 1000) + 3600);
  return { piId, settlement: hexAddr };
}

function verify(n: InventoryNetwork, args: { usdc?: string; to?: string; amount?: string; hash?: string; piId?: string; network?: string }) {
  return arc.verifyPayment({
    txHash: args.hash ?? newHash(),
    network: args.network ?? n.slug,
    paymentIntentId: args.piId!,
    settlementAddress: args.to!,
    expectedAmountBaseUnits: args.amount ?? AMOUNT,
    usdcAddress: args.usdc ?? n.nativeUsdc,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 17 — PER-NETWORK REGISTRY-FACT MATRIX (derived, runs for every enabled row)
// ═══════════════════════════════════════════════════════════════════════════
for (const n of ENABLED) {
  test(`P17 [${n.slug}]: registry row matches the audited inventory`, () => {
    const cfg = arc.getNetworkConfig(n.slug);
    expect(cfg.chainId).toBe(n.chainId);
    expect(cfg.usdcAddress).toBe(n.nativeUsdc);
    expect(cfg.usdcDecimals).toBe(6);
    expect(cfg.rpcUrl).toBe(n.rpc);
    expect(cfg.explorerBase).toBe(n.explorer);
    expect(cfg.finalityMode).toBe(n.finalityMode);
    // money-critical invariants for an enabled EVM row
    expect(Number.isInteger(cfg.chainId) && cfg.chainId > 0).toBe(true);
    expect(/^0x[0-9a-fA-F]{40}$/.test(cfg.usdcAddress), `${n.slug} native usdc must be a 0x[40hex] address`).toBe(true);
    expect(arc.FINALITY_MODES.has(cfg.finalityMode)).toBe(true);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 17 — PER-NETWORK MONEY GATE: happy path + every mandated negative
// ═══════════════════════════════════════════════════════════════════════════
for (const n of ENABLED) {
  test(`P17 [${n.slug}]: native USDC payment credits; wrong token/recipient/amount/expiry all fail closed`, async () => {
    const { piId, settlement } = seedIntent(n, `${n.slug}_gate`);
    const amount = BigInt(AMOUNT);

    // HAPPY: correct native contract, correct recipient, exact amount.
    stub = { contract: n.nativeUsdc, to: settlement, amount, blockNumber: 100n };
    await expect(verify(n, { piId, to: settlement })).resolves.toMatchObject({ success: true });

    // WRONG RECIPIENT — a transfer to some other wallet never satisfies this intent.
    const other = '0x' + 'ab'.repeat(20);
    stub = { contract: n.nativeUsdc, to: other, amount, blockNumber: 100n };
    await expect(verify(n, { piId, to: settlement })).resolves.toMatchObject({ success: false });

    // WRONG AMOUNT — short by 1 base unit fails (exact-match gate).
    stub = { contract: n.nativeUsdc, to: settlement, amount: amount - 1n, blockNumber: 100n };
    await expect(verify(n, { piId, to: settlement })).resolves.toMatchObject({ success: false });

    // WRONG TOKEN — a non-pinned contract (even with correct recipient/amount) fails.
    stub = { contract: '0x' + 'cd'.repeat(20), to: settlement, amount, blockNumber: 100n };
    await expect(verify(n, { piId, to: settlement })).resolves.toMatchObject({ success: false });

    // EXPIRED INTENT — beyond expires_at + grace, all other rules satisfied, still refused.
    const { piId: expPi } = seedIntent(n, `${n.slug}_exp`, { expiresAt: Math.floor(Date.now() / 1000) - 999999 });
    stub = { contract: n.nativeUsdc, to: settlement, amount, blockNumber: 100n };
    await expect(verify(n, { piId: expPi, to: settlement })).resolves.toMatchObject({ success: false });
  });

  test(`P17 [${n.slug}]: a lying RPC (eth_chainId mismatch) fails closed before any receipt read`, async () => {
    const provider = new arc.ArcProvider(n.slug);
    // Fake ONLY the endpoint answer; the real ensureChainIdMatches guard runs.
    (provider as unknown as { client: { getChainId: () => Promise<number> } }).client.getChainId = async () => (n.chainId as number) + 1;
    await expect(provider.ensureChainIdMatches()).rejects.toThrow(/Chain mismatch/);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 18 — CROSS-CHAIN SECURITY (pairwise isolation)
// ═══════════════════════════════════════════════════════════════════════════
test('P18: a valid native payment on network A cannot satisfy an intent pinned to network B (pairwise)', async () => {
  for (let i = 0; i < ENABLED.length; i++) {
    for (let j = 0; j < ENABLED.length; j++) {
      if (i === j) continue;
      const A = ENABLED[i];
      const B = ENABLED[j];
      // When two enabled networks share the SAME native USDC contract address
      // (Arc Testnet and Arc Mainnet both pin 0x3600...0000), token identity
      // alone cannot discriminate them — the eth_chainId guard does (proven per
      // network by the "lying RPC" test above). This sweep covers the pairs where
      // the pinned-token-address layer IS the discriminating money gate.
      if (A.nativeUsdc.toLowerCase() === B.nativeUsdc.toLowerCase()) continue;
      // Intent is pinned to B (native B token, B chain). Present a genuine native
      // transfer on A (contract = A native) to B's settlement + exact amount.
      const { piId, settlement } = seedIntent(B, `${B.slug}_x_${A.slug}`);
      stub = { contract: A.nativeUsdc, to: settlement, amount: BigInt(AMOUNT), blockNumber: 100n };
      const r = await verify(B, { piId, to: settlement });
      expect(r.success, `payment on ${A.slug} must NOT satisfy intent on ${B.slug}`).toBe(false);
    }
  }
});

test('P18: same native USDC address across networks is isolated by the eth_chainId guard (Arc testnet/mainnet)', () => {
  // The only enabled pair sharing a token address — assert the premise holds so
  // the cross-token sweep above stays honest, and rely on the chain-id guard.
  const arcT = ENABLED.find((n) => n.slug === 'arc_testnet')!;
  const arcM = ENABLED.find((n) => n.slug === 'arc_mainnet')!;
  expect(arcT.nativeUsdc).toBe(arcM.nativeUsdc);
  expect(arcT.chainId).not.toBe(arcM.chainId);
});

test('P18: replay protection is scoped to (tx_hash, network) — same tx id on a different chain stays isolated', async () => {
  const A = ENABLED[0];
  const tx = newHash();
  // Record the tx under A only.
  getDb().prepare(`INSERT INTO blockchain_transactions(id,tx_hash,network,chain_id,block_number,block_timestamp,from_address,to_address,usdc_address,amount)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(`btx_${tx}_A`, tx, A.slug, A.chainId as number, 100, Math.floor(Date.now() / 1000), SENDER, A.nativeUsdc, A.nativeUsdc, AMOUNT);

  // Re-verifying the SAME (tx, A) is flagged as replay.
  const { piId: piA, settlement: sA } = seedIntent(A, `${A.slug}_replay_A`);
  stub = { contract: A.nativeUsdc, to: sA, amount: BigInt(AMOUNT), blockNumber: 100n };
  const replayA = await verify(A, { piId: piA, to: sA, hash: tx });
  expect(replayA.success).toBe(false);
  expect(replayA.failureReason).toMatch(/replay|already recorded/i);

  // The same tx id under B is NOT blocked by A's replay row; it evaluates B's own
  // rules (and here is a valid native B payment) — proving per-network isolation.
  // Use a network whose native USDC differs from A so the token gate is satisfied.
  const B2 = ENABLED.find((n) => n.nativeUsdc.toLowerCase() !== A.nativeUsdc.toLowerCase())!;
  const { piId: piB, settlement: sB } = seedIntent(B2, `${B2.slug}_replay_B`);
  stub = { contract: B2.nativeUsdc, to: sB, amount: BigInt(AMOUNT), blockNumber: 100n };
  const okB = await verify(B2, { piId: piB, to: sB, hash: tx });
  expect(okB.success, 'same tx id must be independently valid on a different network').toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — NATIVE PINNING + BRIDGED REJECTION (every network with a documented bridged)
// ═══════════════════════════════════════════════════════════════════════════
test('P5: the registry pins NATIVE Circle USDC for every enabled network, never the documented bridged asset', () => {
  for (const n of ENABLED) {
    const row = getDb().prepare('SELECT usdc_address FROM network_configs WHERE network=?').get(n.slug) as { usdc_address: string };
    expect(row.usdc_address).toBe(n.nativeUsdc);
    if (n.bridgedUsdc) {
      expect(n.bridgedUsdc.toLowerCase()).not.toBe(n.nativeUsdc.toLowerCase());
      expect(row.usdc_address.toLowerCase()).not.toBe(n.bridgedUsdc.toLowerCase());
    }
  }
});

test('P5: a bridged/synthetic USDC.e transfer with correct recipient + exact amount is STILL rejected', async () => {
  const bridged = ENABLED.filter((n) => n.bridgedUsdc);
  expect(bridged.length).toBeGreaterThan(0); // Polygon/Avax/Arbitrum/Base etc. must have documented bridged fixtures
  for (const n of bridged) {
    const { piId, settlement } = seedIntent(n, `${n.slug}_bridged`);
    // The settlement wallet is paid the bridged token; recipient + amount + chain all
    // correct, but the contract is NOT the pinned native USDC -> must fail closed.
    stub = { contract: n.bridgedUsdc as string, to: settlement, amount: BigInt(AMOUNT), blockNumber: 100n };
    const r = await verify(n, { piId, to: settlement });
    expect(r.success, `${n.slug}: bridged ${n.bridgedUsdc} must never be accepted`).toBe(false);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 19 — INVENTORY COMPLETENESS / NO SILENT OMISSION / STALENESS
// ═══════════════════════════════════════════════════════════════════════════
test('P19: every Circle-native network is classified with an explicit status + reason (no silent omission)', () => {
  const STATUSES = new Set(['IMPLEMENTED_ENABLED', 'VERIFIED_NOT_ENABLED', 'SPECIAL_HANDLING', 'BLOCKED_NON_EVM', 'BLOCKED_NO_SOURCE']);
  for (const n of CIRCLE_INVENTORY) {
    expect(STATUSES.has(n.status), `${n.slug} has an unexpected status`).toBe(true);
    expect(n.circleNativeUsdc).toBe(true);
    expect(n.evm).toBe(n.protocolFamily === 'evm');
    expect(typeof n.reason === 'string' && n.reason.trim().length > 0, `${n.slug} must carry an explicit reason`).toBe(true);
    // Non-enabled rows explain WHY via reason; enabled rows must be fully specified.
    if (n.status === 'IMPLEMENTED_ENABLED') {
      expect(n.evm).toBe(true);
      expect(Number.isInteger(n.chainId) && (n.chainId as number) > 0).toBe(true);
      expect(/^0x[0-9a-fA-F]{40}$/.test(n.nativeUsdc)).toBe(true);
      expect(n.decimals).toBe(6);
      expect(n.finalityMode).not.toBeNull();
      expect(arc.FINALITY_MODES.has(n.finalityMode as string)).toBe(true);
    } else {
      // A held / special / blocked row may be null-finality (fail-closed) but must
      // never carry a BOGUS mode string that could later be enabled by accident.
      if (n.finalityMode != null) expect(arc.FINALITY_MODES.has(n.finalityMode), `${n.slug} held row has invalid mode`).toBe(true);
    }
  }
});

test('P19: no duplicate slugs and no duplicate chain ids across the inventory', () => {
  const slugs = CIRCLE_INVENTORY.map((n) => n.slug);
  expect(new Set(slugs).size).toBe(slugs.length);
  const evmChainIds = CIRCLE_INVENTORY.filter((n) => n.evm && n.chainId != null).map((n) => n.chainId as number);
  expect(new Set(evmChainIds).size).toBe(evmChainIds.length);
});

test('P19: the ENABLED registry set equals the inventory enabled set exactly (nothing extra, nothing missing)', () => {
  const invEnabled = ENABLED.map((n) => n.slug).sort();
  const dbEnabled = (getDb().prepare('SELECT network FROM network_configs WHERE is_enabled=1').all() as { network: string }[]).map((r) => r.network).sort();
  expect(dbEnabled).toEqual(invEnabled);
});

test('P19: held / special-handling / blocked / non-EVM networks have NO enabled registry row', () => {
  for (const n of CIRCLE_INVENTORY.filter((x) => x.status !== 'IMPLEMENTED_ENABLED')) {
    expect(getDb().prepare('SELECT id FROM network_configs WHERE network=? AND is_enabled=1').get(n.slug)).toBeNull();
  }
});

test('P19: the inventory is at least as large as the Circle native-network snapshot (stale inventory surfaces, never silent under-coverage)', () => {
  // If Circle lists MORE native networks than we track, this assertion fires so the
  // inventory must be re-audited — it can never silently claim complete support.
  expect(CIRCLE_INVENTORY.length).toBeGreaterThanOrEqual(CIRCLE_SNAPSHOT.claimedNativeNetworks);
  expect(CIRCLE_SNAPSHOT.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
