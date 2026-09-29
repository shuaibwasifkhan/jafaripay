# JafariPay — Phase L Final Report
### Webhook Signing Security Fix (H-1) + Receipt / Link / Reconciliation Production Hardening

Date: 2026-09-29 · Status: COMPLETE — working tree only, no commit / push / deploy / restart.

---

## 1. H-1 root cause

Deliveries were signed with the endpoint's **`secret_hash`** (an HMAC-SHA256 digest of
the raw `whsec_...` secret, keyed by `WEBHOOK_HMAC_SECRET`), while merchants were shown
and told to verify with the **raw secret**. The signature contract
`signature = HMAC_SHA256(raw_body_prefix, merchant_webhook_secret)` was therefore
impossible to satisfy: the hash is one-way and is *not* the merchant's credential.
Every externally-consumed webhook was unverifiable (documented defect **H-1** in
`docs/h1-webhook-audit.md`, stages A–L of the credential lifecycle audited first).

## 2. Existing webhook credential lifecycle (audit summary)

- `generateAndHashWebhookSecret()` created `whsec_<64 hex>`, stored only `secret_hash` +
  4-char `secret_preview`. Plaintext was returned once at create — then unrecoverable.
- `worker/process` (`delivery.ts`) selected `secret_hash` and signed with it → H-1.
- No rotation endpoint existed; a lost/leaked secret meant delete-and-recreate.
- `GET /webhook-endpoints` returned preview only (good). Delivery payloads/rows contained
  no secret material (good). Retry schedule: `10s, 30s, 2m, 5m, 30m, 2h, 8h`, 8 attempts max,
  each attempt re-signed with a fresh timestamp (semantics now locked by test W23).
- Signature format: `X-JafariPay-Signature: t=<unix>,v1=HMAC_SHA256(secret, "<t>.<rawBody>")`
  with a ±300 s freshness window and constant-time compare in `verifyWebhookSignature`.

## 3. Chosen secure architecture

**Environment-keyed AES-256-GCM envelope at rest, decrypted in memory only at signing
time.** New nullable column `webhook_endpoints.secret_ciphertext` stores
`v1.<iv_b64>.<tag_b64>.<ct_b64>` encrypting the raw signing secret under a key derived
(`scrypt`, fixed salt `jafaripay-webhook-secret-at-rest`) from env
`WEBHOOK_SIGNING_ENC_KEY`. Deliveries now sign with the **decrypted raw secret**.
`secret_hash` is retained for lifecycle/identity only (never used for signing).
Legacy rows without ciphertext **fail closed**: the delivery is marked `failed` with
`last_error = signing_secret_unavailable: rotate this endpoint secret` — never silently
signed with the wrong key, never mutating payment state. Production boot now fail-fast
requires `WEBHOOK_SIGNING_ENC_KEY` alongside the other three secrets.

## 4. Why this architecture

- HMAC is **symmetric**: the server must be able to recover the exact merchant secret —
  a hash is structurally insufficient. Some recoverable form must persist.
- Constraints honored: no plaintext at rest (encrypted envelope), **no new secret-
  management dependency** (no KMS/Vault — env key only), signing material never in
  logs/URLs/frontend bundles/errors, and the fix does not "use `secret_hash` merely
  because it exists."
- Fail-closed for legacy endpoints was preferred over a silent fallback, and over
  auto-rotation, because silently changing a signing key breaks merchant verification
  worse than a visible, actionable failure with a documented one-step remedy (rotate).
- Additive nullable column = idempotent, restart-safe, FK-safe migration.

## 5. Migration impact

- One additive `ALTER TABLE webhook_endpoints ADD COLUMN secret_ciphertext TEXT`
  (hasColumn-guarded, idempotent, runs at every boot in `schema.ts`). No data destroyed,
  no restart requirements beyond normal deploy.
- **Existing endpoints**: `secret_ciphertext` is NULL → their pending deliveries fail
  closed until the merchant rotates the secret once (new `POST /webhook-endpoints/:id/rotate-secret`).
  The raw secret of pre-Phase-L endpoints is unrecoverable by design, so rotation is the
  only correct migration. This is documented in the audit and surfaced in delivery errors.
- New endpoints get ciphertext automatically.

## 6. Backward compatibility impact

