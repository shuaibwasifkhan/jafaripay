/**
 * CCTP MASTER PHASE 13 — cross-chain status projection + dashboard/API surface.
 *
 * Proves the READ-ONLY journey view:
 *   • projectCrossChainStatus is a PURE, TOTAL function of a transfer row — every
 *     one of the 13 PHASE 9 states maps to a sane bucket/timeline, an unknown
 *     state never throws, terminality matches the state machine, and NO money or
 *     state is ever implied;
 *   • loadCrossChainStatus returns null for a same-chain intent (so legacy
 *     response shapes are preserved byte-for-byte) and the projected view for a
 *     real cross-chain transfer;
 *   • the merchant GET /:id and public GET /:id/public endpoints ADD a
 *     `cross_chain` block ONLY for a cross-chain intent with a transfer row, stay
 *     TENANT-ISOLATED (a foreign key 404s), and NEVER leak the attestation
 *     signature or internal back-off bookkeeping.
 *
 * Namespace (*_cctp13_*) + disjoint '0xd3..' tx family — `bun test` shares ONE
 * sqlite DB, so collisions would corrupt another suite.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import express from 'express';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctp13_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp13-test-secret';

// schema.ts is imported dynamically (after DATABASE_URL) so DB_PATH is never
// frozen to the shared default; the routers are then imported dynamically too.
const { migrate, getDb } = await import('./db/schema.ts');
const { projectCrossChainStatus, loadCrossChainStatus, CROSS_CHAIN_MILESTONE_KEYS } =
  await import('./blockchain/cctp-status.ts');
const { CCTP_STATES } = await import('./blockchain/cctp-state.ts');
import type { CrossChainTransferRow } from './blockchain/cctp-status.ts';
const intentsRouter = (await import('./api/payment-intents.ts')).default;
const paymentsRouter = (await import('./api/payments.ts')).default;

const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const hashApiKey = (key: string) =>
  createHmac('sha256', process.env.API_KEY_HMAC_SECRET!).update(key).digest('hex');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

/** A fully-populated transfer row for the PURE projection (no DB needed). */
function fakeRow(state: string): CrossChainTransferRow {
  return {
    id: 'cct_cctp13_fake', payment_intent_id: 'pi_cctp13_fake',
    source_network: 'base_sepolia', source_chain_id: 84532,
    source_tx_hash: '0x' + 'd3'.repeat(32), source_block_number: 111, source_finalized_at: 1000,
    cctp_message_id: '0x' + 'aa'.repeat(32),
    destination_network: 'arc_testnet', destination_chain_id: 5042002,
    destination_tx_hash: state === 'settled' ? '0x' + 'd4'.repeat(32) : null, destination_block_number: null,
    mint_recipient: ARC_WALLET, amount_base_units: '5000000', fee_base_units: '0',
    attestation_status: 'none', claim_status: 'none', state, failure_reason: null,
    created_at: 1000, updated_at: 2000,
  };
}

