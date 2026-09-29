/**
 * JafariPay — Database schema + migrations (Bun built-in SQLite)
 */

import { Database } from 'bun:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { CIRCLE_INVENTORY, newlyEnabledEvmRows } from './networks.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_URL || path.join(__dirname, '../../data/jafaripay.db');

let _db: Database | null = null;

// ── Phase 1 multi-chain registry migration helpers ──────────────────────
// SQLite cannot drop a CHECK constraint via ALTER, so a legacy table (one
// whose stored DDL still contains the Arc-only `CHECK(network IN
// ('arc_testnet','arc_mainnet'))`) is rebuilt with the canonical 12-step
// procedure: PRAGMA foreign_keys=OFF → BEGIN → create replacement → copy →
// drop old → rename → commit → recreate indexes → PRAGMA foreign_keys=ON.
// ALTER TABLE ... RENAME rewrites FK clauses that reference the *renamed*
// table, not clauses that merely resolve to its name — payment_intents'
// `REFERENCES settlement_wallets(id) ON DELETE RESTRICT` stays intact and
// re-binds to the replacement automatically. The whole step is idempotent:
// once sqlite_master no longer mentions the legacy literals it is a no-op.

function tableDdl(db: Database, table: string): string {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { sql: string } | null;
  return row?.sql ?? '';
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}

function hasArcOnlyCheck(db: Database, table: string): boolean {
  return tableDdl(db, table).includes("'arc_testnet'");
}

