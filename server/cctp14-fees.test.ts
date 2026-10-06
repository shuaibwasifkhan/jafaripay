/**
 * CCTP MASTER PHASE 14 — cross-chain fee-model exposure.
 *
 * Proves the fee model is EXPOSED honestly and additively — nothing is charged
 * or moved here; the intent/transfer amounts stay authoritative:
 *   • describeCrossChainFees is PURE: a Standard CCTP transfer is 1:1 (net ==
 *     gross, every fee lane 0); a hypothetical observed/platform fee lowers net
 *     and flips is_one_to_one; an oversized/garbage fee value CLAMPS net at zero
 *     and never throws or implies a negative payout;
 *   • the cross-chain STATUS view now carries that breakdown (so the merchant
 *     GET, the public GET and the dashboard payment detail all surface it for
 *     free);
 *   • the merchant intent-creation response includes `fees` for a CROSS-CHAIN
 *     intent and omits it entirely for a same-chain one (legacy shape intact).
 *
 * Namespace (*_cctp14_*) + disjoint '0xe3..' tx family for the shared DB.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctp14_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp14-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const { describeCrossChainFees } = await import('./lib/fees.ts');
const { loadCrossChainStatus } = await import('./blockchain/cctp-status.ts');
const intentsModule = await import('./api/payment-intents.ts');
const intentsRouter = intentsModule.default;
const { setForwardingQuoteForTest } = intentsModule;

const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const hashApiKey = (key: string) =>
  createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

function seedTransfer(intentId: string, feeBaseUnits: string): void {
  getDb().prepare(
    `INSERT INTO cross_chain_transfers(id,payment_intent_id,source_network,source_chain_id,source_usdc_address,token_messenger,
      source_tx_hash,source_finalized_at,destination_network,destination_chain_id,mint_recipient,amount_base_units,
      fee_base_units,attestation_status,state,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(`cct_cctp14_${intentId}`, intentId, 'base_sepolia', 84532, SRC_USDC, '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    '0x' + 'e3'.repeat(31) + intentId.slice(-2), 1000, 'arc_testnet', 5042002, ARC_WALLET, '5000000',
    feeBaseUnits, 'complete', 'settled', 2000);
}

beforeAll(() => {
  migrate();
  // STEP 5N: keep the cross-chain create hermetic — stub the live Circle
  // Forwarding quote to fail so F stays the '0' default (the route's fail-safe
  // DIRECT path). P14-5 asserts the intent-creation fee EXPOSURE (net == gross,
  // merchant still nets M), which is exactly what a '0' fee projects, so this
  // preserves the assertion UNWEAKENED without any live network I/O.
  setForwardingQuoteForTest(async () => { throw new Error('hermetic test: no live Circle quote'); });
  const app = express();
  app.use(express.json());
  app.use('/v1/payment-intents', intentsRouter);
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

// ── P14-1: Standard transfer is a clean 1:1, all fee lanes zero ──────────────
test('P14-1: a Standard (zero-fee) transfer projects a 1:1 breakdown with every lane at zero', () => {
  const f = describeCrossChainFees({ amountBaseUnits: '5000000', feeBaseUnits: '0' });
  expect(f.model).toBe('cctp_standard_1to1');
  expect(f.currency).toBe('USDC');
  expect(f.gross_amount_base_units).toBe('5000000');
  expect(f.gross_amount_decimal).toBe('5.000000');
  expect(f.platform_fee_base_units).toBe('0');
  expect(f.cctp_max_fee_base_units).toBe('0');
  expect(f.cctp_fee_executed_base_units).toBe('0');
  expect(f.net_amount_base_units).toBe('5000000');
  expect(f.net_amount_decimal).toBe('5.000000');
  expect(f.is_one_to_one).toBe(true);
});

// ── P14-2: an observed/platform fee lowers net and breaks 1:1 ────────────────
test('P14-2: non-zero observed CCTP + platform fees reduce the merchant net and flag non-1:1', () => {
  const f = describeCrossChainFees({ amountBaseUnits: '5000000', feeBaseUnits: '1000', platformFeeBaseUnits: '500' });
  expect(f.net_amount_base_units).toBe('4998500');
  expect(f.net_amount_decimal).toBe('4.998500');
  expect(f.is_one_to_one).toBe(false);
});

// ── P14-3: oversized / garbage fee values clamp safely at zero net ───────────
test('P14-3: net clamps at zero for an oversized fee and garbage strings degrade to zero, never throwing', () => {
  const over = describeCrossChainFees({ amountBaseUnits: '1000', feeBaseUnits: '99999999' });
  expect(over.net_amount_base_units).toBe('0');
  expect(over.net_amount_decimal).toBe('0.000000');

  const junk = describeCrossChainFees({ amountBaseUnits: 'not-a-number', feeBaseUnits: 'oops' });
  expect(junk.gross_amount_base_units).toBe('0');
  expect(junk.cctp_fee_executed_base_units).toBe('0');
  expect(junk.net_amount_base_units).toBe('0');
  expect(junk.is_one_to_one).toBe(true); // 0 == 0
});

// ── P14-4: the status view carries the fee breakdown ─────────────────────────
test('P14-4: loadCrossChainStatus projects the fee breakdown onto the journey view', () => {
  getDb().prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctp14', 'P14');
  getDb().prepare('INSERT INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_cctp14', 'merch_cctp14', ARC_WALLET, 'arc_testnet');
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
      amount_decimal,amount_base_units,environment,status,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('pi_cctp14', 'merch_cctp14', 'sw_cctp14', ARC_WALLET, 'base_sepolia', 84532, SRC_USDC, '5.00', '5000000',
    'test', 'succeeded', 9_999_999_999, 1, 'base_sepolia', 'arc_testnet', 5042002);
  seedTransfer('pi_cctp14', '0');
  const v = loadCrossChainStatus('pi_cctp14')!;
  expect(v.fees.net_amount_base_units).toBe('5000000');
  expect(v.fees.is_one_to_one).toBe(true);
});

// ── P14-5: merchant intent API returns fees for cross-chain, none same-chain ─
test('P14-5: intent-creation response includes fees for cross-chain and omits it for same-chain', async () => {
  getDb().prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctp14k', 'P14k');
  getDb().prepare('INSERT INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_cctp14k', 'merch_cctp14k', ARC_WALLET, 'arc_testnet');
  getDb().prepare(
    'INSERT INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)',
  ).run('ak_cctp14k', 'merch_cctp14k', null, 'p14', 'sk_test_', hashApiKey('sk_test_cctp14k'), 'sk_test_cctp14k', 1, 'test');

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(`${baseUrl}/v1/payment-intents`, {
      method: 'POST', headers: { Authorization: 'Bearer sk_test_cctp14k', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  const cc = await post({ amount: '5.00', network: 'base_sepolia', cross_chain: true });
  expect(cc.status).toBe(201);
  const fees = cc.body.fees as Record<string, unknown>;
  expect(fees).toBeTruthy();
  expect(fees.is_one_to_one).toBe(true);
  expect(fees.net_amount_base_units).toBe(cc.body.amount_base_units);

  // A same-chain intent keeps its exact prior shape — NO fees key is added.
  const sc = await post({ amount: '3.00', network: 'arc_testnet' });
  expect(sc.status).toBe(201);
  expect('fees' in sc.body).toBe(false);
});
