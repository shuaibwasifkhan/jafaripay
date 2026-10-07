# JAFARIPAY — PRODUCTION GO-LIVE READINESS PACK (PHASE 21)

Status: **DOCUMENT ONLY — NO CODE CHANGES, NO ACTIVATION, NO TRANSACTIONS.**
Date: 2026-10-01 — **Phase 21C closure update appended 2026-10-06** (see §0; all
prior statements about CCTP Forwarding being unimplemented/unexercised are SUPERSEDED).
**Real-mainnet UAT close-out appended 2026-10-07** (see §0A — PRODUCTION CCTP FORWARDING
E2E — PASS; it supersedes the "never executed on mainnet" framing in §11).
Purpose: A precise, evidence-based operational readiness pack for the human/infrastructure
team performing the Phase 21 go-live. Every claim cites a repository file.

---

## 0. Phase 21C Closure Update (2026-10-06) — VERIFIED EVIDENCE

Since this pack was written, the CCTP **Forwarding** workstream has been implemented
and verified end-to-end. The following are CLOSED (do-not-reopen) facts:

| Gate | Result | Evidence |
|------|--------|----------|
| CCTP V2 Forwarding implementation | **PASS** | `server/blockchain/cctp-forwarding-fee.ts` (Circle fee quote, fail-closed), `depositForBurnWithHook` + `cctp-forward` v0 hook wired server-side, `payment_intents.forwarding_max_fee_base_units` server-authored-only |
| Forwarding fee calculation | **PASS** | Quoted from Circle's `/v2/burn/USDC/fees/{src}/{dst}?forward=true` Standard(2000) entry; Circle's documented formula applied verbatim; F is never client-chosen and never defaulted to 0 |
| V2 `DepositForBurn` ABI/parser | **PASS** | Correct V2 event layout parsed (`server/db/cctp.ts` message offsets, `cctp-source.ts`) |
| Forwarding attestation semantics | **PASS** | Corrected Circle-forwarding attestation verification (returned message keccak == `cctp_message_id`, Standard finality ≥ 2000 gate) |
| Real Base Sepolia → Arc Testnet Forwarding | **PASS** | Circle's forwarder executed `receiveMessage` on Arc Testnet; destination tx observed and verified |
| Real APPLICATION E2E (full pipeline) | **PASS** | intent → checkout → real burn → verify → worker → Circle attestation → forwardTxHash → Arc mint → settlement → payment `succeeded` |
| Exactly-one-burn certification | **PASS** | One and only one source burn for the E2E intent |
| Idempotency certification | **PASS** | Re-settle / re-attestation paths produce no duplicate credit (R-series + P15 tests) |
| Merchant received exactly M (not M+F) | **PASS** | E2E: M = 1,000,000 credited while gross burn was M+F = 1,021,527 |
| Brevo SMTP (D-4) | **PASS** | Implemented + live delivery to Zoho inbox verified (unchanged from §9) |
| Full automated suite | **PASS** | **711 pass / 0 fail / 4785 expect() / 41 files**; typecheck EXIT=0; build PASS; lint clean |

**Latest fresh application E2E evidence (live Base Sepolia → Arc Testnet, Circle sandbox):
DO NOT TOUCH — read-only historical evidence:**

```
payment_intent : pi_s3djmmlvuac03cvusbaoznwh
M              : 1,000,000 base units
F (forward fee): 21,527 base units (Circle live quote at intent time)
gross burn     : 1,021,527
source tx      : 0x421af175e5546d2d1fa90b8d1839e23cd1eb0d3b5692b4878273faf07ec19f1b (Base Sepolia)
CCTP message id: 0x79df0653ee162a17011a6af7306e8339dddfd156e75b1455d8d17ac2ab20d911
forwardTxHash  : 0x180774aff0b969f5628d82abd5f9119a0e7b14d1b481b344de6fbdec9b5f35b6 (Arc Testnet, executed by Circle's forwarder)
merchant credit: 1,000,000 (exactly M)
intent status  : succeeded | exactly-one-burn: YES | idempotent: YES
```

(A prior direct-forwarding probe also succeeded — `e2e_forwarding.log`, F=19,872,
forward tx `0x09eae1e8398d0350a10f1d59462ba56d867c49160c1008fcf547142b3c33dc0f`
at Arc Testnet block 65577812, minted exactly 1,000,000 to the pinned recipient.)

**Still NOT closed by this evidence:**

- **External merchant webhook delivery was NOT exercised by the application E2E**
  — the test merchant had **zero webhook endpoints**, so no external POST left the
  system. The internal event/outbox path (payment_events + webhook_deliveries
  enqueue) and the full signing/retry/idempotency matrix ARE verified locally
  (Phase L W1–W26). External delivery to a live merchant endpoint remains a
  go-live smoke-test item (§11 / Runbook §13).
- **D-1 formal approval:** the evidence now supports **CIRCLE FORWARDING (Option C)**
  as the executor model — it is implemented and testnet-verified. The accountable
  owner's written sign-off is still REQUIRED before production (§6, §14, Runbook §2),
  together with Circle **mainnet** account-entitlement confirmation for Forwarding
  (testnet success does not by itself prove production entitlement —
  `docs/CCTP_EXECUTOR_DECISION_BRIEF.md` §6.1/§15).
- Production RPCs, secrets, hosting, TLS, durable DB, monitoring: unchanged
  (human/infrastructure items, §14–§15).

**Engineering hardening added at closure (safe, local, fail-closed):** a production
boot config validator (`server/lib/production-config.ts`, wired into `server/index.ts`)
now refuses production startup on incomplete origin/TLS config, half-wired Brevo
credentials, proxy enabled without token, testnet E2E signer keys present in a
production env, or a malformed `ENABLE_LIVE_PAYMENTS` value. The live-payments gate
is now strictly `=== 'true'` (previously ANY non-empty string — including `false`
— enabled live mode). CORS localhost fallbacks are dev-only. Covered by 15 new
`production-config.test.ts` cases + webhook retry-ladder test W26.

---

## 0A. PRODUCTION CCTP FORWARDING E2E — PASS (2026-10-07) — REAL MAINNET EVIDENCE

> **PRODUCTION CCTP FORWARDING E2E — PASS**, recorded 2026-10-07. Base **Mainnet** →
> Arc **Mainnet**, real USDC, Circle **production** attestation, Circle's production
> forwarder executing the destination leg. This is the first real-money execution of the
> §11 "Cross-Chain CCTP Payment" procedure.
>
> **Evidence tier — do not confuse the three:** §0's `pi_s3djmmlvuac03cvusbaoznwh` block is
> historical **Base Sepolia → Arc Testnet / Circle sandbox** evidence and is unchanged,
> read-only. Unit/integration suites are **development** evidence. **This §0A block is the
> only REAL PRODUCTION money evidence in the repository.**

