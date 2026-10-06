# JafariPay — Universal Multi-Chain USDC Payment Infrastructure

A non-custodial developer payment infrastructure for accepting USDC through Payment Intents, hosted checkout, Payment Links, independent on-chain verification, direct merchant settlement, receipts, reconciliation, and signed webhooks — across 10 supported EVM mainnets.

## Links

- **Website:** https://jafari.co.in
- **Documentation:** https://jafari.co.in/docs
- **Roadmap:** https://jafari.co.in/roadmap
- **GitHub:** https://github.com/shuaibwasifkhan/jafaripay
- **Developer contact:** dev@jafari.co.in

---

## What JafariPay provides

All of the following are implemented in this repository:

- **Payment Intent API** — create/read/verify/cancel USDC payment intents (`/v1/payment-intents`).
- **Hosted checkout** — a React checkout page (`/checkout/:id`) that connects a wallet and sends the USDC transfer.
- **Payment Links** — shareable hosted USDC links (`/v1/payment-links`, public `/pay/:id`) that mint a payment intent on click — no customer-side integration.
- **Independent on-chain verification** — the backend re-verifies every payment against the target network's RPC; frontend success is never trusted.
- **Direct merchant settlement** — customer USDC is transferred straight to the merchant's configured settlement wallet.
- **Signed webhooks** — HMAC-SHA256 signed event deliveries (`X-JafariPay-Signature`) with automatic retries.
- **Receipts** — automatic on-chain receipts, emailed to customers and viewable via a public capability link (`/api/receipts/:id`).
- **Idempotency protection** — `Idempotency-Key` support on Payment Intent creation.
- **Duplicate/replay protection** — a settled transaction hash can never be credited twice.
- **Reconciliation worker** — background expiry, stuck-state recovery, and webhook delivery; every intent is matched to its settled on-chain transfer in a single auditable ledger view.
- **JavaScript SDK** — a standalone IIFE build served at `/sdk.js` that launches the hosted checkout and reports the outcome.
- **Merchant dashboard** — projects, settlement wallets, API keys, payments, webhooks, links, and receipts.
- **Wallet-based authentication** — merchants sign in with SIWE / EIP-4361; no email or password.
- **Multi-chain native USDC** — accept USDC across 10 supported EVM mainnets (plus clearly-separated development testnets), gated per environment by an explicit flag.

## Capabilities

Implemented and available to integrate (across the supported production EVM mainnets; development testnets are separate and labelled as such):

- **Multi-Chain USDC** — native USDC on 10 supported EVM mainnets (Arc, Base, Arbitrum, Polygon PoS, Avalanche C, OP Mainnet, Linea, Unichain, zkSync Era, Celo)
- **Payment Intents** — create, read, verify, cancel (`/v1/payment-intents`)
- **Hosted Checkout** — wallet-connected checkout page (`/checkout/:id`)
- **Payment Links** — shareable hosted USDC links (`/pay/:id`)
- **On-chain Payment Verification** — backend re-verifies every transfer against the network's RPC
- **Direct Merchant Settlement** — customer USDC lands in the merchant's settlement wallet
- **Cross-chain Settlement to Arc** — opt-in Circle CCTP v2 route with Forwarding: pay native USDC on Base, Arbitrum, Polygon, Avalanche, OP, Linea or Unichain — the customer burns the payment amount plus the server-quoted Circle forwarding fee on the source, and the merchant receives exactly the requested amount in the merchant's one pinned Arc wallet (non-custodial); Arc→Arc and every other network stay same-chain
- **Signed Webhooks** — HMAC-SHA256 event deliveries with retries and replay protection
- **Receipts** — automatic on-chain receipts with email + public link
- **API Keys** — per-project `pk_`/`sk_` key pairs (test and live)
- **Payment Reconciliation** — background expiry, stuck-state recovery, and webhook delivery
- **JavaScript SDK** — drop-in `/sdk.js` checkout launcher
- **Wallet-based Authentication** — SIWE / EIP-4361 sign-in for the merchant dashboard

