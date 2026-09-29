/**
 * JafariPay — Multi-chain registry foundation tests (bun:test, Phase 1).
 *
 * Proves the DATABASE/REGISTRY foundation migration ONLY:
 *  - a legacy Arc-only database (CHECK(network IN ('arc_testnet','arc_mainnet'))
 *    on settlement_wallets.network and network_configs.network) migrates
 *    successfully via the SQLite table-rebuild procedure,
 *  - existing Arc rows + merchant/settlement-wallet/payment-intent data
 *    survive untouched, and foreign keys remain enforced afterwards,
 *  - arc_testnet gains is_testnet=1 / arc_mainnet is_testnet=0, and both
 *    keep required_confirmations=0 (today's Arc behaviour, no new delay),
 *  - non-Arc network rows and settlement wallets can now be registered,
 *  - duplicate ENABLED chain_id is rejected; a duplicate is allowed only
 *    while at most one row for that chain id is enabled (partial-index
 *    semantics),
 *  - usdc_decimals <> 6 on an enabled row fails seed validation,
 *  - migrate() is idempotent (safe to execute more than once).
 *
 * All non-Arc chain ids used here are inert fixtures in the 9xxxxx range —
 * no real production network (Base/Polygon/Arbitrum/…) is registered.
 */
import { test, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

const TMP_DB = join(import.meta.dir, '..', 'data', `_migration_test_${process.pid}.db`);

const USDC = '0x3600000000000000000000000000000000000000';
const SETTLEMENT = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';

// ── Exact pre-Phase-1 DDL (verbatim from git HEAD server/db/schema.ts) ───────
const LEGACY_DDL = [
  `CREATE TABLE merchants (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    email       TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE settlement_wallets (
    id          TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
    address     TEXT NOT NULL,
    network     TEXT NOT NULL CHECK(network IN ('arc_testnet','arc_mainnet')),
    label       TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(merchant_id, address, network)
  )`,
  `CREATE TABLE network_configs (
    id            TEXT PRIMARY KEY,
    network       TEXT NOT NULL UNIQUE CHECK(network IN ('arc_testnet','arc_mainnet')),
    chain_id      INTEGER NOT NULL,
    rpc_url       TEXT NOT NULL,
    explorer_base TEXT NOT NULL,
    usdc_address  TEXT NOT NULL,
    usdc_decimals INTEGER NOT NULL DEFAULT 6,
    is_enabled    INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE payment_intents (
    id                    TEXT PRIMARY KEY,
    merchant_id           TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    project_id            TEXT REFERENCES projects(id) ON DELETE RESTRICT,
    settlement_wallet_id  TEXT NOT NULL REFERENCES settlement_wallets(id) ON DELETE RESTRICT,
    settlement_address    TEXT NOT NULL,
    network               TEXT NOT NULL,
    chain_id              INTEGER NOT NULL,
    usdc_address          TEXT NOT NULL,
    amount_decimal        TEXT NOT NULL,
    amount_base_units     TEXT NOT NULL,
    currency              TEXT NOT NULL DEFAULT 'USDC',
    order_id              TEXT,
    description           TEXT NOT NULL DEFAULT '',
    metadata              TEXT NOT NULL DEFAULT '{}',
    status                TEXT NOT NULL DEFAULT 'requires_payment'
      CHECK(status IN ('requires_payment','processing','succeeded','failed','expired','cancelled')),
    environment           TEXT NOT NULL CHECK(environment IN ('test','live')),
    expires_at            INTEGER NOT NULL,
    created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at            INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
];

function createLegacyDb(): void {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (existsSync(f)) rmSync(f);
  const db = new Database(TMP_DB, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  for (const ddl of LEGACY_DDL) db.run(ddl);

  // Arc registry rows exactly as production holds them today.
  db.run(
    `INSERT INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_enabled) VALUES(?,?,?,?,?,?,?,?)`,
    ['nc_arc_testnet', 'arc_testnet', 5042002, 'https://rpc.testnet.arc.io', 'https://explorer.testnet.arc.io', USDC, 6, 1]
  );
  db.run(
    `INSERT INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_enabled) VALUES(?,?,?,?,?,?,?,?)`,
    ['nc_arc_mainnet', 'arc_mainnet', 5042, 'https://rpc.mainnet.arc.io', 'https://explorer.arc.io', USDC, 6, 1]
  );

  // Existing merchant data that MUST survive the rebuild untouched.
  const now = Math.floor(Date.now() / 1000);
  db.run(`INSERT INTO merchants(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)`,
    ['merch_legacy', 'Legacy Merchant', null, now, now]);
  db.run(`INSERT INTO settlement_wallets(id,merchant_id,project_id,address,network,label,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    ['sw_legacy', 'merch_legacy', null, SETTLEMENT, 'arc_mainnet', 'primary', 1, now, now]);
  db.run(
    `INSERT INTO payment_intents(id,merchant_id,project_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,currency,order_id,description,metadata,status,environment,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['pi_legacy', 'merch_legacy', null, 'sw_legacy', SETTLEMENT, 'arc_mainnet', 5042, USDC, '10.00', '10000000',
     'USDC', 'ord_1', 'Legacy intent', '{}', 'succeeded', 'live', now + 3600, now, now]
  );
  db.close();
}

// Set DATABASE_URL BEFORE importing so getDb()/DB_PATH bind to the temp DB.
createLegacyDb();
process.env.DATABASE_URL = TMP_DB;
// `bun test` shares one module registry across test files, and schema.ts
// captures DB_PATH + the connection at module scope. Import a cache-busted
// specifier so this file gets its OWN schema-module instance and can never
// observe (or poison) the instance used by payment-expiry.test.ts.
const schemaModulePath = `./db/schema.ts?migration-test-${process.pid}`;
const { migrate, getDb } = (await import(/* @vite-ignore */ schemaModulePath)) as {
  migrate: () => void;
  getDb: () => Database;
};

type NetRow = {
  id: string; network: string; chain_id: number; rpc_url: string; explorer_base: string;
  usdc_address: string; usdc_decimals: number; is_testnet: number; required_confirmations: number;
  finality_mode: string; is_enabled: number; created_at: number;
};
function getNet(network: string): NetRow | undefined {
  return getDb().prepare('SELECT * FROM network_configs WHERE network=?').get(network) as NetRow | undefined;
}

// 1. Legacy Arc-only DB migrates successfully; Arc rows + legacy data intact.
test('1: legacy Arc-only DB migrates; Arc rows and merchant data survive', () => {
  migrate(); // first run performs the table rebuilds

  // CHECK constraints are gone from the live schema
  for (const table of ['network_configs', 'settlement_wallets']) {
    const { sql } = getDb().prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { sql: string };
    expect(sql).not.toContain("'arc_testnet'");
  }

  // Arc registry values are byte-for-byte preserved (Phase 5H adds the
  // finality_mode column — legacy rows gain it via ALTER, then the curated
  // self-heal pins Arc to 'immediate', which IS the preserved behavior).
  const t = getNet('arc_testnet')!;
  expect({ ...t, is_testnet: 0, required_confirmations: 0, created_at: 0 }).toEqual({
    id: 'nc_arc_testnet', network: 'arc_testnet', chain_id: 5042002,
    rpc_url: 'https://rpc.testnet.arc.io', explorer_base: 'https://explorer.testnet.arc.io',
    usdc_address: USDC, usdc_decimals: 6, is_enabled: 1, is_testnet: 0, required_confirmations: 0,
    finality_mode: 'immediate', created_at: 0,
  });
  const m = getNet('arc_mainnet')!;
  expect({ ...m, is_testnet: 0, required_confirmations: 0, created_at: 0 }).toEqual({
    id: 'nc_arc_mainnet', network: 'arc_mainnet', chain_id: 5042,
    rpc_url: 'https://rpc.mainnet.arc.io', explorer_base: 'https://explorer.arc.io',
    usdc_address: USDC, usdc_decimals: 6, is_enabled: 1, is_testnet: 0, required_confirmations: 0,
    finality_mode: 'immediate', created_at: 0,
  });

  // Existing payment intent is untouched
  const pi = getDb().prepare('SELECT * FROM payment_intents WHERE id=?').get('pi_legacy') as Record<string, unknown>;
  expect(pi).toBeTruthy();
  expect(pi.status).toBe('succeeded');
  expect(pi.network).toBe('arc_mainnet');
  expect(pi.chain_id).toBe(5042);
  expect(pi.amount_base_units).toBe('10000000');
  expect(pi.settlement_wallet_id).toBe('sw_legacy');
});

// 2/3/4. Arc rows get the correct environment class and unchanged finality.
test('2-4: arc_testnet is_testnet=1, arc_mainnet is_testnet=0, required_confirmations=0 (Arc behaviour preserved)', () => {
  expect(getNet('arc_testnet')!.is_testnet).toBe(1);
  expect(getNet('arc_mainnet')!.is_testnet).toBe(0);
  // Today Arc credits on receipt existence — Phase 1 must not add delay.
  expect(getNet('arc_testnet')!.required_confirmations).toBe(0);
  expect(getNet('arc_mainnet')!.required_confirmations).toBe(0);
});

// 5. Non-Arc network rows and settlement wallets can now be registered.
test('5: non-Arc network_configs row and settlement wallet insert cleanly', () => {
  const db = getDb();
  db.run(`INSERT INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_testnet) VALUES(?,?,?,?,?,?,?,?)`,
    ['nc_fixture_900001', 'fixture_net_a', 900001, 'http://localhost:1/rpc', 'http://localhost:1/ex', USDC, 6, 1]);
  expect(getNet('fixture_net_a')!.chain_id).toBe(900001);

  // The settlement_wallets.network CHECK previously rejected this row.
  db.run(`INSERT INTO settlement_wallets(id,merchant_id,address,network) VALUES(?,?,?,?)`,
    ['sw_fixture', 'merch_legacy', '0x1111111111111111111111111111111111111111', 'fixture_net_a']);
  expect(db.prepare('SELECT network FROM settlement_wallets WHERE id=?').get('sw_fixture')).toBeTruthy();
});

// 6/7. Duplicate chain_id protection follows partial-index semantics.
test('6-7: duplicate enabled chain_id rejected; disabled duplicates allowed; re-enabling rejected', () => {
  const db = getDb();
  // Same chain id as fixture_net_a (900001) but ENABLED → must be rejected.
  expect(() => db.run(`INSERT INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals) VALUES(?,?,?,?,?,?,?)`,
    ['nc_fixture_900001_dup', 'fixture_net_a_dup', 900001, 'http://localhost:1/rpc', 'http://localhost:1/ex', USDC, 6])).toThrow();

  // A DISABLED duplicate is allowed (partial index covers is_enabled=1 only).
  db.run(`INSERT INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_enabled) VALUES(?,?,?,?,?,?,?,?)`,
    ['nc_fixture_900002', 'fixture_net_b', 900002, 'http://localhost:1/rpc', 'http://localhost:1/ex', USDC, 6, 1]);
  db.run(`INSERT INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_enabled) VALUES(?,?,?,?,?,?,?,?)`,
    ['nc_fixture_900002_off', 'fixture_net_b_retired', 900002, 'http://localhost:2/rpc', 'http://localhost:2/ex', USDC, 6, 0]);

  // Enabling the second row for the same chain id must now be rejected.
  expect(() => db.run(`UPDATE network_configs SET is_enabled=1 WHERE id='nc_fixture_900002_off'`)).toThrow();
  // And both-disabled releases the constraint again.
  db.run(`UPDATE network_configs SET is_enabled=0 WHERE id='nc_fixture_900002'`);
  db.run(`UPDATE network_configs SET is_enabled=1 WHERE id='nc_fixture_900002_off'`);
  expect((getDb().prepare('SELECT is_enabled FROM network_configs WHERE id=?').get('nc_fixture_900002_off') as { is_enabled: number }).is_enabled).toBe(1);
});

// 8. Foreign keys remain enforced after the settlement_wallets rebuild.
test('8: FK enforcement intact — bogus reference rejected, referenced wallet delete RESTRICTed', () => {
  const db = getDb();
  expect(() => db.run(
    `INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,environment,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ['pi_bad_fk', 'merch_legacy', 'sw_does_not_exist', SETTLEMENT, 'arc_mainnet', 5042, USDC, '1.00', '1000000', 'live', 9999999999]
  )).toThrow();
  // sw_legacy is referenced by pi_legacy (status='succeeded') → RESTRICT blocks.
  expect(() => db.run(`DELETE FROM settlement_wallets WHERE id='sw_legacy'`)).toThrow();
  // No dangling rows anywhere.
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

