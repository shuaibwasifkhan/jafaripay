# Phase G — Developer Experience Review

Goal journey (from the spec):
`create merchant → create intent → show checkout → receive webhook → verify payment →
retrieve receipt → (eventually) accept supported networks → set settlement preference`.

The SDK was **not rewritten** and backward compatibility is preserved. This is a review
of what a developer can do today versus the ideal journey, plus the smallest, safe gaps.

## 1. Journey coverage today

| Step | How a dev does it today | State |
|---|---|---|
| 1. Create merchant | Dashboard, wallet sign-in (SIWE). Projects + settlement wallets + API keys are created here. | ✅ works |
| 2. Create Payment Intent | `POST /v1/payment-intents` with `sk_test_…` + `Idempotency-Key`. Returns `checkout_url`. | ✅ works |
| 3. Show checkout | Redirect to hosted `/checkout/:id`, or embed via SDK `JafariPay.checkout()` / `JafariPay.mount()`. | ✅ works |
| 4. Receive webhook | Signed `payment.*` deliveries with retries. | ⚠️ works, but see **G-1** |
| 5. Verify payment | Backend auto-verifies on checkout submit; dev reads truth via webhook or `GET /v1/payments/:id` (now enriched, Phase F). | ✅ works |
| 6. Retrieve receipt | **NEW (Phase B):** public `/receipt/:id` + `GET /api/receipts/:id`. | ✅ newly available |
| 7. Accept supported networks | Network is chosen at intent creation and validated against the registry. | ⚠️ partial — see **G-3** |
| 8. Settlement preference | Merchant sets a settlement wallet per network in the dashboard. | ⚠️ partial — see **G-3** |

New in this phase and directly DX-relevant:
- **Receipts** (Phase B): a customer-facing, network-aware `/receipt/:id` page and a
  merchant receipt list — a step that previously didn't exist at all.
- **Payment Links** (Phase C): `POST /v1/payment-links` → a shareable `/pay/:id` URL that
  mints intents from a server-pinned amount. Removes the need for a merchant backend just
  to charge a fixed amount — a meaningful "in 30 seconds" path.
- **Reconciliation view** (Phase F): `GET /v1/payments/:id` now returns, in one call,
  intent + amount + network + token + tx hash + payer + settlement wallet +
  `verification_state` + receipt + webhook state — so "did this settle and did my hooks
  fire?" is answerable without joining four endpoints.

## 2. Gaps / friction (small, additive — deliberately not force-fixed)

- **G-1 (blocks step 4) — webhook verification is not usable as documented.** The delivery
  engine signs with `secret_hash` (never exposed), not the `whsec_…` secret the merchant is
  given, so a merchant literally *cannot* verify the signature (see Phase H, **H-1**). The
  README/docs even instruct them to "verify with your endpoint secret". This is the single
  biggest DX defect on the journey and must be fixed (human decision — credential handling)
  before webhooks can be recommended as the source of truth.
- **G-2 — no copy-paste end-to-end example for the new features.** Receipts and Payment
  Links ship with routes + tests but no quickstart snippet. Add docs + an SDK-demo note
  (Phase J), not new code.
- **G-3 — "accept networks / settlement preference" is implicit.** There is no single
  merchant-level "which networks do I accept + where do I settle" surface exposed in one
  place; today network comes from the registry and settlement from per-network wallets.
  The Payment Link already carries `allowed_networks`, which is the right seed — a future
  additive merchant preference object (not a DB redesign) would complete steps 7–8.
- **G-4 — SDK status polling is a UI hint only.** The SDK correctly says postMessage/polling
  are *not* proof of settlement. Keep it that way; the authoritative path is webhook →
  reconciliation. No change recommended (backward compat + honesty).

## 3. What is genuinely good already (keep)

- Clear, dependency-free SDK that never touches keys/funds; hosted checkout + REST are the
  real integration paths.
- `Idempotency-Key` semantics (replay original response, `409` on mismatch) are exactly the
  right primitive for a flaky network.
- `checkout_url` in the intent response makes step 2→3 a single redirect.
- Amount/network/expiry are server-pinned end to end — a developer cannot accidentally build
  an insecure "amount comes from the browser" flow.

## 4. Recommendation (no code changes this phase)
The journey is ~80% smooth; the one true blocker is **G-1/H-1** (webhook verification).
Fix the signing-key handling, then publish quickstart docs for receipts + payment links
(Phase J). Do not expand the SDK surface — it is intentionally thin and that is a feature.
