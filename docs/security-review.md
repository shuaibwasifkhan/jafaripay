# Phase H — Security Review of Master-Phase Changes

Scope: the new/changed surface from Phases B, C, F (receipts, payment links,
reconciliation view, checkout email capture) plus the agent/webhook surfaces Phases
D/E point at. Method: read the actual handlers + money gate; corroborated by the
dedicated tests (receipts R1–R17, links L1–L12, reconciliation F1–F6) in `bun test`.
**No existing control was weakened.**

## 1. Controls that hold (verified in code, backed by tests)

| Check | Finding | Evidence |
|---|---|---|
| Merchant / tenant isolation | Every merchant read/write is `WHERE merchant_id = caller`. Foreign payment/receipt/link → 404. | Phase F `WHERE p.id=? AND p.merchant_id=?`; receipts R12/R13; links L9; recon F5 |
| IDOR / BOLA on receipts | Public receipt is a **capability** URL (unguessable id) with a *safe projection* — no `merchant_id`/`payment_id` leak; unknown id → 404. | `api/receipts.ts`; R10, R11 |
| Predictable identifiers | `rcpt_`/`plink_`/`pi_` ids are 24 base-36 chars from `crypto.randomBytes` (~124-bit entropy) → non-enumerable. | `lib/ids.ts` |
| Duplicate webhook | Deliveries are per `(endpoint, intent, event)`; endpoint consumer must dedupe by delivery id. | `webhooks/delivery.ts` |
| Duplicate receipt | `receipts.payment_id UNIQUE` → one receipt per payment; regenerate is idempotent. | schema; R4 |
| Replay (money) | `payments UNIQUE(tx_hash, network)` + `blockchain_transactions UNIQUE(tx_hash,network)`; re-submitting a tx is refused. | `arc-provider.ts` gate; L (replay) |
| Cross-network / chain-id confusion | Provider calls `eth_chainId` and compares to the pinned registry `chain_id` **before** any credit; a lying/mismatched endpoint fails closed. | `ensureChainIdMatches` |
| Token confusion | Verification pins the **native USDC contract** per network and matches the `Transfer` log address; wrong-token transfer is not credited. | money gate list |
| Amount manipulation | Verification requires **exact base-unit amount** (integer, never float). Intent amount/network/expiry are server-pinned; the client/browser cannot set the authoritative charge. | `arc-provider.ts`; links L5 |
| Expiry bypass | Intent/link expiry checked server-side; expired → 410/`expired`; a `payment_link` mints intents with `min(now+default, link.expires_at)`. | links L6/L7 |
| Settlement-wallet mismatch | Verification requires `recipient == pi.settlement_address` (exact). | `arc-provider.ts`; F1 asserts recipient==settlement |
| Email abuse / injection | Email is **never** the money gate; `isValidEmail` bounded length; `receipt_email` rejected with 400 **before** the money path; provider-agnostic dev transport. | `email/transport.ts`; R7a/R7b |
| Sensitive data exposure | Public receipt omits internal ids; reconciliation view is merchant-scoped; API keys/webhook secrets stored hashed, shown once. | R10; F6; `api-keys`/`webhooks` |
| SSRF | Webhook endpoint creation blocks private/local URLs (`isPrivateUrl`). | `api/webhooks.ts:29` |
| Amount/formatting on public pages | `/receipt/:id` and `/pay/:id` render server data only; the pay page sends **nothing** about the charge client-side. | `PayLinkPage.tsx` |

Phase F specifically keeps the reconciliation view **read-only + merchant-scoped**, and
its webhook JOIN is additionally filtered by `webhook_endpoints.merchant_id = caller`,
so a delivery row that (even via a mis-keyed intent FK) belongs to another merchant's
endpoint cannot surface — proven by F6.

## 2. Findings to escalate (NOT auto-"fixed" — each touches credentials/real-money semantics)

### H-1 (HIGH) — Merchant cannot verify the webhook signature it is being sent
`generateAndHashWebhookSecret()` hands the merchant `secret = whsec_…` and stores
`secret_hash = HMAC(WEBHOOK_HMAC_SECRET, secret)`. But the delivery engine signs with
**`signWebhookPayload(d.secret_hash, payload, t)`** (`webhooks/delivery.ts:64`) — i.e. the
HMAC *digest*, which is never returned to the merchant. A consumer holding only
`whsec_…` **cannot reproduce `X-JafariPay-Signature`**, so it can neither verify
authenticity nor detect a forged/replayed "payment.succeeded". This directly undermines
the webhook-authenticity control that Phases E/F rely on.
- **Why not fixed here:** the correct fix changes signing-key/credential handling. Signing
  with the raw `secret` requires storing it reversibly (encryption/secret manager) — a
  at-rest credential design decision. Per the mandatory safety rules (real-money/custody/
  secrets), **STOP and document**, do not guess.
- **Recommended remediation (human):** store an encrypted raw secret (or derive the signing
  key consistently from what the merchant holds); publish a reference verifier using the
  documented `t=…,v1=…` scheme + 300 s window + constant-time compare. Add a test that the
  merchant-side secret verifies a signed payload.

### H-2 (MEDIUM) — `randomString` modulo bias
`ALPHABET[b % 36]` with `b ∈ [0,255]` (256 % 36 ≠ 0) slightly biases character frequency.
Entropy remains ~123+ bits over 24 chars, so ids stay non-enumerable; noted as
informational, not a practical break. Low-risk fix: rejection sampling to a 32-multiple
range if id space is ever tightened.

### H-3 (LOW / pre-existing) — `WEBHOOK_HMAC_SECRET` / `API_KEY_HMAC_SECRET` dev fallbacks
Both fall back to `'dev-…'` literals when the env var is unset. Acceptable for local/test,
but must be a hard startup requirement in production (fail-fast if missing) to avoid a
predictable HMAC key. Confirm via deployment/config review (Phase J).

### H-4 (process) — Public capability URLs are bearer secrets
`/receipt/:id` and `/pay/:id` authorize purely on the unguessable id. Correct for now, but
a receipt URL in an email can be forwarded. Mitigations already in place: safe projection
(no internal ids), email-status isolation, and merchant-scoped resend. Consider short-TTL
or view-token rotation if receipts ever expose more PII.

## 3. Backward-compatibility & safety confirmations
- Phase F is **purely additive** to `GET /payments/:id` (original keys untouched); no money
  path changed. No existing security test was altered or removed — the suite only grew.
- No real transactions, keys, secrets, deployment, commit, or push were introduced anywhere
  in this phase (all cross-chain/router/agent work is design-only).
