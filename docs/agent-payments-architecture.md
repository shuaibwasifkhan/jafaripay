# Phase E — Agent / Machine-to-Machine Payment Architecture (Design)

> **Status: ARCHITECTURE STUDY.** No autonomous financial agent was built, and none
> should be. This document maps the *developer/API primitives* that a future
> agent-native (M2M) payment flow needs, and records which of them **already exist**
> in JafariPay today versus which are still missing. No speculative AI features.

Target flow from the spec:
```
Agent → Create Payment Intent → receive payment instructions → pay USDC
      → verify → signed webhook → service/API access granted → receipt
```

## 1. Audit: what the current API already gives an agent (no wallet-auth change)

The **merchant** stays wallet-authenticated (SIWE) for *onboarding/dashboard*, but the
agent never uses that path. An agent authenticates with a **secret API key**
(`Authorization: Bearer sk_test_…`), which the codebase already supports via
`requireSessionOrApiKey`. Verified existing primitives:

| Agent need | Primitive | Where (verified in code) | Status |
|---|---|---|---|
| Deterministic create (safe retries) | `Idempotency-Key` header, merchant-scoped, request-hash conflict → `409 idempotency.conflict`, else replay stored response | `api/payment-intents.ts` + `idempotency_keys` table | ✅ **exists** |
| Machine-readable intent | JSON: `id, status, amount, currency, network, chain_id, settlement_address, usdc_address, expires_at, checkout_url` | POST `/v1/payment-intents` response | ✅ **exists** |
| Payment instructions for the payer | Hosted checkout URL `/checkout/:id`; amount/network/expiry pinned server-side (client cannot override) | checkout API + hosted page | ✅ **exists** |
| Deterministic status | Intent `status ∈ {requires_payment, processing, succeeded, failed, expired, cancelled}` (DB CHECK); `payments.status` only after verified credit | schema CHECK | ✅ **exists** |
| Finalize a payment | `POST /checkout/:id/verify { tx_hash, chain_id }` — the payer (human wallet *or* an agent controlling a wallet) submits the on-chain tx for verification; replay-guarded by `UNIQUE(tx_hash,network)` | `api/checkout.ts` | ✅ **exists** |
| Signed completion signal | Webhooks HMAC-SHA256 over `"<t>.<payload>"`, header `X-JafariPay-Signature: t=…,v1=…`, **constant-time compare**, 300 s replay window, retry ladder `[10,30,120,300,1800,7200,28800]`s | `webhooks/delivery.ts` | ✅ **exists** (Stripe-compatible shape) |
| Reconciliation read | `GET /v1/payments/:id` — intent + amount + network + token + tx hash + payer + settlement wallet + verification_state + receipt + webhook state | `api/payments.ts` (Phase F) | ✅ **exists** |
| Receipt | public capability `GET /api/receipts/:receiptId`; merchant-scoped `GET /v1/receipts` | `api/receipts.ts` (Phase B) | ✅ **exists** |

**Verdict:** the current API can already drive a full M2M happy path (create → pay →
verify → signed webhook → reconcile → receipt) **without changing the wallet-auth
merchant model**. The primitives an agent needs — idempotency, deterministic status,
signed webhooks, machine-readable resources — are present.

## 2. Gaps to close before this is genuinely "agent-native" (design, NOT built)

These are additive/contract-level, none require custody or money-semantics changes, but
each is a **human API-design decision** and was deliberately NOT implemented autonomously:

1. **`402 Payment-Required` resource primitive.** Today an agent that wants to *buy
   access* must first call the intents API out-of-band. A future pattern: a protected
   endpoint returns `402` with an embedded, server-created intent
   (`{ amount, currency, network, expires_at, payment_instruction }`) so the agent can
   pay-to-proceed in one round-trip. This is a *new endpoint contract*, additive.
2. **Intent vs payment clarity for machines.** Both are `succeeded`. Document/expand a
   single canonical "did money settle for intent X" read (the Phase F view is the seed).
3. **Webhook delivery identity.** Add a stable `webhook_deliveries.id`/event id surfaced
   in the payload so an agent can dedupe at the *event* level, not just the payment level.
4. **Capability grant after settlement.** "Service/API access" implies mapping a settled
   intent to an entitlement. JafariPay should stay the *payment oracle*, not become an
   entitlement store — recommend: agent reads the signed webhook, then enforces its own
   access. Keep the boundary clean.
5. **Machine-readable docs for the state machine** (allowed transitions + terminal states)
   so an agent can reason about retries deterministically. (Docs — Phase J.)

## 3. Safety boundaries kept intact

- **No autonomous spending:** nothing here lets JafariPay move a customer's/merchant's
  funds. A human/agent wallet still signs every on-chain action; we only verify + notify.
- **Idempotency & replay are already enforced** at both creation (`Idempotency-Key`) and
  verification (`UNIQUE(tx_hash,network)`) — critical so a retried agent call cannot
  double-charge or double-credit.
- **Webhook authenticity** is HMAC-signed with a replay window; consumers must verify the
  signature and reject stale timestamps before trusting a "succeeded" event (see Phase H).
- **Amount integrity**: intent amount/network/expiry are server-pinned; the browser/agent
  never supplies the authoritative charge.

## 4. Recommendation

Do **not** build an agent layer now. The payment primitives an agent needs already exist
and are tested. The next concrete, safe step is (a) publishing the machine-readable
state/API contract, and optionally (b) a `402 Payment-Required` demo endpoint — both
additive and human-reviewed before shipping.
