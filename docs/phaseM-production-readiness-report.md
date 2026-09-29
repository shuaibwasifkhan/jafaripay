# PHASE M — JafariPay Production Readiness + Product Freeze Audit

Status: **COMPLETE — AUDIT + targeted local hardening. HARD STOP. Nothing committed / pushed / deployed.**
Date: 2026-09-29
Type: AUDIT + HARDENING (NOT feature expansion). CCTP / Router work remains CLOSED and untouched.

---

## 1. Executive summary

JafariPay is **architecturally sound and safe to freeze**, conditional on a short
list of **human infrastructure actions** that are inherent to any first production
deployment and require **no code change**. This phase audited the existing
implementation end-to-end against the "Universal USDC Payment Infrastructure"
direction without expanding scope, re-verified every Phase L guarantee, and fixed
**only two concrete, local, additive defects** discovered during the audit.

- **No P0 findings.** No cross-merchant data leak, no secret exposure at rest or
  over the wire, no money-integrity or verification-bypass defect exists.
- **Phase L webhook security is intact and re-confirmed** (raw secret →
  AES-256-GCM at rest → decrypt only at delivery → HMAC over the raw body →
  merchant verifies the raw body; `secret_hash` never signs).
- **Two safe local defects fixed + pinned with targeted tests** (checkout verify
  RPC-error handling; receipt-email merchant-name escaping). Zero regressions.
- **Freeze recommendation: B — SAFE TO FREEZE WITH HUMAN ACTIONS.** The blockers
  are configuration/infrastructure (production RPC endpoints, `WEBHOOK_SIGNING_ENC_KEY`
  provisioning + merchant secret rotation, a real email provider), all outside the
  code and all explicitly enumerated in §17.

The architecture can be frozen. What cannot yet be claimed is "production-ready
out of the box" — the enabled mainnet networks are **read-only verified** and need
dedicated **production RPCs**, and real email delivery is **implemented but not
wired to a provider** (safe default).

---

## 2. Baseline (captured before any change; re-verified after)

- **HEAD:** `33126e74e37c5b426bc5d10c240fb576e0840532` (branch `main`,
  "Add JafariPay USDC checkout SDK, docs, and production fixes").
- **Working tree:** 58 uncommitted paths (all Phase B–L work is uncommitted; Phase
  M added 3 more edited files + this report). **Nothing discarded.**
- **SDK version:** `1.0.0` (injected from `package.json` at build time).
- **Test suite:** baseline **438 pass / 0 fail** → after Phase M tests **440 pass / 0 fail**.
- **Typecheck:** clean (`tsc --noEmit`, exit 0).
- **Build:** clean — app bundle (`vite build`) + SDK bundle (`dist/sdk.js`, ~6.3 kB) both OK.
- **Lint:** clean on all Phase M-touched files. Full-tree lint has **pre-existing**
  `no-explicit-any` + `react-hooks` warnings in tracked files (`src/sdk`,
  `DocsPage`, `HeroShowcase`, `RoadmapPage`) that are NOT Phase M regressions and
  were left untouched (HARD RULE 9 — no stylistic rewrites).
- **Enabled networks:** 13 (3 testnet + 10 mainnet) — authoritative from `network_configs`.
- **API surface / SDK surface:** unchanged this phase (see §12, §13).

---

## 3. Production environment audit (STEP 2)

16 server env vars inventoried. **No secret values are printed here.** Classification:

| Var | Class | Notes |
|-----|-------|-------|
| `NODE_ENV` | PRODUCTION REQUIRED | `production` enables the fail-fast secret guard + strict SDK https. |
| `DATABASE_URL` | PRODUCTION REQUIRED | bun:sqlite file path; WAL mode. |
| `SESSION_SECRET` | PRODUCTION REQUIRED (≥16) | session token signing; boot fails if short/absent in prod. |
| `API_KEY_HMAC_SECRET` | PRODUCTION REQUIRED (≥16) | API-key lookup HMAC. |
| `WEBHOOK_HMAC_SECRET` | PRODUCTION REQUIRED (≥16) | legacy/identity HMAC path. |
| `WEBHOOK_SIGNING_ENC_KEY` | PRODUCTION REQUIRED (≥16) | AES-256-GCM key for webhook signing secrets at rest (Phase L). |
| `JAFARIPAY_DOMAIN` | PRODUCTION REQUIRED | SIWE domain; default `jafari.co.in`. |
| `ALLOWED_ORIGINS` | PRODUCTION REQUIRED | CORS allowlist (adds to built-in localhost). |
| `ENABLE_LIVE_PAYMENTS` | PRODUCTION REQUIRED for live | live api keys / live settlement wallets 403 unless set. |
| `CHECKOUT_BASE_URL` | REQUIRED | hosted-checkout base; default `https://jafari.co.in`. |
| `PORT` | OPTIONAL | default 3001. |
| `RPC_PROXY_BASE_URL` / `RPC_PROXY_CHAINS` / `RPC_PROXY_TOKEN` | OPTIONAL (proxy deployment model) | direct-RPC deployments leave unset; proxy mode fails closed if a mapped chain lacks a token. |
| `EMAIL_TRANSPORT` | OPTIONAL | `dev` (default) or `none`. NO real provider is wired — safe default. |
| `EMAIL_DEV_FAIL` | DEV/TEST ONLY | forces dev-transport failure to exercise isolation. |