Planned / future (**not** yet available): **Invoices, Recurring & Advanced Billing, Agent/M2M payments, Payment Firewall** — see the public roadmap for their status. Multi-chain USDC, cross-chain settlement to Arc (Circle CCTP), Payment Links, Receipts, and webhooks are shipped.

## Payment flow

```
Merchant → Payment Intent API → Hosted Checkout → Customer Wallet
        → On-chain USDC Transfer (supported network) → Independent Verification
        → Merchant Settlement → Signed Webhook → Reconciliation + Receipt
```

## Documentation

The public developer documentation lives at https://jafari.co.in/docs and covers: Quickstart, Authentication, Payment Intents, Checkout, Payment Links, Receipts, Reconciliation, JavaScript SDK, Webhooks, Webhook Verification, Test Mode, Supported Networks, Production, Security, API Reference, Error Codes, Troubleshooting, and Changelog.

The supported integration paths are the **hosted checkout page**, the **REST API**
(see above), and the **JavaScript SDK**. The SDK ships as a standalone IIFE build
served at `https://jafari.co.in/sdk.js`:

```html
<!-- Load the SDK -->
<script src="https://jafari.co.in/sdk.js"></script>
```

It is a thin cross-origin messenger: it launches the hosted `/checkout/:id` page
in a new window (`JafariPay.checkout`) or an embedded launcher (`JafariPay.mount`)
and reports the checkout's terminal outcome via origin-verified `postMessage`
callbacks. It does **not** process USDC, request wallet keys, or custody funds —
verification and settlement remain in the JafariPay backend (webhooks and
`/api/checkout/:id/verify`). A developer test page is at
`https://jafari.co.in/sdk-demo.html?pi=<payment-intent-id>`; the reference
documentation is at `https://jafari.co.in/docs/sdk`.

## Roadmap

See the public roadmap for current, planned, exploring, and future product directions: https://jafari.co.in/roadmap

## Non-custodial model

JafariPay is non-custodial. Merchants do **not** deposit funds into a JafariPay-controlled wallet. Each Payment Intent embeds the merchant's configured `settlement_address`, and the customer's wallet sends the USDC ERC-20 transfer **directly** to that address. The backend only observes and verifies the on-chain transfer — it never holds, forwards, or has spending authority over merchant funds, and it never requests or stores private keys or seed phrases.

## Network integration

The backend network registry is the single source of truth, seeded at startup (`server/db/networks.ts` → `server/db/schema.ts`) and mirrored in the frontend allowlist (`src/supported-chains.ts`, `src/onchain-facts.ts`).

**Supported production mainnets** (native USDC, 6 decimals):

