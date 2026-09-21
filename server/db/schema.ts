/**
 * JafariPay — Database schema + migrations (Bun built-in SQLite)
 */

import { Database } from 'bun:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_URL || path.join(__dirname, '../../data/jafaripay.db');

let _db: Database | null = null;

export function getDb(): Database {
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
    network     TEXT NOT NULL CHECK(network IN ('arc_testnet','arc_mainnet')),
    label       TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(merchant_id, address, network)
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_settlement_wallets_merchant ON settlement_wallets(merchant_id)');

  db.run(`CREATE TABLE IF NOT EXISTS network_configs (
    id            TEXT PRIMARY KEY,
    network       TEXT NOT NULL UNIQUE CHECK(network IN ('arc_testnet','arc_mainnet')),
    chain_id      INTEGER NOT NULL,
    rpc_url       TEXT NOT NULL,
    explorer_base TEXT NOT NULL,
    usdc_address  TEXT NOT NULL,
    usdc_decimals INTEGER NOT NULL DEFAULT 6,
    is_enabled    INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

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

  // Seed network configs (idempotent)
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

  console.log('[DB] Migrations applied.');
}
