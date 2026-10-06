/**
 * CCTP MASTER PHASE 2 — cross-chain data model + migration gate.
 *
 * Proves the PHASE 2 schema change is ADDITIVE, BACKWARD-COMPATIBLE and
 * IDEMPOTENT, and that the new cross_chain_transfers table enforces the
 * storage-layer invariants the later phases rely on:
 *   • payment_intents gains source/settlement decoupling columns that are
 *     NULL (and is_cross_chain=0) for legacy same-chain rows — so no existing
 *     intent is rewritten and same-chain behaviour is unchanged.
 *   • the payment_intents DDL still carries NO finality/confirmation/mode
 *     column (the phase5h invariant) — new names avoid those tokens.
 *   • cross_chain_transfers enforces: one transfer per intent, partial UNIQUE
 *     replay indexes (source tx, burn msg, message id, destination tx), and
 *     CHECK-bounded attestation/claim/state enums.
 *   • migrate() run twice is a no-op (no duplicate table/column/FK errors).
 * Pure schema — no DB network calls, no money.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctpschema_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp-schema-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');

const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';

function tableExists(name: string): boolean {
  return getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== null;
}
function columnsOf(table: string): Set<string> {
  return new Set((getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}
function intentDdl(): string {
  return (getDb().prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='payment_intents'`).get() as { sql: string }).sql;
}

// A minimal valid legacy same-chain intent (only the pre-PHASE-2 columns).
function insertLegacyIntent(id: string): void {
  getDb()
    .prepare(
      `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,environment,expires_at)
       VALUES(?,?,?,?,?,?,?,?,?, 'test', 9999999999)`
    )
    .run(id, 'merch_p2', 'sw_p2', ARC_WALLET, 'arc_testnet', 5042002, '0x3600000000000000000000000000000000000000', '1.00', '1000000');
}

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_p2', 'PHASE 2 test merchant');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)').run('sw_p2', 'merch_p2', ARC_WALLET, 'arc_testnet');
});

afterAll(() => {
  // Release the shared bun-test module-registry DB handle BEFORE deleting, so the
  // next suite's getDb() reopens cleanly (matches the master-reconciliation
  // convention). Without the close the lingering handle corrupts later suites.
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('P2-1: migrate() is idempotent — running it a second time never errors', () => {
  expect(() => migrate()).not.toThrow();
  expect(() => migrate()).not.toThrow();
});

test('P2-2: payment_intents gained the source/settlement decoupling columns', () => {
  const cols = columnsOf('payment_intents');
  for (const c of ['source_network', 'source_chain_id', 'settlement_network', 'settlement_chain_id', 'is_cross_chain']) {
    expect(cols.has(c)).toBe(true);
  }
});

test('P2-3: the new payment_intents columns carry no forbidden finality/confirmation/mode token', () => {
  const ddl = intentDdl();
  expect(ddl).not.toMatch(/finality/i);
  expect(ddl).not.toMatch(/confirmation/i);
  expect(ddl).not.toMatch(/mode/i);
});

test('P2-4: a legacy same-chain intent is valid and self-classifies as non-cross-chain', () => {
  insertLegacyIntent('pi_p2_legacy');
  const row = getDb().prepare('SELECT is_cross_chain, source_network, settlement_network FROM payment_intents WHERE id=?').get('pi_p2_legacy') as
    { is_cross_chain: number; source_network: string | null; settlement_network: string | null };
  expect(row.is_cross_chain).toBe(0);
  expect(row.source_network).toBeNull();
  expect(row.settlement_network).toBeNull();
});

test('P2-5: cross_chain_transfers table exists with the full lifecycle column set', () => {
  expect(tableExists('cross_chain_transfers')).toBe(true);
  const cols = columnsOf('cross_chain_transfers');
  for (const c of [
    'id', 'payment_intent_id', 'source_network', 'source_chain_id', 'source_usdc_address',
    'token_messenger', 'source_tx_hash', 'source_block_number', 'source_finalized_at',
    'burn_message_hash', 'cctp_message_id', 'destination_network', 'destination_chain_id',
    'destination_tx_hash', 'destination_block_number', 'mint_recipient', 'amount_base_units',
    'attestation_status', 'attestation', 'claim_status', 'state', 'failure_reason',
    'fee_base_units', 'created_at', 'updated_at',
  ]) {
    expect(cols.has(c)).toBe(true);
  }
});

// Helper: insert one well-formed in-transit transfer for the given intent.
// `over` may set optional lifecycle columns (source_tx_hash, burn_message_hash,
// cctp_message_id, attestation_status, claim_status, state, ...).
function insertTransfer(id: string, pi: string, over: Record<string, unknown> = {}): void {
  const cols: string[] = [
    'id', 'payment_intent_id', 'source_network', 'source_chain_id', 'source_usdc_address',
    'token_messenger', 'destination_network', 'destination_chain_id', 'mint_recipient', 'amount_base_units',
  ];
  const vals: unknown[] = [id, pi, 'base_mainnet', 8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', 'arc_mainnet', 5042, '0x0000000000000000000000003af65566013269a1c2f6ee97d49f93a98d51d220', '1000000'];
  for (const [k, v] of Object.entries(over)) {
    cols.push(k); vals.push(v);
  }
  const placeholders = cols.map(() => '?').join(',');
  getDb()
    .prepare(`INSERT INTO cross_chain_transfers(${cols.join(',')}) VALUES(${placeholders})`)
    .run(...vals);
}

test('P2-6: a new cross-chain intent + transfer persists with defaults (in transit, not failed)', () => {
  insertLegacyIntent('pi_p2_x1');
  getDb().prepare('UPDATE payment_intents SET is_cross_chain=1, source_network=?, settlement_network=?, settlement_chain_id=? WHERE id=?')
    .run('base_mainnet', 'arc_mainnet', 5042, 'pi_p2_x1');
  insertTransfer('cct_p2_1', 'pi_p2_x1');
  const t = getDb().prepare('SELECT state, attestation_status, claim_status, fee_base_units FROM cross_chain_transfers WHERE id=?').get('cct_p2_1') as
    { state: string; attestation_status: string; claim_status: string; fee_base_units: string };
  // A freshly recorded burn is in transit — never 'failed'.
  expect(t.state).toBe('source_payment_submitted');
  expect(t.attestation_status).toBe('none');
  expect(t.claim_status).toBe('none');
  expect(t.fee_base_units).toBe('0');
});

test('P2-7: one transfer per payment intent (UNIQUE payment_intent_id)', () => {
  expect(() => insertTransfer('cct_p2_dup', 'pi_p2_x1')).toThrow();
});

test('P2-8: partial UNIQUE replay index — duplicate source tx + network rejected', () => {
  insertLegacyIntent('pi_p2_x2');
  insertLegacyIntent('pi_p2_x3');
  insertTransfer('cct_p2_src_a', 'pi_p2_x2', { source_tx_hash: '0xaaa1', });
  expect(() => insertTransfer('cct_p2_src_b', 'pi_p2_x3', { source_tx_hash: '0xaaa1' })).toThrow();
});

test('P2-9: replay indexes — duplicate cctp_message_id and burn_message_hash rejected', () => {
  insertLegacyIntent('pi_p2_x4');
  insertLegacyIntent('pi_p2_x5');
  insertTransfer('cct_p2_msg_a', 'pi_p2_x4', { cctp_message_id: 'msg-1', burn_message_hash: 'burn-1' });
  expect(() => insertTransfer('cct_p2_msg_b', 'pi_p2_x5', { cctp_message_id: 'msg-1' })).toThrow();
  insertLegacyIntent('pi_p2_x6');
  expect(() => insertTransfer('cct_p2_msg_c', 'pi_p2_x6', { burn_message_hash: 'burn-1' })).toThrow();
});

test('P2-10: NULL replay-key columns are exempt from the partial UNIQUE (two un-finalized transfers coexist)', () => {
  insertLegacyIntent('pi_p2_x7');
  insertLegacyIntent('pi_p2_x8');
  insertTransfer('cct_p2_null_a', 'pi_p2_x7');
  insertTransfer('cct_p2_null_b', 'pi_p2_x8'); // same NULL source_tx_hash/message — must be allowed
});

test('P2-11: CHECK constraints reject invalid attestation/claim/state values', () => {
  insertLegacyIntent('pi_p2_bad1');
  expect(() => insertTransfer('cct_p2_bad_att', 'pi_p2_bad1', { attestation_status: 'bogus' })).toThrow();
  insertLegacyIntent('pi_p2_bad2');
  expect(() => insertTransfer('cct_p2_bad_claim', 'pi_p2_bad2', { claim_status: 'bogus' })).toThrow();
  insertLegacyIntent('pi_p2_bad3');
  expect(() => insertTransfer('cct_p2_bad_state', 'pi_p2_bad3', { state: 'lost' })).toThrow();
});

test('P2-12: cross_chain_transfers enforces required source/destination columns NOT NULL', () => {
  expect(() =>
    getDb().prepare(`INSERT INTO cross_chain_transfers(id,payment_intent_id,destination_network,destination_chain_id,mint_recipient,amount_base_units) VALUES(?,?,?,?,?,?)`)
      .run('cct_p2_nn', 'pi_p2_x1', 'arc_mainnet', 5042, '0x0', '1')
  ).toThrow(); // missing source_network/chain_id/usdc/token_messenger
});