**Findings:**
- **E-1 (P2):** **No `.env.example` exists** in the repo. Remediated this phase — a
  template was added (§18, §19). Network/explorer URLs are **not** env-driven: they
  live in the `network_configs` registry (single source of truth), so there is no
  testnet/mainnet env confusion risk.
- **E-2 (P1, human action):** running with `NODE_ENV!=production` uses dev fallback
  secrets, including the webhook encryption fallback → §17.
- **No secrets in source, logs, or API responses** were found (§13). `.env` holds
  only a dummy `FOO=`; `DEPLOYER_PRIVATE_KEY` is referenced solely by
  `scripts/compass-deploy.ts` (never logged).

---

## 4. Webhook production audit (STEP 3) — Phase L re-verified, not redesigned

All 18 mandated checks confirmed against the live code:

**Proven lifecycle:**
```
RAW SECRET (whsec_...)          generated once, returned once (create + rotate)
   ↓ encryptSecret() AES-256-GCM (keyed by WEBHOOK_SIGNING_ENC_KEY, scrypt)
secret_ciphertext (v1.iv.tag.ct)  stored in webhook_endpoints (additive, nullable)
   ↓ at delivery: decryptSecret()  (returns null on any failure, never throws)
raw signing secret (in memory)
   ↓ signWebhookPayload(secret, rawBody, ts)
X-JafariPay-Signature: t=<unix>,v1=HMAC_SHA256(secret, "<t>.<rawBody>")
   ↓
merchant verifies the SAME raw body bytes
```

- `secret_hash` is used **only** for identity/lifecycle and the DB lookup — it is
  **never** the signing key (H-1 root cause is fixed and confirmed in
  `delivery.ts::processPendingDeliveries`, which selects `secret_ciphertext`).
- **Fail-closed:** a delivery with no decryptable ciphertext aborts with
  `signing_secret_unavailable: rotate this endpoint secret` — it never sends an
  unsigned or hash-signed payload. Legacy pre-Phase-L rows fail closed the same way.
- **Replay window:** ±300s; **constant-time** compare with a length guard.
- **Retry:** `[10,30,120,300,1800,7200,28800]`, MAX_ATTEMPTS=8, **re-signed every
  attempt** with a fresh timestamp.
- **Rotation:** `POST /webhook-endpoints/:id/rotate-secret` atomically replaces
  hash + preview + ciphertext and returns the new plaintext once; the old secret is
  invalidated immediately.
- **Merchant isolation + enumeration resistance:** endpoints are merchant-scoped; a
  foreign id returns the same generic 404 as a nonexistent id.
- **SSRF guard:** `isPrivateUrl` blocks private/loopback targets at creation.
- **Logs/errors:** no signing material is logged.

**Result: webhook security remains fully intact. No code change required.**

---

## 5. Receipt audit (STEP 4)

- Receipts are created **only** from a verified + credited `succeeded` payment;
  `UNIQUE(payment_id)` prevents duplicates; a concurrent-insert race returns the
  winner and never surfaces an error to the money path.
- **Snapshot immutability:** amount, tx, block, network, explorer, merchant_name
  are captured at generation from verified data; amount is re-derived from
  `amount_base_units`.
- **Email failure is fully isolated:** it only ever moves the receipt's
  `email_status`; the payment stays `succeeded`. Max 4 attempts with backoff
  `[30,120,600,3600]`.
- **Access control:** public projection `GET /api/receipts/:id` (unguessable
  `rcpt_` capability id, ~124 bits) omits `merchant_id`/`payment_id`; merchant list
  + resend are scoped and cross-merchant resend is a 404.
