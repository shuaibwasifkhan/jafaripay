# Phase J — Documentation Audit (what must change, and when)

> This is an **inventory of doc updates**, not a rewrite. Per the spec, the public
> website redesign is intentionally **not** performed in this phase. Nothing here makes a
> marketing claim; every line is classified **implemented-in-repo / planned / blocked**,
> and production availability is only asserted where a deploy actually happened (none did
> this phase).

Sources of truth for accuracy: the working tree, the all-native-USDC multi-chain
certification report (authoritative for network status), and Circle's live docs (for CCTP).

## 1. Concrete inaccuracies / staleness to fix (highest value first)

1. **Webhook verification guidance is wrong (README §Webhooks L135, in-app
   `/docs` → Webhook Verification, SDK docs).** Both tell the merchant to "verify with your
   endpoint secret" (`whsec_…`), but the delivery engine signs with `secret_hash` (see Phase
   H **H-1**). Until H-1 is fixed, docs describe a procedure that cannot succeed. **Action:**
   fix the code first (human decision), then the docs; do NOT paper over it in docs alone.
2. **"Roadmap items (Payment Links, …) are NOT currently available" (README L45) is now
   partially stale at the repo level.** Receipts (Phase B) and a Payment Link MVP (Phase C)
   are **implemented in the working tree** with tests + public pages, but **not deployed**
   (no deploy this phase). **Action:** on next deploy, split into *implemented-in-repo* vs
   *live-on-jafari.co.in*; keep "not available [in production]" accurate until deploy.
3. **Network support: README is Arc-only, the cert report is multi-chain.** README
   "Live capabilities" and "Arc integration" list only Arc Testnet/Mainnet, while the
   repository carries a registry-backed `network_configs` table and the certification report
   records 13 EVM enabled / 11 non-EVM blocked (Cronos demoted). **Action:** reconcile the
   "supported network matrix" against the **report** (authoritative) — do not inflate beyond
   it; state testnet vs mainnet and per-network production-RPC status explicitly.
4. **Reconciliation view (Phase F) is undocumented.** `GET /v1/payments/:id` now returns
   `verification_state`, `receipt`, `webhook_deliveries`, `payment_link_id`, `usdc_address`,
   `currency`. **Action:** add to API Reference + "payment flow" docs once shipped.

## 2. Update targets (map: what → where → status)

| Doc target | What needs to change | Class |
|---|---|---|
| `README.md` | Add Receipts + Payment Links (repo vs prod), network matrix from report, Phase F fields, corrected webhook section | planned (post-deploy) |
| In-app `/docs` (`src/components/docs/DocsPage.tsx`) | Receipts quickstart, Payment Links quickstart, webhook-verify fix, reconciliation reference | planned |
| API Reference | `POST /v1/payment-links`, `GET /pay/:id`, `GET /api/receipts/:id`, enriched `GET /v1/payments/:id` | implemented-in-repo |
| SDK docs | No SDK surface change (Phase G: keep thin). Just note receipts/links are served by hosted pages, not the SDK | no-change |
| Payment-flow docs | Add post-verification receipt step + email-status isolation | implemented-in-repo |
| Supported-network matrix | Mirror cert report exactly (13 EVM enabled / 11 blocked / Cronos demoted / production-RPC-pending) | blocked (needs prod RPC) |
| Architecture docs | Link the new `router-cctp-feasibility.md` + `agent-payments-architecture.md` as *design, not built* | planned/design |
| Roadmap (jafari.co.in/roadmap) | Mark Receipts + Payment Links "in development/implemented-in-repo"; keep Router/CCTP/Agent as research | planned |
| Canteen Showcase description | **Not touched this phase** — depends on deploy + real demo data | blocked (deploy) |
| SEO / positioning | Defer; no broad claims ("universal/any network") until multi-chain prod RPC + any router actually ship | blocked |

## 3. Implemented vs planned vs blocked (doc-relevant snapshot)

- **Implemented in-repo (tested, not deployed):** receipts (B), payment links (C),
  reconciliation enrichment (F), public `/receipt/:id` + `/pay/:id` pages, checkout email
  capture, 39 new tests (403/0 green).
- **Planned (design only, code not written):** Payment Router abstraction (D), agent/M2M
  `402` pattern (E), merchant network/settlement preference object (G-3).
- **Blocked on human/real-money/infra decisions:** CCTP cross-chain settlement (needs
  custody/relayer/funding decision + real keys + prod RPC), webhook-signature fix (touches
  credential storage, H-1), production network enablement (needs production RPC), website
  redesign/deploy.

## 4. What NOT to write (guards)
- No claim that cross-chain routing / "settle anywhere" exists — it does not (Phase D).
- No "AI/agent payments are live" — only the primitives exist (Phase E).
- No network list beyond the certification report; testnet ≠ mainnet.
- No instructions that imply the merchant can verify webhooks today (H-1 unfixed).