| Field | Value |
|-------|-------|
| Verdict | **PASS** (2026-10-07) |
| payment_intent | `pi_x39anzavxvj60ojq0gyseqpz` |
| cross_chain_transfer | `cct_uq64gsr4kgahtkfd8v0pe1uf` |
| Source network | `base_mainnet` — chain 8453, native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Settlement network | `arc_mainnet` — chain 5042 |
| Merchant net credited (M) | **1.000000 USDC** (1,000,000 base units — exactly M, not M+F) |
| Forwarding fee (F = `max_fee`) | 0.016011 USDC (16,011 base units; server-authored Circle quote, never client-chosen) |
| Gross source burn (M+F) | 1.016011 USDC (1,016,011 base units) |
| Source tx | `0x353ad0e014ea9506404b52c2001b032b00d5693a38053a303cf90e3395f22b42` |
| Destination tx | `0x54a528648f77f7e0210bdd2bb34f74c43767935b1c404ac510fce4b1b8f2e134` |
| `destination_domain` / `min_finality_threshold` / `destination_caller` | 26 / 2000 (Standard) / `bytes32(0)` |
| Transfer state path | `source_finalizing → source_finalized → attestation_pending → settled` |
| Final `attestation_status` / `claim_status` / state | `complete` / `confirmed` / `settled` |
| payment | `pay_845ktggmrz49cpig26fkdqad` — `succeeded`, 1.000000, `arc_mainnet` / 5042 |
| receipt | `rcpt_y42kg3b70s43fh2pn85souen` — 1.000000 USDC, `payment_status=succeeded` |
| `email_status` | `sent` (`emailed_at` populated) |

**Authoritative source-tx outcome.** The wallet UI (MetaMask) first reported
"Interaction failed" for the `depositForBurn` submission. The Base receipt fetched
afterwards is authoritative: `status=0x1` (**SUCCESS**) and
`to=0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` — exactly the mainnet
`TokenMessengerV2` pinned in `server/db/cctp.ts`. **This UAT is NOT a failed source
transaction**, and nothing was re-signed or replayed to obtain that receipt.

**Server-side completion — the browser was not required.** The journey reached `settled`
with the customer's browser no longer participating: source finality, attestation and
destination settlement were all driven by the reconciliation worker. That is precisely the
Phase 21F (checkout hands the journey to the worker) + Phase 21G (worker recovers/drives
source finality) behaviour, committed as `0544966`
(`feat(cross-chain): complete the CCTP journey server-side after the source burn`), with
`server/cctp21f-checkout-bridge.test.ts` and `server/cctp21g-source-finality.test.ts` as the
regression coverage.

**Verification basis — stated honestly.** Every value above was read from JafariPay's own
production SQLite rows plus receipt/attestation data the application verified over RPC: the
Base source receipt, Circle's production attestation (money gates: `amount == M+F`,
`maxFee == F`, `finalityThresholdExecuted >= 2000`, `feeExecuted == F`), and the Arc mint
receipt re-checked by `verifyDestinationMint` **before** the merchant credit. The destination
hash was recorded from Circle's `forwardTxHash` on the attestation
(`server/blockchain/cctp-attestation.ts`) — proof that Circle's forwarder broadcast the
destination leg. **No independent block-explorer confirmation was captured for this
close-out, and none is claimed here.**

**What this evidence newly closes:** Circle **mainnet** Forwarding entitlement for
Base Mainnet → Arc Mainnet (domain 6 → 26) is no longer inferred from testnet — the
production forwarder actually executed the destination leg. **What it still does NOT close:**
the D-1 **written** sign-off by the accountable owner (§6, Runbook §2), and external merchant
webhook delivery to a live endpoint — **no webhook-delivery evidence was captured for this
UAT**, so external delivery remains unexercised by recorded evidence (the same caveat as §0;
the internal event/outbox path is covered by the Phase L W1–W26 matrix).

**Secrets / PII:** this section intentionally records no API keys, no SMTP credentials, no
`.env` contents and no signer keys. The receipt's `customer_email` value is deliberately not
reproduced here — only its delivery status (`sent`) is recorded.

---

## 1. Executive Status

JafariPay's engineering scope (Phases 0–20 + CCTP Forwarding closure) is **fully
verified** at code level:
- 759 automated tests, 0 failures, typecheck clean (711 at the Phase 21C closure counted in §0)
- Real CCTP V2 testnet E2E (Phase 16): Base Sepolia → Arc Testnet mint confirmed
- **Real CCTP Forwarding application E2E (Phase 21C): full intent→settlement flow
  with Circle's forwarder executing the destination leg — see §0**
- **REAL PRODUCTION CCTP Forwarding E2E (2026-10-07): Base Mainnet → Arc Mainnet,
  1 USDC, completed server-side after the burn without the browser — see §0A**
- Same-chain, cross-chain, and inventory integrity gates (Phases 17–20) all pass
- Live read-only validation (Phase 20): 13/13 enabled EVM networks PASS
- No secrets or private keys in the repository

**Phase 21 is an OPERATIONAL milestone.** No additional code phase is defined.
The system is **READY FOR OPERATIONAL PROVISIONING** — not yet production-live.

---

## 2. Verified Engineering Scope

| Layer | Status | Evidence |
|-------|--------|----------|
| Money gate (verifyPayment) | VERIFIED | 13 per-network matrix tests + 4 same-chain gates |
| CCTP V2 cross-chain pipeline | VERIFIED | Phases 5–15 tests (attestation, destination, state machine, worker) |
| CCTP **Forwarding** (fee quote, hook, attestation, settlement) | **VERIFIED — see §0 + §0A** | `server/blockchain/cctp-forwarding-fee.ts`, `cctp-forwarding-attestation-5nfix.test.ts`, `cctp-forwarding-fee.test.ts`, live Base Sepolia → Arc Testnet application E2E, **live Base Mainnet → Arc Mainnet production UAT (§0A)** |
| Cross-chain isolation (no chain confusion) | VERIFIED | Phase 18: 3/3 pairwise + replay tests |
| Registry completeness (no silent omission) | VERIFIED | Phase 19: 5/5 inventory gates |
| Live network identity validation | VERIFIED | Phase 20: 13/13 PASS |
| Real testnet E2E settlement | VERIFIED | Phase 16: TX `0xca4436a1…` on Arc Testnet |
| Webhook signing + at-rest encryption | VERIFIED | Phase L + security tests |
| Email delivery | VERIFIED | `EmailTransport` interface + `dev`/`none`/`brevo_smtp` transports + retry contract. D-4 IMPLEMENTED (Brevo SMTP). Live SMTP submission + inbox delivery independently verified. |
| Frontend SDK + checkout | VERIFIED | Build clean, 759 tests |

