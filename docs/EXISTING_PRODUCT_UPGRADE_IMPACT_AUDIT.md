# JafariPay Existing Product Upgrade Impact Audit

> **READ-ONLY AUDIT — no application, website, SDK, README, or docs file was modified to produce this report.**
> Baseline commit: `4152f851cac520f1e8c0349ef102ce0dfa725e74` (working tree clean at audit time).
> Live product crawled: `https://jafari.co.in`, `/docs`, `/roadmap` (2026-10-06, rendered a11y snapshots).
> Companion authority docs: `PRODUCTION_GO_LIVE_READINESS.md`, `OPERATOR_RUNBOOK.md`, `CCTP_EXECUTOR_DECISION_BRIEF.md`.

---

## 1. Executive Summary

The recent engineering upgrade (CCTP v2 + Circle **Forwarding**, server-authored fee `F`, Brevo SMTP, production-config fail-closed validator, webhook hardening W1–W26) is **fully implemented and verified in code and in the repo's internal docs** — but the **public product surfaces have not caught up**:

1. **The live website is stale relative to HEAD.** The deployed `/roadmap` has no "Cross-chain to Arc" card and its "Shipping today" sub-line omits "cross-chain via Circle CCTP" — both exist in the repo source at HEAD. A redeploy alone already improves the public story.
2. **Three public surfaces state `maxFee = 0` / "1:1" for cross-chain** (root README §Capabilities, in-app Docs → Supported Networks, live Roadmap card). Under the implemented Forwarding architecture this is **factually wrong**: the customer burns the gross `M + F` (`maxFee = F > 0` on forwarding routes); the merchant nets exactly `M`. This is the single most important correctness contradiction found.
3. **The checkout UI never displays the forwarding fee `F`** to the customer (it shows "Pay M USDC" while approving/burning M + F) — a cost-disclosure gap on the money path.
4. **The docs API Reference advertises `/v1/*` merchant-management endpoints that do not exist** (`/v1/api-keys`, `/v1/webhook-endpoints` incl. `PATCH`, `/v1/webhook-deliveries`, `/v1/settlement-wallets`, `/v1/projects`) and points to a `/docs/openapi.json` that is not in the repo. Real `/v1` (secret-key) surface = payment-intents, payments, receipts, payment-links; the rest are session-auth `/api/*` dashboard routes.
5. **Smaller contradictions**: docs claim API keys are "hashed (bcrypt)" (actual: HMAC-SHA256); the landing "Product flow" badge shows `POST /v1/payment_intents` (underscore; real path is hyphenated); the docs Changelog stops before the multi-chain/CCTP/Forwarding/Brevo era; site claims "OpenAPI reference" that doesn't exist; "MIT License" is claimed but there is **no LICENSE file** and `package.json` has no license field.
6. Everything else audited **agrees with the verified implementation** — the 10-mainnet network tables (website/README/docs/registry), the same-chain flow, webhooks (events, signing format, max-age, retry ladder), Payment Links, Receipts semantics, the SDK surface, the dashboard, and the reconciliation story are accurate and should be marked KEEP-AS-IS.

**Bottom line:** the upgrade is ~100% done in the engine and ~70% reflected in the product's own words. The required changes are documentation/copy corrections, one customer-facing fee-disclosure UI addition, one additive API-response consistency fix, a redeploy, and a LICENSE/package-metadata decision. **None of them are blocked, and none change payment behavior** — except the fee-display and create-response `fees` items, which are additive disclosures (classified MUST before public cross-chain promotion).

## 2. Current Product Baseline (what jafari.co.in presents today)

Live crawl (deployed build, older than HEAD):

- Landing: hero "Accept USDC across 10 supported EVM mainnets"; network grid = Arc 5042, Base 8453, Arbitrum 42161, Polygon 137, Avalanche 43114, OP 10, Linea 59144, Unichain 130, zkSync Era 324, Celo 42220; 5-stage product flow; capabilities grid (multi-chain, hosted checkout, intents, links, receipts, reconciliation, non-custodial, signed webhooks, developer-first); REST+SDK code snippets; use cases; footer "Open source · MIT License".
- Landing **never mentions CCTP/cross-chain/Forwarding**; settlement story is strictly "money settles on the network it was made on".
- Docs Quickstart: SIWE signup → settlement wallet → `pk_test_/sk_test_` keys → `POST /v1/payment-intents` curl → checkout redirect → `/sdk.js` SDK → webhook verification example. Docs footer: "Non-custodial USDC payments **on Arc**" + "Built on **Arc**" (Arc-only framing inconsistent with the 10-chain landing copy).
- Roadmap (deployed): "LIVE NOW" = Multi-Chain USDC, Intents, Hosted Checkout, On-Chain Verification, Direct Settlement, Payment Links, Receipts, Reconciliation, Signed Webhooks, API Keys, JavaScript SDK. NEXT = Invoices, Recurring Billing, Merchant Reporting. EXPLORING/FUTURE = Agent Payments, policies, Payment Passport, Smart Settlement, firewall, treasury, outcome payments, non-JS SDKs. **No cross-chain entry at all.**
- Auth surfaces work as claimed: wallet sign-in (SIWE), dashboard behind guard.

## 3. Current Engineering Baseline (verified at HEAD)

- 711 tests pass / 0 fail / 4,785 `expect()` / 41 files; `tsc --noEmit` clean; `vite build` (SPA + `dist/sdk.js`) clean; `git diff --check` clean; `oxlint server` 0/0 (see §22 lint caveat).
- CCTP v2 + Forwarding: `depositForBurnWithHook` + 24-byte `cctp-forward` v0 hook; per-intent live fee quote (`server/blockchain/cctp-forwarding-fee.ts`), server-authored `forwarding_max_fee_base_units`, fail-safe DIRECT fallback; Standard finality 2000; `destinationCaller = bytes32(0)`; merchant credited exactly `M`; customer burns `M + F`; JafariPay observes `forwardTxHash`, verifies destination settlement, never signs destination `receiveMessage`.
- Real application E2E on testnet (intent `pi_s3djmmlvuac03cvusbaoznwh`, M=1,000,000, F=21,527, gross 1,021,527 — see readiness pack §0).
- Webhook engine: HMAC-SHA256 `t=,v1=`, 300s max-age, AES-256-GCM secret envelope, 8-attempt ladder `[10,30,120,300,1800,7200,28800]s`, SSRF guard, W1–W26 matrix (external live-endpoint delivery still untested — 0 endpoints).
- Brevo SMTP transport (approved + live-verified at send level).
- `validateProductionConfig` fail-closed boot guard (PC1–PC15).
- Network registry: 13 enabled rows (10 mainnets + 3 testnets) from a 38-network Circle inventory; CCTP sources enabled = Base, Arbitrum One, Polygon, Avalanche, OP, Linea, Unichain (domains 6,3,7,1,2,11,10) + Base Sepolia (pilot); destination always Arc domain 26; zkSync/Celo same-chain-only.

