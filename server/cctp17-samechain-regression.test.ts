/**
 * CCTP MASTER PHASE 17 — ARC SAME-CHAIN REGRESSION GATE.
 *
 * The cross-chain build is meant to be STRICTLY ADDITIVE: an Arc→Arc payment
 * must settle, credit, receipt and webhook EXACTLY as it did before any CCTP
 * code existed, and none of the cross-chain projections (status, fees) may ever
 * leak into a same-chain record. This file is the standing gate that proves it:
 *
 *   P17-1  a real same-chain Arc settlement still runs the FULL unchanged money
 *          path: /checkout/:id/verify → succeeded, exactly one credited payment,
 *          one payment.succeeded webhook delivery, one receipt.
 *   P17-2  the same-chain surface is byte-for-byte unchanged: the createIntent
 *          response carries no `fees` / `settlement_network`, no
 *          cross_chain_transfers row is ever created, and the merchant
 *          GET /:id adds no `cross_chain` key (PHASE 13/14 stay null here).
 *   P17-3  same-chain replay/idempotency holds: verifying the SAME tx again
 *          never produces a second payment (money-safety unchanged).
 *   P17-4  status projection for a same-chain intent is null, while the same
 *          merchant's one pinned Arc wallet backs BOTH same-chain and a
 *          cross-chain intent — proving the two journeys stay isolated.
 *
 * NO real network: the Arc receipt is a narrowly-mocked provider read (the same
 * technique as phase5c), but the REAL route handlers + verifyPayment rules run
 * unmodified. Per-file isolated DB (no shared-DB pollution).
 */