// 9. migrate() is idempotent — safe to execute again.
test('9: migrate() re-run is a no-op (idempotent)', () => {
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM network_configs').get() as { n: number };
  const piBefore = getDb().prepare('SELECT * FROM payment_intents WHERE id=?').get('pi_legacy') as Record<string, unknown>;
  migrate();
  migrate();
  const after = getDb().prepare('SELECT COUNT(*) AS n FROM network_configs').get() as { n: number };
  expect(after.n).toBe(before.n);
  expect(getDb().prepare('SELECT * FROM payment_intents WHERE id=?').get('pi_legacy')).toEqual(piBefore);
  expect(getNet('arc_testnet')!.is_testnet).toBe(1);
  expect(getNet('arc_mainnet')!.is_testnet).toBe(0);
});

// 10. Enabled rows must keep USDC 6 decimals (seed validation, JafariPay is
// USDC-only — no generic token abstraction).
test('10: enabled row with usdc_decimals<>6 fails migrate() validation', () => {
  const db = getDb();
  db.run(`INSERT INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals) VALUES(?,?,?,?,?,?,?)`,
    ['nc_fixture_bad_dec', 'fixture_net_bad_decimals', 900003, 'http://localhost:3/rpc', 'http://localhost:3/ex', USDC, 18]);
  expect(() => migrate()).toThrow(/USDC-only/);
  // Clean up so the (re-runnable) validation stays green for the rest of the run.
  db.run(`DELETE FROM network_configs WHERE id='nc_fixture_bad_dec'`);
  migrate(); // restore known-good state
});

afterAll(() => {
  try { getDb().close(); } catch { /* already closed */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* Windows may still hold the handle briefly; safe to leave */ }
  }
});
