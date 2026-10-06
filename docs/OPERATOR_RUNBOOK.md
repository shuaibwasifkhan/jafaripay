# JafariPay — Production Operator Runbook

**Purpose:** Step-by-step operational procedure to execute Phase 21 (production go-live) **after** the accountable business owner has approved the required decisions and DevOps/SRE has provisioned the external infrastructure.

**Audience:** DevOps / SRE / on-call operator.

**Non-goal:** This runbook **does not make any human/business decisions itself**. It records the outcome of decisions as the accountable owner approves them (see Section 2). As of this update, **decision D-4 (Email provider) has been approved, implemented, and live-verified (Brevo SMTP)**; that decision is recorded here so operators do not re-litigate it. **D-1 (CCTP executor model) remains formally UNAPPROVED**, but the repository now contains complete implementation + live testnet evidence supporting **Option C — Circle Forwarding** (see Section 9 and `docs/PRODUCTION_GO_LIVE_READINESS.md` §0). All other Phase 21 decisions (hosting provider, network activation scope, data-retention policy, monitoring stack, incident ownership) remain OPEN. This runbook documents WHAT must be done, WHO must do it, WHERE it is configured, HOW to verify it, WHAT evidence to capture, and WHAT blocks the process.

**Companion documents:**

- `docs/PRODUCTION_GO_LIVE_READINESS.md` — authoritative Phase 21 readiness checklist and status of every subsystem (engineering-complete vs. operationally pending).
- `docs/DEPLOYMENT.md` — historical Arc Testnet single-VPS deployment procedure.
- `docs/MASTER-PHASE-FINAL-REPORT.md` — cumulative engineering phase record (Phases 0–20).
- `docs/phaseM-production-readiness-report.md` — earlier operational readiness snapshot (historical).
- `AGENTS.md` — repository conventions.

> **CRITICAL:** ENGINEERING VERIFIED ≠ PRODUCTION LIVE.
> Phases 16–20 are verified at code level. Phase 21 is an **operational** milestone requiring human decisions and infrastructure provisioning that this repository does not perform.

---

## Section 1 — Current Baseline (as of Phase 21C closure, 2026-10-06)

**Verified engineering state:**

| Metric | Value |
|--------|-------|
| Test suite | 711 pass / 0 fail / 4785 expect() / 41 files |
| Typecheck | EXIT = 0 |
| Frontend + SDK build | PASS |
| Lint (oxlint) | clean |
| Phase 16 — Base Sepolia → Arc Testnet CCTP V2 E2E | VERIFIED |
| Phase 17 — same-chain regression | VERIFIED |
| Phase 18 — cross-chain pairwise isolation | VERIFIED |
| Phase 19 — inventory completeness / staleness | VERIFIED |
| Phase 20 — 13/13 enabled-EVM live read-only validation | VERIFIED (against public/shared RPCs) |
| Phase 21C — **real application CCTP Forwarding E2E** (intent→checkout→burn→attestation→forwardTxHash→Arc mint→settlement, merchant credited exactly M, exactly-one-burn, idempotent) | **VERIFIED PASS** — evidence in `docs/PRODUCTION_GO_LIVE_READINESS.md` §0 |
| Production boot config validator (`server/lib/production-config.ts`, PC1–PC15) | IMPLEMENTED (fail-closed) |
| Phase 21A — Production Operational Preflight | COMPLETE (documentation-only) |
| Product documentation / WebApp cross-chain alignment | ALIGNED |

**Currently enabled production-candidate set:** 13 EVM networks (Section 4 lists them with chain IDs and RPC endpoints).

**Currently disabled:** 12 VERIFIED_NOT_ENABLED + 3 SPECIAL_HANDLING + 2 BLOCKED_NO_SOURCE + 11 BLOCKED_NON_EVM.

**Phase 21 status:** **OPERATIONALLY BLOCKED** — pending human/business decisions (executor model, providers) and infrastructure provisioning (hosting, RPCs, secrets, database).

**No Phase 22+ is defined.**

---

## Section 2 — Go-Live Decision Gate

**DO NOT proceed until the accountable owner has explicitly approved each of the following decisions in writing.**

| # | Decision | Options | Owner | Status |
|---|----------|---------|-------|--------|
| D-1 | **CCTP executor model** | A: JafariPay-operated relayer · B: Merchant self-execution · C: Circle Forwarding Service | Product / Business | **UNAPPROVED (written sign-off required)** — Option C is now IMPLEMENTED + TESTNET-VERIFIED (Section 9, readiness pack §0); Circle **mainnet** account entitlement confirmation also required before production |
| D-2 | **Production network scope** | (a) Arc-only same-chain minimal launch, or (b) full 13 ENABLED multi-chain + cross-chain | Product / Compliance | UNAPPROVED |
| D-3 | **Hosting provider** | Cloud/VPS/bare-metal — provider not named in this repo | Business / DevOps | UNAPPROVED |
| D-4 | **Email provider** | **Brevo (via `smtp-relay.brevo.com:587` STARTTLS)** — approved by the project owner. Uses the existing `EmailTransport` abstraction; no new configuration system. | Business / Backend | **APPROVED + IMPLEMENTED + LIVE-TEST VERIFIED** — `EmailTransport` wired; SMTP credentials provisioned; test email delivered to `dev@jafari.co.in` inbox confirmed. Production-host outbound verification remains |
| D-5 | **Data retention & compliance policy** | What is stored, for how long, jurisdiction | Legal / Compliance | UNAPPROVED |
| D-6 | **Monitoring & alerting approach** | Vendor / self-hosted / on-call rotation | SRE / Ops lead | UNAPPROVED |
| D-7 | **Incident & rollback ownership** | Named on-call owner, escalation path | Ops lead / Business | UNAPPROVED |

The runbook is **neutral** on every option. It documents the operational consequences of each but does **not** rank them and does **not** recommend.

Only when all seven decisions above have an explicit owner sign-off may the operator begin Sections 3–11.

---

## Section 3 — Production Infrastructure

### 3.1 Hosting checklist

Provision an environment that satisfies:

- [ ] Application process (Node/Bun runtime, `bun run server/index.ts`) starts on boot and restarts on crash (systemd / pm2 / equivalent — operator choice).
- [ ] Worker process — currently embedded inside the server process (`server/workers/reconciliation.ts` runs on an interval). **Do NOT split into a separate process without explicit architectural authorization**; SQLite WAL is single-writer.
- [ ] Persistent filesystem mount at the directory that will hold `DATABASE_URL` (must survive restarts).
- [ ] Outbound HTTPS allowed to: 13 EVM RPC hosts (Section 4), Circle CCTP APIs (attestation + destination), merchant webhook endpoints (arbitrary HTTPS), configured email provider.
- [ ] Inbound 443 (TLS) open; 80 may redirect.
- [ ] Log rotation configured (structured `console.log`/`console.error` to stdout; process manager captures).
- [ ] Health probe (`GET /health`) reachable from external monitor.
- [ ] Restart policy that preserves the SQLite file across restarts.
- [ ] NTP synchronized (blockchain finality is time-sensitive).

