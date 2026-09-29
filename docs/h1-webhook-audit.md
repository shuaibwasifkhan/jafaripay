# Phase L — H-1 Audit: Webhook Credential Lifecycle & Root Cause

> Audit performed against the actual working-tree source (REF-3/REF-4), not report
> summaries. No code edited before this document.

## 1. End-to-end credential trace (current code)

| # | Stage | Code | Behavior |
|---|---|---|---|
| 1 | Webhook creation | `api/webhooks.ts:25` `POST /webhook-endpoints` (requireSession) | Validates URL + SSRF, calls `generateAndHashWebhookSecret()` |
| 2 | Secret generation | `webhooks/delivery.ts:106` | `secret = whsec_<hex(randomBytes(32))>`; `hash = HMAC(WEBHOOK_HMAC_SECRET, secret)` |
| 3 | Returned to merchant | `api/webhooks.ts:38` | 201 body includes plaintext `secret` **once** |
| 4 | DB persistence | `api/webhooks.ts:37` | Stores `secret_hash` + `secret_preview` (last 4). **The raw `secret` is never persisted.** |
| 5 | Hashing | `delivery.ts:108/112` | One-way keyed HMAC (`WEBHOOK_HMAC_SECRET`), not reversible |
| 6 | Signing | `delivery.ts:64` | `signWebhookPayload(d.secret_hash, payload, ts)` → HMAC **key = `secret_hash`** |
| 7 | Delivery | `delivery.ts:81` | POST body + header `X-JafariPay-Signature: t=<ts>,v1=<hmac>` |
| 8 | Merchant verification | docs `DocsPage.tsx:361` | `HMAC(secret, "<ts>.<rawBody>")` vs `v1`, timing-safe, 300s window |
| 9 | Rotation | — | **No rotation endpoint exists** |
| 10 | Secret exposure/logging | — | Secret is not logged; but see §3 (never surfaced in UI) |
| 11 | Retry | `delivery.ts:94` | Re-signs on each attempt (same key semantics) |
| 12 | Replay protection | `verifyWebhookSignature` | Timestamp ±300s + constant-time compare (correct in the *verifier*) |

## 2. Root cause of H-1 (precise)

The merchant is given the raw `secret` (`whsec_…`) and the docs tell them to compute
`v1 = HMAC(secret, "<t>.<rawBody>")`. But the server computes
`v1 = HMAC(secret_hash, "<t>.<rawBody>")` where `secret_hash = HMAC(WEBHOOK_HMAC_SECRET, secret)`.

These can never match, because reproducing `secret_hash` requires the server-only
`WEBHOOK_HMAC_SECRET`, which the merchant does not (and must not) have. **Therefore every
webhook signature is unverifiable by the merchant**, so they either skip verification
(forgery/replay possible) or reject all deliveries. `secret_hash` is a *password-style
verification digest* that was mistakenly reused as a *symmetric signing key*.

## 3. Two additional compounding defects found while tracing

- **D-2 (merchant can't even retrieve the secret):** the dashboard
  `WebhooksPage.tsx:create()` discards the 201 response body and never shows the plaintext
  `secret` (list view shows only `…preview`). So even with correct signing, the merchant has
  no working way to obtain the secret to verify with.
- **D-3 (no rotation):** there is no rotate endpoint, so a leaked/lost secret is
  unrecoverable short of delete-and-recreate.

## 4. Critical design question — must the raw secret be persisted to sign?

**YES.** HMAC is symmetric: to sign a future delivery (and every retry) the server must
recover the *exact* key the merchant holds. A one-way hash cannot be used to sign, and a
password-verification digest must **not** be repurposed as a signing key. So JafariPay must
persist a **recoverable** signing secret per endpoint.

## 5. Chosen secure architecture (smallest safe, matches current model)

The app already manages server-side symmetric keys purely as **environment variables**
(`SESSION_SECRET`, `API_KEY_HMAC_SECRET`, `WEBHOOK_HMAC_SECRET`, each with a dev fallback
and a production fail-fast guard in `index.ts:40`). It has **no** KMS/Vault and the spec
forbids inventing one. So the smallest safe design consistent with this architecture is:

- **Encrypt each endpoint's raw signing secret at rest** with **AES-256-GCM** using a new
  env key `WEBHOOK_SIGNING_ENC_KEY`, stored in a new additive column
  `webhook_endpoints.secret_ciphertext` as a versioned envelope `v1.<iv>.<tag>.<ct>`.
- **Sign with the decrypted raw secret** (key = the exact `whsec_…` the merchant holds).
  Payload/header format is unchanged → no wire-format break for correctly-implemented
  consumers (of which there are none today, since verification was impossible).
- **Keep `secret_hash`** (now used only for lifecycle/identity, never for signing) and
  `secret_preview` (display). Raw secret still shown **once** at create/rotate; **never**
  in GET/list; **never** logged/URL/error/receipt/SDK.
- **Add rotation** (`POST /webhook-endpoints/:id/rotate-secret`) that replaces the
  ciphertext+hash+preview and returns the new plaintext once → old secret stops verifying.
- **Fix the UI** to reveal the secret once after create/rotate (D-2).

### Alternatives rejected
- *Plaintext secret in DB* — avoidable, so disallowed by the spec ("DB must not store
  plaintext secrets if avoidable").
- *Keep signing with `secret_hash`* — the actual bug; forbidden ("do not use secret_hash as
  a signing key merely because it exists").
- *Asymmetric signing / external KMS* — invents a production secret-management dependency;
  over-engineered for this app.

### Migration / backward-compat impact
- Additive nullable column only; idempotent (`hasColumn` guard), restart-safe, FK-safe.
- Pre-existing endpoints have `secret_hash` but **no recoverable secret** → they cannot be
  signed under the new scheme. The delivery engine **fails closed** for such endpoints
  (delivery → `failed`, `last_error='signing_secret_unavailable'`) and never emits a broken
  signature or mutates payment state. Because the old signatures were already unverifiable,
  this breaks no working consumer; the merchant restores service with one **Rotate**. This is
  documented, not silent. (No legacy real merchants exist in this pre-production tree.)