## 4. Live Website Audit

| Claim (live) | Where | FE component | BE capability | Verified? | Verdict |
|---|---|---|---|---|---|
| "10 supported EVM mainnets" + 10-chain grid w/ chain IDs | Landing | `LandingPage.tsx` | registry `network_configs` | ✅ matches registry | ACCURATE |
| "Native USDC pinned per network; bridged/synthetic never accepted" | Landing | — | verifier contract check | ✅ | ACCURATE |
| 5-stage flow incl. `POST /v1/payment_intents` badge | Landing product section | `LandingPage.tsx` ~L92 | real path `/v1/payment-intents` | ⚠️ | PATH TYPO (underscore vs hyphen) — copy fix |
| "Funds move directly to your settlement wallet" (stage 3) | Landing | — | same-chain ✅; cross-chain goes via CCTP burn | ⚠️ | True for same-chain only; incomplete once cross-chain is promoted |
| "HMAC-SHA256 signed, 8 attempts, replay protection, webhook = source of truth" | Landing + docs | WebhooksPage | delivery.ts | ✅ W1–W26 | ACCURATE |
| "ERC-20 Transfer verified (token/amount/recipient)" | Landing stage 4 | — | arc-provider verify | ✅ | ACCURATE |
| Code snippet `fetch("https://your-instance.com/v1/payment-intents")` | Landing dev section | — | ✅ route exists | ACCURATE |
| SDK snippet `/sdk.js`, `JafariPay.checkout/mount` | Landing + docs | sdk/index.ts, dist/sdk.js served at `/sdk.js` w/ 404 guard | ✅ | ACCURATE |
| "Receipts: automatic, emailed to customers" | Landing/roadmap | ReceiptPage | receipts + Brevo | ✅ code; ⚠️ prod env pending | ACCURATE (deployment-blocked) |
| "OpenAPI reference" (landing dev blurb; docs `/docs/openapi.json`) | Landing, API ref footer | — | **no openapi file exists** | ❌ | FALSE CLAIM — must remove or create spec |
| "Non-custodial USDC payments on Arc" / "Built on Arc" (docs footer) | Docs footer | `DocsPage.tsx` | 10 chains + Arc settlement | ⚠️ | UNDERSTATES product; internal contradiction with landing |
| "Open source · MIT License" | Footer | — | **no LICENSE file, no pkg license field** | ❌ | CONTRADICTION — legal surface |
| Hero showcase "Payment link · live jafari.co.in/pay/plnk_8s2v" | Landing | `HeroShowcase.tsx` | demo data labelled "LIVE" | ⚠️ | MOCK dressed as live — perception risk, low priority |
| Invoices "Coming", Recurring "Exploring", Agent "Exploring", Firewall "Future" | Landing tabs | HeroShowcase | consistent with RoadmapPage | ✅ honest | KEEP |
| Cross-chain / CCTP / Forwarding | entire site | — | IMPLEMENTED + testnet-verified | ❌ absent | MISSING public story (deployed + repo landing copy both omit it; only roadmap card at HEAD mentions it) |

## 5. Frontend Audit

Routes (`App.tsx`): `/` landing, `/login` SIWE, `/checkout/:id`, `/receipt/:id`, `/pay/:id`, `/docs(/:slug)`, `/roadmap`, `/dashboard/{,payments,payments/:id,projects,api-keys,webhooks,developers,settings}`, `* → /`.

| Surface | Status | Notes |
|---|---|---|
| CheckoutPage | **IMPLEMENTED — upgrade-current** | Same-chain ERC-20 path + cross-chain burn path (`handlePayCrossChain`); builds plan via `cctp-checkout.ts`; uses `depositForBurnWithHook` when `plan.forwarding`; fail-closed if server hook missing; same-chain verify pipeline hard-guarded off for cross-chain |
| Checkout fee display | **MISSING (gap)** | UI shows `Pay {intent.amount} USDC` (= M) and balance; never renders `F`/gross despite the server exposing `pi.fees` in the checkout JSON (checkout.ts L100). Customer approves M+F blind |
| PayLinkPage / ReceiptPage | IMPLEMENTED | match documented semantics |
| Dashboard payments + PaymentDetailPage | **IMPLEMENTED — upgrade-current** | `CrossChainJourney` timeline w/ source tx, destination tx (forwardTxHash surfaces here), mint recipient, failure reason |
| WebhooksPage | IMPLEMENTED | subscribes exactly the 7 deliverable events incl. both `payment.cross_chain.*`; rotate secret; deliveries + retry |
| ApiKeysPage / ProjectsPage / SettingsPage / DevelopersPage / OverviewPage / AuthPage | IMPLEMENTED | consistent with backend; no old-architecture assumptions found (no relayer/signer UI, no direct-`receiveMessage` claims) |
| LandingPage | PARTIAL / OUTDATED | Accurate for same-chain; **no cross-chain capability story**; `payment_intents` underscore typo; "OpenAPI reference" claim |
| RoadmapPage (repo HEAD) | PARTIAL — has CCTP card **but with stale fee copy** ("1:1 … maxFee=0") + no Forwarding/fee mention | AND **not deployed** (live site lacks the card entirely) |
| DocsPage | see §9 | the public docs ARE the docs surface |
| Error/loading/pending states | IMPLEMENTED across pages | |

No frontend code was found that assumes the OLD (pre-CCTP or direct-relayer) architecture — the checkout engine was fully upgraded. The gaps are **copy + fee disclosure**, not logic.

## 6. Backend/API Audit

Real mount table (`server/index.ts` L111–149):