- **XSS discipline:** all HTML fields route through `escapeHtml`/`rowHtml`/
  `escapeAttr`; explorer href is `escapeAttr` (never a `javascript:` link).

**Email production classification: IMPLEMENTED BUT NEEDS CONFIGURATION.** The
provider-agnostic abstraction and full retry/isolation pipeline exist and are
tested, but only the `dev` (in-memory) and `none` transports are wired. No real
SMTP/SES/Postmark provider exists — this is the deliberate, safe default (§17, §18).

- **R-1 (P2, FIXED this phase):** `renderReceiptEmail` interpolated
  merchant-controlled `merchant_name` **unescaped** into the `<h2>`; now routed
  through `escapeHtml` (§18, pinned by test M2).

---

## 6. Payment Links audit (STEP 5)

- A link is a durable, merchant-owned charge **definition**; it stores **no money
  state**. It mints intents using **the link's stored amount** — a client can never
  set the amount through the public pay flow.
- One-charge MVP: a paid link refuses a second intent with **409 `link_paid`**; an
  open intent on the same network is reused idempotently; disabled → **410**,
  expired → **410**.
- Environment-class enforcement matches the intent rules.
- **Capability entropy:** `plink_` + 24 base36 chars (~124 bits) — non-enumerable.
- **Merchant isolation (test):** merchant A cannot read or disable merchant B's
  link (generic 404) — `master-payment-links.test.ts::L9`. No secret leakage on the
  public `payRouter`.

**Result: Payment Links remain intact. No change required.**

---

## 7. Payment + verification lifecycle audit (STEP 6)

Lifecycle `CREATE → CHECKOUT → CUSTOMER PAY → VERIFY → CONFIRM → WEBHOOK → RECEIPT
→ RECONCILE` traced end-to-end. The verification pipeline
(`arc-provider.ts`) enforces a 10-point check that fails closed:

1. `eth_chainId` verified against the registry **before any read** (mismatch/unreachable → throw).
2. Finality gate by registry `finality_mode` (`immediate`/`count`/`safe`/`finalized`);
   tag modes fail closed if the RPC can't serve the tag — **never** downgraded.
3. Successful receipt; USDC `Transfer` decoded from the **pinned native** contract
   (bridged USDC.e/USDbC rejected).
4. Exact recipient + exact base units; tx replay uniqueness (`tx_hash`+`network`).
5. PI not already `succeeded`; expiry + `PI_SETTLEMENT_GRACE_S` (20 min).

The persisted PI `chain_id` is the sole network authority; the client-supplied
`chain_id` is only an assertion and is rejected on mismatch **before** any read.
Duplicate/replay, wrong network/token/amount/merchant/settlement-wallet, stale and
expired intents are all handled (idempotent success, terminal `failed`/`expired`).

- **PL-1 (P1, FIXED this phase):** `POST /checkout/:id/verify` called `verifyPayment`
  **outside** a try/catch. Because `verifyPayment` fails closed by **throwing** on
  RPC/chain failures, a transient infrastructure error produced an unhandled Express 5
  error (opaque HTML 500) and left the intent stuck in `processing` until the
  reconciliation reset. The API-key sibling (`POST /v1/payment-intents/:id/verify`)
  already handled this correctly; the public path now mirrors it (retryable 503 JSON +
  `processing→requires_payment`). Money is never mutated on this path (§18, test M1).

---

## 8. Merchant isolation audit (STEP 7)

Every merchant-scoped resource was checked for cross-tenant access via ids,
capability ids, public URLs, API routes, query params, pagination, direct lookups,
and mutation endpoints: payment intents, payments, checkout, receipts, payment
links, webhook endpoints, webhook deliveries, reconciliation, settlement wallets,
API keys, and dashboard reads.

- All merchant list/read/mutation routes filter by the authenticated merchant id.
- Public reads are capability-gated by unguessable ids and return **safe
  projections** only.
- Cross-merchant access returns the **same generic 404** as nonexistent — no
  enumeration signal.
- Covered by existing tests: `webhook-security W10`, `master-receipts R12/R13`,
  `master-payment-links L9`, `master-reconciliation F5`, `phase5e 2a/2b/2c`.

**Result: no cross-merchant leak. No P0.**

---

## 9. Public endpoint abuse audit (STEP 8)

- **Rate limiting:** global 300/min (key = merchantId || ip); auth 20/min.
- **Body limit:** 1 mb (blocks oversized payloads; malformed JSON is rejected by
  the parser before handlers run).
