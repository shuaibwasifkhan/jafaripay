/**
 * STEP 5N-FINAL — HTTP INTEGRATION OF THE EXISTING CCTP MODULES.
 *
 * The CCTP modules (applyForwardingQuote, detectSourceBurn) were implemented and
 * unit-tested in earlier Steps but were NEVER invoked by any production route.
 * This file is the focused regression gate proving the two NEW wires:
 *
 *   CHANGE 1  POST /v1/payment-intents, after the cross-chain row legitimately
 *             exists, drives the server-owned Forwarding quote so F is written
 *             into payment_intents.forwarding_max_fee_base_units. The client can
 *             NEVER author F; a quote failure fails-safe to DIRECT (F stays 0).
 *   CHANGE 2  POST /checkout/:id/verify branches on is_cross_chain: a cross-chain
 *             intent goes to detectSourceBurn (NOT the same-chain verifyPayment)
 *             and returns { status: 'processing' }; a same-chain intent still runs
 *             the FULL unchanged money path.
 *
 * NO live network / NO real chain: the Circle quote transport is canned and the
 * real applyForwardingQuote persistence is exercised end-to-end; source-burn
 * detection is driven through the route seam with canned module results (the burn
 * VALIDATION itself — amount === M + F, wrong recipient, replay — stays proven by
 * cctp-burn.test.ts, which is NOT weakened here). Same-chain verification reuses
 * the narrow ArcProvider.prototype receipt mock (the cctp17 technique). Isolated
 * per-file DB (*_cctp5n_*).
 */
import { test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctp5n_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp5n-test-secret';
process.env.EMAIL_TRANSPORT = 'dev';

const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');
const { applyForwardingQuote, CCTP_FORWARD_HOOK_DATA, FORWARDING_FINALITY_STANDARD } =
  await import('./blockchain/cctp-forwarding-fee.ts');
const intentsModule = await import('./api/payment-intents.ts');
const checkoutModule = await import('./api/checkout.ts');
const intentsRouter = intentsModule.default;
const checkoutRouter = checkoutModule.default;
const { setForwardingQuoteForTest } = intentsModule;
const { setSourceBurnDetectionForTest } = checkoutModule;
import type { FetchLike } from './blockchain/cctp-attestation.ts';
import type { SourceBurnSuccess, SourceBurnFailure } from './blockchain/cctp-source.ts';

const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const ARC_TESTNET = 'arc_testnet';
const ARC_CHAIN = 5042002;
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const KEY = 'sk_test_cctp5n';
const BASE_SEPOLIA_CHAIN = 84532;

// The Circle Standard(2000) fee we canned into the quote: med forward fee and a
// 0 bps minimumFee, so F === forwardFee exactly (protocolFee === 0). 19_872 is the
// same magnitude as the Step 5L-F real quote (a plausible non-trivial fee).
const CANONICAL_FEE_MED = '19872';

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const hashApiKey = (key: string) => createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let seq = 0;
const txHash = () => '0x' + 'c5'.repeat(31) + ((++seq) % 256).toString(16).padStart(2, '0');

function transferLog(to: string, amount: bigint) {
  const topics = encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from: SENDER as `0x${string}`, to: to as `0x${string}` } });
  return { address: ARC_USDC.toLowerCase(), topics: topics as string[], data: encodeAbiParameters([{ type: 'uint256' }], [amount]), logIndex: 0 };
}
/** Mock a genuine Arc-native-USDC Transfer to the merchant wallet (immediate finality). */
function mockArcReceipt(to: string, amount: bigint) {
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockImplementation(((requested: string) => Promise.resolve({
    txHash: requested, status: 'success' as const, blockNumber: 100n,
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)), from: SENDER, to,
    logs: [transferLog(to, amount)],
  })) as never);
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockResolvedValue(200n as never);
}