- Wire format of the signature header is **unchanged** (`X-JafariPay-Signature: t=…,v1=…`);
  what changes is that `v1` is now computed with the secret the merchant actually holds —
  i.e., the documented contract finally matches reality (this is the fix, not a break).
- Create response shape is a superset (same fields; `secret` still returned once).
- `GET` list response unchanged (preview only). No SDK or checkout changes required.
- Legacy merchants must rotate once — an intentional, visible invalidation (per spec:
  "don't silently invalidate," fail-closed + explicit error + dashboard action provided).

## 7. Webhook implementation changes

- `server/lib/crypto.ts` (new): `encryptSecret` / `decryptSecret` (AES-256-GCM, versioned
  envelope; `decryptSecret` never throws, returns null on tampered/foreign/missing blobs).
- `server/webhooks/delivery.ts`: worker selects `we.secret_ciphertext`, decrypts per
  delivery, signs with the raw secret; fail-closed branch for missing/undecryptable
  ciphertext (attempts incremented, no fetch, payment untouched);
  `generateAndHashWebhookSecret()` now also returns `ciphertext`.
- `server/db/schema.ts`: additive `secret_ciphertext` column migration.
- `server/api/webhooks.ts`: create stores ciphertext; **new**
  `POST /:id/rotate-secret` (session auth, merchant-scoped 404 identical for foreign and
  nonexistent ids — enumeration-safe) atomically replaces hash/preview/ciphertext and
  returns the new plaintext exactly once.
- `server/index.ts`: `WEBHOOK_SIGNING_ENC_KEY` added to the production fail-fast secret list.
- `src/components/dashboard/WebhooksPage.tsx`: reveal-once banner (Copy / Done), rotate
  button with explicit "invalidates the old secret immediately" warning, create() captures
  the returned secret for one-time display.
- `src/components/docs/DocsPage.tsx`: corrected header name to `X-JafariPay-Signature`,
  corrected retry schedule (~10s…8h, 8 total attempts), new "Signing secret" section
  (reveal-once + rotation semantics), hardened verifier example (raw bytes, length guard
  before `timingSafeEqual`, freshness window), pointer to the reference script.

## 8. Reference verifier

`scripts/verify-webhook-reference.mjs` — dependency-free ESM, merchant-facing, uses **no
JafariPay internals**: `verifyWebhookSignature({ rawBody, signatureHeader, secret,
maxAgeSec = 300, nowSec })` parses the header defensively, enforces the freshness window,
recomputes `HMAC_SHA256(secret, "<t>.<rawBody>")` over the **raw body bytes**, and
compares constant-time with a length guard. `--selftest` covers 7 cases
(valid / wrong secret / tampered body / tampered timestamp / stale timestamp / empty
header / short signature) — all pass. Interop with the server was verified: signatures
from the real delivery worker verify with the raw `whsec_` secret (and do **not** verify
with `secret_hash` — the W21 regression test).

## 9. Receipt security findings

Audited `api/receipts.ts`, `receipts/service.ts`, `lib/ids.ts`, public projection:
**already hardened** (capability ids `rcpt_` + 24 base36 chars ≈ 124 bits, non-
enumerable; merchant-scoped 404s; issued receipts are immutable snapshots — no
PUT/PATCH surface; email-send isolation with max 4 attempts + backoff; explorer URLs
from a pinned registry; XSS-escaped rendering). **No production changes needed.**
Locked in by HL5/HL6/HL9 (exact pinned public key set; intent-email changes cannot alter
an issued receipt; no edit endpoint exists). Intentional design note: the public receipt
page shows `customer_email` — capability-scoped by design (only holders of the unguessable
id see it).

## 10. Payment Link security findings

Audited `api/payment-links.ts` + public `/pay/:id`: **already hardened** (amount integrity
is server-side — the link's stored `amount_decimal`/base units are used for the intent,
never a client-supplied amount; `metadata` and internal ids never cross the public
capability boundary; status/expiry gating; active/archived transitions merchant-scoped).
No production changes. Pinned by HL7: public projection is the exact key set
`[amount, currency, description, expired, expires_at, id, merchant_name, order_id, paid,
payable, status]` — no metadata, no merchant_id, no base units.

## 11. Reconciliation security findings