| Method/Path (real) | Auth | Purpose | Idempotency | Documented? | Consumer parity |
|---|---|---|---|---|---|
| `POST /v1/payment-intents` | `sk_` | create (incl. `cross_chain:true`) | `Idempotency-Key` ✅ | ✅ quickstart+intents+README | docs ✓ |
| `GET /v1/payment-intents[/:id]` | key/session | list/detail | — | ✅ | |
| `POST /v1/payment-intents/:id/verify` | sk_ | same-chain verify (cross-chain intents get `cross_chain.wrong_verify_endpoint`) | tx-hash replay guard | ✅ | |
| `POST /v1/payment-intents/:id/cancel` | key | cancel (+`payment.cancelled` timeline event) | — | listed in API ref ✓ | |
| `GET /v1/payments[/:id]` | key | ledger reads | — | ✅ | |
| `POST/GET /v1/payment-links`, `/:id/disable` | sk_ | links CRUD | — | ✅ (dedicated doc section) | |
| `GET /pay/:id`, `POST /pay/:id/create` | public capability | link pay page | link-paid guard ✅ | ✅ | |
| `GET /v1/receipts`, `POST /v1/receipts/:id/resend` | key | receipts | — | ✅ | |
| `GET /api/receipts/:id` | capability | public receipt | — | ✅ | |
| `GET/POST /api/checkout/:id[/verify|/receipt]` | public | checkout JSON engine | guards verified | partially (README ✓, docs ✓) | |
| `GET /health` | public | liveness | — | internal runbook ✓ (public docs silent — fine) | |
| `/sdk.js` (+ 404 guard) | public | SDK asset | — | ✅ | |
| `/api/auth /api/projects /api/api-keys /api/settlement-wallets /api/webhook-endpoints /api/webhook-deliveries` (+ bare dev aliases) | **session only** | dashboard CRUD | — | ❌ **mis-documented** (see next para) | |

**Flags (exact):**
- **Documented-but-missing API:** API Reference advertises `GET/POST/DELETE /v1/api-keys`, `GET/POST/PATCH/DELETE /v1/webhook-endpoints`, `GET /v1/webhook-deliveries + POST …/retry`, `GET/POST/DELETE /v1/settlement-wallets`, `GET/POST /v1/projects`. **None of these are mounted under `/v1`** — they are session-cookie dashboard routes. A merchant following the docs gets 404. Also no `PATCH` webhook endpoint exists (rotate is `POST /api/webhook-endpoints/:id/rotate-secret`); deliveries live on a separate mount (`/api/webhook-deliveries`).
- **Undocumented backend features (public):** none material beyond the fee/forwarding story; cancel + cross_chain events are in docs.
- **Obsolete/duplicate API:** bare un-prefixed mounts (`/projects`, `/payments`, …) are **dev-proxy duplicates** — correctly kept prod-inert by design but they DO listen in production too (same router mounted twice); low-risk note, not a required change.
- **Create-response fee inconsistency:** `POST /v1/payment-intents` applies the forwarding quote (persisting `F`) but then builds the response `fees` with a hardcoded `feeBaseUnits:'0'` ("Standard CCTP is 1:1" — pre-Forwarding comment). Merchant's create-time view can therefore contradict the checkout-time `fees` (which is quote-correct). Additive fix; no money path changes.

## 7. SDK Audit

Repo SDK surface = **one artifact**: the standalone IIFE at `/sdk.js` (`src/sdk/browser.ts` → `src/sdk/index.ts`, built by `vite.sdk.config.ts`, version injected from `package.json`, served with cache + 404 guard). `src/cctp-checkout.ts` is checkout-page internals, not a published library. There is **no npm package** (name in package.json is still `studio-app`).

| SDK feature | Backend capability | Current SDK | Required change | Breaking? | Docs change? | Priority |
|---|---|---|---|---|---|---|
| `checkout()/mount()/close/destroy/version` | hosted checkout | ✅ exposes exactly this | none | — | — | — |
| Terminal status reporting (`succeeded/failed/expired/cancelled`) | checkout postMessage | ✅ matches | none | — | — | — |
| Cross-chain/Forwarding awareness | burn+forward flow | **not applicable** — SDK never touches chain interactions; checkout page handles them | none (correct-by-design: must NOT gain CCTP logic) | — | optionally document "cross-chain intents launch identically via SDK" | C |
| Webhook verification helper | W1–W26 engine | ❌ none (docs show manual `verifySignature`) | optional future helper — do NOT add now | no | docs fine | C |
| Server API client (intents CRUD) | `/v1` REST | ❌ none | intentionally out of scope (backend calls belong to merchant) | — | — | D (do not change) |
| Package metadata | — | `studio-app@1.0.0`, no exports/types, unpublished | decision: keep `/sdk.js`-only OR publish real package | no | README install snippet would change | B/E (human decision) |

Answers to the mandated questions: (1) exposes checkout launcher only; (2) backend now supports cross-chain + forwarding; (3) nothing must be added for correctness; (4) nothing outdated (no chain assumptions); (5) types consistent (UI-result only, explicitly not settlement proof — correctly disclaimed); (6–10) SDK does **not** assume direct CCTP anywhere — it is architecture-neutral; (11) docs match SDK behavior exactly; (12) examples executable (`/sdk-demo.html` exists in `public/` and is served).

## 8. README Audit (root `README.md`, 273 lines — the only real README)

No server/SDK/docs/DEPLOYMENT READMEs exist (only `lib/forge-std` upstream). Findings at line level:

| Line | Current text | Problem | Verdict |
|---|---|---|---|
| L44 | "receives **1:1** … non-custodial, **maxFee=0**" | Contradicts implemented Forwarding economics (burn = M+F, maxFee=F>0, merchant nets M) | **MUST CHANGE** |
| L154 | "Implemented events include `payment.created … payment.expired`" | Omits the 2 subscribable `payment.cross_chain.*` events + `payment.cancelled` timeline | SHOULD CHANGE |
| L184–197 env table | 10 vars | Missing `WEBHOOK_SIGNING_ENC_KEY`, all `EMAIL_*`/Brevo vars, RPC-proxy vars, `E2E_*` (dev-only) | SHOULD CHANGE |
| L211 | "The current test suite (`server/payment-expiry.test.ts`) covers…" | Massively understates: 41 files / 711 tests including webhook matrix, forwarding, production-config | SHOULD CHANGE |
| L216–235 structure | omits `server/blockchain/cctp-*.ts`, `cctp-forwarding-fee.ts`, `lib/production-config.ts`, `email/brevo-smtp.ts`, `src/sdk/`, `docs/` listed as only 2 files | Stale map | NICE TO HAVE |
| L150 | "the hosted checkout page and REST API are the integration paths **shipped in this repository**" vs L29/L67–82 "SDK ships at /sdk.js" | Internal contradiction (leftover pre-SDK caveat) | SHOULD CHANGE |
| L272 | "Open source. See repository for details." + site claims MIT | No LICENSE file, no package.json license field | HUMAN DECISION (E) |
| L254–259 | Mainnet proof tx (same-chain Arc) | Accurate; consider adding testnet forwarding E2E pointer once public story launches | KEEP / C |
| Rest (flow, non-custodial, networks table, security list, curl examples) | | Verified accurate against code | KEEP AS-IS |