| Network | Chain ID | Native USDC |
|---|---|---|
| Arc | `5042` | `0x3600000000000000000000000000000000000000` |
| Base | `8453` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Arbitrum One | `42161` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Polygon PoS | `137` | `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359` |
| Avalanche C | `43114` | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |
| OP Mainnet | `10` | `0x0b2c639c533813f4aa9d7837caf62653d097ff85` |
| Linea | `59144` | `0x176211869ca2b568f2a7d4ee941e073a821ee1ff` |
| Unichain | `130` | `0x078d782b760474a361dda0af3839290b0ef57ad6` |
| ZKsync Era | `324` | `0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4` |
| Celo | `42220` | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` |

**Development testnets (NOT for production):** Arc Testnet (`5042002`), Base Sepolia (`84532`), Arbitrum Sepolia (`421614`).

- Money is accepted only from each network's pinned native USDC contract; bridged/synthetic USDC variants are rejected by address.
- Wallet transport uses viem's curated chain definitions via wagmi (`src/supported-chains.ts`, `src/config.ts`); the backend verifier (`server/blockchain/arc-provider.ts`) decodes the ERC-20 `Transfer` event from the configured USDC contract per network.
- Live/mainnet payments are disabled unless `ENABLE_LIVE_PAYMENTS=true`; the default is testnet only.

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

The in-app developer docs (`/docs`, rendered from `src/components/docs/DocsPage.tsx`) describe the same three integration paths — the REST API, the hosted checkout endpoints above, and the JavaScript SDK (`JafariPay.checkout()` / `JafariPay.mount()`). All of them, including the SDK source (`src/sdk/`, built to `dist/sdk.js`), ship in this repository; use the hosted `checkout_url` for the simplest integration.

### Webhooks

Signed event deliveries (`server/webhooks/delivery.ts`). Each request carries an `X-JafariPay-Signature` header of the form `t=<timestamp>,v1=<hmacSha256>`, where the signed payload is `` `${timestamp}.${rawBody}` ``. Verify it with your endpoint secret and a constant-time comparison. Delivery retries on non-2xx with backoff. The seven deliverable events (exactly the endpoints' subscribable set, `VALID_EVENTS` in `server/api/webhooks.ts`) are `payment.created`, `payment.processing`, `payment.succeeded`, `payment.failed`, `payment.expired`, `payment.cross_chain.attestation_received`, and `payment.cross_chain.failed`.

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

Environment variables (names only — never commit real values). "production required" means the fail-closed boot guard (`server/lib/production-config.ts`) refuses to start `NODE_ENV=production` without it; see `.env.example` for the authoritative template.

| Variable | Class | Purpose |
|---|---|---|
| `NODE_ENV` | production required | Set to `production` for deployment. |
| `PORT` | optional | Server port (default `3001`). |
| `DATABASE_URL` | production required | SQLite file path (defaults to `./data/jafaripay.db`). |
| `SESSION_SECRET` | production required (≥16 chars) | HMAC key for session tokens. |
| `API_KEY_HMAC_SECRET` | production required (≥16 chars) | HMAC key for API-key hashing. |
| `WEBHOOK_HMAC_SECRET` | production required (≥16 chars) | HMAC key for webhook identity signing. |
| `WEBHOOK_SIGNING_ENC_KEY` | production required (≥16 chars, stable) | AES-256-GCM key encrypting raw webhook signing secrets at rest; rotating it makes existing ciphertext undecryptable until each secret is re-saved. |
| `ALLOWED_ORIGINS` | production required | Comma-separated CORS allowlist (https). |
| `CHECKOUT_BASE_URL` | production required | Public base URL used to build `checkout_url` (https). |
| `JAFARIPAY_DOMAIN` | production required | Domain shown in the SIWE sign-in message. |
| `ENABLE_LIVE_PAYMENTS` | gate (must be `true` to serve live) | Unset/false = testnet-only; `true` enables live-class (mainnet) payments across the supported networks. |
| `RPC_PROXY_BASE_URL`, `RPC_PROXY_CHAINS`, `RPC_PROXY_TOKEN` | optional (all-or-nothing) | Shared RPC-proxy deployment model; if a base URL is set, the chains list and token are required and unmapped networks fail closed. Leave unset to use direct curated RPCs. |
| `EMAIL_TRANSPORT` | optional | `dev` (in-memory sink, default) \| `none` (explicit no-op) \| `brevo_smtp` (production relay). |
| `EMAIL_BREVO_SMTP_LOGIN`, `EMAIL_BREVO_SMTP_KEY` | required when `EMAIL_TRANSPORT=brevo_smtp` | Brevo SMTP credentials (injected via secret manager, never committed). |
| `EMAIL_FROM` | required when `brevo_smtp` | The Brevo-verified sender address for receipt mail. |
| `EMAIL_BREVO_SMTP_HOST`, `EMAIL_BREVO_SMTP_PORT`, `EMAIL_BREVO_TIMEOUT_MS` | optional | Connection overrides (defaults: `smtp-relay.brevo.com`, `587`, `15000`). |
| `EMAIL_DEV_FAIL` | test-only | Forces email failure in tests; the boot guard rejects it in production. |
| `E2E_SOURCE_PK`, `E2E_RELAYER_PK` | test-only (testnet signer keys) | Used by local cross-chain E2E scripts; the boot guard rejects any production boot that carries them. |

See `docs/DEPLOYMENT.md` for full VPS/Nginx/HTTPS deployment instructions.

## Testing & checks

```bash
bun test                              # bun:test suite
bunx tsc --noEmit                     # TypeScript typecheck
bunx oxlint --type-aware src scripts  # lint (frontend/scripts)
bunx oxlint server                    # lint (server)
bun run build                         # production frontend build
```

Run the test suite with `bun test` (no fixed count is maintained here — the suite grows with the project). It covers the payment settlement-grace behavior and the verification rules (recipient, amount, token/contract, duplicate/replay, idempotency, worker expiry), plus the CCTP cross-chain source/attestation/destination pipeline, forwarding-fee quoting and its API/checkout presentation, the webhook signing/replay/SSRF matrix, receipts and the email transport, payment links, and the production-config boot guard. Tests mock only external blockchain RPC I/O; the real verification pipeline executes against an isolated temporary SQLite database.

## Project structure

```
server/
  index.ts                 Express app: security headers, CORS, routes, static serving
  api/                     REST routes: payment-intents, checkout, payments, payment-links,
                           receipts, webhooks, webhook-deliveries, api-keys, projects,
                           settlement-wallets, auth
  auth/siwe.ts             SIWE / EIP-4361 wallet authentication + sessions
  blockchain/              arc-provider.ts (ERC-20 Transfer verification) and the CCTP
                           engine: cctp-source, cctp-attestation, cctp-destination,
                           cctp-forwarding-fee, cctp-status (cross-chain state machine)
  db/schema.ts             SQLite schema + migrations + network config seeding
  db/networks.ts, db/cctp.ts  Network registry + Circle CCTP source/destination table
  email/                   EmailTransport abstraction (dev sink / none / brevo-smtp)
  lib/                     money.ts (exact base-unit math), fees.ts (fee presentation),
                           production-config.ts (fail-closed boot guard)
  middleware/auth.ts       API-key + session auth, tenant scoping
  webhooks/delivery.ts     Signed webhook delivery + retries + SSRF guard
  workers/reconciliation.ts    Expiry / stuck recovery / webhook / cross-chain driver
