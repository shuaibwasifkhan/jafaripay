/**
 * JafariPay — payment-expiry race regression tests (bun:test).
 *
 * Verifies the bounded settlement-grace behaviour:
 *  - verification succeeds before expiry, and during the grace window
 *  - verification is rejected once past expiry + grace
 *  - the reconciliation worker defers hard-expiry until past the grace
 *  - ALL verification rules (recipient, amount, token/contract, duplicate,
 *    idempotency) remain enforced during the grace window
 *
 * What is mocked: ONLY external blockchain I/O — `ArcProvider.getTransactionReceipt`
 * (the RPC fetch). The real `verifyPayment` rule pipeline (USDC Transfer decode,
 * exact recipient/amount match, duplicate/replay check, PI status/expiry check),
 * the real checkout route handler, and the real worker `tick()` all execute
 * unmodified against an isolated temporary SQLite database.
 */
import { test, expect, beforeAll, afterEach, afterAll, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import express from 'express';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TMP_DB = join(import.meta.dir, '..', 'data', `_expiry_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;

// Import AFTER DATABASE_URL is set so getDb() opens the temp DB.
const { migrate, getDb } = await import('./db/schema.ts');
const arc = await import('./blockchain/arc-provider.ts');
const { tick } = await import('./workers/reconciliation.ts');
const checkoutRouter = (await import('./api/checkout.ts')).default;

const GRACE = arc.PI_SETTLEMENT_GRACE_S;
const USDC = '0x3600000000000000000000000000000000000000';
const SETTLEMENT = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const SENDER = '0x2ebcd5d751c5ea788ebca0032f5bd23daa0564c7';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

function makeReceipt(opts: { txHash: string; to?: string; value?: bigint; contract?: string; status?: 'success' | 'reverted' }) {
  const to = (opts.to ?? SETTLEMENT).toLowerCase();
  const value = opts.value ?? 1_000_000n;
  const contract = (opts.contract ?? USDC).toLowerCase();
  const { topics, data } = (() => {
    const topics = encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from: SENDER as `0x${string}`, to: to as `0x${string}` } });
    const data = encodeAbiParameters([{ type: 'uint256' }], [value]);
    return { topics, data };
  })();
  return {
    txHash: opts.txHash,
    status: opts.status ?? 'success',
    blockNumber: 100n,
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    from: SENDER,
    to: contract,
    logs: [{ address: contract, topics: topics as string[], data, logIndex: 0 }],
  };
}

function mockReceipt(receipt: ReturnType<typeof makeReceipt> | null): void {
  spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockResolvedValue(receipt as never);
}

let seq = 0;
function seedPi(expiresInSec: number, status = 'requires_payment'): string {
  const db = getDb();
  const id = `pi_test_${process.pid}_${seq++}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO payment_intents(id,merchant_id,project_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,currency,status,environment,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, 'merch_test', null, 'sw_test', SETTLEMENT, 'arc_testnet', 5042002, USDC, '1.00', '1000000', 'USDC', status, 'test', now + expiresInSec, now, now);
  return id;
}

beforeAll(() => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (existsSync(f)) rmSync(f);
  migrate();
  const db = getDb();
  db.prepare('INSERT INTO merchants(id,name) VALUES(?,?)').run('merch_test', 'Test Merchant');
  db.prepare('INSERT INTO settlement_wallets(id,merchant_id,address,network) VALUES(?,?,?,?)').run('sw_test', 'merch_test', SETTLEMENT, 'arc_testnet');
  app = express();
  app.use(express.json());
  app.use('/checkout', checkoutRouter);
  server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://localhost:${port}`;
});

afterEach(() => { spyOn(arc.ArcProvider.prototype, 'getTransactionReceipt').mockRestore(); });

afterAll(() => {
  server?.close();
  try { getDb().close(); } catch { /* already closed */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* Windows may still hold the handle briefly; safe to leave */ }
  }
});