### 3.2 Database checklist

- [ ] `DATABASE_URL` points at an absolute path on durable, backed-up storage (default is `./data/app.db`; override with a mounted volume).
- [ ] Directory is writable by the process user; file permissions restrict access to that user.
- [ ] Sufficient free disk (SQLite file grows monotonically; WAL may temporarily double it).
- [ ] `migrate()` runs at boot — never run destructive schema commands manually.
- [ ] **Backup:** external, scheduled snapshot of the SQLite file (e.g. `sqlite3 … .backup` or filesystem snapshot). Verify by restoring to a scratch location.
- [ ] **Restore procedure** documented and rehearsed with real data before go-live.
- [ ] Self-healing seed behaviour understood: every `migrate()` re-UPDATEs every row in `network_configs.rpc_url` from `CIRCLE_INVENTORY` — a live DB UPDATE alone is reverted on restart. Persistent RPC changes require editing `server/db/networks.ts` and redeploying.

**Never execute destructive commands manually in production.** If a rollback requires restoring the DB, use the documented procedure in Section 15.

---

## Section 4 — Production RPC Provisioning

**Authoritative source:** `server/db/networks.ts` `CIRCLE_INVENTORY`. This is the seed for `network_configs`; the self-healing migration rewrites the DB from it on every boot.

Currently 13 ENABLED networks. All 13 rows use the network's **curated public/shared RPC**. For production, dedicated endpoints are required for the 10 public mainnets (rate-limit + reliability).

### 4.1 Network table

| # | Slug | Chain ID | Current RPC (test / shared) | Production requirement | Proxy support (no code change) | Notes |
|---|------|---------:|-----------------------------|------------------------|-------------------------------|-------|
| 1 | `arc_mainnet` | 5042 | `https://rpc.mainnet.arc.io` | Dedicated (or Arc proxy) | YES (`PROXY_SLUGS` entry) | Destination chain for all CCTP mints |
| 2 | `arc_testnet` | 5042002 | `https://rpc.testnet.arc.io` | Keep as-is (testnet) | YES (`PROXY_SLUGS` entry) | Test only — not live money |
| 3 | `base_mainnet` | 8453 | `https://mainnet.base.org` | **Dedicated required** | NO (needs code change to add) | CCTP source + same-chain |
| 4 | `base_sepolia` | 84532 | `https://sepolia.base.org` | Keep as-is (testnet) | NO | Phase 16 E2E source |
| 5 | `arbitrum_one` | 42161 | `https://arb1.arbitrum.io/rpc` | **Dedicated required** | NO | CCTP source + same-chain |
| 6 | `arbitrum_sepolia` | 421614 | `https://sepolia-rollup.arbitrum.io/rpc` | Keep as-is (testnet) | NO | Test only |
| 7 | `polygon_pos` | 137 | `https://polygon.drpc.org` | **Dedicated required** (currently on shared dRPC) | NO | CCTP source + same-chain |
| 8 | `avalanche_c` | 43114 | `https://api.avax.network/ext/bc/C/rpc` | **Dedicated required** | NO | CCTP source + same-chain |
| 9 | `op_mainnet` | 10 | `https://mainnet.optimism.io` | **Dedicated required** | NO | CCTP source + same-chain |
| 10 | `linea` | 59144 | `https://rpc.linea.build` | **Dedicated required** | NO | CCTP source + same-chain |
| 11 | `unichain` | 130 | `https://mainnet.unichain.org` | **Dedicated required** | NO | CCTP source + same-chain |
| 12 | `zksync_era` | 324 | `https://mainnet.era.zksync.io` | **Dedicated required** | NO | Same-chain only (not a CCTP source today) |
| 13 | `celo` | 42220 | `https://forno.celo.org` | **Dedicated required** | NO | Same-chain only (not a CCTP source today) |

**Total mainnet networks requiring a dedicated production RPC: 10** (`base_mainnet`, `arbitrum_one`, `polygon_pos`, `avalanche_c`, `op_mainnet`, `linea`, `unichain`, `zksync_era`, `celo`, `arc_mainnet`). Testnets keep their public endpoints.

### 4.2 RPC provisioning procedure (operator)

1. Obtain dedicated endpoints from the chosen RPC provider (Alchemy / QuickNode / Infura / self-run node — provider is NOT named in this repo; decision D-3 or an SRE-level sub-decision).
2. For each of the 10 mainnet rows above, edit the `rpc:` field in `server/db/networks.ts` `CIRCLE_INVENTORY` **or** use a proxy that maps chain-id → endpoint (Section 4.3).
3. If using a **direct endpoint**, commit the change and redeploy. Self-healing seed rewrites the DB on next boot from the edited inventory.
4. If using a **proxy for Arc only**, set `RPC_PROXY_BASE_URL`, `RPC_PROXY_CHAINS`, `RPC_PROXY_TOKEN` in the deployment env.
5. Run `bun run scripts/phase20-live-validate.ts` (read-only) — expected 13/13 PASS against the newly configured endpoints. Any chain-id mismatch or missing bytecode is a **hard stop** (Section 17).

**Never commit real RPC-provider credentials into `server/db/networks.ts`.**

### 4.3 Proxy model

`server/blockchain/arc-provider.ts` `PROXY_SLUGS` (line 87) is currently frozen to `{ arc_testnet: 'Arc_Testnet', arc_mainnet: 'Arc' }` — **only these two slugs can route through a shared proxy without a code change**.

For non-Arc networks the operator must either:
- Use a direct URL (Section 4.2 step 1–3), or
- Explicitly authorize adding non-Arc entries to `PROXY_SLUGS` (a code change requiring its own review; not part of this runbook).

When the proxy is enabled, `RPC_PROXY_TOKEN` is interpolated into the URL (line 117). Operators **must** ensure the proxy and any intervening load balancer / log shipper redact the URL query string; otherwise the token leaks to logs.

### 4.4 Chain identity verification

Every read path in `arc-provider.ts` invokes `ensureChainIdMatches()` (line 250) before a receipt/head/finality call. This is a fail-closed guard — if a provider returns a different chain id than the row expects, it THROWS and the request fails as retryable 503.

**Verification steps after provisioning:**

- [ ] `GET` the RPC endpoint's `eth_chainId` — must equal the chain id in Section 4.1.
- [ ] Confirm `USDC` token contract bytecode at the pinned address on each network (`phase20-live-validate.ts` performs this read-only check).
- [ ] Confirm no intermediate proxy silently rewrites chain id.

---

## Section 5 — Production Secrets

**Authoritative list** (`server/lib/production-config.ts` `REQUIRED_PRODUCTION_SECRETS`, enforced by the boot gate in `server/index.ts`):