- **CORS:** fixed allowlist (localhost dev origins + `ALLOWED_ORIGINS`) — no
  wildcard.
- **CSP:** `default-src 'self'`, `frame-src 'none'`, `connect-src` = the curated,
  exactly-inventory-minimal host list (`lib/csp.ts`).
- **Security headers:** helmet defaults on.
- **Brute-force capability ids:** ~124-bit ids make enumeration infeasible; unknown
  ids return generic 404s.

- **PE-1 (P2, NOT fixed — post-launch):** the public money-path endpoints
  (`/checkout/:id/verify`, `/pay/:id/create`) are protected only by the **global**
  300/min limiter, not a dedicated tighter per-IP bucket. This is acceptable for
  launch (verification itself fails closed and is not self-amplifying), but a
  purpose-built limiter on these two routes is worthwhile post-launch hardening.
  Adding one now would change request-rejection behavior without a proven defect —
  deferred per HARD RULE 10/13.

No giant security framework was added (per spec).

---

## 10. Database / migration audit (STEP 9)

- All recent migrations are **idempotent and additive** (`hasColumn` guards):
  `secret_ciphertext` (nullable ALTER), `finality_mode`, `customer_email`,
  `payment_link_id`, the receipts table, and the Phase-1 registry rebuild with FK
  re-check.
- **Fresh DB** and **existing DB upgrade** both succeed (seed + self-healing
  reconcile; `migration-multichain` / `phase5i-migration-safety` suites pass).
- **`WEBHOOK_SIGNING_ENC_KEY` behavior:** the upgrade adds a *nullable* column and
  never back-fills it, so it **cannot silently create usable endpoints** — a row
  without ciphertext **fails closed at delivery** ("rotate this endpoint secret"),
  exactly matching Phase L. The DB never stores a plaintext secret.
- Startup boot validation (`decimals==6` + known `finality_mode`) throws on an
  invalid registry row — fail-fast, not fail-open.

**Result: migrations are production-safe.**

---

## 11. Network / RPC production audit (STEP 10)

Certified inventory only — **no network was added or invented.** 13 enabled
networks (from `network_configs`). Classification:

- **CERTIFIED / READ-ONLY VERIFIED — REQUIRES PRODUCTION RPC (mainnet, 10):**
  `arc_mainnet, base_mainnet, arbitrum_one, op_mainnet, polygon_pos, avalanche_c,
  linea, zksync_era, unichain, celo`. Each has a validated registry row (chain id,
  pinned native USDC `^0x[40hex]$`, decimals 6, known finality mode) and was verified
  read-only in earlier certification, but several currently point at **public/default
  RPC hosts** (e.g. `polygon.drpc.org`, `api.avax.network`). For real money these must
  be replaced with **dedicated production RPCs** (§17). Fail-closed chain-id and
  finality gates protect against a lying/unreachable endpoint in the meantime.
- **READY (testnet, 3):** `arc_testnet, base_sepolia, arbitrum_sepolia` — intended
  for test flows; not for production settlement.
- **NOT enabled / SPECIAL_HANDLING / BLOCKED** (hyperevm, sonic, cronos — no
  observable finality boundary; Cronos demoted in Phase 20; non-EVM rails; ENS-only
  Ethereum) remain **disabled** and unreachable.

**No real-money E2E was performed and none is claimed.** No marketing statement
about production readiness is made where only read-only verification exists.

---

## 12. SDK backward-compatibility audit (STEP 11)

`window.JafariPay` = `{ version, checkout(), mount() }` (+ `destroy()` on the
returned handles). Verified intact:
- `checkout()` / `mount()` signatures and returned handle shape unchanged.
- postMessage trust is strict: exact origin == baseUrl origin, exact message type,
  matching `paymentIntent`, terminal-status-only. `'*'` is only ever used by the
  *page* to emit; the SDK never *accepts* an unverified origin.
- Fallback polling, timeout (`2s × 300`), duplicate mount/checkout, and https-in-
  production enforcement all preserved. No secrets ship in the bundle (test).

**Result: no breaking change. No consumer impact.** No STOP-and-report condition hit.

---

## 13. API contract vs docs audit (STEP 12)