---

## 3. Phase 16–20 Evidence Summary

| Phase | Gate | Result |
|-------|------|--------|
| 16 | Base Sepolia → Circle → Arc Testnet | VERIFIED PASS (destination TX recorded) |
| 17 | Same-chain Arc regression (4 gates) | 4/4 PASS |
| 18 | Cross-chain pairwise isolation (3 gates) | 3/3 PASS |
| 19 | Inventory completeness (5 gates) | 5/5 PASS |
| 20 | Live RPC read-only validation (13 networks) | 13/13 PASS, 0 MISMATCH |
| All | Full test suite | 759 pass / 0 fail / 5084 expect() / 47 files (2026-10-07 production close-out; 711/4785/41 at Phase 21C closure; 622/4301 at first writing) |
| All | Typecheck (tsc --noEmit) | EXIT=0 |

---

## 4. Production Network Inventory

### A. ENABLED EVM Networks (13) — `is_enabled=1` in registry

| Slug | Chain ID | Native USDC | CCTP Domain | Finality | Phase 20 | CCTP Source? | RPC (current) |
|------|----------|-------------|-------------|----------|----------|--------------|---------------|
| arc_mainnet | 5042 | 0x3600…0000 | 26 (dest) | immediate | PASS | No (dest) | rpc.mainnet.arc.io |
| arc_testnet | 5042002 | 0x3600…0000 | 26 (dest) | immediate | PASS | No (dest) | rpc.testnet.arc.io |
| base_mainnet | 8453 | 0x8335…2913 | 6 | finalized | PASS | Yes | mainnet.base.org |
| base_sepolia | 84532 | 0x036C…CF7e | 6 | count | PASS | Yes (test) | sepolia.base.org |
| arbitrum_one | 42161 | 0xaf88…5831 | 3 | finalized | PASS | Yes | arb1.arbitrum.io/rpc |
| arbitrum_sepolia | 421614 | 0x75fa…AA4d | — | count | PASS | No | sepolia-rollup.arbitrum.io/rpc |
| polygon_pos | 137 | 0x3c49…3359 | 7 | finalized | PASS | Yes | polygon.drpc.org |
| avalanche_c | 43114 | 0xB97E…8a6E | 1 | finalized | PASS | Yes | api.avax.network |
| op_mainnet | 10 | 0x0b2c…ff85 | 2 | finalized | PASS | Yes | mainnet.optimism.io |
| linea | 59144 | 0x1762…e1ff | 11 | finalized | PASS | Yes | rpc.linea.build |
| unichain | 130 | 0x078d…7ad6 | 10 | finalized | PASS | Yes | mainnet.unichain.org |
| zksync_era | 324 | 0x1d17…38D4 | — | finalized | PASS | No | mainnet.era.zksync.io |
| celo | 42220 | 0xcebA…118C | — | finalized | PASS | No | forno.celo.org |

### B. VERIFIED_NOT_ENABLED Networks (12)

| Slug | Chain ID | Reason Held |
|------|----------|-------------|
| ethereum_mainnet | 1 | Operator decision: ENS-only, not payable |
| monad | 143 | New chain — human go-live |
| morph | 2818 | Newer L2 — human go-live |
| ink | 57073 | Newer OP-stack — human go-live |
| worldchain | 480 | Third-party RPC (Alchemy) — Phase 21 dedicated RPC |
| xlayer | 196 | New (Aug 2026) — human go-live |
| xdc | 50 | Finality policy review needed |
| sei_evm | 1329 | Third-party RPC — held |
| injective_evm | 1776 | New chain — held |
| plume | 98866 | Newer chain — held |
| plasma | 9745 | New (Aug 2026) — held |
| codex | 81224 | Low-info — held |

### C. SPECIAL_HANDLING / BLOCKED (5)

| Slug | Chain ID | Status | Reason |
|------|----------|--------|--------|
| hyperevm | 999 | SPECIAL_HANDLING | No distinct safe/finalized boundary |
| sonic | 146 | SPECIAL_HANDLING | safe==latest+1 (no lag) |
| cronos | 25 | SPECIAL_HANDLING | Phase 20 demotion: no observable finality |
| edge_chain | null | BLOCKED_NO_SOURCE | No viem definition |
| pharos | null | BLOCKED_NO_SOURCE | No viem definition |

### D. NON-EVM BLOCKED (11)

Solana, Aptos, Sui, Stellar, Algorand, Hedera, NEAR, Noble, Polkadot, XRPL, Starknet — all
require a `PaymentNetworkAdapter` rail (documented plan in networks.ts lines 148–171).

### E. CCTP Contract Pair (cross-chain-constant)

| Environment | TokenMessenger V2 | MessageTransmitter V2 |
|-------------|-------------------|-----------------------|
| Mainnet | 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d | 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64 |
| Testnet | 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA | 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275 |

Source: `server/db/cctp.ts` lines 49–56, verified against docs.arc.io and onchain-facts.

---

## 5. RPC Readiness

### Current State

The architecture supports TWO deployment models (`server/blockchain/arc-provider.ts` lines 57–82):

**MODEL 1 — Direct curated RPC (default, current state):**
- `resolveRpcUrl()` returns the `network_configs.rpc_url` verbatim
- Public endpoints: mainnet.base.org, arb1.arbitrum.io/rpc, polygon.drpc.org, etc.
- Chain-ID guard: `ensureChainIdMatches()` (viem `client.getChainId()`) runs BEFORE
  every receipt, head, and safe/finalized read (`arc-provider.ts` lines 275, 313, 320, 335)
- Provider transport (`arc-provider.ts` lines 234–237): 15s timeout, 3 retries at
  1s delay (viem `http()` options). An exhausted retry surfaces to the merchant
  as a retryable 503 (checkout.ts / payment-intents.ts); a lying/mismatched
  endpoint THROWS before any receipt read — fail closed, never retried into acceptance.

**MODEL 2 — Proxy mode (via `RPC_PROXY_BASE_URL`):**
- Only applies to networks in `PROXY_SLUGS` (currently arc_testnet, arc_mainnet only)
- Requires `RPC_PROXY_TOKEN` — fails closed without it
- Per-network opt-out via `RPC_PROXY_CHAINS` allowlist
- The Arc rows' seed uses `buildRpcUrl()` (schema.ts lines 662/677), so proxy
  configuration for Arc IS supported without a code edit. Non-Arc networks
  require adding a `PROXY_SLUGS` entry — a code change, not a config change.

