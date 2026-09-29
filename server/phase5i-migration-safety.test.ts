/**
 * JafariPay — MASTER PHASE Part 13: migration safety for the six-network registry.
 *
 * Proves the shared migrate() seed lands EXACTLY the six intended enabled
 * networks on BOTH a fresh (current-schema) database and a legacy Arc-only
 * database, without disturbing pre-existing rows or the preserved policies.
 *
 *   Fresh DB   : empty file -> migrate() builds schema + seeds -> 6 enabled.
 *   Legacy DB  : verbatim pre-Phase-1 Arc-only DDL + Arc rows + merchant/PI
 *                data -> migrate() rebuilds -> same 6 enabled, legacy data intact.
 *
 * Invariants asserted:
 *   • exactly six enabled networks, the canonical slugs + chain ids
 *   • preserved policies (Arc immediate/0, Base Sepolia count/3, Arb Sepolia count/24)
 *   • the two new mainnets (Base Mainnet finalized, Arbitrum One finalized)
 *   • no OTHER chain is enabled (OP/Polygon/Avalanche/Ethereum-payable/zkSync)
 *   • idempotent (re-run never duplicates or drifts)
 *   • self-healing (a deliberately corrupted curated row is restored)
 *   • FK-safe (foreign_key_check clean after migration)
 *
 * This file owns its OWN cache-busted schema instances (as migration-multichain
 * does) so it can never observe or poison the shared DB used by other suites.
 */
import { test, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { CIRCLE_INVENTORY, enabledEvmRows } from './db/networks.ts';

const USDC = '0x3600000000000000000000000000000000000000';
const SETTLEMENT = '0x3af65566013269a1c2f6ee97d49f93a98d51d220';

// The canonical end-state expected after the seed is DERIVED from the single
// source of truth (server/db/networks.ts) so this policy test can never drift
// from the registry it validates (PHASE 19). enabledEvmRows() is exactly the set
// the registry seeds; the complement (status !== IMPLEMENTED_ENABLED) is the set
// that must NEVER be enabled — held EVM, special-handling and all non-EVM rails,
// plus Ethereum which the operator keeps ENS-only (never payable).
const EXPECTED_ENABLED = enabledEvmRows().map((n) => n.slug).sort();
const EXPECTED_CHAIN_IDS = enabledEvmRows().map((n) => n.chainId as number).sort((a, b) => a - b);
const EXPECTED_COUNT = EXPECTED_ENABLED.length;
const FORBIDDEN_SLUGS = CIRCLE_INVENTORY.filter((n) => n.status !== 'IMPLEMENTED_ENABLED').map((n) => n.slug);
// Every audited EVM chain id that is NOT in the enabled set must stay un-enabled.
const FORBIDDEN_CHAIN_IDS = CIRCLE_INVENTORY
  .filter((n) => n.evm && n.chainId != null && n.status !== 'IMPLEMENTED_ENABLED')
  .map((n) => n.chainId as number);

function makeDb(path: string): Database {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) rmSync(f);
  return new Database(path, { create: true });
}

// Verbatim pre-Phase-1 Arc-only DDL (same as migration-multichain.test.ts).
const LEGACY_DDL = [
  `CREATE TABLE merchants (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`,
  `CREATE TABLE projects (id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`,
  `CREATE TABLE settlement_wallets (id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, address TEXT NOT NULL, network TEXT NOT NULL CHECK(network IN ('arc_testnet','arc_mainnet')), label TEXT NOT NULL DEFAULT '', is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(merchant_id, address, network))`,
  `CREATE TABLE network_configs (id TEXT PRIMARY KEY, network TEXT NOT NULL UNIQUE CHECK(network IN ('arc_testnet','arc_mainnet')), chain_id INTEGER NOT NULL, rpc_url TEXT NOT NULL, explorer_base TEXT NOT NULL, usdc_address TEXT NOT NULL, usdc_decimals INTEGER NOT NULL DEFAULT 6, is_enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT (unixepoch()))`,
  `CREATE TABLE payment_intents (id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT, project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT, settlement_wallet_id TEXT NOT NULL REFERENCES settlement_wallets(id) ON DELETE RESTRICT, settlement_address TEXT NOT NULL, network TEXT NOT NULL, chain_id INTEGER NOT NULL, usdc_address TEXT NOT NULL, amount_decimal TEXT NOT NULL, amount_base_units TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USDC', order_id TEXT, description TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'requires_payment' CHECK(status IN ('requires_payment','processing','succeeded','failed','expired','cancelled')), environment TEXT NOT NULL CHECK(environment IN ('test','live')), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`,
];