Docs cross-checked against implementation: authentication (`sk_`/`pk_`), payment
intent creation + idempotency (409 conflict), checkout verify, webhook **events**
(`payment.created/processing/succeeded/failed/expired`), the **retry schedule**
(`~10s,30s,2m,5m,30m,2h,8h`, 8 attempts) — all match `[10,30,120,300,1800,7200,28800]`
+ MAX_ATTEMPTS=8; the **signature header** `t=...,v1=...` and the raw-body HMAC
algorithm match `signWebhookPayload`; reveal-once + rotation semantics match. The
reference verifier snippet matches the ±300s / timingSafeEqual implementation.

**No wrong field names, no stale signature/retry/event data found.** One honest gap:
the docs do not document the **503 retryable** RPC-error response on the public
verify endpoint — now that checkout verify returns it (consistent with the API-key
endpoint), docs should mention it (§19 documentation delta). No website rewrite
performed this phase.

---

## 14. Observability / failure handling audit (STEP 13)

Failures were traced for RPC timeout/unavailable/invalid, verification throw,
webhook failure, receipt/email failure, DB failure, malformed request, and
invalid/unsupported network:
- Every verification failure **fails closed** and never mutates the payment unless
  independently verified.
- Email and webhook failures are recorded on their own rows and never touch the
  payment status; both are retried by the worker.
- Stuck `processing` intents self-heal via reconciliation (>5 min with no payment →
  `requires_payment`); expiry runs after the grace window.
- **No secrets are logged** (only which env var is missing at the boot guard; the
  dev email sink logs only `to`/`subject`).

The single concrete failure-handling defect (PL-1) was the checkout-verify throw
escaping as an opaque 500 — now fixed so it is a diagnosable, retryable 503 (§7, §18).

---

## 15. Test results (STEP 14)

| Gate | Result |
|------|--------|
| Full suite (before) | 438 pass / 0 fail |
| Full suite (after)   | **440 pass / 0 fail** (+2 targeted, 0 regressions) |
| Typecheck            | PASS (exit 0) |
| Build (app + SDK)    | PASS |
| Lint (touched files) | PASS (0 errors) — full-tree pre-existing `no-explicit-any`/`react-hooks` left untouched per HARD RULE 9 |

New targeted tests (only for concrete audited gaps, not count-inflation):
- **M1** — checkout verify: a thrown RPC error → retryable **503 JSON** + intent
  reset `processing→requires_payment` (never stuck).
- **M2** — receipt email **HTML-escapes** a merchant-controlled name; raw markup
  must not appear, escaped entities must.

Report status vocabulary: PASS = as above. **BLOCKED:** none. **NOT APPLICABLE:**
real-money E2E (out of scope by mandate).

---

## 16. Findings by severity (STEP 15)

**P0 (must fix before production):** none.

**P1 (should fix before production):**
- **PL-1** — checkout-verify RPC-error handling. **CODE: FIXED + tested this phase.**
- **ENV-KEY** — `WEBHOOK_SIGNING_ENC_KEY` must be a strong, *stable* value in
  production; endpoints created under the dev fallback (or legacy rows) must be
  **rotated**. **HUMAN ACTION** (§17).
- **RPC** — enabled mainnets must be repointed to **dedicated production RPCs**.
  **HUMAN ACTION** (§17).
- **LIVE-GATE** — `ENABLE_LIVE_PAYMENTS`, `ALLOWED_ORIGINS`, `JAFARIPAY_DOMAIN`,
  `NODE_ENV=production`, and strong `SESSION_SECRET`/`API_KEY_HMAC_SECRET`/
  `WEBHOOK_HMAC_SECRET` must be set. **HUMAN ACTION** (§17).

**P2 (post-launch hardening):**
- **R-1** — receipt-email `merchant_name` escaping. **CODE: FIXED + tested this phase.**
- **E-1** — missing `.env.example`. **DOCS: ADDED this phase.**
- **PE-1** — dedicated per-IP limiter on the two public money-path verify/create
  routes (currently only the global 300/min). Deferred.
- **EMAIL** — wire a real provider behind `EmailTransport`. Deferred (do not invent).

**P3 (future product work):** settlement preferences, additional certified
networks, docs/website copy refresh. Out of scope.

---

## 17. Required human actions (before go-live)

1. **Provision production secrets** — set `NODE_ENV=production`; set strong (≥16
   char) `SESSION_SECRET`, `API_KEY_HMAC_SECRET`, `WEBHOOK_HMAC_SECRET`, and
   especially `WEBHOOK_SIGNING_ENC_KEY`. **Code change required: NO.** (Boot fails
   fast otherwise — the guard already exists.)