Audited `api/payments.ts` reconciliation enrichment and `api/webhook-deliveries.ts`:
every enrichment query is filtered by the same `merchant_id` already authorized on the
request (`receipts WHERE payment_id=? AND merchant_id=?`, deliveries joined through
`webhook_endpoints WHERE we.merchant_id=?`) — a foreign row can never attach; cross-tenant
`GET /payments/:id` with a valid API key returns 404. Enrichment is read-only and never
touches the money path. No production changes. Pinned by HL2/HL8/HL10 (no secret material
on any read surface; network-scoped payments; cross-tenant isolation under the new schema).

## 12. Tests added

- `server/webhook-security.test.ts` — **25 cases (W1–W25)** per the mandated matrix:
  valid/invalid/wrong-secret signatures, modified body, tampered/stale/future/malformed
  timestamps, replay window, cross-merchant secret rejection, envelope roundtrip,
  decrypt null-safety, GCM ciphertext-and-tag tamper, secret≠hash≠ciphertext material,
  `timingSafeEqual` length-mismatch no-throw, whitespace + Unicode (NFC vs NFD) byte
  sensitivity, reveal-once + GET-list leakage scan, at-rest non-plaintext, rotation
  old-rejected/new-accepted via the real worker, **W21 = H-1 regression guard**
  (verify-with-secret_hash fails, verify-with-raw-secret succeeds), legacy fail-closed
  (no fetch, no payment mutation, actionable error), retry signature semantics (both
  attempts verify, same secret, fresh timestamps), authz + enumeration-safe 404s + SSRF
  block, and console-spies proving the secret never appears in logs across
  create/deliver/rotate.
- `server/phaseL-hardening.test.ts` — **10 cases (HL1–HL10)** pinning ciphertext-at-rest,
  no-leak read surfaces, atomic rotation, delivery-row cleanliness, receipt snapshot +
  immutability, capability-id entropy (200 samples, format + uniqueness + non-sequential),
  public `/pay` exact projection, network-scoped payments, cross-tenant reconciliation.
- `scripts/verify-webhook-reference.mjs --selftest` — 7 cases (included in gates run).

## 13. Full test result

```
bun test → 438 pass / 0 fail / 3251 expect() calls across 19 files
```
(403 pre-existing + 25 new W + 10 new HL; zero regressions. Blockchain/network still
untouched by tests; dev email transport only.)

## 14. Typecheck

`bunx tsc --noEmit` → **0 errors**.

## 15. Build

`bun run build` (Vite app) and `bun run build:sdk` (Vite SDK) → both **succeed**.

## 16. Lint

`bunx oxlint` on all Phase L files (10 files) → **0 warnings / 0 errors**. One
`react-hooks` set-state-in-effect error exists in `DocsPage.tsx` (line ~1409,
`setNavOpen(false)`); **proven pre-existing** by linting the unmodified
`git show HEAD:src/components/docs/DocsPage.tsx` copy — outside Phase L scope, untouched.

## 17. Files changed

| File | Change |
|---|---|
| `server/webhooks/delivery.ts` | sign with decrypted raw secret; fail-closed legacy; ciphertext from generator |
| `server/api/webhooks.ts` | store ciphertext on create; new `POST /:id/rotate-secret` |
| `server/db/schema.ts` | additive `secret_ciphertext` column + idempotent migration |
| `server/index.ts` | `WEBHOOK_SIGNING_ENC_KEY` in production fail-fast list |
| `src/components/dashboard/WebhooksPage.tsx` | reveal-once banner, copy, rotate UI + warning |
| `src/components/docs/DocsPage.tsx` | corrected header/retry docs; signing-secret section; hardened verifier example |

## 18. Files created

| File | Purpose |
|---|---|
| `server/lib/crypto.ts` | AES-256-GCM secret envelope encrypt/decrypt |
| `scripts/verify-webhook-reference.mjs` | dependency-free merchant reference verifier + selftest |
| `server/webhook-security.test.ts` | W1–W25 webhook security matrix |
| `server/phaseL-hardening.test.ts` | HL1–HL10 hardening invariants |
| `docs/h1-webhook-audit.md` | pre-implementation lifecycle audit (produced in the audit step) |

## 19. Database migrations

One migration only: `ALTER TABLE webhook_endpoints ADD COLUMN secret_ciphertext TEXT`
(nullable, hasColumn-guarded, applied on boot, idempotent, restart-safe, FK-safe,
additive — no existing column or row modified). No backfill is possible or wanted
(plaintext is unrecoverable by design); legacy rows fail closed until rotated.