function ensureRegistrySchema(db: Database): void {
  const ncNeedsRebuild = hasArcOnlyCheck(db, 'network_configs')
    || !hasColumn(db, 'network_configs', 'is_testnet')
    || !hasColumn(db, 'network_configs', 'required_confirmations');
  const swNeedsRebuild = hasArcOnlyCheck(db, 'settlement_wallets');
  if (!ncNeedsRebuild && !swNeedsRebuild) return;

  db.run('PRAGMA foreign_keys = OFF'); // must be set outside a transaction
  db.run('BEGIN');
  try {
    if (ncNeedsRebuild) {
      db.run(`CREATE TABLE network_configs_new (
        id                     TEXT PRIMARY KEY,
        network                TEXT NOT NULL UNIQUE,
        chain_id               INTEGER NOT NULL,
        rpc_url                TEXT NOT NULL,
        explorer_base          TEXT NOT NULL,
        usdc_address           TEXT NOT NULL,
        usdc_decimals          INTEGER NOT NULL DEFAULT 6,
        is_testnet             INTEGER NOT NULL DEFAULT 0,
        required_confirmations INTEGER NOT NULL DEFAULT 0,
        finality_mode          TEXT NOT NULL DEFAULT 'count',
        is_enabled             INTEGER NOT NULL DEFAULT 1,
        created_at             INTEGER NOT NULL DEFAULT (unixepoch())
      )`);
      // The legacy table has no is_testnet / required_confirmations columns —
      // they take their defaults (0) and the Arc markings are applied after
      // the seed step below. required_confirmations=0 preserves today's Arc
      // behaviour exactly: a confirmed receipt is credited without any new
      // confirmation delay. finality_mode defaults to 'count' — the semantic
      // of every pre-5H row (a required_confirmations depth gate) — and the
      // curated backfill UPDATEs below pin the canonical per-network values.
      db.run(`INSERT INTO network_configs_new
                (id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_enabled,created_at)
              SELECT id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_enabled,created_at
                FROM network_configs`);
      db.run('DROP TABLE network_configs');
      db.run('ALTER TABLE network_configs_new RENAME TO network_configs');
    }

    if (swNeedsRebuild) {
      db.run(`CREATE TABLE settlement_wallets_new (
        id          TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
        address     TEXT NOT NULL,
        network     TEXT NOT NULL,
        label       TEXT NOT NULL DEFAULT '',
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(merchant_id, address, network)
      )`);
      db.run(`INSERT INTO settlement_wallets_new
                (id,merchant_id,project_id,address,network,label,is_active,created_at,updated_at)
              SELECT id,merchant_id,project_id,address,network,label,is_active,created_at,updated_at
                FROM settlement_wallets`);
      db.run('DROP TABLE settlement_wallets');
      db.run('ALTER TABLE settlement_wallets_new RENAME TO settlement_wallets');
    }
    db.run('COMMIT');
  } catch (err) {
    try { db.run('ROLLBACK'); } catch { /* already rolled back */ }
    db.run('PRAGMA foreign_keys = ON');
    throw err;
  }
  db.run('PRAGMA foreign_keys = ON');

  // Post-rebuild integrity: no dangling FK rows, and recreate required indexes.
  const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
  if (violations.length > 0) {
    throw new Error(`[DB] Registry migration aborted — foreign_key_check reports ${violations.length} violation(s)`);
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_settlement_wallets_merchant ON settlement_wallets(merchant_id)');
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS uq_network_configs_enabled_chain ON network_configs(chain_id) WHERE is_enabled = 1');
  console.log('[DB] Multi-chain registry schema migration applied (CHECK constraints relaxed).');
}

// ── Phase 5H: finality_mode column ──────────────────────────────────────
// A plain additive column — unlike the Phase 1 CHECK relaxation this needs
// no table rebuild. NOT NULL with a DEFAULT is legal in SQLite ALTER TABLE.
// The default 'count' is semantically faithful: every pre-5H row's policy was
// exactly "required_confirmations child blocks below the latest head".
function ensureFinalityModeColumn(db: Database): void {
  if (hasColumn(db, 'network_configs', 'finality_mode')) return;
  db.run(`ALTER TABLE network_configs ADD COLUMN finality_mode TEXT NOT NULL DEFAULT 'count'`);
  console.log('[DB] Phase 5H: added network_configs.finality_mode (default \'count\').');
}

// ── MASTER PHASE B: customer receipt system ─────────────────────────────
// Purely ADDITIVE and backward-compatible. Two changes, each guarded so
// re-running migrate() is a no-op:
//   1. payment_intents.customer_email — an optional (nullable) destination for
//      the customer receipt, supplied by the merchant at intent creation. It is
//      NEVER part of the money/verification gate; existing rows get NULL and
//      every pre-existing intent behaves exactly as before.
//   2. a receipts table — one immutable receipt per SUCCEEDED payment. The
//      UNIQUE(payment_id) constraint is the duplicate-receipt prevention gate.
//      A receipt row is created ONLY after a payment is verified + credited;
//      intent creation alone never produces one. email_status is tracked on the
//      receipt, NOT on the payment: email success/failure can never move a
//      payment off 'succeeded' (the whole point of the isolation).
function ensureCustomerEmailColumn(db: Database): void {
  if (hasColumn(db, 'payment_intents', 'customer_email')) return;
  db.run(`ALTER TABLE payment_intents ADD COLUMN customer_email TEXT`);
  console.log('[DB] Phase B: added payment_intents.customer_email (nullable).');
}

// ── MASTER PHASE C: link an intent back to the Payment Link that minted it.
// Nullable + additive; existing intents (and intents created directly via the
// Payment Intent API) keep NULL and behave identically. This column is how a
// link detects "already paid" and prevents a second charge (replay) — it is NOT
// a money field and never enters the verification gate.
function ensurePaymentLinkColumn(db: Database): void {
  if (hasColumn(db, 'payment_intents', 'payment_link_id')) return;
  db.run(`ALTER TABLE payment_intents ADD COLUMN payment_link_id TEXT`);
  db.run('CREATE INDEX IF NOT EXISTS idx_pi_link ON payment_intents(payment_link_id)');
  console.log('[DB] Phase C: added payment_intents.payment_link_id (nullable).');
}

// ── MASTER PHASE L (H-1): store the webhook signing secret ENCRYPTED at rest so
// the server can sign with the same secret the merchant verifies with. Additive +
// nullable; runs after webhook_endpoints exists. Idempotent via hasColumn.
function ensureWebhookSecretEncryptionColumn(db: Database): void {
  if (hasColumn(db, 'webhook_endpoints', 'secret_ciphertext')) return;
  db.run(`ALTER TABLE webhook_endpoints ADD COLUMN secret_ciphertext TEXT`);
  console.log('[DB] Phase L: added webhook_endpoints.secret_ciphertext (nullable, AES-256-GCM envelope).');
}

function ensureReceiptsSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS receipts (
    id                TEXT PRIMARY KEY,
    payment_id        TEXT NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
    payment_intent_id TEXT NOT NULL REFERENCES payment_intents(id) ON DELETE RESTRICT,
    merchant_id       TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    customer_email    TEXT,
    merchant_name     TEXT NOT NULL DEFAULT '',
    order_id          TEXT,
    amount_decimal    TEXT NOT NULL,
    amount_base_units TEXT NOT NULL,
    currency          TEXT NOT NULL,
    network           TEXT NOT NULL,
    chain_id          INTEGER NOT NULL,
    tx_hash           TEXT NOT NULL,
    explorer_url      TEXT NOT NULL DEFAULT '',
    block_timestamp   INTEGER NOT NULL,
    payment_status    TEXT NOT NULL DEFAULT 'succeeded',
    email_status      TEXT NOT NULL DEFAULT 'pending'
      CHECK(email_status IN ('pending','sent','failed','skipped','no_email')),
    email_attempts    INTEGER NOT NULL DEFAULT 0,
    last_email_error  TEXT,
    next_email_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
    emailed_at        INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_receipts_merchant ON receipts(merchant_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_receipts_pi ON receipts(payment_intent_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_receipts_email_status ON receipts(email_status, next_email_attempt_at)');
}

export function getDb(): Database {
  if (_db) {
    // `bun test` shares one module registry across test files; a previous
    // file may have closed the handle in its afterAll. Reopen instead of
    // surfacing "Database has closed". Production code never closes the DB,
    // so this guard is inert there.
    try {
      _db.run('SELECT 1');
      return _db;
    } catch {
      _db = null;
    }
  }
  if (!_db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH, { create: true });
    _db.run('PRAGMA journal_mode = WAL');
    _db.run('PRAGMA foreign_keys = ON');
    _db.run('PRAGMA busy_timeout = 5000');
  }
  return _db;
}

// Build RPC URL from proxy env vars or fall back to public Arc endpoints
function buildRpcUrl(compassChain: string, publicFallback: string): string {
  const proxyChains = (process.env.RPC_PROXY_CHAINS || '').split(',');
  if (process.env.RPC_PROXY_BASE_URL && proxyChains.includes(compassChain)) {
    return `${process.env.RPC_PROXY_BASE_URL}/api/rpc/${compassChain}?_rpc_token=${process.env.RPC_PROXY_TOKEN}`;
  }
  return publicFallback; // arc-studio-allow-onchain-literal
}

export function migrate(): void {
  const db = getDb();

  db.run(`CREATE TABLE IF NOT EXISTS merchants (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    email       TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS merchant_wallets (
    id          TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    address     TEXT NOT NULL,
    chain_id    INTEGER NOT NULL DEFAULT 5042002,
    is_primary  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(address)
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_merchant_wallets_merchant ON merchant_wallets(merchant_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_merchant_wallets_address ON merchant_wallets(address)');

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id             TEXT PRIMARY KEY,
    merchant_id    TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    wallet_address TEXT NOT NULL,
    expires_at     INTEGER NOT NULL,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    revoked        INTEGER NOT NULL DEFAULT 0
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_merchant ON sessions(merchant_id)');

  db.run(`CREATE TABLE IF NOT EXISTS auth_nonces (
    nonce       TEXT PRIMARY KEY,
    address     TEXT,
    expires_at  INTEGER NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_projects_merchant ON projects(merchant_id)');

  db.run(`CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT PRIMARY KEY,
    merchant_id  TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
    name         TEXT NOT NULL,
    key_prefix   TEXT NOT NULL,
    key_hash     TEXT NOT NULL,
    key_preview  TEXT NOT NULL,
    is_secret    INTEGER NOT NULL DEFAULT 0,
    environment  TEXT NOT NULL CHECK(environment IN ('test','live')),
    is_active    INTEGER NOT NULL DEFAULT 1,
    last_used_at INTEGER,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    revoked_at   INTEGER
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_api_keys_merchant ON api_keys(merchant_id)');

  db.run(`CREATE TABLE IF NOT EXISTS settlement_wallets (
    id          TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
    address     TEXT NOT NULL,
    network     TEXT NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(merchant_id, address, network)
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_settlement_wallets_merchant ON settlement_wallets(merchant_id)');

  // Supported-network registry. The `network` slug is intentionally NOT
  // constrained to an Arc-only allow-list (multi-chain Phase 1): the valid
  // set is exactly the enabled rows of this table. Registry rows are managed
  // ONLY by migrations/ops — there is no API that writes this table.
  db.run(`CREATE TABLE IF NOT EXISTS network_configs (
    id                     TEXT PRIMARY KEY,
    network                TEXT NOT NULL UNIQUE,
    chain_id               INTEGER NOT NULL,
    rpc_url                TEXT NOT NULL,
    explorer_base          TEXT NOT NULL,
    usdc_address           TEXT NOT NULL,
    usdc_decimals          INTEGER NOT NULL DEFAULT 6,
    is_testnet             INTEGER NOT NULL DEFAULT 0,
    required_confirmations INTEGER NOT NULL DEFAULT 0,
    finality_mode          TEXT NOT NULL DEFAULT 'count',
    is_enabled             INTEGER NOT NULL DEFAULT 1,
    created_at             INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  // Two enabled networks must never share a chain id — aliasing would let one
  // RPC serve two "different" registry networks (chain-confusion risk).
  // Disabled rows may reuse a chain id (e.g. a re-added network keeps history).
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS uq_network_configs_enabled_chain ON network_configs(chain_id) WHERE is_enabled = 1');

  // Existing production databases still carry the legacy Arc-only CHECK
  // constraints above; SQLite cannot drop a CHECK via ALTER, so migrate the
  // real tables (idempotent, no-op once the new shape is in place).
  ensureRegistrySchema(db);
  // Phase 5H: additive finality_mode column for databases that already have
  // the post-Phase-1 shape (the rebuild path above carries it natively).
  ensureFinalityModeColumn(db);

  db.run(`CREATE TABLE IF NOT EXISTS payment_intents (
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
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_pi_merchant ON payment_intents(merchant_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_pi_status ON payment_intents(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_pi_order ON payment_intents(order_id)');

  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id                  TEXT PRIMARY KEY,
    payment_intent_id   TEXT NOT NULL REFERENCES payment_intents(id) ON DELETE RESTRICT,
    merchant_id         TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    tx_hash             TEXT NOT NULL,
    network             TEXT NOT NULL,
    chain_id            INTEGER NOT NULL,
    sender_address      TEXT NOT NULL,
    recipient_address   TEXT NOT NULL,
    amount_base_units   TEXT NOT NULL,
    amount_decimal      TEXT NOT NULL,
    block_number        INTEGER NOT NULL,
    block_timestamp     INTEGER NOT NULL,
    status              TEXT NOT NULL DEFAULT 'succeeded',
    verified_at         INTEGER NOT NULL DEFAULT (unixepoch()),
    created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(tx_hash, network)
  )`);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_pi ON payments(payment_intent_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_payments_tx ON payments(tx_hash, network)');

  db.run(`CREATE TABLE IF NOT EXISTS blockchain_transactions (
    id              TEXT PRIMARY KEY,
    tx_hash         TEXT NOT NULL,
    network         TEXT NOT NULL,
    chain_id        INTEGER NOT NULL,
    block_number    INTEGER NOT NULL,
    block_timestamp INTEGER NOT NULL,
    from_address    TEXT NOT NULL,
    to_address      TEXT NOT NULL,
    usdc_address    TEXT NOT NULL,
    amount          TEXT NOT NULL,
    log_index       INTEGER NOT NULL DEFAULT 0,
    raw_receipt     TEXT NOT NULL DEFAULT '{}',
    payment_id      TEXT REFERENCES payments(id),
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(tx_hash, network)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payment_events (
    id                TEXT PRIMARY KEY,
    payment_intent_id TEXT NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
    event_type        TEXT NOT NULL,
    from_status       TEXT,
    to_status         TEXT,
    data              TEXT NOT NULL DEFAULT '{}',
    created_at        INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_pe_pi ON payment_events(payment_intent_id)');

  db.run(`CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id             TEXT PRIMARY KEY,
    merchant_id    TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
    url            TEXT NOT NULL,
    secret_hash    TEXT NOT NULL,
    secret_preview TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    events         TEXT NOT NULL DEFAULT '["payment.created","payment.succeeded","payment.failed","payment.expired","payment.processing"]',
    environment    TEXT NOT NULL CHECK(environment IN ('test','live')),
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_wh_merchant ON webhook_endpoints(merchant_id)');

  db.run(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id                  TEXT PRIMARY KEY,
    webhook_endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    payment_intent_id   TEXT NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
    event_type          TEXT NOT NULL,
    payload             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','delivering','delivered','failed')),
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    last_response_code  INTEGER,
    last_response_body  TEXT,
    last_error          TEXT,
    delivered_at        INTEGER,
    created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_wd_endpoint ON webhook_deliveries(webhook_endpoint_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_wd_pi ON webhook_deliveries(payment_intent_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_wd_status_next ON webhook_deliveries(status, next_attempt_at)');

  db.run(`CREATE TABLE IF NOT EXISTS idempotency_keys (
    id              TEXT PRIMARY KEY,
    merchant_id     TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    key             TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    response_body   TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    resource_id     TEXT,
    resource_type   TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at      INTEGER NOT NULL DEFAULT (unixepoch() + 86400),
    UNIQUE(merchant_id, key)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id          TEXT PRIMARY KEY,
    merchant_id TEXT REFERENCES merchants(id) ON DELETE SET NULL,
    actor_type  TEXT NOT NULL DEFAULT 'merchant',
    action      TEXT NOT NULL,
    resource    TEXT,
    resource_id TEXT,
    metadata    TEXT NOT NULL DEFAULT '{}',
    ip_address  TEXT,
    user_agent  TEXT,
    request_id  TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_merchant ON audit_logs(merchant_id)');

  // ── MASTER PHASE B: additive receipt schema (see helpers above). Runs after
  // payment_intents + payments exist so the ALTER ADD COLUMN and the receipts
  // FK both bind correctly. Idempotent: guarded by hasColumn / IF NOT EXISTS.
  ensureCustomerEmailColumn(db);
  ensurePaymentLinkColumn(db);
  ensureReceiptsSchema(db);
  // ── MASTER PHASE L (H-1): webhook signing secret is now stored ENCRYPTED at
  // rest (AES-256-GCM) so the server can sign with the exact secret the merchant
  // holds. Additive + nullable; existing rows keep only secret_hash (unverifiable
  // for signing) until the merchant rotates once. secret_hash is retained for
  // lifecycle/identity only and is no longer used to sign.
  ensureWebhookSecretEncryptionColumn(db);

  // ── MASTER PHASE C: reusable Payment Links (invoices). A payment_link is a
  // durable, merchant-owned intent TEMPLATE that mints concrete payment_intents
  // on demand — it never stores money state itself and reuses the entire intent
  // + verification + receipt pipeline. Purely additive; no existing table shape
  // changes. allowed_networks is a JSON array of registry slugs (empty = any
  // network the merchant's API-key environment permits).
  db.run(`CREATE TABLE IF NOT EXISTS payment_links (
    id                TEXT PRIMARY KEY,
    merchant_id       TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
    amount_decimal    TEXT NOT NULL,
    amount_base_units TEXT NOT NULL,
    currency          TEXT NOT NULL DEFAULT 'USDC',
    description       TEXT NOT NULL DEFAULT '',
    order_id          TEXT,
    metadata          TEXT NOT NULL DEFAULT '{}',
    allowed_networks  TEXT NOT NULL DEFAULT '[]',
    expires_at        INTEGER,
    status            TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active','disabled')),
    environment       TEXT NOT NULL CHECK(environment IN ('test','live')),
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_payment_links_merchant ON payment_links(merchant_id)');

  // Seed network configs (idempotent insert)
  const usdcAddress = '0x3600000000000000000000000000000000000000'; // arc-studio-allow-onchain-literal
  db.run(
    `INSERT OR IGNORE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals) VALUES(?,?,?,?,?,?,?)`,
    ['nc_arc_testnet', 'arc_testnet', 5042002, // arc-studio-allow-onchain-literal
     buildRpcUrl('Arc_Testnet', 'https://rpc.testnet.arc.io'), // arc-studio-allow-onchain-literal
     'https://explorer.testnet.arc.io', usdcAddress, 6] // arc-studio-allow-onchain-literal
  );
  db.run(
    `INSERT OR IGNORE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals) VALUES(?,?,?,?,?,?,?)`,
    ['nc_arc_mainnet', 'arc_mainnet', 5042, // arc-studio-allow-onchain-literal
     buildRpcUrl('Arc', 'https://rpc.mainnet.arc.io'), // arc-studio-allow-onchain-literal
     'https://explorer.arc.io', usdcAddress, 6] // arc-studio-allow-onchain-literal
  );

  // Reconcile the Arc MAINNET row to the independently-verified canonical values.
  // INSERT OR IGNORE above does nothing when the row already exists, so an existing
  // DB created before these values were confirmed would keep stale data. This
  // UPDATE is idempotent and self-healing: it enforces the verified Arc Mainnet
  // chain_id / RPC / USDC predeploy / decimals / explorer on every migrate().
  // The Testnet row is intentionally NOT touched here.
  db.run(
    `UPDATE network_configs
       SET chain_id=?, rpc_url=?, explorer_base=?, usdc_address=?, usdc_decimals=?
     WHERE network='arc_mainnet'`,
    [5042, // arc-studio-allow-onchain-literal
     buildRpcUrl('Arc', 'https://rpc.mainnet.arc.io'), // arc-studio-allow-onchain-literal
     'https://explorer.arc.io', usdcAddress, 6] // arc-studio-allow-onchain-literal
  );

  // ── Phase 1: environment class + finality policy for the Arc rows.
  // These UPDATEs are idempotent and cover BOTH paths: a migrated legacy DB
  // (columns arrived via the table rebuild with default 0) and a fresh DB
  // (rows inserted by the seed above without the new columns).
  // required_confirmations stays 0 on Arc — preserving today's behaviour
  // (credit as soon as the receipt exists); no new confirmation delay is
  // introduced for Arc Mainnet or Arc Testnet in this phase.
  // Phase 5H names that existing behaviour explicitly: finality_mode
  // 'immediate' — receipt-exists credits, no head/tag read gate. This is
  // Arc's officially documented optimal policy (docs.arc.io: BFT deterministic
  // finality <1s, "no confirmation-count thresholds" needed), not a compromise.
  db.run(`UPDATE network_configs SET is_testnet=1, required_confirmations=0, finality_mode='immediate' WHERE network='arc_testnet'`);
  db.run(`UPDATE network_configs SET is_testnet=0, required_confirmations=0, finality_mode='immediate' WHERE network='arc_mainnet'`);

  // ── Phase 5H generic backfill note: any row that predates the column keeps
  // its EXACT prior semantics automatically — ALTER TABLE ... ADD COLUMN
  // NOT NULL DEFAULT 'count' backfills existing rows with the mode that IS
  // their historical behavior (a required_confirmations depth gate), and no
  // required_confirmations value is read or rewritten by this phase.
  // The curated UPDATEs below additionally pin finality_mode on every known
  // row on every boot (self-healing, same reviewed pattern as 5B/5F/Phase 1).

  // ── Phase 5B: Base Sepolia — the FIRST additional real network (TESTNET only).
  // All facts are verified against official sources, never guessed:
  //   • chain id 84532  = viem `baseSepolia` (testnet:true) and onchain-facts
  //   • USDC            = Circle OFFICIAL Base Sepolia contract address
  //                       0x036CbD53842c5426634e7929541eC2318f3dCF7e (6 decimals)
  //                       https://developers.circle.com/stablecoins/usdc-contract-addresses
  //   • RPC             = https://sepolia.base.org (Base official public testnet RPC)
  //   • explorer        = https://sepolia.basescan.org (Basescan, viem + onchain-facts)
  // required_confirmations=3 is an explicitly justified testnet finality value:
  // Base Sepolia is an OP-stack L2 with ~2s blocks, so 3 confirmations (~6s)
  // guards the public testnet against shallow reorgs while keeping the flow fast
  // and, unlike Arc's 0, exercises the registry-driven finality gate on a real
  // network. is_enabled=1 because the row passes every provider registry check
  // (chain id >0, valid RPC URL, 0x[40hex] USDC, decimals 6, confirmations >=0).
  // BASE MAINNET IS DELIBERATELY NOT REGISTERED OR ENABLED IN THIS PHASE.
  // Seed is idempotent (INSERT OR IGNORE) + a self-healing reconcile UPDATE,
  // mirroring the Arc Mainnet reconcile above, so existing installs pick up the
  // verified canonical values on the next migrate(). The Arc rows are untouched.
  const baseSepoliaUsdc = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // arc-studio-allow-onchain-literal — Circle official Base Sepolia USDC
  db.run(
    `INSERT OR IGNORE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_testnet,required_confirmations,finality_mode,is_enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ['nc_base_sepolia', 'base_sepolia', 84532, // arc-studio-allow-onchain-literal
     'https://sepolia.base.org', 'https://sepolia.basescan.org', // arc-studio-allow-onchain-literal
     baseSepoliaUsdc, 6, 1, 3, 'count', 1]
  );
  db.run(
    `UPDATE network_configs
       SET chain_id=?, rpc_url=?, explorer_base=?, usdc_address=?, usdc_decimals=?, is_testnet=?, required_confirmations=?, finality_mode=?, is_enabled=?
     WHERE network='base_sepolia'`,
    [84532, // arc-studio-allow-onchain-literal
     'https://sepolia.base.org', 'https://sepolia.basescan.org', // arc-studio-allow-onchain-literal
     baseSepoliaUsdc, 6, 1, 3, 'count', 1]
  );

  // ── Phase 5F: Arbitrum Sepolia — the SECOND independent EVM network (TESTNET only).
  // Proves the registry-driven architecture needs no per-chain code: this row +
  // the frontend allowlist + one CSP host is the entire change (provider,
  // verification and checkout logic are untouched).
  // All facts verified against official sources, never copied from memory:
  //   • chain id 421614 = docs.arbitrum.io "RPC endpoints and providers" table
  //                       (Arbitrum Sepolia (Testnet), Nitro rollup, parent Sepolia)
  //                       + viem `arbitrumSepolia` (testnet:true, blockTime 250ms)
  //                       + live eth_chainId == 0x66eee (421614) this phase
  //   • USDC            = Circle OFFICIAL Arbitrum Sepolia contract address
  //                       0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d (6 decimals)
  //                       https://developers.circle.com/stablecoins/usdc-contract-addresses
  //                       NATIVE CIRCLE USDC ONLY — NOT legacy bridged USDC.e
  //                       (0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8, which is
  //                       Arbitrum ONE's USDC.e and has no code on Sepolia).
  //   • RPC             = https://sepolia-rollup.arbitrum.io/rpc (official table + viem)
  //   • explorer        = https://sepolia.arbiscan.io (official table + viem +
  //                       onchain-facts) — compatible with buildTxExplorerUrl(),
  //                       which appends '/tx/<hash>' to explorerBase.
  // required_confirmations=24 is derived, not guessed. Official Arbitrum docs
  // (how-arbitrum-works/reference/finality-and-reorgs) state that a child-block
  // confirmation COUNT does not translate to Arbitrum finality — reorg exposure
  // is bounded by PARENT-chain finality, and irreversible crediting should wait
  // for the `finalized` block tag. The provider's only registry primitive is a
  // child-block count, so this value keeps the same wall-clock discipline the
  // reviewed Base Sepolia policy uses (3 blocks x ~2s = ~6s of head growth) at
  // Arbitrum Sepolia's curated/measured ~250ms block time: 6s / 0.25s = 24
  // blocks (measured live this phase: 25 blocks in ~6s). It is a shallow
  // head-progression gate that rejects crediting at the sequencer tip — it is
  // explicitly NOT hard finality; see the Phase 5F report's open note.
  // ARBITRUM ONE (42161) AND BASE MAINNET (8453) WERE DELIBERATELY DEFERRED HERE
  // (testnet-first discipline). They are registered in the MASTER PHASE block
  // below, after the Phase 5I readiness audit classified both READY.
  // Idempotent seed (INSERT OR IGNORE) + self-healing reconcile UPDATE, exactly
  // like Base Sepolia, so existing installs pick up the canonical values on the
  // next migrate(). The Arc rows and the Base Sepolia row are untouched.
  const arbitrumSepoliaUsdc = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'; // arc-studio-allow-onchain-literal — Circle official Arbitrum Sepolia USDC (native, not USDC.e)
  db.run(
    `INSERT OR IGNORE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_testnet,required_confirmations,finality_mode,is_enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ['nc_arbitrum_sepolia', 'arbitrum_sepolia', 421614, // arc-studio-allow-onchain-literal
     'https://sepolia-rollup.arbitrum.io/rpc', 'https://sepolia.arbiscan.io', // arc-studio-allow-onchain-literal
     arbitrumSepoliaUsdc, 6, 1, 24, 'count', 1]
  );
  db.run(
    `UPDATE network_configs
       SET chain_id=?, rpc_url=?, explorer_base=?, usdc_address=?, usdc_decimals=?, is_testnet=?, required_confirmations=?, finality_mode=?, is_enabled=?
     WHERE network='arbitrum_sepolia'`,
    [421614, // arc-studio-allow-onchain-literal
     'https://sepolia-rollup.arbitrum.io/rpc', 'https://sepolia.arbiscan.io', // arc-studio-allow-onchain-literal
     arbitrumSepoliaUsdc, 6, 1, 24, 'count', 1]
  );

  // ── MASTER PHASE: Base Mainnet (8453) + Arbitrum One (42161) — production
  // multi-chain expansion, authorized by the Phase 5I readiness audit (both
  // classified READY FOR IMPLEMENTATION). Same registry-driven pattern as
  // 5B/5F: one row each, provider/verification/checkout logic UNTOUCHED.
  // All facts verified against OFFICIAL sources, never guessed or copied from
  // the Sepolia rows:
  //   • Base Mainnet  chain 8453, RPC https://mainnet.base.org, explorer
  //                   https://basescan.org (docs.base.org connect-to-base + viem
  //                   `base`), native Circle USDC
  //                   0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (6 decimals,
  //                   Circle USDC contract-addresses docs; live eth_getCode has
  //                   runtime bytecode this phase).
  //   • Arbitrum One  chain 42161, RPC https://arb1.arbitrum.io/rpc, explorer
  //                   https://arbiscan.io (docs.arbitrum.io RPC table + viem
  //                   `arbitrum`), NATIVE Circle USDC
  //                   0xaf88d065e77c8cC2239327C5EDb3A432268e5831 (6 decimals).
  //                   The legacy bridged USDC.e
  //                   0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8 EXISTS on
  //                   Arbitrum One mainnet and is DELIBERATELY NOT REGISTERED —
  //                   verification pins the native contract address only, so a
  //                   USDC.e transfer is rejected regardless of recipient/amount
  //                   (contract address is authoritative, never symbol/name).
  // finality_mode='finalized' for BOTH: these are irreversible-production
  // networks, so crediting waits for parent-chain (Ethereum) finality. Both
  // official RPCs natively serve the `finalized` tag (Phase 5I live probe +
  // docs); if an endpoint ever stops serving it the provider FAILS CLOSED
  // rather than downgrading to safe/count/latest/immediate (Phase 5H contract).
  // required_confirmations=0 is inert under 'finalized'. is_testnet=0 marks
  // these live-class: a test API key can NEVER create/select them (environment
  // class enforcement) and their settlement wallets stay behind
  // ENABLE_LIVE_PAYMENTS. is_enabled=1: each row passes every provider registry
  // check (chain id >0, valid https RPC, 0x[40hex] USDC, decimals 6, mode known).
  // Idempotent INSERT OR IGNORE + self-healing reconcile UPDATE, exactly like
  // 5B/5F/Phase 1. The four previously-enabled rows are untouched.
  const baseMainnetUsdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // arc-studio-allow-onchain-literal — Circle official Base Mainnet native USDC
  db.run(
    `INSERT OR IGNORE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_testnet,required_confirmations,finality_mode,is_enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ['nc_base_mainnet', 'base_mainnet', 8453, // arc-studio-allow-onchain-literal
     'https://mainnet.base.org', 'https://basescan.org', // arc-studio-allow-onchain-literal
     baseMainnetUsdc, 6, 0, 0, 'finalized', 1]
  );
  db.run(
    `UPDATE network_configs
       SET chain_id=?, rpc_url=?, explorer_base=?, usdc_address=?, usdc_decimals=?, is_testnet=?, required_confirmations=?, finality_mode=?, is_enabled=?
     WHERE network='base_mainnet'`,
    [8453, // arc-studio-allow-onchain-literal
     'https://mainnet.base.org', 'https://basescan.org', // arc-studio-allow-onchain-literal
     baseMainnetUsdc, 6, 0, 0, 'finalized', 1]
  );

  const arbitrumOneUsdc = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // arc-studio-allow-onchain-literal — Circle official Arbitrum One NATIVE USDC (NOT USDC.e 0xFF97...5CC8)
  db.run(
    `INSERT OR IGNORE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_testnet,required_confirmations,finality_mode,is_enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ['nc_arbitrum_one', 'arbitrum_one', 42161, // arc-studio-allow-onchain-literal
     'https://arb1.arbitrum.io/rpc', 'https://arbiscan.io', // arc-studio-allow-onchain-literal
     arbitrumOneUsdc, 6, 0, 0, 'finalized', 1]
  );
  db.run(
    `UPDATE network_configs
       SET chain_id=?, rpc_url=?, explorer_base=?, usdc_address=?, usdc_decimals=?, is_testnet=?, required_confirmations=?, finality_mode=?, is_enabled=?
     WHERE network='arbitrum_one'`,
    [42161, // arc-studio-allow-onchain-literal
     'https://arb1.arbitrum.io/rpc', 'https://arbiscan.io', // arc-studio-allow-onchain-literal
     arbitrumOneUsdc, 6, 0, 0, 'finalized', 1]
  );

  // ── MASTER EXPANSION (PHASE 6): conservative-subset Circle-native-USDC EVM
  // mainnets. Seeded DIRECTLY from the classified Circle inventory
  // (server/db/networks.ts newlyEnabledEvmRows()) so the registry can NEVER
  // silently diverge from the audited network set (PHASE 19 completeness) —
  // adding a payable network is a single inventory edit, not new SQL. Every
  // row was live read-only validated this phase (eth_chainId match, native
  // USDC bytecode present, decimals==6, and a DISTINCT safe/finalized head),
  // and all metadata is viem 2.56.5 curated (REF-14) / Circle (REF-10) —
  // never guessed. Ethereum is intentionally ABSENT from this set (operator
  // keeps it ENS-only). This block is purely ADDITIVE: the six previously-
  // enabled rows above are untouched, and each new row uses the same
  // idempotent INSERT OR IGNORE + self-healing reconcile UPDATE as 5B/5F/1.
  // required_confirmations=0 is inert under 'finalized'/'safe' modes.
  for (const n of newlyEnabledEvmRows()) {
    db.run(
      `INSERT OR IGNORE INTO network_configs(id,network,chain_id,rpc_url,explorer_base,usdc_address,usdc_decimals,is_testnet,required_confirmations,finality_mode,is_enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [`nc_${n.slug}`, n.slug, n.chainId as number, n.rpc as string, n.explorer as string, // arc-studio-allow-onchain-literal (inventory-sourced)
       n.nativeUsdc, n.decimals, 0, 0, n.finalityMode as string, 1]
    );
    db.run(
      `UPDATE network_configs
         SET chain_id=?, rpc_url=?, explorer_base=?, usdc_address=?, usdc_decimals=?, is_testnet=?, required_confirmations=?, finality_mode=?, is_enabled=?
       WHERE network=?`,
      [n.chainId as number, n.rpc as string, n.explorer as string, // arc-studio-allow-onchain-literal (inventory-sourced)
       n.nativeUsdc, n.decimals, 0, 0, n.finalityMode as string, 1, n.slug]
    );
  }

  // PHASE 20 SELF-HEAL — fail-closed DEMOTION path. The seed loop above only
  // ADDs/updates; without this, an inventory network that gets demoted out of
  // IMPLEMENTED_ENABLED (e.g. Cronos after its curated endpoint showed NO
  // observable safe/finalized boundary) would silently KEEP its enabled row in
  // every existing database. Any inventory slug that is not inventory-enabled
  // must have no enabled registry row — enforced idempotently on every boot.
  // Re-enabling later is symmetric: the seed loop's UPDATE flips is_enabled
  // back to 1. The six pre-EXPANSION rows (arc_*, *_sepolia, base_mainnet,
  // arbitrum_one) are not inventory demotion candidates and are untouched.
  for (const n of CIRCLE_INVENTORY) {
    if (n.status === 'IMPLEMENTED_ENABLED') continue;
    db.run(`UPDATE network_configs SET is_enabled=0 WHERE network=?`, [n.slug]);
  }

  // Seed validation — JafariPay is USDC-only and native Circle USDC has
  // 6 decimals on every supported EVM chain. Fail fast at boot rather than
  // persist a registry row that would break exact base-unit accounting.
  // (Guard on the data itself, not on the Arc slugs, so future curated
  // registry migrations naturally fall under the same validation.)
  const badDecimals = db.prepare(
    'SELECT network, usdc_decimals FROM network_configs WHERE is_enabled = 1 AND usdc_decimals <> 6'
  ).all() as Array<{ network: string; usdc_decimals: number }>;
  if (badDecimals.length > 0) {
    throw new Error(
      `[DB] network_configs validation failed — JafariPay is USDC-only (6 decimals), invalid enabled rows: ` +
      badDecimals.map(r => `${r.network}(${r.usdc_decimals})`).join(', ')
    );
  }
  // Phase 5H: an enabled row must declare one of the four known finality modes
  // — an empty/unknown mode could never be enforced correctly, so fail closed
  // at boot (same guard style as the decimals check above).
  const badMode = db.prepare(
    "SELECT network FROM network_configs WHERE is_enabled = 1 AND finality_mode NOT IN ('immediate','count','safe','finalized')"
  ).all() as Array<{ network: string }>;
  if (badMode.length > 0) {
    throw new Error(
      `[DB] network_configs validation failed — unknown finality_mode on enabled rows: ` +
      badMode.map(r => r.network).join(', ') +
      " (allowed: 'immediate', 'count', 'safe', 'finalized')"
    );
  }

  console.log('[DB] Migrations applied.');
}