async function createIntent(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/v1/payment-intents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function checkoutVerify(id: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/checkout/${id}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function checkoutGet(id: string) {
  const res = await fetch(`${baseUrl}/checkout/${id}`);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const intentRow = (id: string) =>
  getDb().prepare('SELECT * FROM payment_intents WHERE id=?').get(id) as Record<string, unknown>;
const paymentsFor = (piId: string) =>
  (getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').all(piId) as { id: string }[]);

/** Canned Circle fees response → the REAL applyForwardingQuote persists F from it. */
function cannedQuoteFetch(): FetchLike {
  return async () => ({
    status: 200,
    ok: true,
    json: async () => [
      { finalityThreshold: 1000, minimumFee: 0.1, forwardFee: { low: 1, med: 2, high: 3 } },
      { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 1, med: Number(CANONICAL_FEE_MED), high: 3 } },
    ],
  });
}

function burnSuccess(over: Partial<SourceBurnSuccess> = {}): SourceBurnSuccess {
  return {
    ok: true,
    transferId: over.transferId ?? 'cct_5n_test',
    paymentIntentId: over.paymentIntentId ?? 'pi_5n',
    sourceTxHash: over.sourceTxHash ?? TX_DEFAULT,
    sourceNetwork: 'base_sepolia',
    sourceBlockNumber: 1,
    cctpNonce: '1',
    burnAmountBaseUnits: over.burnAmountBaseUnits ?? '0',
    mintRecipientBytes32: '0x' + '00'.repeat(32),
    destinationDomain: 26,
    burnMessageHash: '0x' + '11'.repeat(32),
    cctpMessageId: '0x' + '11'.repeat(32),
    cctpMessage: '0x',
    depositor: SENDER,
    maxFee: over.maxFee ?? '0',
    minFinalityThreshold: FORWARDING_FINALITY_STANDARD,
    finalityThresholdExecuted: FORWARDING_FINALITY_STANDARD,
    sourceFinalized: true,
    state: over.state ?? 'source_finalized',
    createdNewTransfer: over.createdNewTransfer ?? true,
  };
}
function burnFailure(code: SourceBurnFailure['code'], retryable: boolean, reason = code): SourceBurnFailure {
  return { ok: false, code, reason, retryable };
}

const TX_DEFAULT = '0x' + 'c5'.repeat(32);

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_5n', '5N merchant');
  // ONE pinned Arc (testnet) wallet — cross-chain settlement target.
  db.prepare('INSERT INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_5n_arc', 'merch_5n', ARC_WALLET.toLowerCase(), ARC_TESTNET);
  db.prepare(
    'INSERT INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)',
  ).run('ak_5n', 'merch_5n', null, '5n', KEY.slice(0, 8), hashApiKey(KEY), KEY.slice(0, 12), 1, 'test');

  const app = express();
  app.use(express.json());
  app.use('/checkout', checkoutRouter);
  app.use('/v1/payment-intents', intentsRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

beforeEach(() => {
  // Default every test to a hermetic fail-safe quote so an unset cross-chain
  // create never touches the live Circle endpoint. Individual tests override.
  setForwardingQuoteForTest(async () => { throw new Error('unset in this test'); });
});

afterEach(() => {
  setForwardingQuoteForTest(null);
  setSourceBurnDetectionForTest(null);
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockRestore();
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockRestore();
});

afterAll(() => {
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) { try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ } }
});

// ── 1. cross-chain intent creation invokes applyForwardingQuote ─────────────
test('5N-1: POST /v1/payment-intents (cross-chain) invokes applyForwardingQuote with the created id', async () => {
  const calls: string[] = [];
  setForwardingQuoteForTest(async (input) => {
    calls.push(input.paymentIntentId);
    return { settlementAmountBaseUnits: 5000000n, approvedMaxFeeBaseUnits: 0n, grossBurnBaseUnits: 5000000n };
  });
  const r = await createIntent({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  expect(r.status).toBe(201);
  expect(calls).toEqual([String(r.body.id)]);
});

// ── 2. server persists forwarding_max_fee_base_units (real module + canned fetch) ─
test('5N-2: the REAL applyForwardingQuote persists the server-approved F into the intent', async () => {
  // Route → real module (only the Circle transport is canned) → DB. Proves the
  // wiring actually WRITES F, not just that the function is reachable.
  setForwardingQuoteForTest((input) => applyForwardingQuote({ ...input, fetchImpl: cannedQuoteFetch() }));
  const r = await createIntent({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  expect(r.status).toBe(201);
  const dbRow = intentRow(String(r.body.id));
  expect(dbRow.forwarding_max_fee_base_units).toBe(CANONICAL_FEE_MED);
  // The merchant settlement target M is NEVER touched by the quote.
  expect(dbRow.amount_base_units).toBe('5000000');
});

// ── 3. client cannot inject the forwarding fee ──────────────────────────────
test('5N-3: a client-supplied forwarding fee is ignored — only the server quote value persists', async () => {
  setForwardingQuoteForTest((input) => applyForwardingQuote({ ...input, fetchImpl: cannedQuoteFetch() }));
  const r = await createIntent({
    amount: '5.00', network: 'base_sepolia', cross_chain: true,
    forwarding_max_fee_base_units: '999999',
    metadata: { forwarding_max_fee_base_units: '888888' },
  });
  expect(r.status).toBe(201);
  const dbRow = intentRow(String(r.body.id));
  // The persisted F is the server/quote value, NEVER anything the client sent.
  expect(dbRow.forwarding_max_fee_base_units).toBe(CANONICAL_FEE_MED);
  expect(JSON.stringify(r.body)).not.toContain('999999');
  expect(JSON.stringify(r.body)).not.toContain('888888');
});

// ── 4. checkout returns the Forwarding route when F > 0 ─────────────────────
test('5N-4: GET /checkout/:id upgrades to a Forwarding route when the server-approved F > 0', async () => {
  setForwardingQuoteForTest((input) => applyForwardingQuote({ ...input, fetchImpl: cannedQuoteFetch() }));
  const r = await createIntent({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  const id = String(r.body.id);
  const g = await checkoutGet(id);
  expect(g.status).toBe(200);
  expect(g.body.forwarding).toBe(true);
  const plan = g.body.cctp_source_route as Record<string, unknown>;
  expect(plan.max_fee).toBe(CANONICAL_FEE_MED);
  expect(plan.min_finality_threshold).toBe(FORWARDING_FINALITY_STANDARD); // 2000
  expect(plan.hook_data).toBe(CCTP_FORWARD_HOOK_DATA);
});

// ── 4b. a DIRECT (F=0) intent keeps the exact unchanged standard route ───────
test('5N-4b: a cross-chain intent with F=0 (quote fail-safe) stays the DIRECT plan', async () => {
  // beforeEach stub throws → fail-safe → F stays 0.
  const r = await createIntent({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  expect(r.status).toBe(201);
  expect(intentRow(String(r.body.id)).forwarding_max_fee_base_units).toBe('0');
  const g = await checkoutGet(String(r.body.id));
  expect(g.body.forwarding).toBe(false);
  const plan = g.body.cctp_source_route as Record<string, unknown>;
  expect(plan.max_fee).toBe('0');
  expect(plan.min_finality_threshold).toBe(0);
});

// ── 5. cross-chain verify invokes detectSourceBurn ──────────────────────────
test('5N-5: cross-chain /checkout/:id/verify calls detectSourceBurn (NOT same-chain verifyPayment)', async () => {
  const seen: { paymentIntentId: string; sourceTxHash: string }[] = [];
  setSourceBurnDetectionForTest(async (input) => {
    seen.push({ paymentIntentId: input.paymentIntentId, sourceTxHash: input.sourceTxHash });
    return burnSuccess({ paymentIntentId: input.paymentIntentId, sourceTxHash: input.sourceTxHash });
  });
  const r = await createIntent({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  const id = String(r.body.id);
  const tx = txHash();
  const v = await checkoutVerify(id, { tx_hash: tx, chain_id: BASE_SEPOLIA_CHAIN });
  expect(seen).toEqual([{ paymentIntentId: id, sourceTxHash: tx }]);
  expect(v.status).toBe(200);
  // A cross-chain verify NEVER creates a same-chain payment credit.
  expect(paymentsFor(id)).toHaveLength(0);
});

// ── 6. cross-chain verify returns processing ────────────────────────────────
test('5N-6: cross-chain /verify returns { status: "processing" } and hands off to the worker', async () => {
  setSourceBurnDetectionForTest(async (input) =>
    burnSuccess({ paymentIntentId: input.paymentIntentId, sourceTxHash: input.sourceTxHash, transferId: 'cct_5n_abc', state: 'source_finalized' }));
  const r = await createIntent({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  const v = await checkoutVerify(String(r.body.id), { tx_hash: txHash(), chain_id: BASE_SEPOLIA_CHAIN });
  expect(v.status).toBe(200);
  expect(v.body.status).toBe('processing');
  expect(v.body.transfer_id).toBe('cct_5n_abc');
  expect(v.body.state).toBe('source_finalized');
});

// ── 6b. a retryable source-burn failure keeps polling as processing ─────────
test('5N-6b: a RETRYABLE source-burn failure (not final yet) still returns processing, never a hard fail', async () => {
  setSourceBurnDetectionForTest(async () => burnFailure('receipt_missing', true, 'source tx not mined yet'));
  const r = await createIntent({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  const v = await checkoutVerify(String(r.body.id), { tx_hash: txHash(), chain_id: BASE_SEPOLIA_CHAIN });
  expect(v.status).toBe(200);
  expect(v.body.status).toBe('processing');
});

// ── 8. invalid source burn remains rejected ─────────────────────────────────
test('5N-8: a NON-retryable invalid source burn is rejected with 422 + machine-readable code', async () => {
  setSourceBurnDetectionForTest(async () => burnFailure('amount_mismatch', false, 'burn amount != M + F'));
  const r = await createIntent({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  const v = await checkoutVerify(String(r.body.id), { tx_hash: txHash(), chain_id: BASE_SEPOLIA_CHAIN });
  expect(v.status).toBe(422);
  expect(v.body.code).toBe('amount_mismatch');
  expect(v.body.status).toBeUndefined(); // not a 'processing' acceptance
});

// ── 9. M + F invariant remains enforced end-to-end ──────────────────────────
test('5N-9: the wired quote yields F from Circle and leaves M intact, so the derived gross is exactly M + F', async () => {
  setForwardingQuoteForTest((input) => applyForwardingQuote({ ...input, fetchImpl: cannedQuoteFetch() }));
  const M = 5000000n;
  const r = await createIntent({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  const id = String(r.body.id);
  const dbRow = intentRow(id);
  const F = BigInt(String(dbRow.forwarding_max_fee_base_units));
  // F is the approved, non-trivial server fee; M is untouched; source gross = M + F.
  expect(F).toBe(BigInt(CANONICAL_FEE_MED));
  expect(BigInt(String(dbRow.amount_base_units))).toBe(M);
  // The checkout route the customer pays against carries max_fee = F (source burn
  // must be M + F); the settlement address stays the merchant Arc wallet = M net.
  const plan = (await checkoutGet(id)).body.cctp_source_route as Record<string, unknown>;
  expect(BigInt(String(plan.max_fee))).toBe(F);
  expect((await checkoutGet(id)).body.settlement_address).toBe(ARC_WALLET);
});

// ── 10. destination settlement remains exactly M ────────────────────────────
test('5N-10: forwarding never changes the merchant settlement target — amount_base_units stays M', async () => {
  setForwardingQuoteForTest((input) => applyForwardingQuote({ ...input, fetchImpl: cannedQuoteFetch() }));
  const r = await createIntent({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  const before = intentRow(String(r.body.id));
  expect(before.amount_base_units).toBe('5000000');   // M
  expect(before.settlement_address).toBe(ARC_WALLET.toLowerCase());
  // Re-fetch after the server quote ran: the ONLY thing the quote may change is F.
  const after = intentRow(String(r.body.id));
  expect(after.amount_base_units).toBe(before.amount_base_units);
  expect(after.settlement_address).toBe(before.settlement_address);
});

// ── 7. same-chain verify behavior remains unchanged ─────────────────────────
test('5N-7: a same-chain intent still runs the FULL unchanged verifyPayment credit path (no detectSourceBurn)', async () => {
  let burnCalled = false;
  setSourceBurnDetectionForTest(async () => { burnCalled = true; return burnSuccess(); });
  const r = await createIntent({ amount: '2.00', currency: 'USDC', network: ARC_TESTNET });
  expect(r.status).toBe(201);
  expect(r.body.cross_chain).toBe(false);
  const id = String(r.body.id);
  mockArcReceipt(ARC_WALLET, 2000000n);
  const v = await checkoutVerify(id, { tx_hash: txHash(), chain_id: ARC_CHAIN });
  expect(v.status).toBe(200);
  expect(v.body.status).toBe('succeeded');
  expect(paymentsFor(id)).toHaveLength(1);
  expect(intentRow(id).status).toBe('succeeded');
  // CHANGE 2 is strictly additive: same-chain NEVER enters the cross-chain branch.
  expect(burnCalled).toBe(false);
});

// ── 11. idempotency remains intact ──────────────────────────────────────────
test('5N-11a: a replayed Idempotency-Key returns the cached intent and quotes F only once', async () => {
  let quoteCalls = 0;
  setForwardingQuoteForTest(async (input) => {
    quoteCalls += 1;
    return applyForwardingQuote({ ...input, fetchImpl: cannedQuoteFetch() });
  });
  const key = `idem_5n_${++seq}`;
  const body = { amount: '5.00', network: 'base_sepolia', cross_chain: true };
  const first = await createIntent(body, { 'Idempotency-Key': key });
  const second = await createIntent(body, { 'Idempotency-Key': key });
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(second.body.id).toBe(first.body.id);
  // The replay short-circuits BEFORE creating a row / quoting, so F is quoted once.
  expect(quoteCalls).toBe(1);
});

test('5N-11b: verifying an already-succeeded intent short-circuits to succeeded without detecting a burn', async () => {
  let burnCalled = false;
  setSourceBurnDetectionForTest(async () => { burnCalled = true; return burnSuccess(); });
  const r = await createIntent({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  const id = String(r.body.id);
  getDb().prepare("UPDATE payment_intents SET status='succeeded' WHERE id=?").run(id);
  const v = await checkoutVerify(id, { tx_hash: txHash(), chain_id: BASE_SEPOLIA_CHAIN });
  expect(v.status).toBe(200);
  expect(v.body.status).toBe('succeeded');
  expect(burnCalled).toBe(false);
});