async function verify(piId: string, txHash: string) {
  const res = await fetch(`${baseUrl}/checkout/${piId}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx_hash: txHash, chain_id: 5042002 }),
  });
  return { status: res.status, body: await res.json() as { status?: string; error?: string; payment?: unknown } };
}
function tx(): string { return '0x' + (seq.toString(16).padStart(2, '0')).repeat(32); }

// 1. valid payment before expiry -> succeeded
test('1: valid payment verified before expiry -> succeeded', async () => {
  const pi = seedPi(3600); const h = tx();
  mockReceipt(makeReceipt({ txHash: h }));
  const r = await verify(pi, h);
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('succeeded');
  const events = getDb().prepare('SELECT event_type FROM payment_events WHERE payment_intent_id=?').all(pi) as { event_type: string }[];
  expect(events.map(e => e.event_type)).toContain('payment.succeeded');
  expect(getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi)).toBeTruthy();
});

// 2. valid payment during grace -> succeeded
test('2: valid payment verified during grace -> succeeded', async () => {
  const pi = seedPi(-60); const h = tx(); // expired 60s ago, within 20m grace
  mockReceipt(makeReceipt({ txHash: h }));
  const r = await verify(pi, h);
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('succeeded');
  expect((getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(pi) as { status: string }).status).toBe('succeeded');
});

// 3. valid payment after grace -> expired/rejected
test('3: valid payment verified after grace -> expired, not credited', async () => {
  const pi = seedPi(-(GRACE + 120)); const h = tx();
  mockReceipt(makeReceipt({ txHash: h }));
  const r = await verify(pi, h);
  expect(r.status).toBe(400);
  expect(r.body.status).toBe('expired');
  expect(getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi)).toBeFalsy();
});

// 4. invalid payment during grace -> NOT succeeded (no matching transfer)
test('4: invalid payment during grace -> not succeeded', async () => {
  const pi = seedPi(-60); const h = tx();
  mockReceipt(makeReceipt({ txHash: h, value: 999n })); // wrong amount => no match
  const r = await verify(pi, h);
  expect(r.body.status).not.toBe('succeeded');
  expect(getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi)).toBeFalsy();
});

// 5. worker does not expire during grace
test('5: worker does NOT expire a PI within grace', async () => {
  const pi = seedPi(-60);
  await tick();
  expect((getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(pi) as { status: string }).status).toBe('requires_payment');
});

// 6. worker expires after grace
test('6: worker DOES expire a PI past grace', async () => {
  const pi = seedPi(-(GRACE + 120));
  await tick();
  expect((getDb().prepare('SELECT status FROM payment_intents WHERE id=?').get(pi) as { status: string }).status).toBe('expired');
  const events = getDb().prepare('SELECT event_type FROM payment_events WHERE payment_intent_id=?').all(pi) as { event_type: string }[];
  expect(events.map(e => e.event_type)).toContain('payment.expired');
});

// 7. duplicate/replay remains rejected
test('7: duplicate tx during grace -> rejected (replay protection)', async () => {
  const pi1 = seedPi(3600); const h = tx();
  mockReceipt(makeReceipt({ txHash: h }));
  expect((await verify(pi1, h)).body.status).toBe('succeeded');
  // Reuse same tx hash on a second, within-grace PI
  const pi2 = seedPi(-60);
  mockReceipt(makeReceipt({ txHash: h }));
  const r = await verify(pi2, h);
  expect(r.body.status).not.toBe('succeeded');
  expect(getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi2)).toBeFalsy();
});

// 8. already-succeeded PI remains idempotent
test('8: already-succeeded PI re-verified within grace -> idempotent', async () => {
  const pi = seedPi(3600); const h = tx();
  mockReceipt(makeReceipt({ txHash: h }));
  expect((await verify(pi, h)).body.status).toBe('succeeded');
  mockReceipt(makeReceipt({ txHash: h }));
  const r = await verify(pi, h);
  expect(r.body.status).toBe('succeeded');
  const rows = getDb().prepare('SELECT COUNT(*) AS n FROM payments WHERE payment_intent_id=?').get(pi) as { n: number };
  expect(rows.n).toBe(1);
});

// 9. wrong recipient during grace rejected
test('9: wrong recipient during grace -> rejected', async () => {
  const pi = seedPi(-60); const h = tx();
  mockReceipt(makeReceipt({ txHash: h, to: '0x000000000000000000000000000000000000dead' }));
  const r = await verify(pi, h);
  expect(r.body.status).not.toBe('succeeded');
  expect(getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi)).toBeFalsy();
});

// 10. wrong amount during grace rejected
test('10: wrong amount during grace -> rejected', async () => {
  const pi = seedPi(-60); const h = tx();
  mockReceipt(makeReceipt({ txHash: h, value: 500_000n }));
  const r = await verify(pi, h);
  expect(r.body.status).not.toBe('succeeded');
  expect(getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi)).toBeFalsy();
});

// 11. wrong token/contract during grace rejected
test('11: wrong token contract during grace -> rejected', async () => {
  const pi = seedPi(-60); const h = tx();
  mockReceipt(makeReceipt({ txHash: h, contract: '0x1111111111111111111111111111111111111111' }));
  const r = await verify(pi, h);
  expect(r.body.status).not.toBe('succeeded');
  expect(getDb().prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi)).toBeFalsy();
});
