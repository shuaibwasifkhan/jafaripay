# CCTP Destination Executor — Decision Brief (D-1)

**Status:** PENDING HUMAN / BUSINESS DECISION — **formal owner sign-off outstanding.**
As of the Phase 21 Closure Addendum (§15, 2026-10-06), **Option C is implemented and
live testnet-verified end-to-end**; the decision has narrowed to written confirmation
of C + Circle **mainnet** account-entitlement verification. Sections marked
SUPERSEDED below reflect the pre-implementation state.
**Phase:** 21 closeout artifact. Circle Forwarding follow-up verification appended.
**Author:** Neutral engineering analysis. No executor is selected, funded, or operated by this document; selection requires the owner sign-off recorded in `docs/OPERATOR_RUNBOOK.md` §18.1.

This brief is a factual analysis of how the destination `receiveMessage` transaction on
Arc can be triggered once a source-chain USDC burn has been attested by Circle. It is
written so a business owner can choose among the three pre-existing documented options
without needing to reason about Solidity or CCTP internals. Every claim is labelled:

- **[Repo]** — evidence from the JafariPay repository (file:line).
- **[Circle]** — evidence from official Circle CCTP V2 developer documentation
  (https://developers.circle.com/cctp).
- **[Account Verification Required]** — a fact that cannot be established from
  public documentation and requires confirmation via the JafariPay Circle
  account / developer-support channel.
- **[Unverified]** — external dependency or pricing that this task could not
  confirm from the repository or from Circle's public documentation.

Strictly out of scope for this brief: selecting an option, writing production
code, deploying contracts, creating or funding wallets, broadcasting any
transaction, or negotiating with Circle about account-level eligibility.

---

## 1. Executive Context

JafariPay accepts USDC on 13+ source EVM networks and settles all of it into a single
merchant-held USDC wallet on **Arc** via Circle's Cross-Chain Transfer Protocol (CCTP)
V2. The state machine and workers already run the flow up to the last step: Circle has
produced an attestation, the destination `receiveMessage(bytes message, bytes
attestation)` calldata is built, and the row parks at state `attested` waiting for an
outside party to actually submit it on Arc. [Repo: `server/blockchain/cctp-state.ts`,
`server/blockchain/cctp-destination.ts`, `server/workers/reconciliation.ts`]

That "outside party" is the **destination executor**. Which party plays that role is a
business/ops decision, not a technical one. The current implementation is
deliberately **executor-agnostic** — no JafariPay code signs or broadcasts anything
on Arc — so any of the three options below can be adopted without rewriting the
state machine, the attestation client, or the settlement verification.

---

## 2. Current JafariPay Architecture (as-is facts)

### 2.1 Destination settlement [Repo]
- `server/blockchain/cctp-destination.ts` builds `receiveMessage` calldata, verifies the mint on Arc after an external party broadcasts, and credits the payment. Never signs or broadcasts.
- `settleDestination(...)` performs Arc-side mint verification and atomic DB credit.
- `destinationClaim(...)` exposes `{ to, data, chainId }` for a downstream executor. This is the sanctioned integration seam.

### 2.2 Attestation [Repo]
- `server/blockchain/cctp-attestation.ts` polls Circle Iris (`https://iris-api.circle.com/v2/messages/{domain}?transactionHash=...`), verifies `keccak256(returnedMessage) == cctp_message_id`, parks at `attested` on success.
- `MAX_ATTESTATION_WINDOW_S = 1800` (30 minutes).
- Emits `payment.cross_chain.attestation_received` webhook.

### 2.3 `receiveMessage` calldata [Repo]
- `buildReceiveMessageCalldata(message, attestation)` encodes `receiveMessage(bytes,bytes)`. No recipient argument — `mintRecipient` is baked into the message body.

### 2.4 Worker [Repo]
- `server/workers/reconciliation.ts` `tickCrossChain()` advances finality, requests attestation, and scans Arc for a matching destination tx hash. The worker NEVER broadcasts.
- `recordDestinationClaim(...)` is the single integration point where an external executor reports "I have / will submit the destination tx."
- `DESTINATION_TIMEOUT_S = 3600` — rows parked at `attested` with no destination tx move to `destination_failed`.

### 2.5 Signing / broadcasting capability [Repo]
- No JafariPay-held private key configured for Arc. No code path constructs, signs, or sends a transaction on Arc. No hot wallet exists in `server/`.

### 2.6 DB state [Repo]
- `server/db/cctp.ts` — registry. `destination_caller_bytes32 = bytes32(0)` on every route (line ~279).
- `server/blockchain/cctp-state.ts` — 13 states: `source_payment_submitted → source_finalizing → source_finalized → attestation_pending → attested → destination_pending → destination_submitted → destination_confirmed → settled` plus terminal failures.
- `advanceTransferState` refuses direct-to-`settled`.

### 2.7 Retry / idempotency [Repo, Circle]
- `UNIQUE(destination_tx_hash, destination_network)` on the transfer table.
- `blockchain_transactions` replay check.
- CCTP V2 protocol one-time-use nonce on the destination chain.
- 24-hour `expirationBlock` with re-attestation available via `POST /v2/reattest/{nonce}`. [Circle]

### 2.8 Security tests protecting the executor boundary [Repo]
- `server/cctp-destination.test.ts` P8 series — deterministic calldata, wrong transmitter refused, wrong recipient/amount refused, unattested → no credit, idempotent, storage-replay blocked.
- `server/cctp-intents.test.ts` — refuses non-CCTP sources.
- `server/cctp13-status.test.ts` — merchant-facing status is DB-derived; a malicious executor cannot rewrite it.

### 2.9 Registry facts to preserve [Repo: `server/db/cctp.ts`]
```
destination_caller_bytes32 = 0x0000000000000000000000000000000000000000000000000000000000000000
max_fee                    = 0
min_finality_threshold     = 0
arc_cctp_domain            = 26   // Circle-assigned domain for Arc, not a chain id
token_messenger_mainnet    = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d
message_transmitter_mainnet= 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64
```
`bytes32(0)` is what makes all three options possible without a destination-side code change.

---

## 3. CCTP V2 Destination Execution Flow (Circle docs)

[Circle: developers.circle.com/cctp]

- A source-chain burn emits `DepositForBurn` (or `DepositForBurnWithHook` when a hook is used).
- Circle's attestation service observes finality and signs an attestation over the message body.
- Anyone with `(message, attestation)` calls `MessageTransmitterV2.receiveMessage(message, attestation)`. When `destinationCaller == bytes32(0)`, the call is **permissionless**. [Circle]
- Transmitter verifies attestation, checks `expirationBlock`, checks `usedNonces`, mints USDC to `mintRecipient`, and invokes hooks / forwarding if requested on the source.
- Protocol nonce is one-time-use. [Circle]
- Fee model: Standard (`maxFee = 0`) is 1:1. Fast transfer deducts `maxFee` from the minted principal unless the source supports upfront fees. [Circle]
- Forwarding is triggered by the **source** calling `depositForBurnWithHook` with the `cctp-forward` hook magic bytes; Circle's forwarder then executes the destination leg. Incompatible with `destinationCaller != bytes32(0)`. [Circle]

---

## 4. Option A — JafariPay-Operated Relayer / Executor

**Definition.** JafariPay runs its own worker that signs and broadcasts `receiveMessage` on Arc using a JafariPay-controlled EVM key.

| # | Dimension | Facts |
|---|-----------|-------|
| 1 | Destination settlement flow | After `attested`, JafariPay's own worker calls `destinationClaim(...)`, signs with a JafariPay Arc key, broadcasts, waits for receipt, and lets existing `tickCrossChain` verify and credit. |
| 2 | Who submits `receiveMessage` | The JafariPay relayer process. |
| 3 | Who pays destination gas | JafariPay funds an Arc gas wallet. [Unverified: exact Arc gas-per-tx pricing] |
| 4 | Wallets required | One operational hot wallet on Arc owned by JafariPay. Does not custody merchant USDC. |
| 5 | JafariPay custody of a signing key | **Yes.** Largest change vs today. |
| 6 | Merchant operational responsibility | None for the destination leg. |
| 7 | Required infrastructure | Always-on relayer process; HSM/KMS or env-var key; write-capable Arc RPC; gas float; monitoring. |
| 8 | Failure modes | Relayer downtime (rows park after 1h); key theft (drains gas wallet, cannot alter `mintRecipient`); RPC outage; nonce races (mitigated by DB `UNIQUE(destination_tx_hash)`). |
| 9 | Retry behaviour | Bounded by `DESTINATION_TIMEOUT_S = 3600s`. Retry must re-check attestation still valid (24h `expirationBlock`). [Circle] |
| 10 | Replay / idempotency | Three layers: DB `UNIQUE`, `blockchain_transactions` check, protocol one-time nonce. [Repo, Circle] |
| 11 | Monitoring | New: relayer lag, gas wallet balance, failed broadcast rate, stuck transfers. |
| 12 | Gas management | Requires an Arc funding pipeline. [Unverified: Arc native gas identity] |
| 13 | USDC / native funding | Gas float only. No protocol USDC held by the relayer. |
| 14 | Security boundary | `mintRecipient` inside attested message; relayer cannot redirect mint. |
| 15 | Key management | Env-var plaintext (weakest) / KMS sign-only (recommended) / HSM (strongest). Business/security choice. |
| 16 | Operational complexity | Highest of the three. JafariPay owns 24/7 destination SLA. |
| 17 | Scaling | Linear gas cost per transfer; batch/aggregate not natively supported by CCTP V2. |
| 18 | Merchant onboarding | Zero destination config. |
| 19 | Recovery / incident | Rotate key to a new relayer address; in-flight rows still resolve because `destinationCaller = bytes32(0)`. Stuck rows re-settleable via `recordDestinationClaim`. |
| 20 | Code changes required | New `server/workers/executor.ts`; KMS integration; new env vars; gas-float monitor. Registry and state machine **unchanged**. |
| 21 | Code changes NOT required | CCTP state machine, attestation client, calldata builder, DB schema, mint verification, settlement credit, security tests. |
| 22 | Circle service dependency | Iris attestation API (already used). |
| 23 | Merchant infra dependency | None. |
| 24 | JafariPay infra dependency | New: signer, broadcaster, gas wallet, monitoring, on-call. |

---

## 5. Option B — Merchant / Self Settlement

**Definition.** The merchant (or a relayer the merchant hires) submits `receiveMessage` on Arc using their own account and gas.

| # | Dimension | Facts |
|---|-----------|-------|
| 1 | Destination settlement flow | JafariPay publishes `(message, attestation)` via webhook or API when state = `attested`. Merchant signs and broadcasts on Arc. Existing `tickCrossChain` scans Arc and settles. |
| 2 | Who submits `receiveMessage` | Merchant. |
| 3 | Who pays destination gas | Merchant. |
| 4 | Wallets required | Merchant's existing Arc USDC wallet (or a delegated merchant EOA). |
| 5 | JafariPay custody of a signing key | **No.** Zero change to JafariPay's key surface. |
| 6 | Merchant operational responsibility | High: must run or hire a signer with uptime. Must maintain Arc gas float. |
| 7 | Required infrastructure | JafariPay: existing `payment.cross_chain.attestation_received` webhook fires today. Merchant: their own signer. |
| 8 | Failure modes | Merchant signer offline → row parks at `attested` → `destination_failed` after 1h. Wrong gas/nonce on merchant side is their problem; JafariPay unaffected. |
| 9 | Retry behaviour | Merchant-side. JafariPay re-verification is idempotent (DB unique + protocol nonce). |
| 10 | Replay / idempotency | Same three layers as Option A. Protocol nonce enforces one-time regardless of sender. [Circle] |
| 11 | Monitoring | JafariPay: alert on rows parked at `attested`. Merchant: their own uptime monitoring. |
| 12 | Gas management | Merchant responsibility. JafariPay publishes "how to fund Arc gas" runbook. [Unverified: Arc gas funding rails] |
| 13 | USDC / native funding | Merchant holds both. |
| 14 | Security boundary | JafariPay never touches a signing key. |
| 15 | Key management | Merchant-side. |
| 16 | Operational complexity | Lowest for JafariPay, highest for merchant. |
| 17 | Scaling | JafariPay cost ~0 (RPC reads only). Merchant scales independently. |
| 18 | Merchant onboarding | Adds operational onboarding requirement. |
| 19 | Recovery / incident | Merchant key loss is a merchant incident; JafariPay cannot settle on their behalf. |
| 20 | Code changes required | Small: authenticated GET returning `(message, attestation, destinationChainId, transmitterAddress)`; formalise webhook payload; docs page. **No state machine change.** |
| 21 | Code changes NOT required | Registry, state machine, verification, DB schema, calldata builder, settlement credit, security tests. |
| 22 | Circle service dependency | Iris attestation API (already used). |
| 23 | Merchant infra dependency | Yes — signer, gas wallet, RPC. |
| 24 | JafariPay infra dependency | None new beyond current server + read RPCs. |

---

## 6. Option C — Circle Forwarding

**Definition.** Use Circle's Forwarding Service so Circle's relayer network executes the destination leg for a fixed fee.

| # | Dimension | Facts |
|---|-----------|-------|
| 1 | Destination settlement flow | **Source side changes.** Burn is submitted with `TokenMessengerV2.depositForBurnWithHook(...)` and hook data beginning with `cctp-forward` magic bytes. Circle's forwarder calls `receiveMessage` on Arc; JafariPay observes the mint. [Circle] |
| 2 | Who submits `receiveMessage` | Circle's forwarder. |
| 3 | Who pays destination gas | Circle's forwarder; recovered via the $0.05 forward fee. [Circle] |
| 4 | Wallets required | No new wallets. Merchant still receives at the pinned Arc address. |
| 5 | JafariPay custody of a signing key | **No.** |
| 6 | Merchant operational responsibility | None for the destination leg. |
| 7 | Required infrastructure | Source-side checkout change to call `depositForBurnWithHook` with `cctp-forward` hook bytes. Arc is publicly listed as a Forwarding destination and every JafariPay source mainnet is publicly listed as Forwarding-capable with upfront-fee support. **JafariPay's Circle-account entitlement to invoke the service is not established by public documentation.** [Circle] [Account Verification Required] |
| 8 | Failure modes | Forwarder unavailable → destination never submitted → row parks at `attested` then `destination_failed`. Hook construction wrong → Circle never forwards; the standard path is unavailable because the tx was routed to a forward hook. [Circle] |
| 9 | Retry behaviour | The source tx cannot be "retried" once submitted — it either forwards or does not. Recovery means manual re-settlement or filing with Circle. |
| 10 | Replay / idempotency | Protocol nonce + Circle forward-side dedup. [Circle] |
| 11 | Monitoring | Alert on rows parked at `attested` (`DESTINATION_TIMEOUT_S = 3600s`). Reconcile per-network forward fees. |
| 12 | Gas management | Handled by Circle; JafariPay sees the forward fee on the source side. [Circle] |
| 13 | USDC / native funding | Forwarding fee is **$0.05 USDC per transfer** for "All other forwarding destinations" (Arc qualifies). [Circle] Fee is either (a) **deducted from minted principal** via `maxFee`, breaking 1:1, or (b) **paid upfront** on the source, preserving 1:1 — but only on sources that support upfront fees. All seven currently registered JafariPay source mainnets (Base, Arbitrum, Polygon PoS, Avalanche, OP Mainnet, Linea, Unichain) are listed with upfront fees ✅ in Circle's table. [Circle] |
| 14 | Security boundary | Trust assumption shifts from JafariPay's own signer to Circle's forwarder. |
| 15 | Key management | No key custody. |
| 16 | Operational complexity | Medium. Removes signer + gas ops. Adds fee-model and hook-construction complexity on the source. |
| 17 | Scaling | Circle's forwarder scales on their side; fee is flat per transfer. |
| 18 | Merchant onboarding | Merchant unaffected on the destination leg. Checkout must surface the extra forward fee when not paid upfront. |
| 19 | Recovery / incident | Forwarder stall → Circle support ticket. No JafariPay-side fallback unless Option A or B is retained. |
| 20 | Code changes required | (a) `server/db/cctp.ts` route plan gains `hook_data` and switches to `depositForBurnWithHook`; (b) `server/lib/fees.ts` gains a second fee model (`cctp_forwarding_upfront` and/or `cctp_forwarding_deducted`); (c) checkout SDK constructs the WithHook call and, on upfront-fee routes, collects the additional $0.05 from the customer; (d) `maxFee` on the burn must be sized to cover both protocol + forward fee when not paid upfront; (e) tests updated for the new fee branch and the new source event variant. State machine and settlement verification unchanged. |
| 21 | Code changes NOT required | CCTP state machine, attestation client, destination verification, DB transfer schema, `receiveMessage` calldata builder, `destination_caller_bytes32 = bytes32(0)`. |
| 22 | Circle service dependency | Yes — Circle Forwarding Service. Public supported-chains matrix lists Arc in the Forwarding column and lists every JafariPay registered source as Forwarding-capable with upfront-fee support. [Circle] However, public documentation does **not** describe an account-level enablement process, nor a self-serve toggle, nor an explicit permissionless guarantee. **Account-level entitlement: [Account Verification Required].** |
| 23 | Merchant infra dependency | None. |
| 24 | JafariPay infra dependency | Only the existing source-side checkout / RPC. |

**Correction to prior documentation.** ~~`docs/OPERATOR_RUNBOOK.md` §9 summarises
Option C as "READY because `destination_caller_bytes32 = 0` accepts the Circle
relayer."~~ That statement was only half-true. Permissionless `destinationCaller`
is a **necessary** condition but not a **sufficient** one. Forwarding must be
requested on the **source** call via `depositForBurnWithHook` with the
`cctp-forward` magic bytes and payload. ~~The current codebase uses
`depositForBurn` (no hook), which will not be forwarded even with
`destinationCaller = bytes32(0)`.~~ **[SUPERSEDED — Phase 21 Closure Addendum,
§15: the codebase NOW implements `depositForBurnWithHook` + the `cctp-forward` v0
hook and a real Forwarding application E2E has PASSED.]** [Repo + Circle]

### 6.1 Circle Forwarding — verified facts (D-1 follow-up)

Re-consulted directly against Circle's current CCTP V2 documentation pages:

- Forwarding Service concept — https://developers.circle.com/cctp/concepts/forwarding-service
- Supported blockchains and domains — https://developers.circle.com/cctp/concepts/supported-chains-and-domains
- CCTP overview — https://developers.circle.com/cctp

Findings:

1. **Product availability.** [Circle] The Forwarding Service is documented as a
   standard CCTP capability, invoked purely on-chain via
   `TokenMessengerV2.depositForBurnWithHook`. Public documentation does not
   describe an enablement form, an account-tier gate, a signed agreement, or a
   dashboard toggle. It also does not state that the service is unconditionally
   permissionless. Any claim about **JafariPay's specific Circle account**
   entitlement therefore cannot be sourced from public documentation.
   **Status: [Account Verification Required].**

2. **Arc as a Forwarding destination.** [Circle] Arc is listed in the
   "Forwarding Service" column of the supported-chains table (✅) and carries
   domain 26. **Status: VERIFIED via public documentation.**

3. **JafariPay source networks and Forwarding eligibility.** [Repo + Circle]
   Cross-checking every `CCTP_REGISTRY` mainnet source in `server/db/cctp.ts`
   against Circle's table:

   | JafariPay slug | Circle chain | Domain | Upfront fees | Listed as Forwarding-capable chain |
   |---|---|---|---|---|
   | `base_mainnet` | Base | 6 | ✅ | ✅ |
   | `arbitrum_one` | Arbitrum | 3 | ✅ | ✅ |
   | `polygon_pos` | Polygon PoS | 7 | ✅ | ✅ |
   | `avalanche_c` | Avalanche | 1 | ✅ | ✅ |
   | `op_mainnet` | OP Mainnet | 2 | ✅ | ✅ |
   | `linea` | Linea | 11 | ✅ | ✅ |
   | `unichain` | Unichain | 10 | ✅ | ✅ |

   All seven registered production source mainnets are documented to support
   upfront fees and appear in the Forwarding column. The testnet pilot uses
   `base_sepolia` (domain 6); Circle's note says "If a mainnet is listed, its
   official testnet is also supported," so Base Sepolia inherits both. The one
   documented exception on testnets is Monad (upfront fees unavailable on Monad
   Testnet); Monad is not in JafariPay's registry.
   **Status: VERIFIED via public documentation.**

   Note: Ethereum is listed in Circle's Forwarding and Upfront-fees columns but
   is **not** currently in the JafariPay `CCTP_REGISTRY` mainnet sources;
   adding it later would not change the eligibility pattern.

4. **Hook requirement.** [Circle] Forwarding is invoked by calling
   `depositForBurnWithHook` on the source `TokenMessengerV2`. Hook data must
   begin with the reserved 24-byte magic `cctp-forward`. Two encodings are
   documented:
   - **v1 (composable framing)** — 24-byte magic + `uint32` version `1` +
     `uint32` payload length + payload. Multiple frames may be concatenated;
     custom hooks must be their own complete frame, not raw bytes appended.
   - **v0 (single-hook framing)** — 24-byte magic + `uint32` version `0` +
     `uint32` length of additional Circle data (typically `0`) + optional
     developer-defined bytes. For EVM destinations with no extra data, the
     docs provide a static hex blob:
     `0x636374702d666f72776172640000000000000000000000000000000000000000`.

   **Status: VERIFIED via public documentation.**

5. **Hook / `destinationCaller` interaction.** [Circle] The docs state
   "Forwarding Service doesn't support forwarding to wrapper contracts (for
   example, when `destinationCaller` is set)." JafariPay's registry pins
   `destination_caller_bytes32 = bytes32(0)` on every route. [Repo:
   `server/db/cctp.ts` line ~279] **Status: compatible with the current
   registry.**

