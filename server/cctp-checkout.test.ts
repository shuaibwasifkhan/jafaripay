/**
 * CCTP MASTER PHASE 4 — server-authoritative checkout route exposure.
 *
 * Proves GET /checkout/:id attaches a server-pinned CCTP source-leg route ONLY
 * for a cross-chain intent, and that the mint recipient is the merchant's pinned
 * Arc wallet as a bytes32, the destination domain is Arc (26), the TokenMessenger
 * pair matches the route environment class, and the transfer is the mandated
 * STANDARD (free, 1:1) plan: maxFee=0, minFinalityThreshold=0. Same-chain intents
 * are unchanged (no route, cross_chain=false). No blockchain I/O, no money.
 *
 * Fixture ids are uniquely namespaced (merch_cctpo / pi_cctpo_*) because `bun
 * test` shares ONE sqlite DB across files — collision here would corrupt other
 * suites exactly as PHASE 3 proved.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import express from 'express';

const TMP_DB = join(import.meta.dir, '..', 'data', `_cctpcheckout_test_${process.pid}.db`);
process.env.DATABASE_URL = TMP_DB;
process.env.API_KEY_HMAC_SECRET = 'cctp-checkout-test-secret';

const { migrate, getDb } = await import('./db/schema.ts');
const checkoutRouter = (await import('./api/checkout.ts')).default;
import { addressToBytes32, cctpSourceRoutePlan, tokenMessengerFor, CCTP_CONTRACTS_TESTNET } from './db/cctp.ts';

const ARC_WALLET = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';
const ARC_WALLET_B32 = '0x0000000000000000000000003af65566013269a1c2f6ee97d49f93a98d51d220';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

function insertIntent(id: string, crossChain: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,environment,expires_at,is_cross_chain,source_network,settlement_network,settlement_chain_id)
       VALUES(?,?,?,?,?,?,?,?,?, 'test', 9999999999, ?, ?, ?, ?)`
    )
    .run(
      id, 'merch_cctpo', 'sw_cctpo', ARC_WALLET,
      crossChain ? 'base_sepolia' : 'arc_testnet',
      crossChain ? 84532 : 5042002,
      crossChain ? SRC_USDC : '0x3600000000000000000000000000000000000000',
      '5.00', '5000000',
      crossChain ? 1 : 0,
      crossChain ? 'base_sepolia' : null,
      crossChain ? 'arc_testnet' : null,
      crossChain ? 5042002 : null,
    );
}

async function getCheckout(id: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/checkout/${id}`);
  return await res.json() as Record<string, unknown>;
}

beforeAll(() => {
  migrate();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchants(id,name) VALUES(?,?)').run('merch_cctpo', 'P4 checkout merchant');
  db.prepare('INSERT OR IGNORE INTO settlement_wallets(id,merchant_id,address,network,is_active) VALUES(?,?,?,?,1)').run('sw_cctpo', 'merch_cctpo', ARC_WALLET, 'arc_testnet');
  insertIntent('pi_cctpo_x', true);
  insertIntent('pi_cctpo_same', false);

  const app = express();
  app.use(express.json());
  app.use('/checkout', checkoutRouter);
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

test('C4-S1: addressToBytes32 left-pads a 20-byte address and rejects bad input', () => {
  expect(addressToBytes32(ARC_WALLET)).toBe(ARC_WALLET_B32);
  expect(() => addressToBytes32('0xdeadbeef')).toThrow();
});

test('C4-S2: cctpSourceRoutePlan throws for a non-CCTP source (never a fabricated route)', () => {
  expect(() => cctpSourceRoutePlan({ sourceSlug: 'zksync_era', mintRecipientAddress: ARC_WALLET, burnTokenAddress: SRC_USDC })).toThrow();
  expect(() => cctpSourceRoutePlan({ sourceSlug: 'arc_testnet', mintRecipientAddress: ARC_WALLET, burnTokenAddress: SRC_USDC })).toThrow();
});

test('C4-S3: tokenMessengerFor picks the cross-chain-constant testnet pair for a testnet route', () => {
  expect(tokenMessengerFor(true)).toBe(CCTP_CONTRACTS_TESTNET.tokenMessengerV2);
});

test('C4-S4: cross-chain GET /checkout/:id exposes the server-pinned Arc route', async () => {
  const pi = await getCheckout('pi_cctpo_x');
  expect(pi.cross_chain).toBe(true);
  const route = pi.cctp_source_route as Record<string, unknown>;
  expect(route).toBeTruthy();
  expect(route.destination_domain).toBe(26);
  expect(route.mint_recipient_bytes32).toBe(ARC_WALLET_B32);      // merchant Arc wallet, never client-chosen
  expect(route.token_messenger).toBe(CCTP_CONTRACTS_TESTNET.tokenMessengerV2); // base_sepolia => testnet pair
  expect((route.burn_token as string).toLowerCase()).toBe(SRC_USDC.toLowerCase());
  expect(route.max_fee).toBe('0');                                // STANDARD free transfer
  expect(route.min_finality_threshold).toBe(0);                   // attest on full source finality
  expect(route.destination_caller_bytes32).toBe('0x' + '0'.repeat(64));
});

test('C4-S5: same-chain GET /checkout/:id is unchanged (no route, cross_chain=false)', async () => {
  const pi = await getCheckout('pi_cctpo_same');
  expect(pi.cross_chain).toBe(false);
  expect(pi.cctp_source_route).toBeUndefined();
});

// ── STEP 5 — server-only exposure of the Forwarding route (fee F > 0) ───────
// F lives ONLY in payment_intents.forwarding_max_fee_base_units (server-authored
// by applyForwardingQuote; a browser can never set it). When F > 0 the GET
// upgrades the STANDARD route to a Forwarding route: max_fee = F, finality = 2000
// and the cctp-forward hook. When F = 0 (default) the DIRECT route is byte-
// identical to C4-S4 — forwarding is strictly additive and never forced.
const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000';

test('C5-S1: cross-chain GET with server F>0 exposes the Forwarding route (hook, max_fee=F, finality 2000)', async () => {
  insertIntent('pi_cctpo_fwd', true);
  getDb().prepare('UPDATE payment_intents SET forwarding_max_fee_base_units=? WHERE id=?').run('20380', 'pi_cctpo_fwd');
  const pi = await getCheckout('pi_cctpo_fwd');
  expect(pi.cross_chain).toBe(true);
  expect(pi.forwarding).toBe(true);
  const route = pi.cctp_source_route as Record<string, unknown>;
  expect(route.max_fee).toBe('20380');                             // F, not the gross, not 0
  expect(route.min_finality_threshold).toBe(2000);                 // Standard finality, never Fast(1000)
  expect(route.hook_data).toBe(FORWARD_HOOK);                      // server-authored cctp-forward bytes
  expect(route.mint_recipient_bytes32).toBe(ARC_WALLET_B32);       // merchant target unchanged
  // The merchant amount M is NEVER the gross — still 5000000.
  expect(pi.amount_base_units).toBe('5000000');
});

test('C5-S2: direct cross-chain GET (F=0 default) is byte-identical to the pre-STEP-5 STANDARD plan', async () => {
  const pi = await getCheckout('pi_cctpo_x'); // inserted with no forwarding fee
  expect(pi.forwarding).toBe(false);
  const route = pi.cctp_source_route as Record<string, unknown>;
  expect(route.max_fee).toBe('0');                                 // direct stays free/1:1
  expect(route.min_finality_threshold).toBe(0);
  expect(route.hook_data).toBeUndefined();                         // NO hook on a direct route
});
