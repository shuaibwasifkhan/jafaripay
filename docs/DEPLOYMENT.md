# JafariPay — Deployment Guide (Arc Testnet)

JafariPay is an open-source, non-custodial USDC payment infrastructure for Arc.
Customer USDC settles **directly** to the merchant's configured settlement wallet.
JafariPay never holds funds, private keys, or seed phrases.

This guide targets a single **Ubuntu 24.04** VPS running the Bun + Express server
behind an Nginx reverse proxy with HTTPS, on **Arc Testnet**. Live payments remain
disabled.

---

## 1. Prerequisites

- Ubuntu 24.04 (or similar Linux)
- A domain name pointing at the server (e.g. `pay.example.com`)
- Nginx
- A TLS certificate (Let's Encrypt / certbot recommended)
- Outbound HTTPS access to the Arc Testnet RPC endpoint

## 2. Bun version

The server uses Bun-native APIs (`bun:sqlite`, `import.meta.dir`) and **must** run
under Bun — Node.js is not sufficient. Pin the version in `.bun-version`.

```bash
curl -fsSL https://bun.sh/install | bash
bun --version   # must match .bun-version
```

## 3. Install dependencies

```bash
bun install --frozen-lockfile
```

## 4. Environment variables

Create a `.env` file (never commit it). Secrets must be unique random strings of
at least 16 characters. In production the server **refuses to start** if
`SESSION_SECRET`, `API_KEY_HMAC_SECRET`, or `WEBHOOK_HMAC_SECRET` are missing or
too short.

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | Yes | Set to `production`. Enables secure cookies + terse errors. |
| `PORT` | No | Server port (default `3001`). |
| `SESSION_SECRET` | Yes (prod) | HMAC key for signing session tokens. |
| `API_KEY_HMAC_SECRET` | Yes (prod) | HMAC key for hashing API keys. |
| `WEBHOOK_HMAC_SECRET` | Yes (prod) | HMAC key for hashing webhook secrets. |
| `ALLOWED_ORIGINS` | Yes | Comma-separated allowed browser origins, e.g. `https://pay.example.com`. |
| `CHECKOUT_BASE_URL` | Yes | Public base URL used to build `checkout_url`, e.g. `https://pay.example.com`. |
| `JAFARIPAY_DOMAIN` | Yes | Domain shown in the SIWE sign-in message, e.g. `pay.example.com`. |
| `DATABASE_URL` | No | Absolute path to the SQLite file (default `./data/jafaripay.db`). |
| `ENABLE_LIVE_PAYMENTS` | No | **Leave unset.** Must remain disabled — Arc Testnet only. |
| `RPC_PROXY_BASE_URL` / `RPC_PROXY_TOKEN` / `RPC_PROXY_CHAINS` | No | Optional keyed RPC proxy; falls back to the public Arc RPC when unset. |

Generate a secret:

```bash
openssl rand -hex 32
```

> Do not put real secret values in documentation, source control, or logs.

## 5. Database initialization

The database and schema are created automatically on first boot (`migrate()` runs
at startup and is idempotent). Ensure the data directory exists and is writable:

```bash
mkdir -p data
```

By default the file lives at `<app>/data/jafaripay.db`. Override with an absolute
`DATABASE_URL` (e.g. `/var/lib/jafaripay/jafaripay.db`).

## 6. Build

```bash
node_modules/.bin/vite build
```

This produces `dist/`. When `dist/` exists, the Express server serves the frontend
and the API from the **same origin**, which avoids all cross-origin cookie issues.

## 7. Start

```bash
bun run start      # runs: bun run server/index.ts
```

The server listens on `PORT` only (the `5173` preview listener is disabled in
production). Nginx terminates TLS and proxies to it.

## 8. systemd service

`/etc/systemd/system/jafaripay.service`:

```ini
[Unit]
Description=JafariPay
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/jafaripay
EnvironmentFile=/opt/jafaripay/.env
ExecStart=/root/.bun/bin/bun run server/index.ts
Restart=on-failure
RestartSec=5
User=jafaripay
Group=jafaripay

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now jafaripay
systemctl status jafaripay
```

The reconciliation + webhook worker starts automatically inside the server process
(`startWorker()`), so no separate worker service is required.

## 9. Nginx reverse proxy

`/etc/nginx/sites-available/jafaripay`:

```nginx
server {
    listen 443 ssl http2;
    server_name pay.example.com;

    ssl_certificate     /etc/letsencrypt/live/pay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name pay.example.com;
    return 301 https://$host$request_uri;
}
```

The app sets `trust proxy = 1`, so `X-Forwarded-Proto` and `X-Forwarded-For` must be
forwarded exactly as above. This is required for secure cookies and correct
per-IP rate limiting.

```bash
ln -s /etc/nginx/sites-available/jafaripay /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## 10. HTTPS requirements

- HTTPS is mandatory. Session cookies are `Secure` in production and browsers reject
  `SameSite=None; Secure` cookies over plain HTTP.
- Obtain/renew certs with certbot: `certbot --nginx -d pay.example.com`.

## 11. Arc Testnet configuration

- Chain ID: `5042002`
- USDC: `0x3600000000000000000000000000000000000000` (6 decimals)
- Public RPC fallback: `https://rpc.testnet.arc.io`
- Explorer: `https://explorer.testnet.arc.io`

Network config is seeded automatically during migration. Both `arc_testnet` and
`arc_mainnet` rows exist, but mainnet/live is gated off by `ENABLE_LIVE_PAYMENTS`
and must stay disabled until you deliberately go live (see §11a).

## 11a. Arc Mainnet configuration (production / live mode)

> Live mode moves REAL USDC. Do not enable it until testnet sign-off is complete
> and the settlement wallet address has been triple-checked. Enabling live mode is
> a deliberate, separate step from deploying the code.

Independently verified Arc Mainnet values (seeded/reconciled by migration):

- Chain ID: `5042`
- USDC (native predeploy, same address as testnet by design): `0x3600000000000000000000000000000000000000` (6 decimals)
- RPC: `https://rpc.mainnet.arc.io`
- Explorer: `https://explorer.arc.io`

The migration performs an idempotent `UPDATE` of the `arc_mainnet` row on every
start, so the verified chain_id / RPC / USDC / decimals / explorer are enforced
even on a pre-existing database (`INSERT OR IGNORE` alone would not correct an
existing row). The `arc_testnet` row is never modified by that reconcile step.

### Required production environment variables (live)

Set these in the server environment (never commit them):

| Variable | Value / purpose |
|---|---|
| `NODE_ENV` | `production` |
| `ENABLE_LIVE_PAYMENTS` | `true` — **enables** live keys, live settlement wallets, and Arc Mainnet payment intents. Leave unset for testnet-only. |
| `SESSION_SECRET` / `API_KEY_HMAC_SECRET` / `WEBHOOK_HMAC_SECRET` | strong unique random values (≥16 chars) |
| `ALLOWED_ORIGINS`, `CHECKOUT_BASE_URL`, `JAFARIPAY_DOMAIN` | real production domain |
| `RPC_PROXY_BASE_URL` / `RPC_PROXY_TOKEN` / `RPC_PROXY_CHAINS` | optional keyed RPC proxy (must include `Arc` in chains to proxy mainnet); otherwise the public `https://rpc.mainnet.arc.io` fallback is used |

Enabling `ENABLE_LIVE_PAYMENTS` flips three server-side gates (auth middleware,
API-key creation, settlement-wallet creation). It does not change any verification
or business logic — the payment engine is fully network-parameterized.

### Settlement wallet setup (live)

1. With `ENABLE_LIVE_PAYMENTS=true`, sign in to the dashboard and add a settlement
   wallet with environment `live` (→ network `arc_mainnet`).
2. Triple-check the address — customer USDC settles directly there; JafariPay is
   non-custodial and never holds funds.
3. Never store a private key or seed phrase anywhere in the app or config.

### Live API key setup

1. Create a `sk_live_` / `pk_live_` key pair from the dashboard (blocked with 403
   unless `ENABLE_LIVE_PAYMENTS=true`).
2. `sk_live_` creates Arc Mainnet payment intents (network derived from the key
   environment — never a fallback). Keep the secret key server-side only.

### Production smoke-test procedure (one deliberate 0.01 USDC payment)

1. Confirm `ENABLE_LIVE_PAYMENTS=true`, live settlement wallet configured, and a
   `sk_live_` key issued.
2. Create ONE payment intent for `0.01` USDC via `POST /v1/payment-intents` with
   the `sk_live_` key (network resolves to `arc_mainnet`, chain_id `5042`).
3. Open the returned `checkout_url`, connect a funded Arc Mainnet wallet, and pay.
4. Capture the tx hash; the backend independently verifies it (correct network,
   receipt success, configured USDC contract, exact amount, exact recipient,
   duplicate protection, PI expiry/status) before marking it `succeeded`.
5. Confirm the dashboard shows the payment `succeeded` with the correct explorer
   link, and that the `payment.succeeded` webhook was delivered and signature-verified.


## 12. Backup requirements

The entire application state is in the SQLite database. Back it up regularly using
SQLite's online backup so WAL data is captured consistently:

```bash
sqlite3 /opt/jafaripay/data/jafaripay.db ".backup '/backups/jafaripay-$(date +%F).db'"
```

Store backups off-server. Test restores periodically.

## 13. SQLite persistence

- The database uses WAL mode (`jafaripay.db`, `-wal`, `-shm` files). Keep all three
  together; never delete the `-wal`/`-shm` files while the server is running.
- Mount the data directory on persistent storage. If using containers, mount a
  volume for the data directory so state survives restarts and redeploys.
- Only a single server process should write to the database file (SQLite is
  single-writer). Horizontal scaling would need an external store — out of scope.

---

## Production readiness checklist

- [ ] `NODE_ENV=production`
- [ ] Strong `SESSION_SECRET`, `API_KEY_HMAC_SECRET`, `WEBHOOK_HMAC_SECRET` set
- [ ] `ALLOWED_ORIGINS`, `CHECKOUT_BASE_URL`, `JAFARIPAY_DOMAIN` set to the real domain
- [ ] HTTPS working, HTTP redirects to HTTPS
- [ ] Nginx forwards `X-Forwarded-Proto` and `X-Forwarded-For`
- [ ] Data directory on persistent storage with automated backups
- [ ] One real Arc Testnet USDC payment completed end-to-end via the checkout UI
      (requires a funded browser wallet — cannot be done from CI)

### Testnet-only operation
- [ ] `ENABLE_LIVE_PAYMENTS` unset

### Going live on Arc Mainnet (deliberate, after testnet sign-off — see §11a)
- [ ] `ENABLE_LIVE_PAYMENTS=true`
- [ ] `arc_mainnet` network_configs row verified: chain_id `5042`, USDC `0x3600…0000`, RPC `https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io`
- [ ] Live settlement wallet added and address triple-checked
- [ ] `sk_live_` / `pk_live_` keys issued; secret key kept server-side only
- [ ] One deliberate 0.01 USDC Arc Mainnet smoke test verified `succeeded`