6. **Fee charging.** [Circle] Circle publishes a fixed service-fee schedule.
   For a forward to Arc the applicable row is **"All other forwarding
   destinations — $0.05 USDC"**. The Forwarding fee covers destination-chain
   gas plus a small service margin; Circle does not refund excess gas but also
   does not retain it (except for rejected priority fees). If `maxFee` is
   insufficient to cover both Fast Transfer and Forwarding fees, CCTP
   prioritises Forwarding and executes as Standard + Forwarding.
   **Status: VERIFIED via public documentation.**

7. **Fee payment mode.** [Circle] Two ways to pay the Forwarding fee are
   documented:
   - **Deducted from the transfer** — the fee is taken from the minted
     principal via `maxFee`; the destination wallet receives
     `amount - feeExecuted` on Arc.
   - **Paid upfront on the source chain** — supported on every blockchain
     marked ✅ in the "Source (Upfront fees)" column, which includes all
     seven JafariPay registered source mainnets (see 3). Upfront fees apply
     to USDC transfers only.

   **Status: VERIFIED via public documentation.**

8. **1:1 (exact-amount) compatibility.** [Repo + Circle] JafariPay's
   `cctp_standard_1to1` fee model commits to gross-burned == net-minted. This is
   preserved under Option C **only** if the source pays the forward fee
   upfront so the minted principal is not reduced. ~~Because all seven
   registered sources support upfront fees per the public Circle matrix, 1:1
   preservation is documented as technically achievable on every current
   source — but JafariPay's checkout code does not yet implement the upfront
   fee path. **Status: REQUIRES CODE CHANGE.**~~ **[SUPERSEDED — IMPLEMENTED +
   TESTNET-VERIFIED: §15.]** The upfront path is live: F is quoted per-intent
   from Circle's fee API (`server/blockchain/cctp-forwarding-fee.ts`,
   fail-closed if unavailable), the customer burns gross `M + F` via
   `depositForBurnWithHook`, and the merchant is credited exactly `M`. The E2E
   proved it: M=1,000,000, F=21,527, gross 1,021,527, merchant credit 1,000,000.

