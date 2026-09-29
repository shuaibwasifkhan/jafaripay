# JafariPay — Public Release Report (STAGE 3 + STAGE 4)

> Scope: finalization of the **public surfaces** — marketing website, product
> documentation, and roadmap — followed by the public-release verification gates.
> The engineering core was already frozen and pushed separately (see
> `docs/engineering-freeze-report.md`, core freeze commit `2a86079`).
>
> This report contains **no secret values**. Environment variables are referred
> to by name only.

---

## 1. Positioning

JafariPay is presented publicly as **Universal USDC Payment Infrastructure**:
accept native USDC for an order, verify the transfer independently on-chain,
and settle non-custodially into the merchant's own wallet. CURRENT capability and
FUTURE roadmap are kept visually and verbally distinct on every surface.

## 2. What "CURRENT" means (and is honestly bounded)

Surfaces may describe as live **only** what exists in the frozen core:

- Payment Intents, hosted Checkout, on-chain verification, direct settlement.
- HMAC-signed webhooks with retry/backoff and replay protection.
- API keys (scoped test/live), projects, settlement wallets.
- **Payment Links** (one-charge, shareable), **Receipts** (email + public
  capability page), and **Reconciliation** (automatic status worker + ledger).
- Standalone JavaScript SDK served at `/sdk.js`.
- Arc Mainnet + Arc Testnet + the certified network set from the network
  certification (no networks were added or invented in this release).

Surfaces must NOT (and do not) claim: a live settlement router, automatic
cross-chain settlement / bridging, CCTP (explicitly CLOSED), non-EVM support, or
any production real-money end-to-end run that has not actually occurred. Email
delivery is described as requiring an outbound provider to be configured.

## 3. Changes made in this stage

### 3.1 Documentation — `src/components/docs/DocsPage.tsx`

Added three previously-undocumented **shipped** capabilities, each written from
the actual route handlers and response shapes (no invented fields):

- **Payment Links** — `POST/GET /v1/payment-links`, `GET /v1/payment-links/:id`,
  `POST /v1/payment-links/:id/disable`; public `GET /pay/:id` and
  `POST /pay/:id/create`; the one-charge MVP rule and the `410 link_disabled` /
  `410 link_expired` / `409 link_paid` / `503 setup.no_settlement_wallet`
  guardrails. Amount is authoritative from the stored link.
- **Receipts** — public capability read `GET /api/receipts/:id` (safe projection);
  merchant `GET /v1/receipts` (isolated, `order_id` filter, limit/offset) and
  `POST /v1/receipts/:id/resend`; `POST /checkout/:id/receipt` to attach/repair an
  email. Documents the guarantee that **email failure never changes payment
  status**, the 4-attempt backoff, HTML-escaping of merchant-controlled fields,
  and the outbound-provider configuration requirement.
- **Reconciliation** — described as an **automatic background worker** (not an
  API): 30s tick, grace-aware expiry, self-heal of stuck `processing` intents,
  pending webhook/email processing; no blockchain scanning in the worker. Ledger
  read-back via `GET /v1/payments[/:id]` and the intent→payment→tx_hash one-to-one
  uniqueness that makes it auditable.

Accuracy fixes applied to existing docs:

- Webhook signature header corrected/standardized to **`X-JafariPay-Signature`**;
  retry cadence updated to the real `[10,30,120,300,1800,7200,28800]` s with
  **up to 8 total attempts** (matches `server/webhooks/delivery.ts`).
- Signing-secret section documents reveal-once + rotation semantics.
- The verification section's raw-bytes / `timingSafeEqual`-after-length-check /
  freshness-window guidance matches `verifyWebhookSignature()` and points at the
  dependency-free reference `scripts/verify-webhook-reference.mjs`
  (`node scripts/verify-webhook-reference.mjs --selftest` → all pass).
- **Quickstart** webhook sample fixed: header lookup
  `req.headers['x-jafaripay-signature']` (Express lower-cases names) and payload
  path `event.data.payment_intent_id` (the delivered `data` is
  `{ payment_intent_id, payment }`, not a top-level `order_id`); parses **after**
  verifying the raw body.

### 3.2 Roadmap — `src/components/landing/RoadmapPage.tsx`

Removed one overclaim in the "Live now" header (the previous "Production-ready on
Arc Mainnet — build on it now" line was softened to describe the built, on-chain
verified rail without asserting a production posture that depends on the human
deployment/E2E stages). All Next / Exploring / Future items were reviewed and left
correctly framed as future work (multi-chain + bridges under "Next", agent/settlement
policy under "Exploring", firewall/treasury/outcome/non-JS-SDK under "Future").

### 3.3 Website — `src/components/landing/LandingPage.tsx`, `HeroShowcase.tsx`

Audited; **no changes required.** Messaging (USDC-native on Arc, non-custodial,
on-chain verified, SIWE wallet auth, REST + JS SDK, signed webhooks) understates
rather than overclaims, and cross-chain tiles are explicitly labelled
"Exploring/Future".

## 4. Public-surface QA

- No `localhost`/`127.0.0.1` presented as a production URL; every localhost hit
  is legitimate (SDK http-only-for-localhost rule, SSRF block docs, tracing noise).
- No placeholder cruft (`TODO`/`FIXME`) and **no secret values** on any surface.
- Real public references only: site `https://jafari.co.in`, SDK
  `https://jafari.co.in/sdk.js`, GitHub `shuaibwasifkhan/jafaripay`, support
  `dev@jafari.co.in`. Generic API examples use `https://your-instance.com`.
- Every referenced asset exists: `sdk-demo.html` in `public/`, and `/sdk.js` is
  built to `dist/sdk.js` and served by `server/index.ts`.

## 5. Verification gates (STAGE 4)

| Gate | Command | Result |
|------|---------|--------|
| Type-check | `bun run typecheck` (`tsc --noEmit`) | **PASS** (exit 0) |
| Build (SPA + SDK) | `bun run build` | **PASS** — `✓ built in 39.45s`; `dist/sdk.js ✓ 640ms` |
| Test suite | `bun test` | **440 pass / 0 fail** (3260 expects, 19 files) |
| Lint (changed files) | `oxlint --type-aware` | **No new issues** |

Lint notes: the only findings on the two touched files are **pre-existing** and
outside this stage's content edits — an unused `ArrowUpRight` import in
`RoadmapPage.tsx` and a `set-state-in-effect` warning in the `DocsPage.tsx`
render/nav code. They are intentionally left untouched to keep the release diff
scoped; the three new imports (`Link2`, `Receipt`, `ArrowLeftRight`) are all used.

## 6. Isolation from the frozen core

This stage modified **only** public-facing React surfaces under
`src/components/{docs,landing}` and this report. No server, contract, SDK,
middleware, or API code was changed; the frozen engineering core
(`2a86079`) is untouched.

## 7. Boundary to production

Public release is complete and verified. Stages 5–10 (production configuration,
DB safety, **deploy**, controlled real-money **E2E**, smoke test, certification)
remain gated behind human actions that cannot be performed autonomously:
production secret **values**, production infrastructure/deploy access, wallet /
private-key operations, and explicit real-money authorization. No production
deployment or real-money E2E is claimed here.