### Required State for Production

- **Dedicated RPCs** per enabled network (no rate limits, no public-traffic degradation)
- The curated `rpc_url` is the BOOT-TIME SOURCE OF TRUTH: the self-healing seed
  re-UPDATEs every row's `rpc_url` from `CIRCLE_INVENTORY` on every `migrate()`
  (schema.ts lines 824–881). A live `UPDATE network_configs …` is therefore
  REVERTED on the next restart.
- Production RPCs must be supplied by ONE of:
  1. **Editing `server/db/networks.ts`** (`rpc` per row) + redeploy — a data edit,
     the intended single-source path; OR
  2. **MODEL 2 proxy** — Arc only without code change; other networks need an
     explicit `PROXY_SLUGS` mapping added in the provider module.

### Configuration Required

| Network | Current RPC | Class | Production Action |
|---------|-------------|-------|-------------------|
| base_mainnet | mainnet.base.org | Dedicated (Alchemy/QuickNode/Infura) |
| arbitrum_one | arb1.arbitrum.io/rpc | Dedicated |
| polygon_pos | polygon.drpc.org | Dedicated |
| avalanche_c | api.avax.network | Dedicated |
| op_mainnet | mainnet.optimism.io | Dedicated |
| linea | rpc.linea.build | Dedicated |
| unichain | mainnet.unichain.org | Dedicated |
| zksync_era | mainnet.era.zksync.io | Dedicated |
| celo | forno.celo.org | Dedicated |
| arc_mainnet | rpc.mainnet.arc.io | Direct or proxy with token |
| base_sepolia | sepolia.base.org | Keep (testnet) |
| arbitrum_sepolia | sepolia-rollup.arbitrum.io | Keep (testnet) |
| arc_testnet | rpc.testnet.arc.io | Keep (testnet) |

### Code Change Required? **NO (MODEL 1 inventory edit) / YES (MODEL 2 for non-Arc)**
MODEL 1: updating `rpc` in `server/db/networks.ts` is a curated-data edit that
requires a redeploy (schema.ts seeds FROM the inventory) — no logic change.
MODEL 2: routing a NON-Arc network through a proxy requires adding a `PROXY_SLUGS`
entry — a small, deliberate code edit. Never route an unmapped network through a
guessed slug (fail-closed by design).

---

## 6. CCTP Executor Architecture

### What the Code Does (executor-agnostic design)

`server/db/cctp.ts` line 278:
```
destination_caller_bytes32: '0x' + '0'.repeat(64)
```

This means: **ANY caller** may execute `receiveMessage(message, attestation)` on Arc.

`server/blockchain/cctp-destination.ts` lines 60–64:
- JafariPay **builds** the calldata: `receiveMessage(bytes message, bytes attestation)`
- JafariPay **does NOT sign or broadcast** it
- There is no recipient argument — funds go to the baked-in `mintRecipient`
- The executor pays only gas; cannot redirect the mint

### Where Destination Execution Occurs

The worker (`server/workers/reconciliation.ts` line 7) imports `settleDestination`:
- It checks whether a destination TX hash is already recorded on `cross_chain_transfers`
- It **verifies** a real mint landed on Arc (reads the receipt via the provider)
- It credits the merchant **passively** after observing the Transfer event
- It does NOT initiate or broadcast the transaction

### Three Production Options (NOT chosen by code)

| Option | Description | Implication |
|--------|-------------|-------------|
| **A. JafariPay-operated relayer** | JafariPay holds a hot wallet on Arc, monitors for attestations, broadcasts receiveMessage | Operational cost (gas), key management, monitoring, uptime SLA. NOT implemented for production. |
| **B. Merchant/self execution** | Merchant (or their agent) calls receiveMessage themselves using the attestation JafariPay provides | No JafariPay gas cost; merchant needs Arc technical capability + gas. Works with `destinationCaller=bytes32(0)`, no code needed. |
| **C. Circle Forwarding Service** | Circle's built-in forwarding broadcasts on their network after attestation | **IMPLEMENTED + TESTNET-VERIFIED (see §0)**: `depositForBurnWithHook` + `cctp-forward` v0 hook + live fee quote + corrected attestation + full application E2E. Zero JafariPay gas/relayer ops; Circle dependency, fee F quoted per-transfer at intent time. |

### What Each Option Changes

| Aspect | A (Relayer) | B (Merchant) | C (Forwarding) |
|--------|-------------|--------------|----------------|
| `destinationCaller` | bytes32(0) (unchanged) | bytes32(0) (unchanged) | bytes32(0) (unchanged) |
| JafariPay code | Add broadcast path | No change | No change |
| Wallet needed | JafariPay Arc hot wallet | Merchant Arc wallet | None (Circle) |
| Gas on Arc | JafariPay pays | Merchant pays | Circle pays (via fee) |
| Operational complexity | High (monitoring, key mgmt) | Low | Lowest |
| Privacy: who sees the attestation | JafariPay | Merchant | Circle |

**This is a business/product decision (D-1).** Option C is now fully implemented and
verified on Base Sepolia → Arc Testnet (§0); the evidence supports choosing
**CIRCLE FORWARDING**, but the accountable owner's WRITTEN sign-off is still pending,
and Circle MAINNET account entitlement for Forwarding must be confirmed before
production (`docs/CCTP_EXECUTOR_DECISION_BRIEF.md` §6.1/§15). Options A/B remain
architecturally possible; no production code change is needed for C.

---

## 7. Wallet / Funding Requirements

### Wallet Roles in Current Architecture

| Role | Purpose | Network | Required? | Current Implementation |
|------|---------|---------|-----------|------------------------|
| **Merchant settlement wallet** | Receives native USDC directly (same-chain) | Arc + all enabled | Required (per merchant) | Created by merchant, stored in `settlement_wallets` |
| **Merchant Arc wallet** (CCTP) | Receives CCTP mint (cross-chain) | Arc mainnet | Required (per merchant) | Same; `mint_recipient` baked into depositForBurn |
| **JafariPay operator** | No funds handled (non-custodial) | N/A | NOT required | N/A — never custodian |
| **CCTP executor wallet** (Option A) | Signs/broadcasts receiveMessage | Arc mainnet | Only if relayer chosen | Test-only (Phase 16 `E2E_RELAYER_PK`) |
| **Customer wallet** | Signs the payment (same-chain) or burn (cross-chain) | Source chain | Required (per payment) | Browser wallet (MetaMask, etc.) |