// ── Two independent DBs, each with its OWN cache-busted schema instance ──────
const FRESH_PATH = join(import.meta.dir, '..', 'data', `_p5i_migfresh_${process.pid}.db`);
const LEGACY_PATH = join(import.meta.dir, '..', 'data', `_p5i_miglegacy_${process.pid}.db`);
// Legacy DB: create the Arc-only shape + Arc rows + surviving merchant data.
{
  const db = makeDb(LEGACY_PATH);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  for (const ddl of LEGACY_DDL) db.run(ddl);
  db.run(`INSERT INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_enabled) VALUES(?,?,?,?,?,?,?,?)`,
    ['nc_arc_testnet', 'arc_testnet', 5042002, 'https://rpc.testnet.arc.io', 'https://explorer.testnet.arc.io', USDC, 6, 1]);
  db.run(`INSERT INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_enabled) VALUES(?,?,?,?,?,?,?,?)`,
    ['nc_arc_mainnet', 'arc_mainnet', 5042, 'https://rpc.mainnet.arc.io', 'https://explorer.arc.io', USDC, 6, 1]);
  const now = Math.floor(Date.now() / 1000);
  db.run(`INSERT INTO merchants(id,name,created_at,updated_at) VALUES(?,?,?,?)`, ['merch_legacy', 'Legacy Merchant', now, now]);
  db.run(`INSERT INTO settlement_wallets(id,merchant_id,address,network) VALUES(?,?,?,?)`, ['sw_legacy', 'merch_legacy', SETTLEMENT, 'arc_mainnet']);
  db.run(`INSERT INTO payment_intents(id,merchant_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,status,environment,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['pi_legacy', 'merch_legacy', 'sw_legacy', SETTLEMENT, 'arc_mainnet', 5042, USDC, '10.00', '10000000', 'succeeded', 'live', now + 3600]);
  db.close();
  for (const f of [FRESH_PATH, `${FRESH_PATH}-wal`, `${FRESH_PATH}-shm`]) if (existsSync(f)) rmSync(f);
}

// schema.ts freezes DB_PATH at module scope from DATABASE_URL, and each cache-
// busted specifier is a distinct module instance — so we set the env var
// immediately BEFORE each import to bind that instance to its own file.
process.env.DATABASE_URL = FRESH_PATH;
const fresh = (await import(`./db/schema.ts?p5i-migfresh-${process.pid}`)) as { migrate: () => void; getDb: () => Database };
process.env.DATABASE_URL = LEGACY_PATH;
const legacy = (await import(`./db/schema.ts?p5i-miglegacy-${process.pid}`)) as { migrate: () => void; getDb: () => Database };
function enabledSet(db: Database) {
  return (db.prepare('SELECT network FROM network_configs WHERE is_enabled=1 ORDER BY network').all() as { network: string }[]).map((r) => r.network);
}
function enabledChainIds(db: Database) {
  return (db.prepare('SELECT chain_id FROM network_configs WHERE is_enabled=1 ORDER BY chain_id').all() as { chain_id: number }[]).map((r) => r.chain_id);
}

const FRESH_DB = fresh.getDb();
// Fresh path: migrate() from an empty database creates + seeds.
fresh.migrate();
// Legacy path: point at the legacy file and rebuild it.
process.env.DATABASE_URL = LEGACY_PATH;
legacy.migrate();
const LEGACY_DB = legacy.getDb();

// ═══ 1. FRESH DB → exactly the canonical enabled set, per-network facts ═══
test('F1: fresh DB migrate() yields EXACTLY the canonical enabled network set', () => {
  expect(enabledSet(FRESH_DB)).toEqual(EXPECTED_ENABLED);
  expect(enabledSet(FRESH_DB)).toHaveLength(EXPECTED_COUNT);
  expect(enabledChainIds(FRESH_DB)).toEqual(EXPECTED_CHAIN_IDS);
});

test('F2: fresh DB preserves the four pre-existing policies untouched', () => {
  const g = (n: string) => FRESH_DB.prepare('SELECT finality_mode,required_confirmations,is_testnet FROM network_configs WHERE network=?').get(n) as { finality_mode: string; required_confirmations: number; is_testnet: number };
  expect(g('arc_testnet')).toEqual({ finality_mode: 'immediate', required_confirmations: 0, is_testnet: 1 });
  expect(g('arc_mainnet')).toEqual({ finality_mode: 'immediate', required_confirmations: 0, is_testnet: 0 });
  expect(g('base_sepolia')).toEqual({ finality_mode: 'count', required_confirmations: 3, is_testnet: 1 });
  expect(g('arbitrum_sepolia')).toEqual({ finality_mode: 'count', required_confirmations: 24, is_testnet: 1 });
});

test('F3: fresh DB adds the two mainnets as live-class finalized/0', () => {
  const g = (n: string) => FRESH_DB.prepare('SELECT finality_mode,required_confirmations,is_testnet,is_enabled FROM network_configs WHERE network=?').get(n) as Record<string, unknown>;
  expect(g('base_mainnet')).toEqual({ finality_mode: 'finalized', required_confirmations: 0, is_testnet: 0, is_enabled: 1 });
  expect(g('arbitrum_one')).toEqual({ finality_mode: 'finalized', required_confirmations: 0, is_testnet: 0, is_enabled: 1 });
});

// ═══ 2. LEGACY DB → same canonical set + legacy data intact + FK clean ═══
test('L1: legacy Arc-only DB migrates to the SAME canonical enabled set', () => {
  expect(enabledSet(LEGACY_DB)).toEqual(EXPECTED_ENABLED);
  expect(enabledChainIds(LEGACY_DB)).toEqual(EXPECTED_CHAIN_IDS);
});

test('L2: legacy merchant + payment intent survive the rebuild untouched', () => {
  const pi = LEGACY_DB.prepare('SELECT * FROM payment_intents WHERE id=?').get('pi_legacy') as Record<string, unknown>;
  expect(pi).toBeTruthy();
  expect(pi.status).toBe('succeeded');
  expect(pi.network).toBe('arc_mainnet');
  expect(pi.chain_id).toBe(5042);
  expect(pi.amount_base_units).toBe('10000000');
  expect(LEGACY_DB.prepare('SELECT id FROM settlement_wallets WHERE id=?').get('sw_legacy')).toBeTruthy();
});

test('L3: FK enforcement intact after legacy rebuild (no dangling rows)', () => {
  expect(LEGACY_DB.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

// ═══ 3. No non-enabled chain is ever enabled (held EVM + special + non-EVM + Ethereum-payable) ═══
test('N1: no held / special-handling / non-EVM / Ethereum-payable row is enabled', () => {
  for (const db of [FRESH_DB, LEGACY_DB]) {
    for (const slug of FORBIDDEN_SLUGS) {
      expect(db.prepare('SELECT id FROM network_configs WHERE network=? AND is_enabled=1').get(slug)).toBeNull();
    }
    // Every audited-but-not-enabled EVM chain id (incl. Ethereum 1 = ENS-only,
    // Monad/Sonic/HyperEVM held or special) must NOT appear as an enabled row.
    for (const chain of FORBIDDEN_CHAIN_IDS) {
      expect(db.prepare('SELECT id FROM network_configs WHERE chain_id=? AND is_enabled=1').get(chain)).toBeNull();
    }
  }
});

// ═══ 4. Idempotent + restart-safe + self-healing ═══
test('I1: migrate() re-run on both DBs stays the canonical set (idempotent, restart-safe)', () => {
  for (const [db, mod] of [[FRESH_DB, fresh], [LEGACY_DB, legacy]] as const) {
    mod.migrate();
    mod.migrate();
    expect(enabledSet(db)).toEqual(EXPECTED_ENABLED);
    expect(enabledSet(db)).toHaveLength(EXPECTED_COUNT);
  }
});

test('S1: self-healing restores a deliberately corrupted mainnet curated row', () => {
  FRESH_DB.prepare('UPDATE network_configs SET rpc_url=?, is_enabled=0, usdc_address=?, finality_mode=?, required_confirmations=? WHERE network=?')
    .run('https://evil.example/', '0x0000000000000000000000000000000000000000', 'count', 999, 'base_mainnet');
  // sanity: the corruption took
  expect(FRESH_DB.prepare('SELECT is_enabled FROM network_configs WHERE network=?').get('base_mainnet')).toEqual({ is_enabled: 0 });
  fresh.migrate();
  const row = FRESH_DB.prepare('SELECT rpc_url,usdc_address,finality_mode,required_confirmations,is_enabled,is_testnet FROM network_configs WHERE network=?').get('base_mainnet') as Record<string, unknown>;
  expect(row).toEqual({
    rpc_url: 'https://mainnet.base.org', usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    finality_mode: 'finalized', required_confirmations: 0, is_enabled: 1, is_testnet: 0,
  });
  expect(enabledSet(FRESH_DB)).toEqual(EXPECTED_ENABLED);
});

test('S2: self-healing restores a deliberately corrupted MASTER-EXPANSION curated row', () => {
  // The newly enabled rows use the SAME self-healing reconcile UPDATE, so an
  // operator/DBA tamper with one (wrong RPC, disabled, wrong token, bogus mode)
  // is reverted on the next migrate() — proving the expansion is restart-safe too.
  FRESH_DB.prepare('UPDATE network_configs SET rpc_url=?, is_enabled=0, usdc_address=?, finality_mode=? WHERE network=?')
    .run('https://evil.example/', '0x0000000000000000000000000000000000000000', 'immediate', 'polygon_pos');
  fresh.migrate();
  const row = FRESH_DB.prepare('SELECT rpc_url,usdc_address,finality_mode,is_enabled,is_testnet FROM network_configs WHERE network=?').get('polygon_pos') as Record<string, unknown>;
  expect(row).toEqual({
    rpc_url: 'https://polygon.drpc.org', usdc_address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    finality_mode: 'finalized', is_enabled: 1, is_testnet: 0,
  });
  expect(enabledSet(FRESH_DB)).toEqual(EXPECTED_ENABLED);
});

afterAll(() => {
  for (const db of [FRESH_DB, LEGACY_DB]) { try { db.close(); } catch { /* already closed */ } }
  for (const base of [FRESH_PATH, LEGACY_PATH]) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { const f = base + suffix; if (existsSync(f)) rmSync(f, { force: true }); } catch { /* OS handle */ }
    }
  }
});