## 9. Documentation Audit (docs/ + in-app DocsPage)

**Repository internal docs (17 files):** the three authority docs are CURRENT (updated during Phase 21 closure). Historical phase reports (`phaseL/phaseM/UAT/MASTER/…`) are dated snapshots — label-honest, KEEP. `router-cctp-feasibility.md` predates the forwarding decision → superseded by the decision brief; acceptable as history. `fee-module-v2` folder does not exist.

**Public in-app docs (`DocsPage.tsx`) — per page:**

| Page | Status | Issues |
|---|---|---|
| Quickstart | ACCURATE | correct paths, keys, SDK, webhook example (header/`t=,v1=`/raw-body all match delivery.ts) |
| Auth | ACCURATE | |
| Payment Intents | **PARTIALLY STALE** | Create example never mentions `cross_chain` or the fee model; immutable-fields fine; state table correct |
| Checkout | PARTIALLY STALE | describes only the ERC-20 transfer path ("Sends the USDC ERC-20 transfer to the settlement wallet") — no cross-chain burn/forwarding checkout behavior documented |
| Payment Links | ACCURATE | matches API incl. `link_paid/link_disabled/link_expired` guards |
| Receipts | MOSTLY ACCURATE | "built-in transport is `dev`/`none` by default" predates D-4 — `brevo_smtp` now selectable; resend semantics correct |
| Reconciliation | ACCURATE | 30s cadence ✅, four-step tick incl. isolated cross-chain batch ✅, ledger claims ✅ |
| JavaScript SDK | ACCURATE | matches `src/sdk` exactly |
| Webhooks | **PARTIALLY STALE** | event table = exactly the 7 deliverable events ✅; ladder ✅; BUT silent on `X-JafariPay-…` delivery state names and (minor) no mention secrets are encrypted-at-rest semantics; OK overall |
| Webhook Verification | ACCURATE | format/300s/timingSafe match |
| Test Mode / Production | ACCURATE | |
| Security | **WRONG FACT** | "Secret keys are hashed (**bcrypt**)" → actual `createHmac('sha256', API_KEY_HMAC_SECRET)` (api-keys.ts L10). 5-minute replay rejection ✅; SSRF ✅ |
| Supported Networks | **STALE (fee)** | tables + addresses + testnet separation ✅; but "delivered **1:1** … `maxFee = 0`, so the amount burned on the source **equals** the amount minted" ❌ under Forwarding |
| API Reference | **STALE/WRONG** | phantom `/v1/*` management endpoints (see §6); missing `/v1/payment-links`, `/v1/receipts`, `/pay/:id`, `/api/checkout/:id` public surface; footer cites non-existent `/docs/openapi.json` |
| Error Codes / Troubleshooting | ACCURATE | |
| Changelog | **STALE** | entries stop at "Arc Mainnet production support / README upgrade for Arc OSS showcase" — nothing for multi-chain, Payment Links, Receipts, SDK, Webhooks v2, CCTP, **Forwarding**, Brevo, production hardening |

Contradictions between docs and code are reported above, **not** silently reconciled.

## 10. Code Examples Audit

| Example | Location | Executable today? | Issue |
|---|---|---|---|
| `curl POST /v1/payment-intents` | README L122, Docs quickstart | ✅ path/auth correct | none |
| fetch-create-redirect snippet | Landing, Docs checkout | ✅ | none |
| Webhook express example | Docs quickstart | ✅ header/`rawBody` semantics correct | relies on `req.rawBody` — needs body-parser raw capture; docs elsewhere say verify raw bytes ✅ |
| SDK `<script>` + `JafariPay.checkout/mount` | Landing/Docs/README | ✅ `public/sdk-demo.html` exists and is served | none |
| Payment-links + receipts curl-style snippets | Docs sections | ✅ match routes | none |
| **`POST /v1/payment_intents`** badge | Landing product flow | ❌ wrong path style | underscore typo |
| OpenAPI `/docs/openapi.json` | Docs API ref + landing claim | ❌ file nonexistent | remove claim or add spec |
| Cross-chain create example (`cross_chain: true`) | **nowhere public** | — | MISSING example for the flagship new feature |

## 11. Network Information Audit (mismatch table)

Sources compared: live site grid · repo `LandingPage.tsx` · `RoadmapPage.tsx` · `DocsPage` networks table · README table · `src/supported-chains.ts`/`src/onchain-facts.ts` · `server/db/networks.ts` (13 enabled rows) · `server/db/cctp.ts` registry · docs cross-chain source table.

- **Chain IDs / USDC addresses / explorers: ALL CONSISTENT** across website, README, docs, frontend allowlist, and backend registry (verified entry-by-entry: 5042/8453/42161/137/43114/10/59144/130/324/42220 + 5042002/84532/421614; USDC addresses byte-identical). ✅ KEEP.
- **CCTP source set: CONSISTENT** — docs & roadmap copy list Base, Arbitrum One, Polygon, Avalanche, OP, Linea, Unichain; `cctp.ts` marks exactly those (+ Base Sepolia testnet) `supportedAsSource:true`; zkSync/Celo same-chain-only everywhere. ✅
- **Testnet/live labelling: CONSISTENT** everywhere ("NOT FOR PRODUCTION" tables, `pk_test_/sk_test_` class enforcement verified in code).
- Mismatches are **qualitative, not tabular**: (a) docs footer/branding says "on Arc / Built on Arc" while 10 chains are live-supported; (b) landing + live roadmap present **zero** cross-chain capability; (c) the fee property stated for cross-chain ("1:1, maxFee=0") contradicts the implementation. No stale chain ID or address was found anywhere.

## 12. CCTP / Forwarding Audit (against the verified architecture)

Reference architecture (per §3, authority docs): opt-in `cross_chain:true` → server quotes F (fail-safe → DIRECT) → customer approves+broadcasts `depositForBurnWithHook` (amount M+F, maxFee=F, finality 2000, hook `cctp-forward` v0, destinationCaller 0) → JafariPay detects burn, fetches attestation, verifies, observes Circle's forwardTxHash, confirms Arc-side settlement, credits merchant exactly M, emits lifecycle webhooks.