### Native Gas Requirements (for executor wallet, Option A only)

| Network | Token | Purpose | Estimated Cost |
|---------|-------|---------|----------------|
| Arc Mainnet | **USDC (native gas)** | receiveMessage gas | UNVERIFIED — no per-claim figure recorded in the repository; measure at go-live |

### USDC Operational Balance

- JafariPay holds **ZERO USDC** (non-custodial)
- No operational USDC balance is required unless an escrow/refund model is added
- Customers pay directly; mints go to merchants

### Private Key Requirements

| Context | Key | Source | Storage |
|---------|-----|--------|---------|
| Production server | NONE | — | Server never signs blockchain transactions |
| Test relayer (Phase 16) | `E2E_RELAYER_PK` | Operator env (NEVER in repo) | Test-only, ephemeral |
| Deployer (contracts) | `DEPLOYER_PRIVATE_KEY` | Operator env | Deploy scripts only (not production server) |
| Executor (Option A) | Arc hot-wallet key | KMS/HSM (TBD) | NOT in code — requires security review |

---

## 8. Secrets & Environment Requirements

### Production Environment Variables Checklist

| Variable | Required | Scope | Purpose | Rotation Supported? | Logged? |
|----------|----------|-------|---------|---------------------|---------|
| `NODE_ENV` | YES | production | Enables secure cookies, fail-fast | N/A | No |
| `SESSION_SECRET` | YES (≥16) | production | HMAC for session tokens | Re-deploy with new value | Never |
| `API_KEY_HMAC_SECRET` | YES (≥16) | production | HMAC for API key hashing | Re-deploy with new value | Never |
| `WEBHOOK_HMAC_SECRET` | YES (≥16) | production | HMAC for webhook secret hashing at rest | Re-deploy + re-hash | Never |
| `WEBHOOK_SIGNING_ENC_KEY` | YES (≥16) | production | AES-256-GCM for webhook signing secrets | Envelope versioned (`v1.` prefix) | Never |
| `ALLOWED_ORIGINS` | YES | production | CORS whitelist | Re-deploy | No |
| `CHECKOUT_BASE_URL` | YES | production | Checkout URL builder | Re-deploy | No |
| `JAFARIPAY_DOMAIN` | YES | production | SIWE domain for auth | Re-deploy | No |
| `ENABLE_LIVE_PAYMENTS` | YES (for mainnet) | production | Gates live-class payments. Strict `=== 'true'`; any other non-empty value (e.g. `false`, `1`, `yes`) is rejected at production boot | Unset = testnet only | No |
| `DATABASE_URL` | optional | all | SQLite file path | N/A | No |
| `PORT` | optional (3001) | all | HTTP listen port | N/A | No |
| `EMAIL_TRANSPORT` | YES | production | `none` / `dev` / **`brevo_smtp` (D-4 IMPLEMENTED + VERIFIED)** | N/A | No |
| `EMAIL_BREVO_SMTP_LOGIN` + `EMAIL_BREVO_SMTP_KEY` + `EMAIL_FROM` (confirmed var names in `server/email/brevo-smtp.ts`) | conditional (only if `EMAIL_TRANSPORT=brevo_smtp`) | production | Credentials for `smtp-relay.brevo.com:587` (STARTTLS) | Re-deploy | Never |
| `RPC_PROXY_BASE_URL` | optional | production | Enables proxy model (Model 2) | N/A | No |
| `RPC_PROXY_TOKEN` | conditional | production | Proxy auth (when Model 2 active) | N/A | **WARNING: interpolated into URL** (line 117) — ensure proxy doesn't log full URL |
| `RPC_PROXY_CHAINS` | conditional | production | Networks routed via proxy | N/A | No |
| `BASE_SEPOLIA_RPC_URL` | optional | testnet | Override registry default | N/A | No |
| `ARC_TESTNET_RPC_URL` | optional | testnet | Override registry default | N/A | No |
| `E2E_SOURCE_PK` | test-only | none | Phase 16 burn signer (Base Sepolia) | N/A | Never (never committed) |
| `E2E_RELAYER_PK` | test-only | none | Phase 16 test executor | N/A | Never (never committed) |
| `E2E_MINT_RECIPIENT` | test-only | none | Phase 16 destination | N/A | Never |
| `E2E_AMOUNT_BASE_UNITS` | optional (test-only) | none | Burn amount override (default 100000) | N/A | Never |
| `E2E_POLL_TIMEOUT_S` | optional (test-only) | none | Attestation poll window (default 900s) | N/A | No |
| `BASE_RPC_URL` / `ARC_RPC_URL` | optional | mainnet pilot | `--mainnet` E2E RPC overrides | N/A | No |

### Production Fail-Fast Guard

`server/index.ts` (boot gate) + `server/lib/production-config.ts` (Phase 21C hardening):
If `NODE_ENV=production`, `validateProductionConfig(process.env)` runs BEFORE the port
opens. The server exits with code 1 on: any of the 4 required secrets (`SESSION_SECRET`,
`API_KEY_HMAC_SECRET`, `WEBHOOK_HMAC_SECRET`, `WEBHOOK_SIGNING_ENC_KEY`) missing or
<16 chars; `ALLOWED_ORIGINS` unset / non-https / localhost / bare origins; `CHECKOUT_BASE_URL`
missing or non-https; malformed `JAFARIPAY_DOMAIN`; invalid `EMAIL_TRANSPORT` choice or
half-wired Brevo credentials; `RPC_PROXY_BASE_URL` set without `RPC_PROXY_TOKEN`/chains;
`E2E_SOURCE_PK`/`E2E_RELAYER_PK` present in a production env; malformed
`ENABLE_LIVE_PAYMENTS` (must be exactly `true`/`false`/unset — the live gate is strict
`=== 'true'`). Findings print variable NAMES only — secret VALUES are never printed
(covered by `server/production-config.test.ts` PC1–PC15).

### Key Rotation Path

- `WEBHOOK_SIGNING_ENC_KEY` change → existing `v1` envelopes become undecryptable →
  merchants must re-provision webhook secrets (documented in crypto.ts)
- `SESSION_SECRET` change → all active sessions invalidated → users re-authenticate
- `API_KEY_HMAC_SECRET` change → existing API keys stop validating → re-issue keys

---

## 9. Webhook / Email / External Services

### Webhook Infrastructure (Phase L — implemented, tested)

