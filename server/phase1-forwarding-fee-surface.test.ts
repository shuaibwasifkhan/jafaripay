/**
 * PRODUCT PHASE 1 — money-facing fee surfaces (server, hermetic).
 *
 * Proves the three corrections on the API side WITHOUT any network, quote or
 * chain I/O (the forwarding quote is stubbed through the existing, production
 * test seam `setForwardingQuoteForTest` — the same seam cctp-integration-5n
 * uses; the real quote module keeps its own suites):
 *   • describeForwardingFees / projectStoredFees describe Forwarding ADDITIVELY
 *     (customer M + F, merchant M) — never as a deduction from the principal;
 *   • the intent-CREATE response reports the fee the server actually persisted
 *     (the old hardcoded '0' is gone) and still reports a clean 1:1 Standard
 *     breakdown when no quote exists (DIRECT path byte-identical);
 *   • a client cannot inject F through the create body (ownership intact);
 *   • the merchant amount M in the row is NEVER touched by a fee;
 *   • GET /checkout/:id for a Forwarding intent exposes the exact three numbers
 *     the checkout UI must render (M / F / M + F) and matches the server plan.
 *
 * Namespace *_p1fee_* + disjoint tx family for the shared DB.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';

const TMP_DB = join(import.meta.dir, '..', 'data', `_p1fee_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'p1fee-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const { describeForwardingFees } = await import('./lib/fees.ts');
const { projectStoredFees } = await import('./blockchain/cctp-status.ts');
const intentsModule = await import('./api/payment-intents.ts');
const intentsRouter = intentsModule.default;
const { setForwardingQuoteForTest } = intentsModule;
const checkoutRouter = (await import('./api/checkout.ts')).default;

const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const KEY = 'sk_test_p1fee';
const M_STR = '5000000';       // merchant amount 5.00 USDC
const FEE = '20380';           // simulated server-approved Circle forwarding fee
const hashApiKey = (key: string) =>
  createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

function seedMerchant(): void {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_p1fee', 'P1 fees');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_p1fee', 'merch_p1fee', ARC_WALLET, 'arc_testnet');
  db.prepare(
    'INSERT OR IGNORE INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)',
  ).run('ak_p1fee', 'merch_p1fee', null, 'p1fee', 'sk_test_', hashApiKey(KEY), KEY, 1, 'test');
}

async function postIntent(body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/v1/payment-intents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeAll(() => {
  migrate();
  seedMerchant();
  const app = express();
  app.use(express.json());
  app.use('/v1/payment-intents', intentsRouter);
  app.use('/checkout', checkoutRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => {
  setForwardingQuoteForTest(null);
  server.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ── P1-1 (§14 A/F unit): Forwarding is ADDITIVE, never a deduction ──────────
test('P1-1: describeForwardingFees projects customer M + F and merchant M, all lanes consistent', () => {
  const f = describeForwardingFees({ merchantAmountBaseUnits: M_STR, forwardingFeeBaseUnits: FEE });
  expect(f.model).toBe('cctp_forwarding_additive');
  expect(f.gross_amount_base_units).toBe('5020380');           // customer burns M + F
  expect(f.gross_amount_decimal).toBe('5.020380');
  expect(f.net_amount_base_units).toBe(M_STR);                 // merchant nets EXACTLY M
  expect(f.net_amount_decimal).toBe('5.000000');
  expect(f.cctp_max_fee_base_units).toBe(FEE);                 // the burn carries maxFee = F
  expect(f.forwarding_fee_base_units).toBe(FEE);
  expect(f.forwarding_fee_decimal).toBe('0.020380');
  expect(f.merchant_amount_base_units).toBe(M_STR);
  expect(f.platform_fee_base_units).toBe('0');                 // JafariPay levies nothing
  expect(f.is_one_to_one).toBe(false);                         // never claim 1:1 here
});

// ── P1-2: a STORED transfer fee only ever means Forwarding; 0/garbage = Standard ─
test('P1-2: projectStoredFees branches on the persisted fee, garbage degrades to Standard', () => {
  const fwd = projectStoredFees(M_STR, FEE);
  expect(fwd.model).toBe('cctp_forwarding_additive');
  expect(fwd.net_amount_base_units).toBe(M_STR);               // merchant NOT short-paid by F
  expect(fwd.gross_amount_base_units).toBe('5020380');

  const direct = projectStoredFees(M_STR, '0');
  expect(direct.model).toBe('cctp_standard_1to1');
  expect(direct.is_one_to_one).toBe(true);

  const junk = projectStoredFees(M_STR, 'not-a-number');
  expect(junk.model).toBe('cctp_standard_1to1');               // fail-safe, never throws
});

// ── P1-3 (§14 F + E): create response reports the ACTUAL persisted fee ──────
test('P1-3: intent creation with a server-approved quote returns forwarding fees M / F / M+F', async () => {
  setForwardingQuoteForTest(async (input) => {
    // Mirrors the real applyForwardingQuote persistence step (its own suites
    // prove the quote math); here we prove the RESPONSE reads the persisted F.
    getDb().prepare('UPDATE payment_intents SET forwarding_max_fee_base_units=? WHERE id=?').run(FEE, input.paymentIntentId);
    return { settlementAmountBaseUnits: BigInt(M_STR), approvedMaxFeeBaseUnits: BigInt(FEE), grossBurnBaseUnits: BigInt(M_STR) + BigInt(FEE) };
  });
  const r = await postIntent({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  expect(r.status).toBe(201);
  const fees = r.body.fees as Record<string, unknown>;
  expect(fees.model).toBe('cctp_forwarding_additive');
  expect(fees.merchant_amount_base_units).toBe(M_STR);
  expect(fees.forwarding_fee_base_units).toBe(FEE);
  expect(fees.gross_amount_base_units).toBe('5020380');        // total M + F
  expect(fees.is_one_to_one).toBe(false);
  // §14 E: the merchant settlement amount M is untouched by the fee.
  expect(r.body.amount_base_units).toBe(M_STR);
  const row = getDb().prepare('SELECT amount_base_units,forwarding_max_fee_base_units FROM payment_intents WHERE id=?')
    .get(r.body.id as string) as { amount_base_units: string; forwarding_max_fee_base_units: string };
  expect(row.amount_base_units).toBe(M_STR);
  expect(row.forwarding_max_fee_base_units).toBe(FEE);
});

// ── P1-4 (§14 B): failed/absent quote keeps the clean DIRECT Standard surface ─
test('P1-4: with no quote (fail-safe DIRECT) the create response is the unchanged Standard 1:1', async () => {
  setForwardingQuoteForTest(async () => { throw new Error('hermetic test: no live Circle quote'); });
  const r = await postIntent({ amount: '4.00', network: 'base_sepolia', cross_chain: true });
  expect(r.status).toBe(201);
  const fees = r.body.fees as Record<string, unknown>;
  expect(fees.model).toBe('cctp_standard_1to1');
  expect(fees.is_one_to_one).toBe(true);
  expect(fees.net_amount_base_units).toBe('4000000');
  expect('forwarding_fee_base_units' in fees).toBe(false);     // no misleading fee row
});

// ── P1-5 (§14 D): a client cannot inject F through the create body ───────────
test('P1-5: client-supplied forwarding fee fields in the POST body are ignored', async () => {
  setForwardingQuoteForTest(async () => { throw new Error('hermetic test: no live Circle quote'); });
  const r = await postIntent({
    amount: '6.00', network: 'base_sepolia', cross_chain: true,
    forwarding_max_fee_base_units: '999999', max_fee: '999999', fees: { forwarding_fee_base_units: '999999' },
  });
  expect(r.status).toBe(201);
  const row = getDb().prepare('SELECT forwarding_max_fee_base_units FROM payment_intents WHERE id=?')
    .get(r.body.id as string) as { forwarding_max_fee_base_units: string };
  expect(row.forwarding_max_fee_base_units).toBe('0');         // server never authored a fee
  const fees = r.body.fees as Record<string, unknown>;
  expect(fees.model).toBe('cctp_standard_1to1');               // and the response says so
});

// ── P1-6 (§14 A backend): checkout GET exposes the exact three numbers ──────
test('P1-6: GET /checkout/:id on a Forwarding intent returns M / F / M + F and the matching plan', async () => {
  setForwardingQuoteForTest(async (input) => {
    getDb().prepare('UPDATE payment_intents SET forwarding_max_fee_base_units=? WHERE id=?').run(FEE, input.paymentIntentId);
    return { settlementAmountBaseUnits: BigInt(M_STR), approvedMaxFeeBaseUnits: BigInt(FEE), grossBurnBaseUnits: BigInt(M_STR) + BigInt(FEE) };
  });
  const created = await postIntent({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  expect(created.status).toBe(201);
  const id = String(created.body.id);

  const res = await fetch(`${baseUrl}/checkout/${id}`);
  expect(res.status).toBe(200);
  const body = await res.json() as Record<string, unknown>;
  expect(body.cross_chain).toBe(true);
  expect(body.forwarding).toBe(true);
  const fees = body.fees as Record<string, unknown>;
  expect(fees.model).toBe('cctp_forwarding_additive');
  expect(fees.merchant_amount_decimal).toBe('5.000000');       // M shown to the customer
  expect(fees.forwarding_fee_decimal).toBe('0.020380');        // F shown to the customer
  expect(fees.gross_amount_decimal).toBe('5.020380');          // M + F shown to the customer
  // The gross the UI displays is the gross the SERVER plan carries (approve/burn).
  const plan = body.cctp_source_route as Record<string, unknown>;
  expect(plan.max_fee).toBe(FEE);
  expect(BigInt(String(fees.gross_amount_base_units))).toBe(BigInt(M_STR) + BigInt(FEE));
});