2. **Keep `WEBHOOK_SIGNING_ENC_KEY` stable** across restarts and environments; a
   changed/absent key makes existing ciphertext undecryptable → those endpoints fail
   closed. **Have existing webhook merchants rotate secrets** after go-live so fresh
   ciphertext is written under the production key. **Code change: NO.**
3. **Repoint mainnet networks to dedicated production RPCs** in `network_configs`
   (`polygon_pos`, `avalanche_c`, `linea`, `zksync_era`, `unichain`, `celo`, `base_mainnet`,
   `arbitrum_one`, `op_mainnet`, `arc_mainnet`) and add the matching host to
   `lib/csp.ts` `CSP_CONNECT_SRC`. **Code change: registry data + one CSP host line
   per swapped RPC** — deliberate, evidence-backed, not a rewrite.
4. **Choose and configure a real email provider** (implement `EmailTransport` behind
   `EMAIL_TRANSPORT`). Until then receipts are stored and only the dev sink runs —
   safe. **Code change: additive provider only.**
5. **Set `ALLOWED_ORIGINS` / `CHECKOUT_BASE_URL` / `JAFARIPAY_DOMAIN`** to the real
   production domain, and `ENABLE_LIVE_PAYMENTS=true` only when ready to accept live.

None of these require architectural change; none were performed by this agent (no
secrets touched, no deploy).

---

## 18. Required code changes (this phase)

Two local, safe, additive fixes — both within scope, both pinned by tests, zero
regressions, no API/architecture change:

1. `server/api/checkout.ts` — `POST /:id/verify`: wrapped `verifyPayment` in a
   try/catch mirroring the API-key endpoint; on throw it resets
   `processing→requires_payment` and returns **503 `{ error, retryable:true }`**.
2. `server/receipts/service.ts` — `renderReceiptEmail`: wrapped the `<h2>`
   `merchant_name` in `escapeHtml`.
3. `server/master-receipts.test.ts` — added targeted tests **M1** and **M2**.
4. `.env.example` — added (documentation/config hygiene; not a config system).

**No other code was changed.** No migration, no new dependency, no API/SDK change.

---

## 19. Documentation delta (STEP 16 — identified, not rewritten)

**Docs to update (small, precise):**
- *Checkout → Verify API:* document the **503 `{ retryable: true }`** RPC-error
  response and advise client retry (now consistent across both verify endpoints).
  Why: the endpoint behavior was made explicit this phase.
- *Environment/deployment:* publish the `.env.example` var table (§3) with the
  production-required set. Why: closes the missing-config-template gap.

**Website to update (defer — no rewrite performed):**
- Network status page: describe enabled mainnets as **"read-only verified —
  production RPC pending"**, not "production-ready." Why: evidence-accurate.

**Roadmap to update:**
- Move "multi-network settlement / router" to a clearly future section; keep CCTP
  marked CLOSED. Why: prevents implying a router exists.

**Marketing claims to remove / never state:**
- No claim that a **CCTP router**, **universal settlement**, or **non-EVM support**
  exists; no claim of **production E2E payment success**; no claim that networks are
  **production-ready without production RPCs**. Current docs are already free of
  these; keep them that way.

---

## 20. Final freeze recommendation

**B — SAFE TO FREEZE WITH HUMAN ACTIONS.**

The architecture is complete, internally consistent, security-sound, and fully
tested; the two concrete defects found were minor and are now fixed with zero
regressions. It can be frozen now. **Do not** mark it "production-ready out of the
box" (option A) until §17 human actions are complete — chiefly **production RPCs**
for the mainnets, a **stable `WEBHOOK_SIGNING_ENC_KEY` + merchant secret rotation**,
and a **wired email provider**. No finding requires a further architecture or public
API change, so no STOP-and-report blocker was triggered.

---

## 21. Explicit statement — nothing was committed, pushed, or deployed

This phase performed **audit + local file edits only**. Specifically:

- **NO commit.** **NO push.** **NO deploy.** **NO production restart.** **NO git
  history alteration.** The working tree is left ready for human review.
- **NO real USDC** was used; **NO private keys or production secrets** were touched
  or printed; **NO real email** was sent.
- **CCTP / Router work was not reopened** in any form.
- The only artifacts written are: `server/api/checkout.ts`, `server/receipts/service.ts`,
  `server/master-receipts.test.ts`, `.env.example`, this report
  (`docs/phaseM-production-readiness-report.md`), and two throwaway `scratch/` files
  that are deleted before this report is finalized.

**FINAL HARD STOP.**
