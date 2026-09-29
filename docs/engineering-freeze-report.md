# JafariPay — Engineering Freeze Report

Stage: **STAGE 2 — Core Final Gates (Master Release workflow)**
Date: 2026-09-29
Scope: **engineering / product core ONLY.** Public website / docs / roadmap were
**intentionally NOT touched in this stage** (see §Finalization).

---

## 1. Freeze baseline

| Item | Value |
|------|-------|
| Branch | `main` |
| HEAD immediately **before** this freeze | `33126e74e37c5b426bc5d10c240fb576e0840532` ("Add JafariPay USDC checkout SDK, docs, and production fixes") |
| Remote | `https://github.com/shuaibwasifkhan/jafaripay` |
| SDK version | `1.0.0` |
| Working tree at capture | 18 modified tracked files + ~50 untracked files = the accumulated Phase B–M engineering core (this freeze commit captures them) |
| `.gitignore` | excludes `.env`, `data/`, `*.db{,-wal,-shm}`, `node_modules/`, `dist/`, `contracts/out|cache`, `lib/forge-std`, traces — **no live state or secrets enter the commit** |
| Deliberately excluded | `scratch/` and `.qoder/` (non-product tooling); all public React marketing/docs/roadmap pages (deferred to the public-release stage) |

---

## 2. Final core gates (against the current tree)

| Gate | Result |
|------|--------|
| Full test suite | **440 pass / 0 fail** across 19 files |
| Typecheck (`tsc --noEmit`) | **PASS** (exit 0) |
| Production build (app + SDK `dist/sdk.js`) | **PASS** |
| Lint (`oxlint`) | **No regressions.** Pre-existing baseline only: 52 `@typescript-eslint/no-explicit-any` in `src/sdk/*` and a handful of `react-hooks` set-state findings in the public Docs/landing pages. Left untouched per the freeze rules (no stylistic rewrite; SDK type surface preserved). |

**Target met: ZERO REGRESSIONS.**

---

## 3. Audited components (STAGE 1 core verification — no website changes)

- **Payments / Payment Intents:** creation, USDC-only amount integrity, currency,
  pinned network/chain snapshot, merchant ownership, merchant+network-scoped
  settlement wallet, verification, idempotency (Idempotency-Key replay / 409).
- **Checkout:** hosted checkout, state machine, verify, **RPC-failure recovery**
  (thrown fail-closed verification → retryable 503 + `processing→requires_payment`,
  Phase M fix present), network selection (PI is sole network authority).
- **Verification (`arc-provider.ts`):** 10-point fail-closed pipeline — `eth_chainId`
  proven before any read; finality gate by registry `finality_mode` (tag modes never
  downgrade); pinned native USDC Transfer decode (bridged rejected); exact recipient +
  exact base units; tx replay uniqueness; expiry + settlement grace.
- **Webhooks (Phase L):** raw secret AES-256-GCM at rest; `decryptSecret` only at
  delivery; HMAC over the RAW body `t=…,v1=…`; ±300s replay window + constant-time
  compare; `secret_hash` never signs; legacy rows fail closed; rotation invalidates the
  old secret immediately; reveal-once; merchant isolation; SSRF guard; 25 security cases.
- **Receipts:** immutable verified snapshot, `UNIQUE(payment_id)` dedupe, email failure
  fully isolated from payment status, retry+backoff, capability access, **merchant_name
  HTML-escaped** (Phase M fix present), explorer link from pinned registry.
- **Payment Links:** durable merchant-owned charge definition (no money state), amount
  from the link only, one-charge MVP (409 `link_paid`), disabled/expired 410, ~124-bit
  capability entropy, merchant isolation (cross-merchant = 404), abuse resistance.
- **Reconciliation:** merchant-scoped, status/verification/webhook/receipt/link/network
  integrity; stuck-`processing` reset; grace-aware expiry; no chain scanning.
- **Multi-chain:** **certified inventory only** — 13 enabled (3 testnet + 10 mainnet)
  from `network_configs`; registry-driven env class; fail-closed boot validation.
- **SDK:** `window.JafariPay` `{version, checkout(), mount(), destroy()}`; strict
  origin/type/paymentIntent postMessage validation; https-in-prod; **backward compatible**.
- **Security:** no private-key storage, no secret leakage at rest/in transit/in logs, no
  cross-merchant access, correct webhook signing, no accidental testnet/mainnet mixing
  (registry-driven `is_testnet`).

No P0 and no unresolved core security defect was found. Phase L and Phase M guarantees
are fully preserved.

---

## 4. Known human production actions (carried from Phase M — none are code changes)

1. Set `NODE_ENV=production` + strong (≥16) `SESSION_SECRET`, `API_KEY_HMAC_SECRET`,
   `WEBHOOK_HMAC_SECRET`, and a **stable** `WEBHOOK_SIGNING_ENC_KEY` (boot guard
   fail-fasts otherwise). A changed/absent enc key makes existing webhook ciphertext
   undecryptable → those endpoints fail closed until the merchant **rotates**.
2. Repoint the 10 enabled mainnets to **dedicated production RPCs** and keep the
   matching single host in `lib/csp.ts` `CSP_CONNECT_SRC`.
3. Provide `ALLOWED_ORIGINS`, `CHECKOUT_BASE_URL`, `JAFARIPAY_DOMAIN` for the live domain;
   set `ENABLE_LIVE_PAYMENTS=true` only when accepting live money.
4. Wire a real **email provider** behind `EmailTransport` (`EMAIL_TRANSPORT`). Today only
   `dev`/`none` exist — email is **IMPLEMENTED BUT NEEDS CONFIGURATION** (safe default).

These belong to the production-configuration stage, not this engineering freeze.

---

## 5. Explicit statements

- **CCTP IS CLOSED.** The settlement-address payment gate is incompatible with CCTP
  source-leg semantics; the router was deliberately stopped. CCTP remains
  research/future only. **No CCTP code was added, changed, or reopened in this phase.**
- **No settlement router** and **no new networks** were introduced; the certified
  inventory is authoritative.
- **No public API or SDK breaking change** was made.
- **No real money** was used; **no secrets printed or touched**; **no deployment**.
- **The public website, docs, and roadmap pages were INTENTIONALLY NOT MODIFIED in this
  stage.** They are addressed only in the later public-release stage. This freeze records
  the engineering core exactly as audited.

---

## 6. Freeze decision

Engineering core is **frozen**: green gates, no P0, no unresolved core security defect,
no architecture change, CCTP untouched. This report's commit becomes the immutable
engineering baseline for the public-release work.
