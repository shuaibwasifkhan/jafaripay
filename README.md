# JafariPay — Open-Source USDC Payment Infrastructure for Arc

A non-custodial developer payment infrastructure for accepting USDC through Payment Intents, hosted checkout, independent on-chain verification, direct merchant settlement, and signed webhooks — built on [Arc](https://arc.io).

- **Live:** https://jafari.co.in
- **Source:** https://github.com/shuaibwasifkhan/jafaripay

---

## What JafariPay provides

All of the following are implemented in this repository:

- **Payment Intent API** — create/read/verify/cancel USDC payment intents (`/v1/payment-intents`).
- **Hosted checkout** — a React checkout page (`/checkout/:id`) that connects a wallet and sends the USDC transfer.
- **Independent on-chain verification** — the backend re-verifies every payment against Arc RPC; frontend success is never trusted.
- **Direct merchant settlement** — customer USDC is transferred straight to the merchant's configured settlement wallet.
- **Signed webhooks** — HMAC-SHA256 signed event deliveries with automatic retries.
- **Idempotency protection** — `Idempotency-Key` support on Payment Intent creation.
- **Duplicate/replay protection** — a settled transaction hash can never be credited twice.
- **Reconciliation worker** — background expiry, stuck-state recovery, and webhook delivery.
- **Merchant dashboard** — projects, settlement wallets, API keys, payments, and webhooks.
- **Testnet + Mainnet networks** — Arc Testnet (default) and Arc Mainnet, with live payments gated behind an explicit flag.

## Payment flow

```
Merchant → Payment Intent API → Hosted Checkout → Customer Wallet
        → Arc USDC Transfer → Independent On-chain Verification
        → Merchant Settlement → Signed Webhook
```

## Non-custodial model

JafariPay is non-custodial. Merchants do **not** deposit funds into a JafariPay-controlled wallet. Each Payment Intent embeds the merchant's configured `settlement_address`, and the customer's wallet sends the USDC ERC-20 transfer **directly** to that address. The backend only observes and verifies the on-chain transfer — it never holds, forwards, or has spending authority over merchant funds, and it never requests or stores private keys or seed phrases.

## Arc integration

Network configuration is seeded into the database at startup (`server/db/schema.ts`) and mirrored in the frontend on-chain facts (`src/onchain-facts.ts`):

| Network | Chain ID | USDC (native predeploy) | Decimals |
|---|---|---|---|
| Arc Testnet | `5042002` | `0x3600000000000000000000000000000000000000` | 6 |
| Arc Mainnet | `5042` | `0x3600000000000000000000000000000000000000` | 6 |

- Wallet transport uses viem's `arcTestnet` / `arc` chains via wagmi (`src/config.ts`).
- The backend verifier (`server/blockchain/arc-provider.ts`) builds an Arc RPC client per network and decodes the ERC-20 `Transfer` event from the configured USDC contract.
- Live/Mainnet payments are disabled unless `ENABLE_LIVE_PAYMENTS=true`; the default is Arc Testnet only.

## Developer integration

Authenticate with a secret API key (`sk_test_…` / `sk_live_…`). Create a Payment Intent server-side:

```bash
curl -X POST https://jafari.co.in/v1/payment-intents \
  -H "Authorization: Bearer sk_test_your_key" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-123" \
  -d '{ "amount": "25.00", "currency": "USDC", "order_id": "ORDER-123" }'
```

The response includes a `checkout_url`. Redirect the customer there (or embed the checkout), then rely on the `payment.succeeded` webhook — not the frontend — as your source of truth:

```javascript
// Server-side: create intent, then redirect the customer to hosted checkout
const res = await fetch("https://jafari.co.in/v1/payment-intents", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.JAFARIPAY_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ amount: "25.00", currency: "USDC", order_id: orderId }),
});
const intent = await res.json();
redirect(intent.checkout_url);
```

Public checkout endpoints (no auth, used by the hosted page):

- `GET  /api/checkout/:id` — public Payment Intent details for rendering checkout.
- `POST /api/checkout/:id/verify` — submit the on-chain `tx_hash`; the backend runs full independent verification before crediting.

The in-app developer docs (`/docs`, rendered from `src/components/docs/DocsPage.tsx`) additionally describe an embeddable browser SDK surface (`JafariPay.checkout()` / `JafariPay.mount()`). Note: the hosted checkout page and REST API are the integration paths shipped in this repository; use the hosted `checkout_url` for the simplest integration.

### Webhooks

Signed event deliveries (`server/webhooks/delivery.ts`). Each request carries an `X-JafariPay-Signature` header of the form `t=<timestamp>,v1=<hmacSha256>`, where the signed payload is `` `${timestamp}.${rawBody}` ``. Verify it with your endpoint secret and a constant-time comparison. Delivery retries on non-2xx with backoff. Implemented events include `payment.created`, `payment.processing`, `payment.succeeded`, `payment.failed`, and `payment.expired`.

## Security & reliability

Each mechanism below is implemented in this repository:

- **Wallet (SIWE / EIP-4361) merchant auth** — dashboard sign-in via signed message with random, short-lived, single-use nonces (`server/auth/siwe.ts`).
- **API key auth** — HMAC-hashed keys; secret keys required for Payment Intent creation; publishable keys cannot create intents (`server/middleware/auth.ts`).
- **Tenant isolation** — every merchant-scoped query filters by `merchant_id`; Merchant A cannot access Merchant B's resources.
- **Independent transaction verification** — receipt success, correct USDC contract, real `Transfer` event, exact recipient, exact base-unit amount, and network are all checked server-side (`server/blockchain/arc-provider.ts`).
- **Exact decimal/base-unit arithmetic** — money math uses integer base units, never floating point (`server/lib/money.ts`).
- **Duplicate/replay protection** — `UNIQUE(tx_hash, network)` plus verifier checks prevent double-crediting.
- **Idempotency** — `Idempotency-Key` returns the original response and rejects mismatched reuse with `409`.
- **Bounded settlement grace** — a genuinely settled payment that lands shortly after expiry can still be verified within a bounded grace window, without weakening any verification rule (`PI_SETTLEMENT_GRACE_S`).
- **Webhook signing + SSRF protection** — HMAC signatures; private/link-local/loopback URLs are blocked.
- **Rate limiting, secure sessions, Helmet CSP, CORS** — configured in `server/index.ts`.
- **Reconciliation worker** — expiry, stuck-`processing` recovery, and webhook delivery (`server/workers/reconciliation.ts`).

## Local development

Requires [Bun](https://bun.sh) (pinned in `.bun-version`).

```bash
bun install
bun run build      # build the frontend (produces dist/, served by the API)
bun run start      # start the Bun + Express server (default port 3001)
# or, for frontend hot-reload during development:
bun run dev
```

Environment variables (names only — never commit real values):

| Variable | Purpose |
|---|---|
| `NODE_ENV` | Set to `production` for deployment. |
| `PORT` | Server port (default `3001`). |
| `SESSION_SECRET` | HMAC key for session tokens (required in production). |
| `API_KEY_HMAC_SECRET` | HMAC key for API-key hashing (required in production). |
| `WEBHOOK_HMAC_SECRET` | HMAC key for webhook-secret hashing (required in production). |
| `ALLOWED_ORIGINS` | Comma-separated allowed browser origins. |
| `CHECKOUT_BASE_URL` | Public base URL used to build `checkout_url`. |
| `JAFARIPAY_DOMAIN` | Domain shown in the SIWE sign-in message. |
| `DATABASE_URL` | SQLite file path (defaults to `./data/jafaripay.db`). |
| `ENABLE_LIVE_PAYMENTS` | Leave unset for Testnet-only; `true` enables Arc Mainnet/live. |

See `docs/DEPLOYMENT.md` for full VPS/Nginx/HTTPS deployment instructions.

## Testing & checks

```bash
bun test                              # bun:test suite
bunx tsc --noEmit                     # TypeScript typecheck
bunx oxlint --type-aware src scripts  # lint (frontend/scripts)
bunx oxlint server                    # lint (server)
bun run build                         # production frontend build
```

The current test suite (`server/payment-expiry.test.ts`) covers the payment settlement-grace behavior and the verification rules (recipient, amount, token/contract, duplicate/replay, idempotency, worker expiry). Tests mock only external blockchain RPC I/O; the real verification pipeline executes against an isolated temporary SQLite database.

## Project structure

```
server/
  index.ts                 Express app: security headers, CORS, routes, static serving
  api/                     REST routes: payment-intents, checkout, payments, webhooks,
                           api-keys, projects, settlement-wallets, auth
  auth/siwe.ts             SIWE / EIP-4361 wallet authentication + sessions
  blockchain/arc-provider.ts   Arc RPC provider, USDC Transfer decoding, payment verifier
  db/schema.ts             SQLite schema + migrations + network config seeding
  lib/money.ts             Exact USDC base-unit arithmetic
  middleware/auth.ts       API-key + session auth, tenant scoping
  webhooks/delivery.ts     Signed webhook delivery + retries + SSRF guard
  workers/reconciliation.ts    Expiry / stuck recovery / webhook worker
src/
  components/checkout/     Hosted checkout page
  components/dashboard/    Merchant dashboard (projects, keys, payments, webhooks, settings)
  components/docs/         In-app developer documentation
  config.ts                wagmi/viem chain + transport config
  onchain-facts.ts         Chain/USDC facts (generated)
contracts/                 Solidity + Foundry scaffolding
docs/                      DEPLOYMENT.md, UAT-REPORT.md
```

## Reusable primitives for Arc builders

Components in this repo that another Arc builder can study or reuse:

- **Payment Intent model/API** — network/amount/settlement immutably captured at creation (`server/api/payment-intents.ts`).
- **Hosted checkout** — wallet connect + USDC transfer + polling (`src/components/checkout/`).
- **On-chain transaction verifier** — receipt + Transfer decode + exact recipient/amount/contract/network checks (`server/blockchain/arc-provider.ts`).
- **Settlement verification** — direct-to-merchant transfer confirmation, non-custodial.
- **Signed webhook mechanism** — HMAC signing, retries, SSRF protection (`server/webhooks/delivery.ts`).
- **Idempotency + duplicate/replay protection** — DB-backed idempotency keys and unique-tx constraints.
- **Reconciliation worker** — expiry and delivery loop (`server/workers/reconciliation.ts`).
- **Exact money math** — integer base-unit helpers (`server/lib/money.ts`).

## Why JafariPay / what it adds

Compared with a basic "send USDC on Arc" example, JafariPay adds the developer-facing payment-infrastructure layer around the transfer: Payment Intents with idempotency, a hosted checkout, backend-authoritative on-chain verification (so success never depends on the browser), duplicate/replay protection, signed webhooks with retries, a reconciliation worker, wallet-based merchant auth with tenant isolation, and a merchant dashboard — while remaining non-custodial. It is intended as a practical, forkable reference for building USDC acceptance on Arc.

## Mainnet proof

The production deployment has processed a real Arc Mainnet USDC payment:

- Transaction: `0x9d82a3b3d2cf47192d179febf7f44bbc850ac5dc53912a57a6279f196fae74ef`
- Explorer: https://explorer.arc.io/tx/0x9d82a3b3d2cf47192d179febf7f44bbc850ac5dc53912a57a6279f196fae74ef

## Links

- GitHub: https://github.com/shuaibwasifkhan/jafaripay
- Live: https://jafari.co.in
- Arc explorer (Mainnet proof tx): https://explorer.arc.io/tx/0x9d82a3b3d2cf47192d179febf7f44bbc850ac5dc53912a57a6279f196fae74ef

## License

Open source. See repository for details.