- **Signing:** HMAC-SHA256 over the raw request body, using the merchant's per-endpoint
  secret (decrypted from AES-256-GCM at-rest envelope at delivery time). Header:
  `X-JafariPay-Signature: t=<unix_ts>,v1=<hex>`; verification enforces a 300s
  max-age on the timestamp (`delivery.ts` line 34)
- **Delivery:** POST with `X-JafariPay-Signature`, 10s timeout (AbortController,
  `delivery.ts` line 124)
- **Retry:** fixed schedule `[10, 30, 120, 300, 1800, 7200, 28800]` seconds =
  MAX 8 total attempts (`RETRY_DELAYS_S.length + 1`), stored in `webhook_deliveries`
- **Idempotency:** stable event ID (`evt_...`) per webhook type per payment — byte-identical
  payload across retries (verified by W26); receiver dedupes on the event id
- **Events:** `payment.succeeded`, `payment.expired`, `cross_chain.*` lifecycle
- **Production requirement:** `WEBHOOK_HMAC_SECRET` + `WEBHOOK_SIGNING_ENC_KEY` must be set
- **Test coverage:** local matrix W1–W26 (signing, verification, replay window, at-rest
  envelope, rotation, SSRF rejection, merchant isolation, retry ladder exhaustion at 8
  attempts then fail-closed). **External delivery to a live merchant endpoint has NOT
  been exercised** — the Phase 21C application E2E merchant had ZERO webhook endpoints,
  so no external POST left the system. The internal event/outbox enqueue path PASSED.
  External delivery to a real merchant endpoint is a go-live smoke-test item (§11).

### Email Infrastructure (Phase B — IMPLEMENTED; D-4 Brevo SMTP LIVE-VERIFIED)

- **Transport:** `EmailTransport` interface; selection by `EMAIL_TRANSPORT` env var
- **Shipped transports:** `dev` (in-memory sink), `none` (no-op), `brevo_smtp` (production)
- **Approved production provider (decision D-4):** **Brevo** via SMTP relay
  - SMTP server: `smtp-relay.brevo.com`
  - SMTP port: `587` (STARTTLS submission)
  - Brevo sending domain authenticated: `jafari.co.in`
  - Brevo branded subdomain: `mail.jafari.co.in`
  - Verified sender: `noreply@jafari.co.in`
  - Existing Zoho mailbox `dev@jafari.co.in` and apex-domain MX/SPF/DKIM records **remain unchanged and authoritative** for inbound/legacy mail — Brevo branding uses the delegated subdomain only
- **Implementation status:** COMPLETE. `server/email/brevo-smtp.ts` + `server/email/smtp-client.ts` registered behind `EMAIL_TRANSPORT=brevo_smtp` in the existing `getEmailTransport()` switch. 23 focused unit tests pass. **No new provider architecture or configuration system** — the existing single-switch selection is used unchanged.
- **Live delivery test:** SMTP relay acceptance and actual mailbox delivery were independently verified. Test email FROM `noreply@jafari.co.in` TO `dev@jafari.co.in` (subject: `[JafariPay SMTP TEST] Brevo delivery verification`) was visibly received in the Zoho inbox.
- **Credential status:** SMTP login + key provisioned by the project owner; injected into the runtime env via secrets manager. **Never committed, never logged.** Env vars: `EMAIL_BREVO_SMTP_LOGIN`, `EMAIL_BREVO_SMTP_KEY`, `EMAIL_FROM`.
- **Contract:** email failure NEVER blocks payment success; receipts table is the durable queue; worker retries pending emails
- **Production deployment remaining:** DevOps injects credentials into production env + SRE verifies outbound 587 to `smtp-relay.brevo.com` from the production host

### Circle Iris (Attestation API)

- **Endpoint:** `https://iris-api.circle.com/v2/messages/{domain}?transactionHash={hash}`
- **Authentication:** NONE (permissionless)
- **Rate limit:** 35/s, 5-min block on 429
- **Back-off:** exponential, stored in DB (`next_attestation_attempt_at`)
- **Production ready:** YES — no credentials needed

---

## 10. Deployment Checklist