| Surface | Statement | vs implementation |
|---|---|---|
| Checkout engine (`src/cctp-checkout.ts`, `CheckoutPage.tsx`) | full forwarding plan incl. fail-closed hook requirement | ✅ CURRENT (canonical) |
| Server (`cctp-source/attestation/destination/forwarding-fee/status`, worker) | burn detection → attestation → destination verify → settle M | ✅ CURRENT |
| Dashboard `CrossChainJourney` | timeline + hashes | ✅ CURRENT |
| Authority docs (3) | implemented + testnet-verified + entitlement caveat | ✅ CURRENT |
| README L44 "1:1, maxFee=0" | ❌ contradicts M+F burn | **OUTDATED — MUST CHANGE** |
| Docs networks §cross-chain "maxFee=0 … burned equals minted" | ❌ same | **MUST CHANGE** |
| RoadmapPage card "receives 1:1 … maxFee=0" | ❌ same | **MUST CHANGE** |
| Landing (repo + live) | silent on cross-chain | MISSING public story (classify B/C) |
| Live roadmap (deployed) | silent entirely | STALE DEPLOYMENT |
| Docs checkout/payment-intents/API | no cross_chain/fees documentation | MISSING (B for public release) |
| SDK | no CCTP assumptions | ✅ correctly neutral |
| "JafariPay signs receiveMessage" claims | none found anywhere | ✅ |

## 13. Payment Lifecycle Audit

Intent → checkout → wallet → approval → burn/transfer → verification → attestation/forwarding → destination → settlement → payment → success → webhook → receipt email → reconciliation.