## 20. Remaining security concerns

1. **`WEBHOOK_SIGNING_ENC_KEY` rotation is not automatic**: changing the env key makes
   existing envelopes undecryptable → those deliveries fail closed until each endpoint is
   rotated. A re-wrap-on-boot utility is deliberately not implemented (larger blast
   radius than the current explicit fail-closed path).
2. **Env key is a single symmetric key** for all endpoints — compromise of the env key +
   DB exposes all signing secrets. KMS envelope-encryption would mitigate but was
   excluded by the "no new secret-management dependency" constraint.
3. Dev fallback keys (`-change-me` constants) exist for non-production convenience;
   the production fail-fast guard is the only enforcement boundary and depends on
   `NODE_ENV`/production detection being correct.
4. Pre-existing `react-hooks` lint error in `DocsPage.tsx` (documented in §16) — should
   be fixed in a separate phase.
5. Public receipt page intentionally discloses `customer_email` to capability-id holders
   (§9) — acceptable for the product model, but worth a human sign-off.

## 21. Remaining human decisions

1. **Deploy + provision `WEBHOOK_SIGNING_ENC_KEY`** in production env before rollout
   (fail-fast will refuse boot otherwise) — I did not touch any real environment.
2. **Communicate the one-time rotation** to existing merchants with webhook endpoints
   (legacy deliveries fail closed with an actionable error until each endpoint rotates).
3. Accept or replace the **single env-key** model vs. introducing KMS later (§20.2).
4. Decide on a **key-rotation procedure** for `WEBHOOK_SIGNING_ENC_KEY` itself (currently:
   rotate env key → rotate each endpoint, or restore old key).
5. Sign off on the **pre-existing DocsPage lint error** handling and on the public-receipt
   email disclosure (§20.4–5).
6. Anything reaching production: commit, push, deploy, restart — all explicitly deferred.

---

## Explicit statements

- **Are plaintext webhook secrets stored?** **No.** Plaintext exists only transiently in
  memory (at generation, at the moment of signing one delivery, and in the single
  create/rotate HTTP response). The database holds only an AES-256-GCM ciphertext
  envelope, a non-reversible `secret_hash`, and a 4-character preview.
- **Where does signing material live?** Encrypted at rest in
  `webhook_endpoints.secret_ciphertext`, keyed by the `WEBHOOK_SIGNING_ENC_KEY`
  environment variable; decrypted in server memory only, at delivery-signing time.
- **When does the merchant receive the secret?** Exactly once — in the response body of
  endpoint creation (`POST /webhook-endpoints`) or of rotation
  (`POST /webhook-endpoints/:id/rotate-secret`). The dashboard shows it in a reveal-once
  banner and it can never be displayed again.
- **Do old secrets remain valid after rotation?** **No.** Rotation atomically replaces
  `secret_hash`, `secret_preview`, and `secret_ciphertext` in one UPDATE; the old secret
  is immediately unusable for verification and no DB column can recover it (proven by
  HL3/W20). Signatures made with the old secret before rotation remain valid only within
  the ±300 s freshness window, then fail.
- **How does replay protection work?** Every delivery (and every retry attempt) is signed
  with a fresh Unix timestamp embedded in the header; verifiers reject anything outside a
  ±300 s freshness window, and the timestamp is *inside* the HMAC input, so it cannot be
  altered without invalidating the signature. Constant-time comparison with a length
  guard prevents timing leaks. Merchants should additionally dedupe by the event `id`
  (retries of the same event carry identical payload but distinct timestamps).
- **How does a merchant verify a webhook independently?** With the raw `whsec_...` secret
  shown once at create/rotate, over the **raw request bytes**: parse `t` and `v1` from
  `X-JafariPay-Signature`, check the timestamp window, compute
  `HMAC_SHA256(secret, "<t>.<rawBody>")`, compare constant-time. A complete, dependency-
  free implementation ships at `scripts/verify-webhook-reference.mjs`
  (`node scripts/verify-webhook-reference.mjs --selftest`) and mirrors the docs example —
  it uses no JafariPay internals.

---

**HARD STOP reached.** No commit, no push, no deploy, no production restart, no real
USDC, no private keys, no production secret changes, no RPC purchase. The working tree
is ready for human review.