| Secret | Purpose | Min length | Boot guard enforces |
|--------|---------|-----------:|---------------------|
| `SESSION_SECRET` | Session token signing | 16 | YES — exit(1) if missing/short |
| `API_KEY_HMAC_SECRET` | API-key lookup HMAC | 16 | YES |
| `WEBHOOK_HMAC_SECRET` | Webhook identity HMAC | 16 | YES |
| `WEBHOOK_SIGNING_ENC_KEY` | AES-256-GCM at-rest key for per-endpoint webhook signing secrets | 16 | YES |

Optional (conditional):

| Secret | When required |
|--------|---------------|
| `RPC_PROXY_TOKEN` | Only if the proxy model is used (`RPC_PROXY_BASE_URL` set). Fails closed if proxy is enabled but token is missing. |
| Brevo SMTP credentials (login + SMTP key) | Required for the D-4-approved Brevo `EmailTransport`. Env var names: `EMAIL_BREVO_SMTP_LOGIN`, `EMAIL_BREVO_SMTP_KEY`, `EMAIL_FROM`. Store in the secrets manager. **Never commit. Never log. Never paste into chat/tickets.** Provisioned externally by the project owner; local test passed. |

### 5.1 Provisioning procedure

1. **Generate externally** using an operator-approved secure mechanism (e.g. `openssl rand -base64 48`, hardware RNG, or a cloud secrets manager's built-in generator). Recommended length: **≥ 32 characters** even though the boot guard's minimum is 16.
2. **Store in the secrets manager** (AWS Secrets Manager / GCP Secret Manager / Vault / operator choice — NOT committed to the repository).
3. **Inject into the deployment environment** at process start (env file from an untracked location, systemd `EnvironmentFile=`, container env-from-secret, etc.).
4. **Never** commit `.env` — `.gitignore` line 2 already enforces this.
5. **Never** paste real values into chat, tickets, screenshots, or bug reports.
6. **Never** log secret values; only names may appear in error messages (`index.ts` guard logs names only).
7. `WEBHOOK_SIGNING_ENC_KEY` **must be stable across restarts**. Changing it makes existing per-endpoint ciphertexts undecryptable — those webhook endpoints will fail closed until the merchant re-submits their signing secret. Treat this key as long-lived and version-controlled in the secrets manager.
8. `SESSION_SECRET`, `API_KEY_HMAC_SECRET`, `WEBHOOK_HMAC_SECRET` may be rotated with an application restart; coordinate any rotation with active sessions and merchant webhook endpoints.

### 5.2 Verification (post-provisioning)

- [ ] Boot with `NODE_ENV=production` and no secrets set → server exits with code 1 and prints the missing variable names.
- [ ] Boot with all 4 set to ≥ 32 random chars → server starts, `GET /health` returns `{ ok: true }`.
- [ ] Boot with all 4 set to < 16 chars → server exits with code 1 and reports which are below the minimum.
- [ ] Boot with the full valid production env → `validateProductionConfig` passes (no findings). Also confirm it REJECTS: `ALLOWED_ORIGINS` with http/localhost entries, missing/non-https `CHECKOUT_BASE_URL`, half-wired Brevo credentials, `RPC_PROXY_BASE_URL` without token, `E2E_SOURCE_PK`/`E2E_RELAYER_PK` present, and `ENABLE_LIVE_PAYMENTS` set to anything other than exactly `true`/`false`/unset. Unit-covered by `server/production-config.test.ts` (PC1–PC15); the guard prints NAMES only — secret values never appear in output.

**This runbook does NOT generate any real secret values.**

---

## Section 6 — Domain / TLS

- [ ] Choose the public domain (this repository's `.env.example` currently uses `jafari.co.in` as a placeholder — the operator confirms the real domain per decision D-3).
- [ ] Configure DNS `A` / `AAAA` records for the API host.
- [ ] Issue TLS certificate (Let's Encrypt / ACM / GCP managed certs / operator choice).
- [ ] Certificate auto-renewal configured and verified (renewal dry-run).
- [ ] Set env vars to the real domain:
  - `JAFARIPAY_DOMAIN=` (used in SIWE message domain)
  - `CHECKOUT_BASE_URL=` (used in checkout links handed to merchants)
  - `ALLOWED_ORIGINS=` (comma-separated CORS allowlist; must include every origin that legitimately calls the API)
- [ ] Verify HTTPS is enforced (no plain HTTP for API or checkout pages).
- [ ] Verify `GET /health` returns HTTP 200 with `{ ok: true }` from an **external** probe (not just from localhost).
- [ ] Verify `GET /health` reports the correct `env` value (`production`).

**No DNS or deployment action is performed by this repository.**

---

## Section 7 — Webhook Production Setup

**Code status: COMPLETE and tested.** Verified properties:

- **Algorithm:** HMAC-SHA256 over `${timestamp}.${rawBody}`.
- **Header format:** `X-JafariPay-Signature: t=<unix_seconds>,v1=<hex_signature>`.
- **Verification max-age:** 300 seconds (5 minutes) — stale deliveries rejected by the receiving endpoint.
- **Delivery timeout:** 10 seconds per attempt (`AbortController`).
- **Retry schedule:** 8 attempts total with back-off `[10, 30, 120, 300, 1800, 7200, 28800]` seconds.
- **Idempotency:** each delivery carries a stable event id; receivers must dedupe.
- **At-rest encryption:** per-endpoint signing secrets stored AES-256-GCM encrypted (`server/lib/crypto.ts`, ciphertext prefix `v1.`).
- **SSRF protection:** private / loopback / link-local / cloud-metadata destination URLs rejected at endpoint-registration time.
- **Local test matrix:** W1–W26 (`server/webhook-security.test.ts`) — signing/verification, replay window, rotation, legacy fail-closed, merchant isolation, secret-never-logged, and full retry-ladder exhaustion (W26). **External delivery to a live merchant endpoint has NOT been exercised in production or in the Phase 21C application E2E** — the E2E merchant had zero webhook endpoints, so no external POST left the system. Section 7.1 staging verification below is therefore a REQUIRED go-live gate, not a formality.
- **Cross-chain events emitted:** `payment.cross_chain.attestation_received` and `payment.cross_chain.failed`, in addition to `payment.succeeded` / `.expired` / `.failed` / `.processing` / `.created`.

**Production configuration remaining:** set `WEBHOOK_HMAC_SECRET` and `WEBHOOK_SIGNING_ENC_KEY` per Section 5.

### 7.1 Operator verification procedure (test environment only, no real money)

1. Register a merchant webhook endpoint on a **staging** JafariPay instance.
2. Trigger a test payment.
3. Capture the delivered request. Verify:
   - Signature header format matches `t=,v1=`.
   - Recomputed HMAC matches the delivered signature using the endpoint's shared secret.
   - Timestamp is within 300 seconds of receipt.
4. Simulate a failure on the receiving server and observe the retry ladder (10s → 30s → 2m → 5m → 30m → 2h → 8h → 8h).
5. Confirm no signing secret appears in server logs (`grep` stdout for the plaintext value).

**Do NOT send a real production webhook during preflight.**

---

## Section 8 — Email

**Code status: IMPLEMENTED AND LIVE-TEST VERIFIED (D-4: Brevo SMTP via `smtp-relay.brevo.com:587` STARTTLS).**

`server/email/transport.ts` ships three transports — `dev` (in-memory sink, default when `EMAIL_TRANSPORT` is unset), `none` (explicit no-op), and `brevo_smtp` (production; D-4). Any unknown `EMAIL_TRANSPORT` value falls through to `dev`. This abstraction is unchanged and remains the sole integration point for email providers.

### 8.1 Provider DECISION — APPROVED (D-4: Brevo via SMTP relay)

The project owner has approved **Brevo** as the transactional email provider, reached over **SMTP relay** using the existing `EmailTransport` abstraction. No new provider architecture or configuration system will be introduced.

**Approved operational facts (external to this repository):**

| Item | Value / Status |
|------|----------------|
| Provider | **Brevo** |
| Transport | SMTP relay |
| SMTP server | `smtp-relay.brevo.com` |
| SMTP port | `587` (STARTTLS submission) |
| Brevo account | Created |
| Brevo-authenticated sending domain | `jafari.co.in` |
| Branded subdomain | `mail.jafari.co.in` — authenticated/branded in Brevo |
| JafariPay sender | Added in Brevo |
| SMTP login + SMTP key | Provisioned by the project owner — injected into runtime env via secrets manager — **never stored in this repository** |
| Verified sender | `noreply@jafari.co.in` |
| Zoho mailbox `dev@jafari.co.in` | **Unchanged.** Remains as-is |
| Zoho MX / SPF / DKIM records | **MUST REMAIN INTACT.** Brevo branding uses `mail.jafari.co.in` as a delegated subdomain; the apex domain's mail routing stays on Zoho |

**Steps completed:**

| # | Step | Status |
|---|------|--------|
| 8.1.1 | Receive the Brevo SMTP login + key from the project owner via the approved secure channel | **DONE** |
| 8.1.2 | Store the SMTP credentials as secrets-manager entries and inject them into the deployment env at process start | **DONE (local)** — production env injection pending hosting provisioning |
| 8.1.3 | Implement `EmailTransport` for Brevo SMTP (`server/email/brevo-smtp.ts` + `server/email/smtp-client.ts`). Registered behind `EMAIL_TRANSPORT=brevo_smtp`. No caller modified. | **DONE** |
| 8.1.4 | Confirm the sender address (`noreply@jafari.co.in`) matches the JafariPay sender approved in Brevo | **DONE** |

**Remaining production-deployment steps:**

| # | Step | Owner | Notes |
|---|------|-------|-------|
| 8.1.5 | Verify outbound connectivity to `smtp-relay.brevo.com:587` from the PRODUCTION network (STARTTLS handshake succeeds; not blocked by egress firewall) | SRE | Validated locally; requires confirmation on the production host |
| 8.1.6 | Verify a real receipt email lands in an external test inbox; check headers for the Brevo-authenticated domain and `mail.jafari.co.in` branding | QA | **DONE (local)** — test email to `dev@jafari.co.in` visibly received in Zoho inbox via subject `[JafariPay SMTP TEST] Brevo delivery verification` |
| 8.1.7 | Verify **failure behaviour**: force an SMTP error (bad credentials / blocked port) and confirm `send()` returns `{ ok: false }`, the receipt is recorded as pending, and payment status remains `succeeded` — never blocks money | QA | Contract documented at `server/email/transport.ts` lines 9–16; unit-tested in `brevo-smtp.test.ts` B12–B15 |
| 8.1.8 | Verify Zoho mail flow (`dev@jafari.co.in`) still delivers correctly after Brevo branding; the Zoho MX / SPF / DKIM records remain authoritative for inbound and legacy outbound mail | SRE / Domain owner | **CONFIRMED** — Zoho inbox received the test email; no MX/DNS was modified |

### 8.2 What was done

- Brevo SMTP `EmailTransport` implemented (`server/email/brevo-smtp.ts` + `server/email/smtp-client.ts`).
- Registered behind `EMAIL_TRANSPORT=brevo_smtp` in the existing single-switch selection.
- 23 focused unit tests added; no real socket opened in tests.
- `.env.example` updated with placeholder credential names (no secrets).
- Live SMTP test performed: one email sent `noreply@jafari.co.in` → `dev@jafari.co.in`; Zoho inbox delivery confirmed.
- No new settings or configuration system was added.
- No real SMTP credentials were placed in the repository.
- No DNS or Zoho configuration was changed.
- No payment or receipt caller was modified.

Email remains an **announcement only**. **Receipt email delivery failure NEVER blocks payment success.** The existing abstraction, receipts table, and worker retry semantics stay unchanged.

---

## Section 9 — CCTP Executor

**Architecture (verified in the repository):**

- `server/db/cctp.ts` sets `destination_caller_bytes32 = bytes32(0)` — the payload is **executor-agnostic** (for plain `depositForBurn`; with Forwarding the hook blob pins the Circle relayer path — see below).
- `server/blockchain/cctp-destination.ts` **builds** the `receiveMessage(bytes,bytes)` calldata but **does not sign or broadcast**.
- `server/workers/reconciliation.ts` passively **observes** the Arc destination; it credits the merchant only after a real Arc `Transfer` event is confirmed by the pinned USDC contract.
- **Option C is implemented and verified:** `server/blockchain/cctp-forwarding-fee.ts` quotes the Forwarding fee F live from Circle (fail-closed: no quote → no intent), checkout burns `M + F` via `depositForBurnWithHook` with the 24-byte `cctp-forward` v0 hook, and the corrected Forwarding attestation + `forwardTxHash` observation path settled a real Base Sepolia → Arc Testnet payment end-to-end (`docs/PRODUCTION_GO_LIVE_READINESS.md` §0).

**Models A/B remain architecturally possible without modifying the registry, schema, or observation pipeline.** What differs is who signs and broadcasts the destination transaction and who funds Arc-native gas.

### 9.1 Model requirements (factual, non-ranked)

| Aspect | A — JafariPay-operated relayer | B — Merchant self-execution | C — Circle Forwarding Service |
|--------|-------------------------------|------------------------------|-------------------------------|
| Who signs `receiveMessage` on Arc | JafariPay (hot wallet) | Merchant (their own wallet) | Circle infrastructure |
| Who pays Arc-native gas | JafariPay | Merchant | Covered by Circle forwarding fee |
| Wallet provisioning | JafariPay must create and fund an Arc wallet; private key stored in KMS/HSM | Each merchant must hold an Arc wallet | None required |
| Key custody | JafariPay (adds custody responsibility) | Merchant (self-custody preserved) | Circle |
| Gas funding operation | JafariPay must maintain Arc-native balance and top up | Merchant tops up their own wallet | Circle absorbs into service fee |
| Monitoring responsibility | JafariPay must continuously watch attestation availability + destination broadcast success | Merchant watches or relies on a JafariPay-provided dashboard + notification | Circle handles; JafariPay depends on Circle SLA |
| Integration dependency | Add a new signing + broadcast module inside the reconciliation worker (or a companion process). **This is a code change.** | Zero code change — the built calldata is already exposed via the payment-intent API response; merchant submits it | Zero code change on the destination — registration happens on the source burn (Forwarding is specified in the source `depositForBurn` call) |
| Operational ownership | JafariPay Ops owns uptime, key security, gas funding | Merchant Ops owns execution timing | Circle Ops owns delivery; JafariPay monitors for gaps |
| Failure mode | If JafariPay's relayer is down, merchants see "attested but not minted" until restored | If merchant never executes, funds remain burnable by them indefinitely (attestation window governs) | Circle outage delays settlement |
| Regulatory consideration | Hot-wallet custody of a live signing key | Merchant retains full self-custody | Circle operates as relay service |
| Cost model | JafariPay absorbs Arc gas per settlement | Merchant absorbs Arc gas per settlement | Circle charges a forwarding fee |
| Current repo state | **NOT IMPLEMENTED** | **READY** — calldata already built and exposed | **IMPLEMENTED + TESTNET-VERIFIED** — full Forwarding pipeline (`depositForBurnWithHook` + fee quote + attestation + settlement) passed a real Base Sepolia → Arc Testnet application E2E; merchant credited exactly M, gross burn M+F, exactly-one-burn, idempotent |

### 9.2 Post-decision operator steps

**Once D-1 (executor model) is approved**, follow only the corresponding row:

- **If Option A selected:**
  - Provision Arc hot wallet in an approved KMS (human/security approval required).
  - Fund wallet with Arc-native gas (finance approval + non-trivial amount).
  - Add a signing module (this is a **code change** — engineering approval, security review).
  - Deploy a new watcher that submits `receiveMessage` after attestation is available.
  - Configure gas balance alerts.
- **If Option B selected:**
  - Expose the built calldata + attestation bytes through the merchant API / dashboard (already available).
  - Document the merchant's procedure for executing on Arc.
  - Add a dashboard view showing "attested but not yet minted" as a distinct pending state (may require small UI change).
- **If Option C selected:**
  - **Engineering is DONE** — the source-side burn already specifies Circle Forwarding via `depositForBurnWithHook` + the `cctp-forward` v0 hook blob, with per-intent fee F quoted live from Circle (see Section 9 architecture + readiness pack §0).
  - No wallet, no key, no gas on JafariPay's side.
  - Confirm the Circle **mainnet** account/project is entitled for Forwarding on the chosen source→destination pair (testnet success does NOT prove production entitlement — verify against current Circle docs/console; `[Account Verification Required]`).
  - Configure any Circle-required production credentials/endpoints for the fee-quote + attestation APIs (Standard finality, 2000 threshold).
  - Document the fee model (merchant pays M, gross burn M+F, F from Circle quote) in merchant-facing pricing.

**This runbook does NOT select any option.** Selecting one is a human/business decision.

---

## Section 10 — Network Activation

**Current production candidate set: 13 IMPLEMENTED_ENABLED networks** (Section 4.1).

**DO NOT activate VERIFIED_NOT_ENABLED networks without explicit per-network authorization.**

There are 12 networks in the `VERIFIED_NOT_ENABLED` status. Examples include Ethereum mainnet (currently ENS-only per the repository's classification) and other Circle-native networks. Activation of any of these is decision **D-2 extension** and requires per-network written approval.

### 10.1 Verification for the current 13 (already authorized)

- [ ] `bun run scripts/phase20-live-validate.ts` reports 13/13 PASS against the configured (production) RPCs.
- [ ] Each chain id matches Section 4.1.
- [ ] Each USDC token address matches `CIRCLE_INVENTORY.nativeUsdc`.
- [ ] Each network's status is `IMPLEMENTED_ENABLED` (unchanged from before this preflight).

### 10.2 Procedure for adding a NEW network (only after written authorization)

For **each** new network, require:

1. **Written approval** from product + compliance naming the specific network slug.
2. **RPC provisioned** — dedicated endpoint, credentials stored in secrets manager.
3. **Chain identity verified** — `eth_chainId` on the endpoint matches the expected chain id.
4. **Token identity verified** — pinned USDC contract address + bytecode on-chain.
5. **Phase 20-style validation** — the network passes the read-only validation.
6. **CCTP source eligibility** — if intended as a cross-chain source, verify the Circle TokenMessenger and MessageTransmitter addresses for that chain against Circle's official CCTP docs (`https://developers.circle.com/cctp`) and add the corresponding `CCTP_REGISTRY` entry. If intended as Arc-destination-only source, also add a `CCTP_REGISTRY` row.
7. **Registry change** — flip `status` from `VERIFIED_NOT_ENABLED` to `IMPLEMENTED_ENABLED` in `server/db/networks.ts`. If Arc-proxy is desired, add the slug to `PROXY_SLUGS`.
8. **Regression** — full test suite stays green; new inventory-driven tests automatically cover the added network.
9. **Rollback plan** — if the network misbehaves, revert the status change and redeploy (self-healing seed will re-UPDATE the DB accordingly on next boot).

**Never** flip multiple network statuses in a batch. One network, one review, one rollback plan.

---

## Section 11 — Pre-Go-Live Checklist

Every checkbox requires attached evidence. No checkbox may be marked complete without proof.

```
[ ] Section 2 decisions D-1 through D-7 all have explicit written owner approval
[ ] Executor model selected (D-1) and named in the go-live ticket
[ ] Production network scope approved (D-2)
[ ] Hosting provider selected (D-3) and infrastructure provisioned
[ ] Email provider DECIDED + IMPLEMENTED (D-4 = Brevo SMTP via smtp-relay.brevo.com:587) — see Section 8
[ ] Brevo SMTP credentials stored in the secrets manager (never committed, never logged)
[ ] Brevo SMTP `EmailTransport` implemented and registered behind `EMAIL_TRANSPORT=brevo_smtp` (Section 8 steps 8.1.1–8.1.4 DONE; 8.1.5–8.1.7 remain for production host)
[ ] Data retention / compliance policy documented (D-5)
[ ] Monitoring / alerting stack operational (D-6)
[ ] Incident / rollback owner assigned (D-7)
[ ] DATABASE_URL points at durable, backed-up storage
[ ] Database backup taken + restore rehearsed on a scratch machine
[ ] Filesystem permissions verified (process user can read/write; other users cannot)
[ ] 10 mainnet networks have dedicated production RPCs provisioned
[ ] Arc proxy OR direct RPC chosen and configured for arc_mainnet
[ ] `phase20-live-validate.ts` reports 13/13 PASS against production RPCs
[ ] Chain-id verification passes for every network on its production endpoint
[ ] All 4 production secrets generated externally (>= 32 chars each), stored in secrets manager
[ ] Secrets injected into deployment env; boot guard passes
[ ] Domain configured (JAFARIPAY_DOMAIN, CHECKOUT_BASE_URL, ALLOWED_ORIGINS)
[ ] TLS certificate issued + auto-renewal verified
[ ] GET /health returns ok=true from external probe over HTTPS
[ ] Webhook signing verified end-to-end in staging (signature matches, max-age enforced, retry ladder observed) — NOT yet done: the Phase 21C application E2E had 0 merchant webhook endpoints, so external delivery remains unexercised
[ ] Webhook SSRF validation verified (private-IP endpoint rejected)
[ ] Email transport set (`EMAIL_TRANSPORT=brevo_smtp` after implementation, or `none` during an interim launch that consciously defers receipt delivery)
[ ] Monitoring alerts configured for /health, worker liveness, RPC failures, webhook failure rate
[ ] On-call rotation established and paging tested
[ ] Rollback procedure rehearsed at least once in staging
[ ] Final regression green:
    [ ] bun test → 711 pass / 0 fail
    [ ] bun run typecheck → EXIT = 0
    [ ] bun run build → PASS
    [ ] Phase 17 gate — PASS
    [ ] Phase 18 gate — PASS
    [ ] Phase 19 gate — PASS
    [ ] Phase 20 live validation — 13/13 PASS
[ ] Evidence packet compiled per Section 14
[ ] Go-live authorization signed by accountable owner (Section 18)
```

---

## Section 12 — Final Regression

**Immediately before any go-live action** (deployment, `ENABLE_LIVE_PAYMENTS=true`, smoke test), re-run:

```bash
bun test
bun run typecheck
bun run build
```

Expected output:

```
711 pass
0 fail
4785 expect() calls
Ran 711 tests across 41 files.
```

```
typecheck EXIT = 0
```

```
✓ frontend built
✓ SDK built
```

Also confirm phase gates:

- Phase 17 — `server/cctp17-samechain-regression.test.ts` — same-chain regression
- Phase 18 — `server/phase6-multichain-matrix.test.ts` — cross-chain pairwise isolation
- Phase 19 — `server/phase6-multichain-matrix.test.ts` — inventory completeness / staleness
- Phase 20 — `scripts/phase20-live-validate.ts` — 13/13 EVM read-only validation (network-touching)

**Do not run mainnet transactions as part of regression.** Tests must be self-contained against in-memory / temp-file SQLite.

If any regression fails, stop go-live. Investigate and resolve before proceeding.

---

## Section 13 — Controlled Smoke Test (DOCUMENTED, NOT EXECUTED)

The smoke test is performed **only after** every Section 11 checkbox is green **and** the accountable owner has signed off go-live authorization.

Two smoke tests are defined:

### 13.A — Same-chain Arc Mainnet test

- **Preflight:** Arc mainnet RPC reachable; `arc_mainnet` chain-id (5042) verified; merchant account exists with a pinned Arc USDC address; `ENABLE_LIVE_PAYMENTS=true`.
- **Test amount:** 1 USDC (minimal).
- **Payment intent:** create via merchant API with `network=arc_mainnet`.
- **Source transaction:** customer pays 1 USDC to the merchant's Arc address on Arc mainnet.
- **Chain confirmation:** worker observes the Transfer event; finality gate satisfied per Arc's configured mode.
- **Merchant credit:** intent transitions to `succeeded` with correct amount.
- **Webhook:** merchant endpoint receives `payment.succeeded` with valid signature.
- **Receipt:** customer email or `EMAIL_TRANSPORT=none` skip recorded per current configuration.
- **Reconciliation:** reconciliation worker marks intent settled; ledger balances.
- **Evidence:** intent id, tx hash, block number, webhook delivery log excerpt, DB row snapshot.
- **Rollback / incident:** if any step fails, revert `ENABLE_LIVE_PAYMENTS=false` and follow Section 15.

### 13.B — Cross-chain Base → Arc CCTP test

- **Preflight:** All Section 11 checkboxes green; **executor model D-1 already selected and implemented**; source and destination CCTP contract addresses verified against `https://developers.circle.com/cctp`; Base mainnet and Arc mainnet both have dedicated production RPCs. **If D-1 = Option C (Circle Forwarding):** confirm Circle mainnet Forwarding entitlement for the pair first (Section 9.2); the burn then goes out as `depositForBurnWithHook` with gross M+F and the fee quote must succeed (fail-closed) at intent creation; expect a `forwardTxHash` observed on Arc executed by Circle's forwarder rather than a JafariPay/merchant broadcast.
- **Test amount:** 1 USDC.
- **Payment intent:** create via merchant API with `cross_chain=true, source_network=base_mainnet, destination=arc_mainnet`.
- **Source transaction:** customer executes `approve` + `depositForBurn` on Base mainnet via the checkout UI.
- **Circle attestation:** watcher polls Circle's attestation API until the message is finalized or the 1800-second attestation window expires. Rate-limit back-off `[5, 300]s` observed.
- **Destination settlement:** per selected executor model (D-1), `receiveMessage(bytes,bytes)` is submitted to Arc. **The specific operational steps depend on the chosen model — see Section 9.2.**
- **Merchant credit:** after the Arc `Transfer` event from the pinned native USDC contract confirms the mint to the merchant's pinned address, worker settles the intent.
- **Webhook:** merchant receives `payment.cross_chain.attestation_received` and later `payment.succeeded` (or `payment.cross_chain.failed` if attestation times out).
- **Receipt:** same as 13.A.
- **Reconciliation:** cross-chain journey recorded in `cctp_journeys` and reconciled against the observed Arc event.
- **Evidence:** source tx hash, attestation id, destination tx hash, Arc block number, webhook logs, DB snapshots.
- **Rollback / incident:** if the attestation cannot be obtained within the 30-minute window, the journey transitions to `cross_chain.attestation_failed` and the customer is notified per policy (decision D-5). If the destination broadcast fails per the chosen executor model, escalate per Section 16.

### 13.C — What this runbook does NOT do

- It does NOT execute either smoke test.
- It does NOT send any funds.
- It does NOT call `depositForBurn` or `receiveMessage`.
- It does NOT fund any relayer wallet.

The smoke tests are executed by a human operator after go-live authorization, at a controlled time, with minimal amounts, on real production infrastructure.

---

## Section 14 — Evidence Collection

The operator retains the following **after every production-touching step** (deployment, smoke test, first N real merchant payments — per decision D-5 retention period):

**Deployment identity:**

- Commit SHA of the deployed build.
- Build artifact digest / container image tag (if applicable).
- Deployment identifier from the hosting platform.
- Timestamp (UTC) of deployment.

**Regression evidence:**

- `bun test` full output (711 pass / 0 fail).
- `bun run typecheck` result (EXIT = 0).
- `bun run build` result.
- `scripts/phase20-live-validate.ts` full output (13/13 PASS).

**RPC + chain identity:**

- For each of the 13 ENABLED networks: chain-id reported by the endpoint, timestamp of verification, operator who verified.
- Any chain-id mismatch (with outcome) if observed.

**Payment evidence (per smoke test / first real payments):**

- Payment intent id
- Source network + tx hash + block number + confirmation count at credit
- Circle attestation id (for cross-chain)
- Destination network + tx hash + block number (for cross-chain)
- Merchant wallet address that received (public address only, never a key)
- Amount (integer micro-USDC)

**Webhook evidence:**

- Endpoint URL (may include domain; strip any query-string secrets)
- Delivery attempt log excerpt (timestamp, HTTP status, response body — if the response is not sensitive)
- Signature verification success confirmation

**Email evidence:**

- Provider send id (if provider implemented; otherwise recorded as `EMAIL_TRANSPORT=none`)
- Recipient inbox acceptance confirmation (or "skipped" if none)

**Monitoring / alert evidence:**

- Alert-rule snapshot at go-live
- Dashboard state at go-live
- First-24h incident log (may be empty)

**Rollback / incident evidence (if any rollback occurred):**

- Trigger condition observed
- Time rollback started, time completed
- Data restored from backup id / timestamp
- Post-rollback verification

**Never record:**

- Private keys of any kind
- Seed phrases / mnemonics
- Production secret values (`SESSION_SECRET`, `API_KEY_HMAC_SECRET`, `WEBHOOK_HMAC_SECRET`, `WEBHOOK_SIGNING_ENC_KEY`, `RPC_PROXY_TOKEN`, email provider credentials)
- Full merchant webhook signing secrets (only the fact that they were registered and verified)
- Customer session tokens
- API keys

Evidence packet is stored in the operator's approved audit store with restricted access per decision D-5.

---

## Section 15 — Rollback

Rollback categories, from safest to most invasive:

### 15.1 Disable live payments (fastest, non-destructive)

- Set `ENABLE_LIVE_PAYMENTS=false` in the deployment environment.
- Restart the application process (no schema change, no data loss).
- New payment intents with `network=mainnet` variants are rejected; existing in-flight payments continue to be reconciled by the worker.
- Use when: RPC outage, attestation API outage, unexpected transaction behaviour, security incident.
- **Does NOT require a rebuild.**

### 15.2 Revert application code

- Deploy the previous known-good commit SHA.
- Restart the process.
- The self-healing seed re-runs `migrate()` at boot; no destructive action.
- Use when: a recent code change introduced a regression.
- **Does NOT delete data.**

### 15.3 Restore database from backup

- Requires human approval (destructive to any writes since the backup).
- Stop the application process.
- Replace the SQLite file at `DATABASE_URL` with the most recent verified backup.
- Restart; `migrate()` runs against the restored file (idempotent).
- Use when: schema corruption, bad data written, accidental irreversible change.
- **Data written after the backup is LOST.** Requires business owner authorization per decision D-5.

### 15.4 Webhook issues

- If a specific merchant endpoint fails to verify signatures: merchant rotates their endpoint signing secret via API. No system-level change required.
- If global webhook delivery is failing (all endpoints): check `WEBHOOK_HMAC_SECRET` and `WEBHOOK_SIGNING_ENC_KEY` — a mid-restart change to `WEBHOOK_SIGNING_ENC_KEY` will make existing per-endpoint ciphertexts undecryptable until merchants rotate.
- Do NOT disable webhook delivery. Merchant integrations depend on it.

### 15.5 CCTP settlement issues

- If attestations fail to arrive (Circle outage): journeys remain in `attestation_pending` until the attestation window (1800s) expires and are then recorded as `cross_chain.attestation_failed`. No manual intervention required to preserve correctness.
- If destination broadcasts fail (Option A relayer issue): journeys remain in `attestation_received, destination_pending`. Merchant credit is NOT issued. Escalate per Section 16. Options:
  - Temporarily switch executor to Option B (merchant self-execution) — no code change, but a policy decision requiring business owner authorization.
  - Restore the relayer wallet / key / gas balance.
- If a destination broadcast succeeded but the observed `Transfer` event does not match the pinned USDC contract address, this is a **critical stop** — disable live payments (15.1) and investigate.

### 15.6 Infrastructure failure

- If hosting is unrecoverable: re-provision the environment per Section 3, restore DB per 15.3, redeploy the last known-good commit.
- If TLS certificate expires: renew; no code change.
- If DNS is hijacked: rotate DNS provider credentials, restore zone, monitor.

### 15.7 Actions requiring human approval

- 15.3 (data loss)
- Any executor-model change in-flight (15.5 second bullet — switching models temporarily)
- Any network status change (enable / disable)
- Any production secret rotation
- Any change to `ALLOWED_ORIGINS` (CORS security posture)

---

## Section 16 — Incident Escalation

**Owner assignments are made by the accountable human per decision D-7.** If a role is not yet assigned, mark `OWNER NOT YET ASSIGNED`.

| Failure mode | Detected by | Initial responder | Escalates to | Notes |
|--------------|-------------|-------------------|--------------|-------|
| Application crash / boot failure | Restart-loop alert, `/health` failing | SRE on-call | Dev lead | Section 15.1 or 15.2 |
| RPC endpoint down / degraded | `eth_chainId` mismatch alert, retry-exhausted error rate | SRE | DevOps lead | Rotate to backup endpoint; not a code change if inventory uses direct URL |
| Chain-id mismatch | `ensureChainIdMatches()` throw | SRE + security | Product | Hard stop; disable live payments (15.1) until investigated |
| CCTP attestation not received | Journey in `attestation_pending` past 30-minute window | Backend on-call | Product | Circle outage OR source-chain congestion; document customer-facing policy |
| Destination settlement not executed | Journey in `attestation_received, destination_pending` | Depends on executor (Option A: SRE; Option B/C: no JafariPay action required) | Business owner | See Section 15.5 |
| Destination settlement failed (executor error) | Relayer alert (only if Option A selected) | SRE | Business owner | Executor-specific runbook required after D-1 |
| Webhook delivery failing to all endpoints | Delivery failure rate alert | Backend | Merchant-facing support | Verify `WEBHOOK_HMAC_SECRET` and `WEBHOOK_SIGNING_ENC_KEY` unchanged; merchant endpoint down? |
| Webhook delivery failing to a single endpoint | Per-endpoint failure alert | Merchant support | Merchant themselves | Merchant rotates secret via API |
| Email delivery failing | Provider error rate | Depends on chosen provider implementation (Section 8) | Business owner | Never blocks payment success; receipts remain in `pending` queue for retry |
| Database write failure | Boot guard / runtime error | SRE | DevOps lead | Check disk, permissions, WAL size |
| Database corruption | Migration error, unreadable rows | SRE | Business owner (Section 15.3 approval) | Restore from backup |
| Wallet / gas failure (Option A relayer only) | Balance alert | Treasury + SRE | Business owner | Requires finance pre-authorization |
| Infrastructure outage (hosting / DNS / TLS) | External monitor | SRE | DevOps lead + provider support | Re-provision per Section 15.6 |
| Security incident (suspected key leak) | Anomalous signature / auth failures | Security owner | Legal + business owner | Rotate affected secret; treat `WEBHOOK_SIGNING_ENC_KEY` rotation as a coordinated program |
| Regulatory / compliance event | Reported | Legal owner | Business owner | Per decision D-5 policy |

**Owner names are NOT defined in this repository.** Populating this table with names and contact channels is part of decision D-7.

---

## Section 17 — Go-Live STOP Conditions

**Go-live MUST halt immediately if any of the following is observed:**

1. **Executor model D-1 has not been approved** — no cross-chain smoke test proceeds.
2. **Production RPC unavailable** for any of the intended launch networks — chain-id check fails, or endpoint returns non-standard responses.
3. **Chain-id mismatch** between the endpoint and `CIRCLE_INVENTORY` row — `ensureChainIdMatches()` throws in any read path.
4. **Any of the 4 required production secrets is missing or below 16 characters** — the boot guard should already have exited the process; if it did not, verify `NODE_ENV=production` was set.
5. **Domain / TLS invalid** — certificate expired, self-signed, hostname mismatch, or `ALLOWED_ORIGINS` does not cover the real origin.
6. **`GET /health` not reachable from an external monitor** over HTTPS.
7. **Database backup not verified** — Section 11 backup checkbox unchecked.
8. **Webhook signature verification fails** in staging against a controlled test endpoint.
9. **Monitoring / alerting not operational** — no evidence that a synthetic alert fires and pages.
10. **Any unresolved critical alert at go-live time.**
11. **Final regression fails** — `bun test` / `typecheck` / `build` or Phase 17/18/19/20 gates not green.
12. **Unexpected transaction behaviour** during smoke test — merchant credit does not match observed Transfer, amount mismatch, target address mismatch.
13. **CCTP attestation cannot be verified** within the 1800-second window for the cross-chain smoke test.
14. **Destination settlement cannot be verified** for the cross-chain smoke test (per selected executor model).
15. **Any Phase 22+ scope-creep item** identified during execution — return to product owner; do not expand scope silently.

When a stop condition is hit:

- Set `ENABLE_LIVE_PAYMENTS=false`.
- Preserve all evidence (Section 14).
- Escalate per Section 16.
- Do NOT re-attempt go-live without an approved root-cause note.

---

## Section 18 — Final Handoff

### 18.1 HUMAN / BUSINESS HANDOFF

The accountable business owner explicitly approves and names:

- D-1 — CCTP executor model (A / B / C). **Status update:** Option C (Circle Forwarding) is implemented and testnet-verified end-to-end (Section 9, readiness pack §0). The owner's approval decision is now: confirm C in writing + authorize the Circle mainnet entitlement check. A and B remain available but are not implemented for production.
- D-2 — Production network scope (Arc-only, 13-ENABLED, or with added networks)
- D-3 — Hosting provider
- D-4 — Email provider: **approved, implemented, and live-tested (Brevo via `smtp-relay.brevo.com:587` STARTTLS)**. `EmailTransport` module shipped (`server/email/brevo-smtp.ts`); SMTP credentials provisioned externally; controlled test email delivered to `dev@jafari.co.in` (Zoho inbox receipt confirmed). What remains: production-host outbound 587 connectivity verification and deployment-env credential injection. Zoho mailbox `dev@jafari.co.in` and the apex-domain MX/SPF/DKIM records remain authoritative and unchanged.
- D-5 — Data retention / compliance policy
- D-6 — Monitoring / alerting approach and vendor
- D-7 — Incident / rollback ownership (named on-call)

Until these are named in writing, **no production action in Sections 3 through 13 may be taken.**

### 18.2 INFRASTRUCTURE HANDOFF

DevOps / SRE provisions and hands off:

- Production hosting environment satisfying Section 3.1
- Durable, writable `DATABASE_URL` with backup + verified restore (Section 3.2)
- Dedicated production RPCs for the 10 non-Arc mainnet networks + Arc mainnet direct-or-proxy decision (Section 4)
- Domain + DNS + TLS certificate with auto-renewal (Section 6)
- Secrets manager containing the 4 required production secrets, injected at process start (Section 5)
- Monitoring / alerting stack with `/health`, worker liveness, RPC error rate, webhook failure rate, and any executor-specific health signals (Section 16)
- On-call rotation established and paging tested

### 18.3 ENGINEERING HANDOFF

Engineering has already delivered and verified:

- Phases 0–20 complete + Phase 21C CCTP Forwarding closure (see `docs/PRODUCTION_GO_LIVE_READINESS.md` §0 and Section 1 of this runbook).
- 711 tests / 0 fails / typecheck EXIT=0 / build PASS / lint clean.
- Phase 20 13/13 read-only live validation against the current curated RPCs.
- CCTP V2 architecture (executor-agnostic by design) + **Circle Forwarding (Option C) implemented and live testnet-verified**.
- Registry, schema, migration, self-healing seed, chain-id guard, webhook signing, at-rest encryption, email transport abstraction, worker reconciliation, production boot config validator — all in place and tested.
- Product documentation + WebApp copy aligned with the verified implementation.

**Nothing in engineering remains open for Phase 21.** Phase 21 is operational.

### 18.4 GO-LIVE AUTHORIZATION

Production execution is authorized only when:

- Every decision in Section 2 (D-1 through D-7) has been approved in writing.
- Every checkbox in Section 11 is ticked with attached evidence.
- The Section 12 regression is green at the exact deployment commit SHA.
- The Section 13 smoke tests are executed in the sequence defined, with evidence collected per Section 14.
- The accountable owner signs the go-live authorization at the bottom of this runbook, referencing the specific commit SHA and deployment identifier.

No agent, script, or automated process may sign that authorization on behalf of the human owner.

---

**Go-live authorization**

```
Owner name:       _______________________________
Owner role:       _______________________________
Date (UTC):       _______________________________
Commit SHA:       _______________________________
Deployment ID:    _______________________________
Executor model:   _______________________________
Signature:        _______________________________
```

---

**END OF RUNBOOK**