- **Backend:** every stage implemented + test-verified (711) + E2E evidence at readiness pack §0. ✅
- **Frontend:** CheckoutPage handles both lifecycles; status polling; terminal states; receipt page; dashboard timeline. ✅ (fee display = §5 gap)
- **Docs/README/site coverage:** same-chain lifecycle fully covered (website 5-stage flow ✅). Cross-chain lifecycle: authority docs only; **public docs cover the first half** (opt-in creation) but mis-state the fee, and the site doesn't tell the story at all. Payment-webhook lifecycle events documented ✅.
- Where the public product story differs from implementation: "customer pays M, merchant receives M, JafariPay never in money path" is **incomplete for cross-chain** (customer pays M+F to Circle's forwarding route; still non-custodial — JafariPay itself never takes a fee, but a Circle network fee exists and must be named honestly).

## 14. Merchant Experience Audit (journey)

1 Discover (landing ✅ accurate same-chain; ❌ no cross-chain value prop) → 2 Docs (✅ quickstart works; ⚠️ phantom /v1 endpoints; ⚠️ no cross-chain guide) → 3/4 Sign-up/auth SIWE (✅ implemented, honestly marketed) → 5 Setup project+settlement wallet (✅ SettingsPage) → 6 API keys (✅ shown once, HMAC-hashed; docs wrong about bcrypt) → 7 Webhook config (✅ UI + W1–W26; external delivery unproven live — staging gate in runbook) → 8 Create payment (✅ API/links) → 9–12 Checkout→confirm (✅; fee disclosure missing) → 13 Webhook receipt (✅) → 14 Email receipt (✅ code+Brevo; prod env pending) → 15 Reconciliation (✅ ledger, CSV-free; "Merchant Reporting" honestly labelled NEXT).

Missing work = copy/fee-disclosure items above + production activation (external), not journey functionality.

## 15. Webhook Audit

- Delivery ladder `[10,30,120,300,1800,7200,28800]s` + terminal fail at 8 attempts ✅ = docs "8 total attempts" + ladder text ✅.
- Signature `t=<ts>,v1=<hmac>` over `${timestamp}.${rawBody}`, 300s max-age, timing-safe example ✅.
- Secret shown once, stored in AES-256-GCM envelope; rotation immediate ✅ (docs match).
- Event universe: deliverable/VALID_EVENTS = 7 (5 payment + `attestation_received` + `failed`); additional lifecycle types (`source_burn_detected`, `settled`, `verification_failed`, `timeout`, `cancelled`) exist as `payment_events` timeline rows only — **docs never claim them as webhooks** ✅ consistent.
- W1–W26 tests map to real implementation files (signing, replay, SSRF, tenant/env isolation, retry, terminal states) ✅.
- Merchant UX: dashboard subscriptions limited to the 7 (matches backend) ✅.
- **Known untested surface (unchanged):** external delivery to a real merchant endpoint (0 endpoints exercised) — public docs don't claim it; runbook §7.1 staging verification remains a REQUIRED go-live gate.

## 16. Email / Receipt Audit

One transport abstraction (`server/email/`), switch-selected by `EMAIL_TRANSPORT`; `brevo_smtp` implemented + unit-tested with injected deliver boundary + live send-verified (D-4). Receipts flow (`processPendingReceiptEmails`) never touches payment status ✅. No second email architecture exists or is proposed. Public surfaces: receipts documented (minor stale "dev/none by default" line); site claims "emailed to customers" ✅ true given prod env wiring (production-blocked, not code-blocked). **No changes required** except the one docs sentence + production env checklist (already in authority docs).

## 17. Package / Release Audit

- `package.json`: name `studio-app` (template default), version `1.0.0`, no `license`, no `exports` — app-package only; the SDK is not an installable package.
- No CHANGELOG.md; changelog lives in-app (`DocsPage CHANGELOG_ENTRIES`) and is stale (§9).
- Lockfile `bun.lock` ✅; build outputs: SPA `dist/` + `dist/sdk.js` (+ map) served from `/sdk.js`.
- Upgrade requires: **changelog entries (public docs)** for multi-chain/CCTP-Forwarding/links/receipts/webhooks/Brevo/production hardening; a **license decision** (add LICENSE or drop MIT claim); **SDK/version identity decision** (rename from `studio-app` / decide publish posture). No API version bump warranted (v1 surface additive-unchanged). No migration notes needed for merchants (same-chain byte-identical behavior; cross_chain is opt-in additive).

## 18. Website ↔ Code Gap Matrix

| Feature | Website (live) | Code (HEAD) | Gap / required action |
|---|---|---|---|
| Same-chain USDC, 10 mainnets | ✅ claimed | ✅ verified | none |
| Hosted checkout, intents, links, receipts, reconciliation, webhooks, SDK, keys, SIWE | ✅ claimed | ✅ verified | none |
| Cross-chain via CCTP | ❌ absent | ✅ implemented + E2E | add public story **after** D-1 sign-off + mainnet entitlement (else advertises an un-enabled capability) |
| Forwarding fee F | ❌ absent | ✅ implemented | fix `maxFee=0/1:1` copy (3 places) + checkout fee display + create-response fees |
| OpenAPI reference | ✅ claimed | ❌ nonexistent | remove claim or add spec |
| MIT license | ✅ claimed | ❌ no file/field | human decision |
| Merchant management REST API (`/v1/api-keys` etc.) | — | ❌ session-only `/api/*` | fix docs API reference |
| "Built on Arc" framing (docs footer) | ✅ present | 10-chain product | update framing |
| Deployed build currency | stale | — | **redeploy** — cheapest high-impact action |

## 19. Website ↔ README ↔ Docs ↔ SDK Consistency Matrix

| Area | Website | README | Docs | SDK | Frontend | Backend | Verified? | Required change |
|---|---|---|---|---|---|---|---|---|
| USDC payments (same-chain) | ✅ | ✅ | ✅ | n/a | ✅ | ✅ | ✅ | none — KEEP |
| Supported networks (10) | ✅ | ✅ | ✅ | n/a | ✅ | ✅ | ✅ | none — KEEP |
| Same-chain flow | ✅ | ✅ | ✅ | ✅ launcher | ✅ | ✅ | ✅ | none |
| CCTP cross-chain | ❌ missing | ⚠️ stale fee | ⚠️ stale fee | ✅ neutral | ✅ current | ✅ current | ✅ testnet E2E | copy ×3 + public story (B) |
| CCTP Forwarding + fee F | ❌ | ❌ | ❌ | — | UI hidden | ✅ | ✅ | **must**: fee copy + fee display + create `fees` field |
| Payment intents | ⚠️ path typo | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | typo fix (C) |
| Hosted checkout | ✅ | ✅ | ⚠️ burn path undocumented | ✅ | ✅ | ✅ | ✅ | docs add (§20-D8) |
| Payment links | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | none |
| Webhooks | ✅ | ⚠️ event list short | ✅ | ❌ no helper (by design) | ✅ | ✅ | ⚠️ external unexercised | README list + keep staging gate |
| Receipts | ✅ | ✅ | ⚠️ transport line | — | ✅ | ✅ | ✅ | one docs sentence (C) |
| Reconciliation | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | none |
| API keys | ✅ | ✅ | ⚠️ bcrypt claim + phantom /v1 | — | ✅ | ✅ | ✅ | docs fixes (must-B) |
| Settlement wallets | ✅ | ✅ | ⚠️ same phantom /v1 | — | ✅ | ✅ | ✅ | docs fix |
| Merchant onboarding | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | none |
| SDK | ✅ | ⚠️ L150 caveat vs L29 | ✅ | ✅ | ✅ | ✅ | ✅ | remove stale caveat |
| Authentication | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | none |
| Testnet vs mainnet | ✅ | ✅ | ✅ | — | ✅ | ✅ enforced | ✅ | none |
| Production readiness claims | honest | honest | authority docs ✅ | — | — | fail-closed ✅ | ✅ | none (do NOT add claims) |
| License | ⚠️ MIT claim | ⚠️ MIT | — | — | — | — | ❌ | human decision |

## 20. Exact Required Changes

| # | File / location | Current state | Problem / why outdated | Exact change required | Dependencies | Breaking? | Priority | Safe now? |
|---|---|---|---|---|---|---|---|---|
| C1 | `README.md` L44 | "receive 1:1 … maxFee=0" | contradicts implemented Forwarding (burn M+F, maxFee=F) | restate: merchant receives exactly M; customer additionally pays Circle forwarding fee F quoted per intent; keep DIRECT/1:1 mention only as fallback when no quote | none | no | **HIGH** | yes (copy) |
| C2 | `src/components/docs/DocsPage.tsx` networks §cross-chain (L392, L402) | "1:1 … burned equals minted, maxFee=0" | same contradiction, on the public money-path doc | rewrite fee paragraph to Forwarding economics + DIRECT fallback note | none | no | **HIGH** | yes |
| C3 | `src/components/landing/RoadmapPage.tsx` L56 card | "1:1 … maxFee=0" | same | same rewrite | none | no | **HIGH** | yes |
| C4 | `src/components/checkout/CheckoutPage.tsx` (+ reuse `pi.fees`) | shows "Pay M", approves M+F | customer cost-disclosure gap on money path | render F + gross when `fees` indicates forwarding | backend already exposes fees | no | **HIGH** (before cross-chain public promotion) | yes (UI add) |
| C5 | `server/api/payment-intents.ts` L245 | create response `fees` hardcodes `feeBaseUnits:'0'` | contradicts quote applied at L225–233; merchant sees wrong breakdown | build `fees` from persisted `forwarding_max_fee_base_units` after quote; update stale "Standard CCTP is 1:1" comment | none | additive (no removals) | **HIGH** | yes (code, additive) |
| C6 | DocsPage API Reference | phantom `/v1/api-keys|webhook-endpoints|webhook-deliveries|settlement-wallets|projects` + PATCH semantics + `/docs/openapi.json` | documented-but-missing API → 404 for merchants | replace with real `/v1` surface (intents, payments, receipts, payment-links, public /pay + /api/checkout) + note that keys/webhooks/wallets are dashboard-only today | none | no | **HIGH** | yes |
| C7 | DocsPage Security "bcrypt" | wrong hash mechanism | HMAC-SHA256 in code | correct one sentence | none | no | MEDIUM | yes |
| C8 | DocsPage checkout + payment-intents pages | no cross_chain/fee documentation | flagship feature undocumented | document `cross_chain:true`, response fields (`source_network…`, `fees`), checkout burn flow, wrong-endpoint guard | C2 wording | no | MEDIUM (B: before public release) | yes |
| C9 | DocsPage Changelog entries | stops pre-upgrade | public changelog dishonest about the product | add entries (Forwarding, multi-chain already shipped-era, links/receipts/webhooks/Brevo/production hardening) | none | no | MEDIUM | yes |
| C10 | Landing product-flow badge `POST /v1/payment_intents` | underscore | path typo | hyphen | none | no | LOW | yes |
| C11 | Landing "OpenAPI reference" + docs claim | no spec exists | false artifact claim | drop claim OR generate openapi.json (later) | decision | no | MEDIUM | decision |
| C12 | README L154 webhook events | 5 listed | omits 2 subscribable cross_chain events + cancelled nuance | align with VALID_EVENTS table | none | no | LOW | yes |
| C13 | README env table | 10 vars | missing WEBHOOK_SIGNING_ENC_KEY, EMAIL_*, RPC proxy | extend (names only) | none | no | MEDIUM | yes |
| C14 | README L211 "current test suite (payment-expiry.test.ts)" | understates | 41 files/711 tests | one sentence update | none | no | LOW | yes |
| C15 | README L150 SDK caveat vs L29/§SDK | contradicts itself | stale pre-SDK note | remove caveat sentence | none | no | LOW | yes |
| C16 | Docs footer "payments on Arc"/"Built on Arc" | Arc-only framing | contradicts 10-chain + Arc-settlement product | reframe ("multi-chain USDC, settlement on native rails / to Arc") | none | no | MEDIUM | yes |
| C17 | License surface | site+README claim MIT; no LICENSE file, no pkg field | unbacked legal claim | **owner decision:** add MIT LICENSE file OR withdraw claim | legal owner | no | MEDIUM (E) | no (decision) |
| C18 | `package.json` name `studio-app@1.0.0` | template default | release identity | decide rename/publish posture (keep `/sdk.js`-only is valid) | owner | no | LOW (E) | no (decision) |
| C19 | Live deployment | build older than HEAD (roadmap card absent) | public site ≠ repo copy | redeploy after implementing C1–C3, C10, C16 | hosting (D-3) | no | HIGH (gated) | no (F) |
| C20 | `public/sw.js` | never registered anywhere | orphan artifact from old iteration | remove later or document intent | none | no | LOW | yes (tiny) |
| C21 | Landing HeroShowcase "LIVE" chip on mock link `plnk_8s2v` | demo data looks live | perception risk ("live" though simulated) | relabel ("Sample") | none | no | LOW | yes |

## 21. Files Likely To Change (future implementation step, in priority order)

`src/components/docs/DocsPage.tsx` (C2, C6–C9, C16) · `README.md` (C1, C12–C15) · `src/components/landing/RoadmapPage.tsx` (C3) · `src/components/checkout/CheckoutPage.tsx` + possibly `src/onchain-money.ts` (C4) · `server/api/payment-intents.ts` (C5, with a new additive test) · `src/components/landing/LandingPage.tsx` (C10, C11, C21) · `package.json`/`LICENSE` (C17–C18, pending decision) · `public/sw.js` (C20, removal).

## 22. Files That Should NOT Change (KEEP AS-IS, with reason)

- **All money-path engine code**: `server/blockchain/cctp-*.ts`, `cctp-forwarding-fee.ts`, `arc-provider.ts`, `server/lib/money.ts|fees.ts|production-config.ts`, `server/webhooks/delivery.ts`, `server/workers/reconciliation.ts`, `src/cctp-checkout.ts` — verified by 711 tests + real E2E; the audit found zero defects (C5 is a disclosure nit above the state machine, not a state-machine change).
- `server/db/networks.ts` + `server/db/cctp.ts` — internally consistent and consistent with every public table; no auto-enable rule.
- `src/sdk/*` + `vite.sdk.config.ts` — correctly architecture-neutral; must NOT gain CCTP logic.
- The three authority docs — current by construction; product audit findings do not contradict them.
- Dashboard pages, Receipt/PayLink pages, App routes — accurate.
- Historical phase reports (`phaseL/phaseM/UAT/MASTER/security-review/…`) — dated evidence trail; supersede by annotation only if ever needed.
- Network/chain-ID/address tables everywhere — verified consistent; no change.

## 23. Breaking Changes

**None identified among required changes.** C5 is additive within the existing `fees` object shape; C4/C2–C3 are disclosure/copy; docs corrections cannot break integrations. The upgrade itself (cross_chain opt-in) is additive: same-chain behavior byte-identical (verified by baseline tests). Only a hypothetical SDK npm-publish (C18) would create a new-semver surface decision — not required now.

## 24. Production Blockers (genuine ones only — unchanged by this audit)

1. D-1 executor sign-off (written approval of Option C) + Circle **mainnet** forwarding entitlement — `CCTP_EXECUTOR_DECISION_BRIEF.md` §15.
2. Production hosting decision + provisioning (D-3, readiness audit Step-2 report).
3. Real production secrets generation + injection (E list, never in repo).
4. Dedicated mainnet RPCs for 10 networks + validator 13/13 (F list).
5. External webhook staging verification (Runbook §7.1) — still never exercised against a live endpoint.
6. DNS/TLS + hostname decision; monitoring/on-call (D-6/D-7); final smoke §13 + flip `ENABLE_LIVE_PAYMENTS=true` last.
This audit adds **no new blockers** — but C1–C5 become blockers **specifically for publicly promoting cross-chain** (the site would otherwise advertise capability with wrong fee semantics).

## 25. Human Decisions

- D-1 sign-off (unchanged). D-2/D-3/D-5/D-6/D-7 (unchanged, infra).
- **New (this audit):** (a) License: add MIT LICENSE file vs withdraw MIT claim; (b) promote cross-chain publicly NOW (fix copy + redeploy) or hold website story until mainnet entitlement — recommend **hold public cross-chain marketing until entitlement, fix fee copy immediately regardless** (wrong money-path claims must not persist even in the same-chain narrative); (c) OpenAPI: generate a real spec vs drop the claim; (d) package identity rename/publish decision.

> **Dated update (2026-10-08) — two of these decisions are now closed, and one recommendation
> is overtaken by events.** This audit's rows and recommendations above are preserved exactly
> as written on 2026-10-06; they are a snapshot, not the current state.
>
> - **(a) License — decided: MIT.** A standard MIT `LICENSE` file now exists at the repository
>   root and `package.json` carries `"license": "MIT"`. The pre-existing "Open source — MIT
>   License" product copy is therefore **backed** rather than withdrawn, and `README.md` now
>   cites the license explicitly. The factual rows in this audit (C17: "no LICENSE file, no pkg
>   license field"; §23 tables) were accurate when written and are superseded as of this date.
> - **(b) Marketing hold — overtaken.** The recommendation to *hold public cross-chain
>   marketing until mainnet entitlement* was correct on the evidence available on 2026-10-06.
>   That premise changed: the real-money **Base Mainnet → Arc Mainnet** CCTP v2 Forwarding
>   journey completed on **2026-10-07** (`docs/PRODUCTION_GO_LIVE_READINESS.md` **§0A**), was
>   independently re-verified from public chain data and third-party explorers on
>   **2026-10-08** (**§0A-1**), and the corrected public copy is **deployed** to
>   `https://jafari.co.in`. Public promotion is now permitted **within the scope that evidence
>   supports** — that single route only, with the standing exclusions recorded in §0A/§0A-1
>   (no written D-1 sign-off, no live webhook-delivery evidence, no claim that the other six
>   registered mainnet sources work, and the UAT was funded from the project owner's own
>   wallet, not an unrelated customer).
> - **Fee-copy work (C1–C3, C6–C16) is complete and live**, so the audit's highest-integrity
>   finding — the repeated "1:1 / maxFee = 0" wording on a money path — no longer applies to
>   the deployed product. `src/checkout-fees.test.ts` U5 keeps that guarded by test.
> - **(c) OpenAPI spec and (d) package identity remain undecided**, and D-2/D-3/D-5/D-6/D-7
>   remain open infrastructure items. The "live deployment lagging HEAD" observation in §27 is
>   likewise superseded: production is aligned with the repository at the time of this update.

## 26. Recommended Upgrade Sequence

1. **Copy corrections (local, zero-risk):** C1→C3 (fee semantics — highest integrity risk), C6–C7 (docs wrong facts), C10, C12–C16.
2. **Additive disclosure work:** C5 (create-response fees) + test; C4 (checkout fee display) — both land behind existing tests, no state-machine change.
3. **Changelog + cross-chain docs:** C8, C9.
4. **Decisions:** C11, C17, C18, marketing-hold choice (25b).
5. **Redeploy (C19)** — after 1–3; this alone also fixes the live-vs-repo drift.
6. Production go-live track (Step-2 report order J: infra → secrets → RPC → webhook staging → monitoring → D-1 → smoke → flag flip).
7. Nice-to-haves whenever: C20, C21.

## 27. Final Verdict

The engineering upgrade is real, verified, and already checkpointed; **the product's own words have not fully absorbed it**. The highest-integrity issue is the triply-repeated "1:1 / maxFee = 0" claim, which now contradicts the implemented forwarding-fee design and sits on a money path customers pay against — it must be corrected before any cross-chain promotion, ideally immediately. The live deployment lagging HEAD means most repo-side fixes are invisible until a redeploy. No behavior, architecture, or state-machine change is recommended anywhere in this audit; the entire required program is copy/docs correction, additive fee disclosure, docs API-truth, one legal decision, and a redeploy.

---

### PRODUCT STATUS

Works and is publicly presented honestly: 10-mainnet same-chain USDC payments (intent → checkout → on-chain verification → direct settlement), payment links, receipts (+email pipeline), dashboard (keys, wallets, webhooks, ledger), SIWE auth, signed webhooks with W1–W26-verified engine, served SDK at `/sdk.js`, reconciliation. All verified at HEAD (711 tests, clean typecheck/build).

### RECENT UPGRADE STATUS

Implemented + testnet-E2E-verified but only half-communicated: CCTP v2 cross-chain to Arc, Circle **Forwarding** (server-quoted fee F, gross burn M+F, merchant exactly M, forwardTxHash observation, Standard-2000 gate), Brevo SMTP, production-config fail-closed validator, webhook hardening + 2 subscribable cross_chain events, dashboard cross-chain timeline. Repo authority docs fully current; public surfaces are not.

### WEBSITE CHANGES

Fee-copy corrections are already in repo components (RoadmapPage); after fixes: redeploy. Add cross-chain capability story only when D-1 + Circle mainnet entitlement allow public promotion (recommended hold). Fix `payment_intents` underscore, "OpenAPI reference" claim, "Built on Arc/on Arc" framing, "LIVE" chip on mock showcase.

### README CHANGES

L44 fee rewrite; events list; env table (ENC key + EMAIL + RPC-proxy names); test-suite sentence; L150 stale SDK caveat removal; license line matched to decision.

### DOCUMENTATION CHANGES

DocsPage: networks §cross-chain fee paragraph rewrite (C2); API Reference → real surface + remove phantom /v1 management endpoints + openapi claim (C6); Security bcrypt→HMAC-SHA256 (C7); checkout/intents pages document `cross_chain` + `fees` (C8); Changelog entries (C9); receipts transport sentence (C); footer framing.

### SDK CHANGES

None required — deliberately architecture-neutral. Open decisions only: package identity/publish posture (C18) and optional future webhook-verification helper (C-class, not now).

### API CHANGES

One additive change: create-response `fees` must reflect the just-applied forwarding quote instead of hardcoded `0` (C5). No removals, no behavior change, no breaking fields.

### BACKEND CHANGES

None beyond C5. Engine, verifier, worker, webhook, email, production-config: audit found no defects; explicitly do-not-touch list (§22).

### NO-CHANGE AREAS

All money-path code; network/CCTP registries; SDK; dashboard/checkout logic; authority docs; historical reports; network tables everywhere (verified consistent); same-chain product story (verified accurate).

### PRODUCTION BLOCKERS

D-1 sign-off + Circle mainnet entitlement · hosting (D-3) · production secrets · dedicated RPCs ×10 + validator · external webhook staging verification · DNS/TLS + hostname · monitoring/on-call · final smoke + flag flip. (Plus: fee-copy correction becomes a gate for *public cross-chain promotion*.)

### HUMAN DECISIONS

D-1 · D-2/3/5/6/7 · **new:** license (MIT file vs claim) · public cross-chain marketing timing (recommend: fix copy now, market after entitlement) · OpenAPI generate-vs-drop · package rename/publish posture.

### IMPLEMENTATION ORDER

1) fee + facts copy (C1–C3, C6–C7, C10, C12–C16) → 2) additive disclosures (C5 + test, C4) → 3) changelog + cross-chain docs (C8–C9) → 4) decisions (C11/C17/C18/marketing-hold) → 5) redeploy (C19) → 6) infra go-live sequence (Phase 21 Step-2 audit, order J) → 7) nice-to-haves (C20–C21).

### SINGLE NEXT STEP

**Correct the three "1:1 / maxFee = 0" fee statements (README L44, DocsPage networks §cross-chain, RoadmapPage card) to the verified Forwarding economics (customer pays M + quoted F; merchant receives exactly M; DIRECT fallback when no quote)** — the only finding where the product's public words contradict a verified money path.