| Item | Status | Evidence / Notes |
|------|--------|------------------|
| Production database | PENDING INFRASTRUCTURE | SQLite; `DATABASE_URL` must point to durable storage |
| Database migrations | COMPLETE | `migrate()` idempotent, self-healing seed, auto-runs on boot |
| Production RPCs | PENDING INFRASTRUCTURE | 10 mainnet networks need dedicated endpoints (§5) |
| Network configuration | COMPLETE | Registry seeded from CIRCLE_INVENTORY; `is_enabled` gates |
| CCTP configuration | COMPLETE | Contract pair, domains, finality threshold all pinned in `server/db/cctp.ts` |
| Executor model selected | **PENDING HUMAN SIGN-OFF** | Evidence supports Option C (Circle Forwarding) — implemented + testnet-verified (§0). Written owner approval + Circle mainnet entitlement remain (§6, §14 #1) |
| Production wallets | PENDING HUMAN | Merchant wallets provisioned by merchants; executor wallet if Option A |
| Native gas | PENDING HUMAN | ARCY on Arc for executor (Option A only) |
| USDC operational balance | NOT REQUIRED | Non-custodial: JafariPay never holds USDC |
| WEBHOOK_SIGNING_ENC_KEY | PENDING CONFIGURATION | Generate random ≥32-char string; set in production env |
| Email provider | **DECIDED — Brevo SMTP (`smtp-relay.brevo.com:587` STARTTLS)** (D-4 approved + IMPLEMENTED + LIVE-TEST VERIFIED) | Production credential injection into deployment env + outbound connectivity verification from production host remain |
| Domain / HTTPS | PENDING INFRASTRUCTURE | JafariPay deployment domain + TLS cert |
| Environment variables | PENDING CONFIGURATION | All 4 required secrets + ALLOWED_ORIGINS + ENABLE_LIVE_PAYMENTS (§8) |
| Logging | COMPLETE | Structured `console.log`/`console.error`; a `requestId` middleware (index.ts line 96) injects per-request IDs. Secrets are never logged. NOTE: No third-party logger (pino, morgan, winston) is mounted — production log routing is via stdout captured by the hosting process manager. External aggregation stack remains PENDING INFRASTRUCTURE |
| Monitoring endpoint | COMPLETE | `GET /health` EXISTS (index.ts lines 162–163) — no external stack required, but dashboards/alerting remain PENDING INFRASTRUCTURE |
| Alerting | PENDING INFRASTRUCTURE | Webhook delivery failures, worker health |
| Backup / recovery | PENDING INFRASTRUCTURE | SQLite single-file; must be backed up externally |
| Rate limits | COMPLETE | express-rate-limit: global 300 req/min + auth 20 req/min (`/auth`, `/api/auth`); Nginx per-IP layer documented (DEPLOYMENT.md §9) |
| Webhook endpoint | COMPLETE | Full delivery + retry implemented, tested |
| Payment intent configuration | COMPLETE | All flows tested (same-chain, cross-chain, expiry) |
| Cross-chain configuration | COMPLETE | Full CCTP V2 pipeline implemented + tested |
| Rollback procedure | PENDING HUMAN | No automated rollback; SQLite version control |
| Incident procedure | PENDING HUMAN | External runbook required |

---

## 11. Mainnet Smoke-Test Procedure

> **STATUS (2026-10-07):** the **Cross-Chain CCTP Payment** procedure below HAS now been
> executed once against real mainnet funds and PASSED — see **§0A** (Base Mainnet →
> Arc Mainnet, 1 USDC, server-side completion). The **same-chain Arc Mainnet** payment
> procedure and the external-merchant-webhook leg have **NOT** been executed.
> This section remains the procedure an operator follows after all go-live gates
> are satisfied. All amounts are minimal (1 USDC).

### Pre-flight (READ-ONLY, NO FUNDS)

1. Run Phase 20 live validator against production RPCs:
   ```bash
   bun run scripts/phase20-live-validate.ts
   ```
   Expected: 13/13 PASS (or reduced set if not all networks enabled).

2. Verify production env:
   - `NODE_ENV=production`
   - All 4 required secrets set, ≥16 chars
   - `ENABLE_LIVE_PAYMENTS=true`
   - `RPC_PROXY_*` configured if using proxy (Arc only without a code edit)

3. Verify database: `migrate()` ran cleanly; `SELECT count(*) FROM network_configs WHERE is_enabled=1` returns expected count.

4. Health check: `curl http://localhost:3001/health` returns 200 (endpoint exists —
   index.ts lines 162–163).

### Same-Chain Arc Payment (minimal: 1 USDC)

1. Create a live payment intent on Arc Mainnet (merchant has a funded Arc wallet)
2. Pay 1 USDC from a customer's Arc wallet (direct transfer)
3. Submit tx hash to `/checkout/:id/verify`
4. Confirm: payment intent → `succeeded`, receipt issued, webhook delivered
5. Evidence: destination tx hash, explorer link, webhook delivery log

### Cross-Chain CCTP Payment (minimal: 1 USDC) — **EXECUTED ON PRODUCTION 2026-10-07: PASS (§0A)**

1. Create a cross-chain intent (source: Base Mainnet, destination: Arc Mainnet)
2. Customer calls `approve` + `depositForBurn` on Base Mainnet TokenMessengerV2
3. Worker polls Circle Iris production: `https://iris-api.circle.com/v2/messages/6?transactionHash={hash}`
4. Executor (per chosen model) broadcasts `receiveMessage` on Arc Mainnet
5. JafariPay worker observes the Arc mint Transfer receipt → credits merchant
6. Confirm: intent `succeeded`, webhook, receipt
7. Evidence: source TX, Circle attestation, destination TX, balance delta

### Cleanup

- Record all TX hashes
- Verify explorer links
- Confirm webhook + email delivered
- Archive evidence in operational log

---

## 12. Security Checklist

| Check | Status |
|-------|--------|
| No private keys in repository | **PASS** (verified by grep; DEPLOYER_PRIVATE_KEY is env-only reference) |
| No seed phrases | **PASS** |
| No production secrets in tracked files | **PASS** (.env has only FOO=bar placeholder) |
| API keys (Circle, RPC providers) | NOT PRESENT (not yet provisioned — correct) |
| Unsafe logging | **PASS** — secrets never appear in console.log (verified server/index.ts) |
| Secret leakage in URLs | **ATTENTION** — `RPC_PROXY_TOKEN` is interpolated into URL (arc-provider.ts:117); ensure proxy/load-balancer doesn't log full request URL |
| Cross-tenant leakage | **PASS** — merchant isolation enforced by auth middleware + API key scoping (tested) |
| Testnet/mainnet mixing | **PASS** — `is_testnet` flag gates environment; chain-ID guard prevents confusion |
| Replay bypass | **PASS** — (tx_hash, network) UNIQUE + blockchain_transactions replay check |
| Token-address bypass | **PASS** — only native USDC contract accepted (bridged rejected — Phase 5 tests) |
| Chain-ID bypass | **PASS** — ensureChainIdMatches fails closed (Phase 17 lying-RPC test) |

---

## 13. Regression Gates

Before any production deployment, re-verify:

```bash
bun test              # 759 pass / 0 fail / 5084 expect() / 47 files (2026-10-07 close-out; 711/4785/41 at Phase 21C closure)
bun run typecheck     # EXIT=0
bun run build         # vite build + SDK bundle clean
bun audit             # no known vulnerabilities in prod deps (record exact output)
bun run scripts/phase20-live-validate.ts   # 13/13 PASS (against PRODUCTION RPCs)
```

Phase-specific regression:
- Phase 16: `scripts/cctp-e2e-base-sepolia.ts --readonly` (testnet infrastructure probe)
- Phase 17: `bun test server/cctp17-samechain-regression.test.ts` (4/4)
- Phase 18: `bun test server/phase6-multichain-matrix.test.ts` (P18 3/3)
- Phase 19: same file (P19 5/5)
- Phase 20: the live validator itself

Suite hermeticity (2026-10-07 close-out): every cross-chain-aware test call site of the
reconciliation worker (`tick()` / `tickCrossChain()`) injects the inert
`fetchImpl` / `providerFactory` / `sourceProviderFactory` seams, so `bun test` issues **no live
Circle/Arc RPC** regardless of which temporary SQLite database the process binds. `bun test`
shares one module registry (and therefore one DB) across files, so a single un-injected `tick()`
can read another suite's rows over the real network and time out — keep the seams injected in any
new worker test.

---

## 14. Human / Business Decisions Required

| # | Decision | Current State | Impact |
|---|----------|---------------|--------|
| 1 | **CCTP executor model** (§6) | Evidence supports **Option C — Circle Forwarding** (implemented + testnet-verified §0; **real-mainnet production UAT PASS §0A**); **written owner sign-off PENDING**. Circle mainnet Forwarding entitlement for Base→Arc is no longer an assumption — §0A shows the production forwarder executing the destination leg | Determines operational architecture, cost, liability |
| 2 | **Which VERIFIED_NOT_ENABLED networks to enable** | 12 held | Each needs go/no-go decision |
| 3 | **Ethereum mainnet: keep ENS-only or make payable?** | Operator chose: ENS-only | Reversal requires registry change |
| 4 | **Email provider selection** | **DECIDED + IMPLEMENTED: Brevo via `smtp-relay.brevo.com:587` (STARTTLS)** — project-owner approved; live SMTP delivery test PASSED | Production credential injection + outbound 587 verification from the hosting environment remain |
| 5 | **Hosting / infrastructure provider** | Not specified in code | VPS/cloud/K8s decision |
| 6 | **Data retention / compliance policy** | Not implemented | GDPR/regulatory for transaction records |
| 7 | **Monitoring / alerting stack** | Not built | SRE decision |
| 8 | **Incident response / rollback procedure** | Not defined | Operational decision |

---

## 15. Infrastructure Actions Required

| # | Action | Owner | Depends On |
|---|--------|-------|------------|
| 1 | Provision production VPS / cloud server | DevOps | Decision #5 |
| 2 | Domain + TLS certificate | DevOps | — |
| 3 | Dedicated RPC endpoints (per enabled network) | DevOps/Platform | Decisions #2, #3 |
| 4 | Generate production secrets (4 required) | Security | — |
| 5 | Set up `DATABASE_URL` on durable storage with backup | DevOps | #1 |
| 6 | Implement Brevo SMTP `EmailTransport` under `server/email/`; inject SMTP credentials; verify outbound 587 and staging delivery | Backend + DevOps | Decision #4 (**approved — Brevo**) |
| 7 | Provision executor wallet (if Option A) | Treasury/Security | Decision #1 |
| 8 | Fund executor wallet with ARCY gas (if Option A) | Treasury | #7 |
| 9 | Deploy with production env (`ENABLE_LIVE_PAYMENTS=true`) | DevOps | All above |
| 10 | Run Phase 20 validator against production RPCs | QA | #3 |
| 11 | Execute smoke-test procedure (§11) — cross-chain leg DONE 2026-10-07 (§0A); same-chain Arc Mainnet leg still pending | QA | #9, #10 |
| 12 | Set up monitoring / alerting | SRE | #9 |

---

## 16. Phase 21 Entry Criteria

Phase 21 (operational go-live) may begin when:

- [x] All code-level phases (0–20 + CCTP Forwarding closure) verified
- [x] 759 tests pass, typecheck clean, build clean, lint clean (2026-10-07 production close-out; 711 when this entry criterion was first checked at Phase 21C)
- [x] Real application CCTP Forwarding E2E PASS (§0 testnet/sandbox; §0A **real mainnet production UAT**)
- [x] Production boot fail-closed config validation implemented (`server/lib/production-config.ts`)
- [x] Phase 20 live validation passes against current (public) RPCs — re-run below
      AFTER production RPCs are configured, before declaring this gate met
- [ ] Human decision #1 (executor model) made
- [ ] Production RPCs provisioned for all enabled mainnet networks
- [ ] All 4 production secrets generated + configured
- [ ] `ENABLE_LIVE_PAYMENTS=true` in the production environment
- [ ] Database on durable storage with backup procedure
- [ ] Monitoring and alerting established
- [ ] Incident response documented

---

## 17. Phase 21 Exit Criteria

Phase 21 is COMPLETE when:

- [ ] Smoke-test §11 executed successfully (at minimum: one same-chain + one cross-chain payment)
- [ ] Webhook deliveries confirmed on a merchant endpoint
- [ ] Receipt email sent (if provider wired)
- [ ] Reconciliation worker running without errors for ≥24 hours
- [ ] No unresolved alerts or failed verifications
- [ ] Merchant onboarding flow verified end-to-end
- [ ] Production monitoring dashboards operational

---

## 18. Evidence / References

### Repository Files

| File | Purpose |
|------|---------|
| `server/db/networks.ts` | Single-source CIRCLE_INVENTORY (41 entries) + CIRCLE_SNAPSHOT |
| `server/db/cctp.ts` | CCTP contract pair, domains, message format, route plan |
| `server/blockchain/arc-provider.ts` | RPC resolution, chain-id guard, verifyPayment, finality modes |
| `server/blockchain/cctp-attestation.ts` | Circle Iris polling, verification |
| `server/blockchain/cctp-destination.ts` | receiveMessage calldata builder, destination settlement |
| `server/blockchain/cctp-status.ts` | Cross-chain status projection |
| `server/workers/reconciliation.ts` | Worker: attestation polling, settlement, expiry |
| `server/webhooks/delivery.ts` | Webhook signing, retry, delivery |
| `server/lib/crypto.ts` | AES-256-GCM at-rest encryption for webhook secrets |
| `server/email/transport.ts` | Email abstraction (dev/none/brevo_smtp; D-4 IMPLEMENTED) |
| `server/index.ts` | Server boot, production secret guard, routes |
| `scripts/phase20-live-validate.ts` | Live read-only network identity validator |
| `scripts/cctp-e2e-base-sepolia.ts` | Phase 16 E2E + --resume recovery |
| `server/phase6-multichain-matrix.test.ts` | Phases 5/17/18/19 acceptance gates |
| `server/cctp17-samechain-regression.test.ts` | Phase 17 regression gate |
| `docs/MASTER-PHASE-FINAL-REPORT.md` | Original product evolution report |
| `docs/phaseM-production-readiness-report.md` | Production readiness audit (Phase M) |
| `docs/DEPLOYMENT.md` | Arc Testnet deployment guide |

### External Authoritative References

| Source | URL |
|--------|-----|
| Circle CCTP V2 | https://developers.circle.com/cctp |
| Circle multi-chain USDC | https://www.circle.com/multi-chain-usdc |
| Circle Arc network | https://docs.arc.network/ |
| Circle Bridge Kit | https://developers.circle.com/bridge-kit |
| Circle GitHub | https://github.com/circlefin |
| Arc GitHub | https://github.com/arc |
| CCTP supported chains/domains | https://developers.circle.com/cctp/concepts/supported-chains-and-domains |
| CCTP message format | https://developers.circle.com/cctp/references/technical-guide |

---

## FINAL ENGINEERING STATUS

**ALL DEFINED CODE-LEVEL PHASES 16–20 VERIFIED.**

**PHASE 21 IS AN OPERATIONAL PRODUCTION GO-LIVE MILESTONE. NO ADDITIONAL CODE PHASE IS DEFINED.**

The repository is architecturally complete for the engineering scope defined in the master
plan. Production activation requires ONLY human/infrastructure/business actions enumerated
in §14–§15 above. No code change is needed to go live.
