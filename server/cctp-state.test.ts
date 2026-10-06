/**
 * CCTP MASTER PHASE 9 — cross-chain state machine.
 *
 * Proves the single authoritative lifecycle graph WITHOUT touching money:
 *   • the state set matches the `cross_chain_transfers.state` CHECK exactly
 *     (behaviourally: SQLite rejects an unknown state, and our list carries every
 *     schema value);
 *   • only legal edges are allowed — the monotonic happy path + the sanctioned
 *     attestation/settle shortcuts + poll self-loops; every backward move and
 *     every attempt to revive a terminal state is refused;
 *   • 'settled' is UNREACHABLE via the generic router (crediting is PHASE 8's
 *     atomic responsibility), so a state advance can never fake a payout;
 *   • advanceTransferState writes atomically, pins the FROM state (no blind
 *     overwrite), records a failure reason only when one is supplied, and never
 *     mutates the ledger.
 *
 * Unique fixture namespace (*_cctps*) + DISJOINT tx-hash/message pattern — the
 * whole suite shares ONE sqlite DB across every cctp-*.test.ts.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctpstate_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp-state-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const {
  CCTP_STATES, TERMINAL_STATES, CCTP_TRANSITIONS, canTransition, legalNextStates,
  isTerminalState, advanceTransferState,
} = await import('./blockchain/cctp-state.ts');

const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const NOW = 1_800_000_000;
let seq = 0;
// DISJOINT from every other cctp-*.test.ts hash family.
const srcHash = (n: number) => '0x' + 'c9'.repeat(31) + (n % 256).toString(16).padStart(2, '0');

function seedTransferInState(state: string): string {
  seq += 1;
  const id = `pi_cctps_${seq}`;
  const tid = `cct_cctps_${seq}`;
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
      amount_decimal,amount_base_units,environment,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, 'merch_cctps', 'sw_cctps', ARC_WALLET, 'base_sepolia', 84532, '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    '5.00', '5000000', 'test', 9999999999, 1, 'base_sepolia', 'arc_testnet', 5042002);
  getDb().prepare(
    `INSERT INTO cross_chain_transfers(id,payment_intent_id,source_network,source_chain_id,source_usdc_address,token_messenger,
      source_tx_hash,destination_network,destination_chain_id,mint_recipient,amount_base_units,state)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(tid, id, 'base_sepolia', 84532, '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', srcHash(seq), 'arc_testnet', 5042002, ARC_WALLET, '5000000', state);
  return tid;
}
function readState(tid: string): string {
  return (getDb().prepare('SELECT state FROM cross_chain_transfers WHERE id=?').get(tid) as { state: string }).state;
}

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctps', 'P9 state merchant');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_cctps', 'merch_cctps', ARC_WALLET, 'arc_testnet');
});

afterAll(() => {
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ── Graph ≡ schema ──────────────────────────────────────────────────────────

test('P9-1: the module state set equals the schema CHECK list (behavioural + exact)', () => {
  // Every schema CHECK value is present, and we declare nothing extra.
  const schemaStates = [
    'source_payment_submitted', 'source_finalizing', 'source_finalized', 'attestation_pending',
    'attested', 'destination_pending', 'destination_submitted', 'destination_confirmed',
    'settled', 'attestation_timeout', 'destination_failed', 'source_reorg', 'verification_failed',
  ];
  expect([...CCTP_STATES].sort()).toEqual([...schemaStates].sort());

  // The DB itself refuses an unlisted state — our list can never drift from it.
  const tid = seedTransferInState('attested');
  expect(() => getDb().prepare('UPDATE cross_chain_transfers SET state=? WHERE id=?').run('bogus_state', tid)).toThrow();
});

test('P9-2: every transition target is a declared state (no dangling edge)', () => {
  for (const from of CCTP_STATES) {
    for (const to of legalNextStates(from)) {
      expect(CCTP_STATES).toContain(to);
    }
  }
});

// ── Legal edges ─────────────────────────────────────────────────────────────

test('P9-3: the monotonic happy path is legal end to end', () => {
  const path = [
    'source_payment_submitted', 'source_finalizing', 'source_finalized', 'attestation_pending',
    'attested', 'destination_pending', 'destination_submitted', 'destination_confirmed', 'settled',
  ];
  for (let i = 0; i < path.length - 1; i++) {
    expect(canTransition(path[i], path[i + 1])).toBe(true);
  }
  // Sanctioned shortcuts: attestation may land straight from finalized; a hard
  // verification failure may park from either pre-attestation poll state.
  expect(canTransition('source_finalized', 'attested')).toBe(true);
  expect(canTransition('source_finalized', 'verification_failed')).toBe(true);
  expect(canTransition('attestation_pending', 'verification_failed')).toBe(true);
});

test('P9-4: poll/retry self-loops are legal so a worker tick is idempotent', () => {
  for (const s of ['source_finalizing', 'attestation_pending', 'destination_pending', 'destination_submitted'] as const) {
    expect(canTransition(s, s)).toBe(true);
  }
});

// ── Illegal edges ───────────────────────────────────────────────────────────

test('P9-5: backward moves and cross-branch jumps are refused', () => {
  const bad: Array<[string, string]> = [
    ['source_finalized', 'source_payment_submitted'],   // never backward
    ['attested', 'source_finalized'],                    // never un-attest
    ['destination_confirmed', 'attested'],               // never back off the settle path
    ['settled', 'attested'],                             // terminal never revives
    ['source_reorg', 'source_finalized'],               // a reorg is parked, not resumed
    ['attestation_timeout', 'attested'],                 // a timeout is not silently attested
    ['verification_failed', 'destination_pending'],     // a hard fail never proceeds
    ['source_payment_submitted', 'attested'],            // cannot skip finality
    ['attested', 'source_payment_submitted'],
  ];
  for (const [from, to] of bad) expect(canTransition(from, to)).toBe(false);
});

test('P9-6: terminal states have no outgoing edges', () => {
  for (const s of TERMINAL_STATES) {
    expect(legalNextStates(s)).toHaveLength(0);
    expect(isTerminalState(s)).toBe(true);
    for (const to of CCTP_STATES) expect(canTransition(s, to)).toBe(false);
  }
});

test('P9-7: unknown state names never transition', () => {
  expect(canTransition('nonsense', 'attested')).toBe(false);
  expect(canTransition('attested', 'nonsense')).toBe(false);
  expect(legalNextStates('nonsense')).toHaveLength(0);
});

// ── The router ──────────────────────────────────────────────────────────────

test('P9-8: advanceTransferState writes a legal edge and updates the timestamp', () => {
  const tid = seedTransferInState('source_payment_submitted');
  const res = advanceTransferState(tid, 'source_finalizing', { nowSeconds: NOW });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error('unexpected');
  expect(res.from).toBe('source_payment_submitted');
  expect(res.to).toBe('source_finalizing');
  expect(readState(tid)).toBe('source_finalizing');
  const r = getDb().prepare('SELECT updated_at FROM cross_chain_transfers WHERE id=?').get(tid) as { updated_at: number };
  expect(r.updated_at).toBe(NOW);
});

test('P9-9: an illegal edge is refused and the stored state is untouched', () => {
  const tid = seedTransferInState('attested');
  const res = advanceTransferState(tid, 'source_finalized');
  expect(!res.ok && res.code).toBe('illegal_transition');
  expect(readState(tid)).toBe('attested');
});

test("P9-10: the router can NEVER write 'settled' (credit is PHASE 8-only)", () => {
  // Even from a state where 'settled' would be the operational next step, the
  // generic advance refuses, so no payout can be faked by moving state alone.
  const tid = seedTransferInState('destination_confirmed');
  const res = advanceTransferState(tid, 'settled');
  expect(!res.ok && res.code).toBe('settled_requires_credit_path');
  expect(readState(tid)).toBe('destination_confirmed');
  // No money row was ever created for THIS intent by a state advance.
  const intentId = (getDb().prepare('SELECT payment_intent_id FROM cross_chain_transfers WHERE id=?').get(tid) as { payment_intent_id: string }).payment_intent_id;
  expect(getDb().prepare('SELECT COUNT(*) c FROM payments WHERE payment_intent_id=?').get(intentId)).toEqual({ c: 0 });
});

test('P9-11: an unknown target or a missing transfer is refused without writing', () => {
  const tid = seedTransferInState('attested');
  expect(!advanceTransferState(tid, 'garbage').ok).toBe(true);
  const missing = advanceTransferState('cct_cctps_nope', 'attested');
  expect(!missing.ok && missing.code).toBe('transfer_not_found');
  expect(readState(tid)).toBe('attested');
});

test('P9-12: a supplied reason is recorded; an ordinary move preserves the prior cause', () => {
  const parked = seedTransferInState('attestation_pending');
  const r1 = advanceTransferState(parked, 'verification_failed', { reason: 'message hash mismatch' });
  expect(r1.ok).toBe(true);
  expect((getDb().prepare('SELECT failure_reason FROM cross_chain_transfers WHERE id=?').get(parked) as { failure_reason: string }).failure_reason).toBe('message hash mismatch');

  // A legal forward move with no reason must not erase an existing cause.
  const fwd = seedTransferInState('source_finalizing');
  getDb().prepare('UPDATE cross_chain_transfers SET failure_reason=? WHERE id=?').run('earlier note', fwd);
  advanceTransferState(fwd, 'source_finalized', { nowSeconds: NOW });
  expect((getDb().prepare('SELECT failure_reason FROM cross_chain_transfers WHERE id=?').get(fwd) as { failure_reason: string }).failure_reason).toBe('earlier note');
});

test('P9-13: the transition table keys cover exactly the declared states', () => {
  expect(Object.keys(CCTP_TRANSITIONS).sort()).toEqual([...CCTP_STATES].sort());
});