import { test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctp17_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp17-test-secret';
process.env.EMAIL_TRANSPORT = 'dev';

const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');
const { loadCrossChainStatus } = await import('./blockchain/cctp-status.ts');
const checkoutRouter = (await import('./api/checkout.ts')).default;
const intentsModule = await import('./api/payment-intents.ts');
const intentsRouter = intentsModule.default;
const { setForwardingQuoteForTest } = intentsModule;

const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const ARC_TESTNET = 'arc_testnet';
const ARC_CHAIN = 5042002;
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const KEY = 'sk_test_cctp17';
const AMOUNT = '2.00';
const AMOUNT_BASE = '2000000';

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const hashApiKey = (key: string) => createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let seq = 0;
const txHash = () => '0x' + 'a7'.repeat(31) + ((++seq) % 256).toString(16).padStart(2, '0');

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

async function createIntent(body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/v1/payment-intents`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function checkoutVerify(id: string, hash: string, chainId: number) {
  const res = await fetch(`${baseUrl}/checkout/${id}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tx_hash: hash, chain_id: chainId }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function merchantGet(id: string, key = KEY) {
  const res = await fetch(`${baseUrl}/v1/payment-intents/${id}`, { headers: { Authorization: `Bearer ${key}` } });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const paymentsFor = (piId: string) => (getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').all(piId) as { id: string }[]);
const countWhere = (sql: string, ...p: (string | number)[]) => (getDb().prepare(sql).get(...p) as { n: number }).n;

beforeAll(() => {
  migrate();
  // STEP 5N: keep the cross-chain create hermetic — stub the live Circle
  // Forwarding quote to fail so F stays the '0' default. P17-4's cross-chain
  // intent only asserts journey ISOLATION (a manually-seeded transfer row), so
  // the fail-safe DIRECT path preserves every assertion UNWEAKENED with no
  // live network I/O.
  setForwardingQuoteForTest(async () => { throw new Error('hermetic test: no live Circle quote'); });
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctp17', 'P17 merchant');
  // ONE pinned Arc wallet — reused by both the same-chain AND cross-chain intent.
  db.prepare('INSERT INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_cctp17', 'merch_cctp17', ARC_WALLET.toLowerCase(), ARC_TESTNET);
  db.prepare(
    'INSERT INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)',
  ).run('ak_cctp17', 'merch_cctp17', null, 'p17', KEY.slice(0, 8), hashApiKey(KEY), KEY.slice(0, 12), 1, 'test');
  db.prepare(
    `INSERT INTO webhook_endpoints(id,merchant_id,url,secret_hash,secret_preview,description,events,environment,is_active)
     VALUES(?,?,?,?,?,?,?,?,1)`,
  ).run('whe_cctp17', 'merch_cctp17', 'https://merchant.example.com/hook', 'hash', 'abcd', 'p17', JSON.stringify(['payment.succeeded']), 'test');

  const app = express();
  app.use(express.json());
  app.use('/checkout', checkoutRouter);
  app.use('/v1/payment-intents', intentsRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(() => {
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockRestore();
  spyOn(arc.ArcProvider.prototype, 'getLatestBlockNumber').mockRestore();
});

afterAll(() => {
  setForwardingQuoteForTest(null);
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) { try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ } }
});

// ── P17-1: unchanged same-chain Arc money path still fully settles ──────────
test('P17-1: same-chain Arc intent credits via /checkout/:id/verify (payment + webhook + receipt)', async () => {
  const created = await createIntent({ amount: AMOUNT, currency: 'USDC', network: ARC_TESTNET, order_id: 'P17-1' });
  expect(created.status).toBe(201);
  const id = String(created.body.id);
  expect(created.body.chain_id).toBe(ARC_CHAIN);
  expect(created.body.usdc_address).toBe(ARC_USDC);
  expect(created.body.settlement_address).toBe(ARC_WALLET.toLowerCase());

  mockArcReceipt(ARC_WALLET.toLowerCase(), BigInt(AMOUNT_BASE));
  const v = await checkoutVerify(id, txHash(), ARC_CHAIN);
  expect(v.status).toBe(200);
  expect(v.body.status).toBe('succeeded');

  expect(getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(id)).toEqual({ status: 'succeeded' });
  expect(paymentsFor(id)).toHaveLength(1);
  expect(countWhere("SELECT count(*) n FROM webhook_deliveries WHERE payment_intent_id=? AND event_type='payment.succeeded'", id)).toBe(1);
  expect(countWhere('SELECT count(*) n FROM receipts WHERE payment_intent_id=?', id)).toBe(1);
});

// ── P17-2: same-chain surface is byte-for-byte unchanged (additive-only) ─────
test('P17-2: same-chain create/get carry no cross-chain keys; no transfer row is created', async () => {
  const created = await createIntent({ amount: AMOUNT, currency: 'USDC', network: ARC_TESTNET, order_id: 'P17-2' });
  const id = String(created.body.id);
  // No PHASE 14 fees, no PHASE 3 settlement columns leaked into the same-chain shape.
  expect('fees' in created.body).toBe(false);
  expect(created.body.cross_chain).toBe(false);
  expect(created.body.settlement_network).toBeUndefined();

  mockArcReceipt(ARC_WALLET.toLowerCase(), BigInt(AMOUNT_BASE));
  await checkoutVerify(id, txHash(), ARC_CHAIN);

  // The cross-chain ledger is never touched by a same-chain payment.
  expect(countWhere('SELECT count(*) n FROM cross_chain_transfers WHERE payment_intent_id=?', id)).toBe(0);

  // PHASE 13 merchant GET adds NO cross_chain key for a same-chain intent.
  const g = await merchantGet(id);
  expect(g.status).toBe(200);
  expect('cross_chain' in g.body).toBe(false);
});

// ── P17-3: same-chain replay/idempotency still holds ────────────────────────
test('P17-3: verifying the same tx twice never produces a second payment', async () => {
  const created = await createIntent({ amount: AMOUNT, currency: 'USDC', network: ARC_TESTNET, order_id: 'P17-3' });
  const id = String(created.body.id);
  const hash = txHash();
  mockArcReceipt(ARC_WALLET.toLowerCase(), BigInt(AMOUNT_BASE));

  const first = await checkoutVerify(id, hash, ARC_CHAIN);
  expect(first.status).toBe(200);
  expect(paymentsFor(id)).toHaveLength(1);

  // Same tx replayed — must NOT double-credit.
  const second = await checkoutVerify(id, hash, ARC_CHAIN);
  expect([200, 400, 409, 422]).toContain(second.status);
  expect(paymentsFor(id)).toHaveLength(1);
  expect(countWhere("SELECT count(*) n FROM webhook_deliveries WHERE payment_intent_id=? AND event_type='payment.succeeded'", id)).toBe(1);
});

// ── P17-4: same-chain vs cross-chain isolation across the ONE Arc wallet ─────
test('P17-4: same-chain status projection is null; cross-chain row projects independently on the same wallet', async () => {
  // Same-chain intent for the merchant.
  const sameChain = await createIntent({ amount: AMOUNT, currency: 'USDC', network: ARC_TESTNET, order_id: 'P17-4-sc' });
  const scId = String(sameChain.body.id);
  expect(loadCrossChainStatus(scId)).toBeNull();

  // A cross-chain intent on the SAME merchant/wallet gets a real transfer row →
  // the projection lights up for it, while the same-chain intent stays null.
  const cross = await createIntent({ amount: AMOUNT, currency: 'USDC', network: 'base_sepolia', cross_chain: true });
  expect(cross.status).toBe(201);
  const ccId = String(cross.body.id);
  getDb().prepare(
    `INSERT INTO cross_chain_transfers(id,payment_intent_id,source_network,source_chain_id,source_usdc_address,token_messenger,
      source_tx_hash,destination_network,destination_chain_id,mint_recipient,amount_base_units,attestation_status,state,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(`cct_cctp17_${ccId}`, ccId, 'base_sepolia', 84532, SRC_USDC, '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    '0x' + 'b7'.repeat(32), 'arc_testnet', ARC_CHAIN, ARC_WALLET, AMOUNT_BASE, 'none', 'source_finalized', 2000);

  expect(loadCrossChainStatus(scId)).toBeNull();          // same-chain STILL isolated
  const cc = loadCrossChainStatus(ccId);
  expect(cc).not.toBeNull();
  expect(cc!.status).toBe('awaiting_attestation');
  expect(cc!.fees.is_one_to_one).toBe(true);
});