9. **Account-level entitlement indicator.** [Circle] Public documentation does
   not describe a dashboard, an API endpoint, or a self-serve flag that would
   let JafariPay programmatically confirm its own account's Forwarding
   eligibility for a specific route pair. **Status: [Account Verification
   Required].** The exact action to obtain confirmation is a business /
   onboarding question: contact Circle via the account manager or
   developer-support channel associated with the JafariPay Circle account;
   ask specifically about Forwarding Service entitlement for each
   `(sourceDomain → destinationDomain=26)` pair listed in section 3 above;
   ask whether any product-level enablement, agreement, or tier change is
   required. That outreach is outside the scope of this repository task.

### 6.2 What remains UNVERIFIED for Option C after this follow-up

- Whether JafariPay's specific Circle account is entitled to invoke Forwarding
  on any (or all) of the seven registered source networks.
  **[Account Verification Required]**
- Whether Circle's product team requires a separate signed agreement, tier
  change, or onboarding call before Forwarding works for JafariPay's API keys
  / sender addresses. **[Unverified — not addressed in public docs]**
- Whether Circle applies any rate limits or throughput caps to the Forwarding
  Service per account. **[Unverified — not addressed in public docs]**

The public supported-chains matrix and the fee table are **capability facts**
about the CCTP protocol; they are **not** statements about any single
integrator's account status and must not be read as such.

