/**
 * CCTP STEP 5 (5B/5C) — Circle Forwarding FEE QUOTE service.
 *
 * Proves the single server-side authority that turns Circle's
 * `/v2/burn/USDC/fees/{src}/{dst}?forward=true` quote into the approved fee F and
 * persists it — WITHOUT inventing fee math and WITHOUT any client ability to set it.
 * Covers:
 *   • the fee endpoint URL is built for the right environment class + Arc domain 26;
 *   • ONLY the STANDARD (finalityThreshold === 2000) entry is ever selected — the
 *     Fast(1000) entry is ignored, keeping alignment with the >= 2000 attestation gate;
 *   • Circle's EXACT documented fee formula (forwardFee.med + protocolFee scaling,
 *     gross = M + F), copied verbatim — never a re-derivation;
 *   • FAIL-CLOSED on a missing/malformed/no-Standard quote, a non-2xx, a network
 *     throw, or a non-JSON body — nothing is ever persisted, so a Forwarding payment
 *     can never proceed with an unknown (or silently-zero) fee;
 *   • applyForwardingQuote writes ONLY payment_intents.forwarding_max_fee_base_units
 *     (F) and NEVER touches amount_base_units (the merchant target M).
 *
 * Unique fixture namespace (*_cctpfwf*) — `bun test` shares ONE sqlite DB across files.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctpfwf_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp-fwf-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const {
  forwardingFeeUrl, selectStandardForwardingQuote, computeForwardingAmounts,
  quoteForwardingFee, applyForwardingQuote,
  FORWARDING_FINALITY_STANDARD, CCTP_FORWARD_HOOK_DATA, ForwardingFeeError,
} = await import('./blockchain/cctp-forwarding-fee.ts');
import type { FetchLike } from './blockchain/cctp-attestation.ts';

// The LIVE-shape Circle response (verified against the sandbox endpoint): one entry
// per finality class. The Fast(1000) entry MUST be ignored; Standard(2000) selected.
const FAST = { finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 27761, med: 28198, high: 29599 } };
const STANDARD = { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 27761, med: 28198, high: 29599 } };
const LIVE_BODY = [FAST, STANDARD];

function makeFetch(route: (url: string) => { status: number; body?: unknown; text?: string }): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url: string) => {
    calls.push(url);
    const r = route(url);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => {
        if (r.body === undefined) throw new Error('not json');
        return r.body;
      },
    } as Awaited<ReturnType<FetchLike>>;
  };
  return { fetch, calls };
}

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctpfwf', 'P5 forwarding fee merchant');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)')
    .run('sw_cctpfwf', 'merch_cctpfwf', '0x3af65566013269a1c2f6ee97d49f93a98d51d220', 'arc_testnet');
});

afterAll(() => {
  try { getDb().close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ── 5B — endpoint URL (environment class + Arc destination 26) ──────────────
test('S5F-1: forwardingFeeUrl targets the ?forward=true fees endpoint for Arc domain 26', () => {
  expect(forwardingFeeUrl({ isTestnet: true, sourceDomain: 0 }))
    .toBe('https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/0/26?forward=true');
  expect(forwardingFeeUrl({ isTestnet: false, sourceDomain: 6 }))
    .toBe('https://iris-api.circle.com/v2/burn/USDC/fees/6/26?forward=true');
});

test('S5F-2: forwardingFeeUrl refuses an invalid source domain (never a bogus quote)', () => {
  expect(() => forwardingFeeUrl({ isTestnet: true, sourceDomain: -1 })).toThrow(ForwardingFeeError);
  expect(() => forwardingFeeUrl({ isTestnet: true, sourceDomain: 1.5 as unknown as number })).toThrow(ForwardingFeeError);
});

// ── 5B — select ONLY the Standard(2000) entry; fail closed on anything else ──
test('S5F-3: selectStandardForwardingQuote picks the 2000 entry and ignores Fast(1000)', () => {
  const entry = selectStandardForwardingQuote(LIVE_BODY);
  expect(entry.finalityThreshold).toBe(FORWARDING_FINALITY_STANDARD); // 2000
  expect(entry).toEqual(STANDARD);
  // Order-independence: the Standard entry first or last yields the same result.
  expect(selectStandardForwardingQuote([STANDARD, FAST])).toEqual(STANDARD);
});

test('S5F-4: selectStandardForwardingQuote FAILS CLOSED on malformed / missing quotes', () => {
  expect(() => selectStandardForwardingQuote('not-an-array')).toThrow(ForwardingFeeError);   // non-array
  expect(() => selectStandardForwardingQuote([FAST])).toThrow(ForwardingFeeError);            // no Standard(2000)
  expect(() => selectStandardForwardingQuote([])).toThrow(ForwardingFeeError);                // empty
  expect(() => selectStandardForwardingQuote([{ finalityThreshold: 2000, minimumFee: NaN, forwardFee: { med: 1 } }])).toThrow(ForwardingFeeError); // bad minimumFee
  expect(() => selectStandardForwardingQuote([{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 'x' } }])).toThrow(ForwardingFeeError); // bad forwardFee.med
  expect(() => selectStandardForwardingQuote([{ finalityThreshold: 2000, minimumFee: 0 }])).toThrow(ForwardingFeeError); // missing forwardFee
});

// ── 5B — Circle's EXACT documented fee formula (gross = M + F) ───────────────
test('S5F-5: computeForwardingAmounts uses Circle verbatim math — F = forwardFee.med + protocolFee', () => {
  // minimumFee 0 => protocolFee 0 => F = forwardFee.med = 28198.
  const a = computeForwardingAmounts(STANDARD, 5_000_000n);
  expect(a.settlementAmountBaseUnits).toBe(5_000_000n);
  expect(a.approvedMaxFeeBaseUnits).toBe(28_198n);
  expect(a.grossBurnBaseUnits).toBe(5_028_198n);
  // Non-zero protocol fee: minimumFee is a float factor scaled by 1e6 (Circle math).
  const e = { finalityThreshold: 2000, minimumFee: 2, forwardFee: { low: 100, med: 100, high: 100 } };
  const b = computeForwardingAmounts(e, 1_000_000n);
  // protocolFee = (1_000_000 * round(2*100)) / 1_000_000 = 200; F = 100 + 200 = 300.
  expect(b.approvedMaxFeeBaseUnits).toBe(300n);
  expect(b.grossBurnBaseUnits).toBe(1_000_300n);
});

test('S5F-6: computeForwardingAmounts rejects a non-positive settlement amount', () => {
  expect(() => computeForwardingAmounts(STANDARD, 0n)).toThrow(ForwardingFeeError);
  expect(() => computeForwardingAmounts(STANDARD, -1n)).toThrow(ForwardingFeeError);
});

// ── 5B/5C — quoteForwardingFee end-to-end + fail-closed transport handling ──
test('S5F-7: quoteForwardingFee returns the computed amounts from a live-shaped quote', async () => {
  const { fetch, calls } = makeFetch(() => ({ status: 200, body: LIVE_BODY }));
  const amounts = await quoteForwardingFee({ isTestnet: true, sourceDomain: 0, settlementAmountBaseUnits: 5_000_000n, fetchImpl: fetch });
  expect(calls[0]).toContain('/v2/burn/USDC/fees/0/26?forward=true');
  expect(amounts.approvedMaxFeeBaseUnits).toBe(28_198n);
  expect(amounts.grossBurnBaseUnits).toBe(5_028_198n);
});

test('S5F-8: quoteForwardingFee FAILS CLOSED (throws) on non-2xx / network error / non-JSON', async () => {
  const run = async (fetchImpl: FetchLike) => {
    try { await quoteForwardingFee({ isTestnet: true, sourceDomain: 0, settlementAmountBaseUnits: 1n, fetchImpl }); return false; }
    catch (e) { return e instanceof ForwardingFeeError; }
  };
  expect(await run(makeFetch(() => ({ status: 500 })).fetch)).toBe(true);   // non-2xx
  expect(await run((async () => { throw new Error('socket hang up'); }) as unknown as FetchLike)).toBe(true); // network throw
  expect(await run(makeFetch(() => ({ status: 200 })).fetch)).toBe(true);    // 200 but body not JSON
});

test('S5F-9: the pinned forwarding hook bytes equal the published Circle constant', () => {
  expect(CCTP_FORWARD_HOOK_DATA).toBe('0x636374702d666f72776172640000000000000000000000000000000000000000');
  // 24-byte `cctp-forward` magic + zero padding = 0x + 64 hex chars.
  expect(CCTP_FORWARD_HOOK_DATA.length).toBe(2 + 64);
});

// ── 5C — server-only persistence of F; M is NEVER touched ───────────────────
let seq = 0;
function seedIntent(amountBaseUnits: string): string {
  const id = `pi_cctpfwf_${++seq}`;
  getDb().prepare(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,
      amount_decimal,amount_base_units,environment,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, 'merch_cctpfwf', 'sw_cctpfwf', '0x3af65566013269a1c2f6ee97d49f93a98d51d220', 'base_sepolia', 84532,
    '0x036CbD53842c5426634e7929541eC2318f3dCF7e', '5.00', amountBaseUnits, 'test', 9999999999, 1, 'base_sepolia', 'arc_testnet', 5042002);
  return id;
}
const resolveSource = (_slug: string) => ({ sourceDomain: 6, isTestnet: true });

test('S5C-1: applyForwardingQuote persists F and leaves the merchant target M unchanged', async () => {
  const id = seedIntent('5000000');
  const { fetch } = makeFetch(() => ({ status: 200, body: LIVE_BODY }));
  const amounts = await applyForwardingQuote({ paymentIntentId: id, fetchImpl: fetch, resolveSource });
  const row = getDb().prepare('SELECT amount_base_units,forwarding_max_fee_base_units FROM payment_intents WHERE id=?').get(id) as {
    amount_base_units: string; forwarding_max_fee_base_units: string;
  };
  // F is now the server-approved fee; M is exactly what it always was.
  expect(row.forwarding_max_fee_base_units).toBe(amounts.approvedMaxFeeBaseUnits.toString()); // '28198'
  expect(row.forwarding_max_fee_base_units).toBe('28198');
  expect(row.amount_base_units).toBe('5000000');
});

test('S5C-2: applyForwardingQuote FAILS CLOSED - a bad quote persists nothing (F stays default 0)', async () => {
  const id = seedIntent('5000000');
  const before = (getDb().prepare('SELECT forwarding_max_fee_base_units FROM payment_intents WHERE id=?').get(id) as { forwarding_max_fee_base_units: string }).forwarding_max_fee_base_units;
  const { fetch } = makeFetch(() => ({ status: 200, body: [FAST] })); // NO Standard entry
  let threw = false;
  try { await applyForwardingQuote({ paymentIntentId: id, fetchImpl: fetch, resolveSource }); } catch (e) { threw = e instanceof ForwardingFeeError; }
  expect(threw).toBe(true);
  const after = (getDb().prepare('SELECT forwarding_max_fee_base_units FROM payment_intents WHERE id=?').get(id) as { forwarding_max_fee_base_units: string }).forwarding_max_fee_base_units;
  expect(after).toBe(before); // unchanged - never a silent zero / partial write on a failed quote
});