function seedTransfer(intentId: string, state: string, attestationStatus = 'none', attestation: string | null = null): void {
  getDb().prepare(
    `INSERT INTO cross_chain_transfers(id,payment_intent_id,source_network,source_chain_id,source_usdc_address,token_messenger,
      source_tx_hash,source_finalized_at,cctp_message_id,destination_network,destination_chain_id,mint_recipient,
      amount_base_units,attestation,attestation_status,state,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(`cct_cctp13_${intentId}`, intentId, 'base_sepolia', 84532, SRC_USDC, '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    '0x' + 'd3'.repeat(31) + intentId.slice(-2), 1000, '0x' + 'aa'.repeat(32),
    'arc_testnet', 5042002, ARC_WALLET, '5000000', attestation, attestationStatus, state, 2000);
}

function insertMerchant(id: string): void {
  getDb().prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run(id, id);
}
function insertWallet(id: string, merchantId: string): void {
  getDb().prepare('INSERT INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run(id, merchantId, ARC_WALLET.toLowerCase(), 'arc_testnet');
}
function insertApiKey(id: string, merchantId: string, key: string): void {
  getDb().prepare(
    'INSERT INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment,is_active) VALUES(?,?,?,?,?,?,?,?,?,1)',
  ).run(id, merchantId, null, 'p13', key.slice(0, 8), hashApiKey(key), key.slice(0, 12), 1, 'test');
}
/** Insert a cross-chain intent directly (is_cross_chain=1) and return its id. */
function insertIntent(id: string, merchantId: string, walletId: string, crossChain: boolean): void {
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
      amount_decimal,amount_base_units,environment,status,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, merchantId, walletId, ARC_WALLET, 'base_sepolia', 84532, SRC_USDC, '5.00', '5000000',
    'test', 'processing', 9_999_999_999, crossChain ? 1 : 0, crossChain ? 'base_sepolia' : null, crossChain ? 'arc_testnet' : null, crossChain ? 5042002 : null);
}
async function getIntentsRoute(path: string, key: string) {
  const res = await fetch(`${baseUrl}/v1/payment-intents/${path}`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeAll(() => {
  migrate();
  const app = express();
  app.use(express.json());
  app.use('/v1/payment-intents', intentsRouter);
  app.use('/payments', paymentsRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => {
  server.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ── P13-1: pure projection is total over the whole PHASE 9 state set ─────────
test('P13-1: every canonical state projects to a sane bucket/timeline; failures/terminal match the machine', () => {
  for (const state of CCTP_STATES as readonly string[]) {
    const v = projectCrossChainStatus(fakeRow(state));
    expect(v.state).toBe(state);
    expect(v.total_milestones).toBe(CROSS_CHAIN_MILESTONE_KEYS.length);
    expect(v.milestones.length).toBe(CROSS_CHAIN_MILESTONE_KEYS.length);
    // The last milestone is only "done" for a settled transfer.
    expect(v.milestones[v.milestones.length - 1].done).toBe(state === 'settled');
    expect(v.is_succeeded).toBe(state === 'settled');
    if (state === 'settled') { expect(v.status).toBe('completed'); expect(v.is_terminal).toBe(true); }
    else if (['attestation_timeout', 'destination_failed', 'source_reorg', 'verification_failed'].includes(state)) {
      expect(v.status).toBe('failed'); expect(v.is_failed).toBe(true); expect(v.is_terminal).toBe(true); expect(v.is_in_progress).toBe(false);
    } else if (['source_finalized', 'attestation_pending'].includes(state)) {
      expect(v.status).toBe('awaiting_attestation'); expect(v.is_in_progress).toBe(true);
    } else if (['attested', 'destination_pending', 'destination_submitted', 'destination_confirmed'].includes(state)) {
      expect(v.status).toBe('awaiting_settlement'); expect(v.is_in_progress).toBe(true);
    } else { // source_payment_submitted / source_finalizing
      expect(v.status).toBe('in_progress'); expect(v.is_in_progress).toBe(true);
    }
  }
});

// ── P13-2: an unknown state yields a safe, non-throwing view ─────────────────
test('P13-2: an unknown state never throws and defaults to a zero-progress in-progress view', () => {
  const v = projectCrossChainStatus(fakeRow('not_a_real_state'));
  expect(v.status).toBe('in_progress');
  expect(v.milestone_index).toBe(0);
  expect(v.is_terminal).toBe(false);
  expect(v.milestones.every(m => !m.done)).toBe(true);
});

// ── P13-3: the loader returns null for a same-chain intent (shape preserved) ──
test('P13-3: loadCrossChainStatus is null for a same-chain intent (no transfer row)', () => {
  insertMerchant('merch_cctp13_sc');
  insertWallet('sw_cctp13_sc', 'merch_cctp13_sc');
  insertIntent('pi_cctp13_sc', 'merch_cctp13_sc', 'sw_cctp13_sc', false);
  expect(loadCrossChainStatus('pi_cctp13_sc')).toBeNull();
});

// ── P13-4: the loader projects a seeded cross-chain transfer ─────────────────
test('P13-4: loadCrossChainStatus projects a seeded cross-chain transfer row', () => {
  insertMerchant('merch_cctp13_a');
  insertWallet('sw_cctp13_a', 'merch_cctp13_a');
  insertIntent('pi_cctp13_a', 'merch_cctp13_a', 'sw_cctp13_a', true);
  seedTransfer('pi_cctp13_a', 'attested', 'complete', '0xSIG');
  const v = loadCrossChainStatus('pi_cctp13_a')!;
  expect(v.state).toBe('attested');
  expect(v.status).toBe('awaiting_settlement');
  expect(v.transfer_id).toBe('cct_cctp13_pi_cctp13_a');
});

// ── P13-5: merchant GET /:id adds cross_chain ONLY for cross-chain ───────────
test('P13-5: merchant intent GET adds cross_chain for cross-chain, omits it for same-chain', async () => {
  insertApiKey('ak_cctp13_a', 'merch_cctp13_a', 'sk_test_cctp13_a');
  insertApiKey('ak_cctp13_sc', 'merch_cctp13_sc', 'sk_test_cctp13_sc');

  const cc = await getIntentsRoute('pi_cctp13_a', 'sk_test_cctp13_a');
  expect(cc.status).toBe(200);
  expect(cc.body.cross_chain).toBeTruthy();
  expect((cc.body.cross_chain as Record<string, unknown>).status).toBe('awaiting_settlement');

  const sc = await getIntentsRoute('pi_cctp13_sc', 'sk_test_cctp13_sc');
  expect(sc.status).toBe(200);
  expect('cross_chain' in sc.body).toBe(false); // same-chain shape untouched
});

// ── P13-6: tenant isolation — a foreign merchant key 404s the intent ─────────
test('P13-6: a foreign merchant API key cannot read another merchant cross-chain intent', async () => {
  insertMerchant('merch_cctp13_b');
  insertApiKey('ak_cctp13_b', 'merch_cctp13_b', 'sk_test_cctp13_b');
  const res = await getIntentsRoute('pi_cctp13_a', 'sk_test_cctp13_b');
  expect(res.status).toBe(404);
});

// ── P13-7: public checkout status adds cross_chain but never leaks secrets ───
test('P13-7: public checkout status exposes the journey but never the attestation signature', async () => {
  const pub = await getIntentsRoute('pi_cctp13_a/public', '');
  expect(pub.status).toBe(200);
  const cc = pub.body.cross_chain as Record<string, unknown>;
  expect(cc).toBeTruthy();
  expect(cc.state).toBe('attested');
  // attestation signature + internal fields are NOT part of the view at all.
  expect('attestation' in cc).toBe(false);
  expect(JSON.stringify(pub.body)).not.toContain('0xSIG');

  const pubSc = await getIntentsRoute('pi_cctp13_sc/public', '');
  expect('cross_chain' in pubSc.body).toBe(false);
});