---

## 7. Security Comparison

| Concern | Option A | Option B | Option C |
|---|---|---|---|
| Private key custody | JafariPay custodies Arc key | Merchant custodies own key | No new key custody |
| Hot-wallet exposure | Yes | Merchant-side, not JafariPay | None |
| Signer isolation | Required | Merchant's choice | N/A |
| Least privilege | Executor signs only `receiveMessage`; cannot alter `mintRecipient` | Same property | Circle's forwarder is a permissionless caller under `bytes32(0)` |
| Gas wallet compromise | Drains JafariPay float; cannot redirect mint | Merchant absorbs | Not applicable to JafariPay |
| Merchant wallet compromise | Merchant incident | Merchant incident | Merchant incident |
| Replay protection | DB `UNIQUE` + `blockchain_transactions` + protocol nonce [Repo, Circle] | Same layers | Same layers + Circle forward dedup |
| Duplicate `receiveMessage` | Second attempt reverts at protocol nonce [Circle] | Same | Same |
| Malicious `destinationCaller` | Pinned `bytes32(0)` [Repo] | Same | Same |
| Message / attestation tampering | `verifyDestinationMint` refuses mismatch [Repo: P8-9] | Same | Same |
| RPC compromise (JafariPay's) | Cannot forge mint (independent read) | Merchant's RPC is merchant's risk | Circle's internal RPCs |
| Relayer downtime | Rows park to `destination_failed` after 1h | Merchant-side outage; JafariPay state safe | Forwarder outage → Circle incident; no self-relay path unless Option A/B retained |
| Stuck settlements | Manual rebroadcast via `recordDestinationClaim` | Merchant rebroadcasts | Circle support loop |
| Insufficient native gas | Relayer blocks | Merchant absorbs | Not applicable to JafariPay |
| Insufficient USDC (fee) | N/A (Standard, maxFee=0) | Same | Applies — forward fee must be paid upfront or deducted; 1:1 preserved only on upfront-fee sources (all 7 registered sources qualify per public Circle docs) [Circle] |
| Webhook / payment state mismatch | P8 + P13 tests prevent executor callback from rewriting merchant status | Same | Same |

---

## 8. Operational Comparison

| Dimension | Option A | Option B | Option C |
|---|---|---|---|
| 24/7 on-call required by JafariPay | Yes | No | No (but Circle incident response is out of JafariPay's control) |
| Merchant operational burden | Zero | High (must run signer) | Zero |
| New external vendors | None (self-run) or KMS/HSM | None | Circle Forwarding Service [Account Verification Required] |
| Merchant onboarding friction | None | Requires technical merchant | None |
| Recovery from stuck row | JafariPay self-serves | Merchant self-serves | Circle support loop |
| Fee predictability | Gas only | Gas only (merchant absorbs) | $0.05/forward + gas [Circle] |
| Exact-amount guarantee preserved | Yes (1:1 standard) | Yes | Only when paid upfront; all 7 registered sources support upfront per Circle table |

---

## 9. Infrastructure Requirements

| Item | Option A | Option B | Option C |
|---|---|---|---|
| JafariPay Arc RPC (write / broadcast) | Required | Not required | Not required |
| JafariPay-held gas float | Required | Not required | Not required |
| KMS / HSM | Recommended | Not required | Not required |
| Always-on relayer process | Required | Not required | Not required |
| Circle Forwarding Service entitlement | Not required | Not required | **[Account Verification Required]** — public docs list Arc and all 7 JafariPay sources as Forwarding-capable but do not describe account-level enablement |
| Merchant-side signer | Not required | Required | Not required |
| Merchant-side Arc gas | Not required | Required | Not required |
| Frontend / SDK: `depositForBurnWithHook` | Not required | Not required | Required change |
| Fee-model change | Not required | Not required | Required (`server/lib/fees.ts` branch for upfront vs deducted) |
| Monitoring (park rate + gas float) | Required | Optional (merchant-visible status) | Required (park rate) |

---

## 10. Cost Considerations

| Cost element | Option A | Option B | Option C |
|---|---|---|---|
| Destination `receiveMessage` gas on Arc | Paid by JafariPay | Paid by merchant | Paid by Circle (recovered in forward fee) |
| Arc per-tx gas cost | **Pricing not verified.** No production tx exists in this repository. | Same | Same |
| Circle Forwarding fee | N/A | N/A | $0.05 USDC per transfer for "All other forwarding destinations." [Circle] |
| Circle Iris attestation API | Free public endpoint. Rate limit documented by Circle. | Same | Same |
| KMS / HSM operational cost | External — provider pricing **not verified.** | N/A | N/A |
| Merchant engineering cost | N/A | Ongoing signer + gas ops | N/A |
| Source-chain gas for burn | Borne by customer/merchant checkout today | Same | Same + forward fee |

**Note on 1:1 fee preservation.** Any option that introduces a deduction from
the minted principal (Fast transfer `maxFee`, Forwarding without the upfront
path) breaks the `cctp_standard_1to1` promise in `server/lib/fees.ts`. That is
a business-model change, not just a technical one, and must be surfaced to
merchants and to the checkout UI. [Repo + Circle]

---

## 11. Current Code Impact per Option

### 11.1 Option A — JafariPay relayer
Files that would change (production code) — NOT done by this task:
- New: `server/workers/executor.ts` (sign + broadcast + submit hash)
- New: KMS / signer integration module
- Modified: `server/index.ts` — register executor worker
- Modified: `server/env.ts` (or equivalent config surface) — new env vars
- New: gas-float monitor + alert rule
- New: runbook section (executor rotation, incident playbook)

Files that would NOT change: `server/db/cctp.ts`, all `server/blockchain/cctp-*.ts`, `server/lib/fees.ts`, existing tests.

### 11.2 Option B — Merchant self-settlement
Files that would change:
- New: authenticated GET endpoint returning `(message, attestation, transmitterAddress, destinationChainId)` for a specific transfer row
- New: `docs/MERCHANT_DESTINATION_EXECUTOR.md` runbook
- Modified: webhook payload shape if not already carrying `(message, attestation)`

Files that would NOT change: state machine, registry, verification, DB schema, fees, calldata builder, tests.

### 11.3 Option C — Circle Forwarding
Files that would change ~~(production code) — NOT done by this task~~ **[DONE —
implemented and testnet-verified, see §15]**:
- ~~`server/db/cctp.ts` — add `hook_data` field on `cctpSourceRoutePlan`; switch call site to `depositForBurnWithHook`; size `max_fee` for either upfront or deducted mode.~~ **DONE** (`hook_data` = `cctp-forward` v0 blob; `depositForBurnWithHook`; upfront mode only — `maxFee` = quoted F, fail-closed).
- ~~Checkout SDK / `src/**` — construct the WithHook call with `cctp-forward` framed bytes; collect the additional forward fee upfront on upfront-fee sources; show fee transparency in UI.~~ **DONE** (burn target = M + server-quoted F; client cannot set F).
- ~~`server/lib/fees.ts` — add second fee model.~~ **DONE** (forwarding fee model in `server/blockchain/cctp-forwarding-fee.ts` + fees wiring; `payment_intents.forwarding_max_fee_base_units` is server-authored-only).
- ~~`server/blockchain/cctp-source.ts` — parse `DepositForBurnWithHook` event variant.~~ **DONE** (correct V2 event layout).
- ~~Tests: new fee-model coverage; new source-event coverage.~~ **DONE** (`cctp-forwarding-fee.test.ts`, `cctp-forwarding-attestation-5nfix.test.ts`, + full application E2E).

Files that would NOT change: state machine, `destination_caller_bytes32 = bytes32(0)`, `cctp-destination.ts`, `cctp-attestation.ts`, `recordDestinationClaim`, DB transfer schema.

---

## 12. Decision Questions the Business Owner Must Answer

Answering each is what closes D-1. These are neutral questions.

1. Who should operate the destination executor — JafariPay, the merchant, or Circle's forwarder?
2. Who should pay destination gas — JafariPay, the merchant, or end-customer via checkout fee?
3. Is JafariPay willing to custody and rotate an Arc signing key in production? If yes, under what KMS/HSM/SoD model?
4. Is 24/7 on-call acceptable to JafariPay operations (Option A)?
5. Is merchant self-settlement operationally acceptable to the target merchant segment?
6. Must `cctp_standard_1to1` exact-amount remain a hard contract to merchants? (Directly shapes how Option C must be implemented — upfront fee path vs deducted path.)
7. Is Circle Forwarding actually available for **JafariPay's Circle account** on every registered source AND for Arc as destination? Public documentation confirms the protocol-level capability but does not confirm account-level entitlement. **[Account Verification Required]**
8. What merchant-facing SLA is required for `attested → settled`?
9. What is the acceptable blast radius of a 1-hour destination stall (existing `DESTINATION_TIMEOUT_S`)?
10. Do we want defense-in-depth (operate Option A as a fallback while shipping Option B or C as primary)?
11. What is our compliance position on JafariPay operating a hot wallet?
12. Are we willing to accept per-transfer operational cost that scales linearly with volume (A) vs a fixed $0.05 forward (C) vs zero (B)?

---

## 13. Open Dependencies

| Dependency | Blocks | Status |
|---|---|---|
| Production Arc RPC (write) | A | Provisioned list exists in `docs/PRODUCTION_GO_LIVE_READINESS.md`; final provider selection pending. |
| Production Arc RPC (read-only verification) | A, B, C | Same as above. |
| KMS / HSM selection and access | A | Pending. |
| Circle Forwarding Service account entitlement (all registered sources → Arc domain 26) | C | **[Account Verification Required — MAINNET]** — public documentation lists Arc in the Forwarding column and lists all 7 JafariPay source mainnets as Forwarding-capable with upfront-fee support; account-level entitlement is not addressed in public documentation. Testnet (Base Sepolia → Arc Testnet) Forwarding has been exercised successfully by this repository; that does NOT prove mainnet entitlement. |
| Arc native gas token identity (USDC vs native) | A, B | **Unverified.** No production tx in this repository. |
| Per-transaction Arc gas cost (mainnet) | A, B | **Pricing not verified.** No production tx in this repository. |
| Merchant-facing status contract for `attested → settled` | A, B, C | Design pending. |
| Webhook payload shape carrying `(message, attestation)` | B | Audit pending in `server/api/webhooks*.ts`. |
| JafariPay upfront-fee implementation path in checkout SDK | C | ~~Not yet implemented~~ **[SUPERSEDED — IMPLEMENTED + TESTNET-VERIFIED (§15).]** Fee is quoted live per intent from Circle and burned upfront on the source (gross M+F); merchant nets exactly M. |

---

## 14. References

### Repository evidence
- `server/db/cctp.ts` — CCTP registry; `destination_caller_bytes32 = bytes32(0)`, `max_fee = '0'`, `min_finality_threshold = 0`; per-source `CCTP_REGISTRY` (Base, Arbitrum, Polygon PoS, Avalanche, OP Mainnet, Linea, Unichain, Base Sepolia testnet, Arc destination).
- `server/blockchain/cctp-destination.ts` — calldata builder, mint verifier, settlement credit.
- `server/blockchain/cctp-attestation.ts` — Circle Iris polling, keccak256 message-id verification, 30-min window.
- `server/blockchain/cctp-state.ts` — 13-state machine, terminal states, legal transitions.
- `server/blockchain/cctp-source.ts` — source burn detection, finality evaluation, message parsing.
- `server/workers/reconciliation.ts` — `tickCrossChain`, `recordDestinationClaim`, `DESTINATION_TIMEOUT_S = 3600`.
- `server/lib/fees.ts` — `cctp_standard_1to1` fee model.
- `server/cctp-destination.test.ts` — P8 executor-boundary security tests.
- `server/cctp-intents.test.ts` — intent creation refuses non-CCTP sources.
- `server/cctp13-status.test.ts` — status projection is DB-derived.
- `docs/PRODUCTION_GO_LIVE_READINESS.md` — Phase 21 readiness pack; §6 executor options.
- `docs/OPERATOR_RUNBOOK.md` §9 — operator view of the executor decision.

### Official Circle documentation
- CCTP overview: https://developers.circle.com/cctp
- Forwarding Service concept (hook format v0/v1, fee table, upfront-fee note, `maxFee` sizing warning): https://developers.circle.com/cctp/concepts/forwarding-service
- Supported blockchains and domains (Arc ✅ Forwarding; upfront-fees columns for Base/Arbitrum/Polygon/Avalanche/OP Mainnet/Linea/Unichain/Ethereum/Arc): https://developers.circle.com/cctp/concepts/supported-chains-and-domains
- Technical guide (`receiveMessage`, `destinationCaller`, nonce replay, expiration): https://developers.circle.com/cctp/references/technical-guide

### Unverified / external
- Arc native gas token identity on mainnet. **[Unverified]**
- Per-transaction Arc gas cost on mainnet. **[Unverified]**
- JafariPay Circle-account entitlement to invoke Forwarding on any route pair. **[Account Verification Required]**
- Whether Circle requires a signed agreement / tier change for Forwarding on JafariPay's account. **[Account Verification Required]**
- Any per-account rate limits or throughput caps applied by Circle's Forwarding Service. **[Unverified]**
- KMS / HSM vendor pricing (relevant only if Option A is selected). **[Unverified]**

---

## Decision Matrix (factual, no scoring)

| Dimension | Option A — JafariPay relayer | Option B — Merchant self-settlement | Option C — Circle Forwarding |
|---|---|---|---|
| Who submits `receiveMessage` | JafariPay process | Merchant process | Circle forwarder |
| Who pays destination gas | JafariPay | Merchant | Circle (recovered in forward fee) |
| New JafariPay-held keys | Yes (one Arc signing EOA) | No | No |
| New merchant operational burden | No | Yes | No |
| Exact-amount 1:1 preserved | Yes | Yes | Yes if paid upfront; no if deducted. All 7 registered sources support upfront per Circle [Circle] |
| `destination_caller_bytes32` must change | No | No | No (`bytes32(0)` remains compatible; forwarding requires unset caller) |
| Source-side code change required | No | No | Yes — `depositForBurnWithHook`, hook payload, fee model |
| Destination-side code change required | Yes — new signing + broadcasting worker | Optional — API to fetch message/attestation | No |
| State machine change | No | No | No |
| DB schema change | No | No | Registry field addition (`hook_data`), no change to transfer schema |
| Circle service dependency beyond Iris | No | No | Yes — Circle Forwarding Service [Account Verification Required for entitlement] |
| Merchant can be non-technical | Yes | No | Yes |
| JafariPay on-call scope grows | Yes | No | No (but adds Circle incident dependency) |
| Fee predictability | Gas only | Gas only (merchant absorbs) | Fixed $0.05 forward [Circle] + gas |
| Blast radius if this option is unavailable | Rows park to `destination_failed` after 1h | Merchant-side; JafariPay state safe | Rows park to `destination_failed` after 1h; no JafariPay self-relay fallback for hook-routed messages |
| Recovery path for stuck settlement | Manual rebroadcast by JafariPay | Merchant rebroadcast | Circle support ticket |
| Fallback compatibility | Can be run alongside B or C | Can be run alongside A or C | Not trivially combinable with A/B because it changes the source call shape |

---

## 15. Phase 21 Closure Addendum (2026-10-06) — Option C IMPLEMENTED + TESTNET-VERIFIED

Since this brief was written, **Option C (Circle Forwarding) has been fully implemented
in the repository and verified by a real application E2E** on Base Sepolia → Arc Testnet
via Circle's sandbox. Read-only evidence (DO NOT re-run or touch):

```
payment_intent : pi_s3djmmlvuac03cvusbaoznwh
M              : 1,000,000 base units (merchant credit — exactly M, not M+F)
F (forward fee): 21,527 base units (quoted LIVE from Circle fee API at intent time)
gross burn     : 1,021,527  (depositForBurnWithHook + cctp-forward v0 hook)
source tx      : 0x421af175e5546d2d1fa90b8d1839e23cd1eb0d3b5692b4878273faf07ec19f1b (Base Sepolia)
CCTP message id: 0x79df0653ee162a17011a6af7306e8339dddfd156e75b1455d8d17ac2ab20d911
forwardTxHash  : 0x180774aff0b969f5628d82abd5f9119a0e7b14d1b481b344de6fbdec9b5f35b6 (Arc Testnet — executed by Circle's forwarder, not by JafariPay)
intent status  : succeeded | exactly-one-burn: YES | idempotent: YES
```

Verified against this brief's own criteria:

| Brief claim | Outcome |
|---|---|
| §6 "current codebase uses `depositForBurn` (no hook)" | **SUPERSEDED** — `depositForBurnWithHook` + 24-byte `cctp-forward` v0 hook (`server/blockchain/cctp-forwarding-fee.ts`) is live in the checkout path |
| §6.1(8) upfront-fee 1:1 path "REQUIRES CODE CHANGE" | **SUPERSEDED — IMPLEMENTED.** F quoted per-intent from Circle (`/v2/burn/USDC/fees/{src}/{dst}?forward=true`, Standard ≥ 2000 finality entry), fail-closed (no quote → no intent); `payment_intents.forwarding_max_fee_base_units` server-authored-only; merchant nets exactly M |
| §6.1(5) hook/`destinationCaller` compatibility | **CONFIRMED on-chain** — `bytes32(0)` retained; Circle's forwarder executed the destination leg |
| Correct Forwarding attestation semantics | **VERIFIED** — returned message keccak == `cctp_message_id`; corrected in `cctp-forwarding-attestation-5nfix.test.ts` + live E2E |
| §12 Q6 (exact-amount hard contract) | **Technically answered YES by implementation** — policy confirmation still belongs to the owner |
| §6.1(1)/(9), §13 entitlement rows | **STILL OPEN [Account Verification Required]** — mainnet entitlement for JafariPay's Circle account; testnet success ≠ production entitlement |

**What D-1 now requires to close (nothing else):**

1. **HUMAN DECISION:** accountable owner records written approval of **CIRCLE
   FORWARDING** (Runbook §2 / §18.1 sign-off line "Executor model: ___"). No code
   work remains for C.
2. **EXTERNAL:** Circle mainnet account-entitlement confirmation for Forwarding on the
   chosen source→Arc(26) pair(s), via the JafariPay Circle account / developer-support
   channel (§6.1 item 9 outreach script). **[Account Verification Required]**

Options A and B remain documented, unselected, and (for A) unimplemented; that is
unchanged and requires no action while C is the evidence-supported choice.

---

## Final Note

This brief documented the three pre-existing options; the Phase 21 Closure Addendum
(§15) records that **Option C is now implemented and live testnet-verified**, leaving
D-1 narrowed to: (a) the business owner's written confirmation, and (b) Circle
**mainnet** account-entitlement verification — neither of which can be resolved from
this repository. Gas-cost ownership, key-custody posture, and merchant technical
capability questions (§12) are all answered in favor of C by the current implementation
+ evidence, subject to that same sign-off. Until the sign-off and Circle mainnet
confirmation exist, D-1 remains formally OPEN and the system continues to run
executor-agnostic as designed.