src/
  components/checkout/     Hosted checkout page (same-chain + CCTP burn paths)
  components/dashboard/    Merchant dashboard (projects, keys, payments, webhooks, settings)
  components/docs/         In-app developer documentation
  components/landing/      Public landing + roadmap pages
  sdk/                     JavaScript SDK source (built by vite.sdk.config.ts → dist/sdk.js)
  cctp-checkout.ts         Wallet transaction planner for the checkout page
  config.ts                wagmi/viem chain + transport config
  onchain-facts.ts, supported-chains.ts  Chain/USDC facts + frontend network allowlist
contracts/                 Solidity + Foundry scaffolding and unit tests
docs/                      Authority docs (production readiness, operator runbook, CCTP
                           executor decision, deployment) + dated engineering phase reports
scripts/                   Build/ops helper scripts
```

## Reusable primitives for builders

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

Compared with a basic "send USDC on Arc" example, JafariPay adds the developer-facing payment-infrastructure layer around the transfer: Payment Intents with idempotency, a hosted checkout, Payment Links, receipts, and reconciliation, backend-authoritative on-chain verification (so success never depends on the browser), duplicate/replay protection, signed webhooks with retries, wallet-based merchant auth with tenant isolation, and a merchant dashboard — across 10 supported EVM mainnets, while remaining non-custodial. It is intended as a practical, forkable reference for building multi-chain USDC acceptance.

## Mainnet proof

The production deployment has processed a real Arc Mainnet USDC payment:

- Transaction: `0x9d82a3b3d2cf47192d179febf7f44bbc850ac5dc53912a57a6279f196fae74ef`
- Explorer: https://explorer.arc.io/tx/0x9d82a3b3d2cf47192d179febf7f44bbc850ac5dc53912a57a6279f196fae74ef

## Resources

- GitHub: https://github.com/shuaibwasifkhan/jafaripay
- Website: https://jafari.co.in
- Documentation: https://jafari.co.in/docs
- Roadmap: https://jafari.co.in/roadmap
- Developer contact: dev@jafari.co.in
- Arc explorer (Mainnet proof tx): https://explorer.arc.io/tx/0x9d82a3b3d2cf47192d179febf7f44bbc850ac5dc53912a57a6279f196fae74ef

## License

Open source. See repository for details.

