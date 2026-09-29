# Phase D — Universal Payment Router & Circle CCTP V2 Feasibility Audit

> **Status: DESIGN / FEASIBILITY STUDY ONLY. Nothing in this document is implemented.**
> No cross-chain money movement has been built, enabled, or executed. No real funds,
> keys, or provider infrastructure are involved. This is architecture groundwork for a
> human go/no-go decision.

Sources consulted (REF-5 — authoritative Circle docs, retrieved live, not from memory):
- `developers.circle.com/cctp/concepts/supported-chains-and-domains`
- `developers.circle.com/cctp/concepts/finality-and-block-confirmations`
- `developers.circle.com/cctp/concepts/fees`
- `developers.circle.com/cctp/concepts/upfront-fees`
Facts below are as of the retrieval date. **Circle warns: do NOT hardcode fees or
contract addresses — always re-fetch from the fee API + contract-addresses page.**

---

## 1. What CCTP V2 actually is (verified facts)

CCTP (Cross-Chain Transfer Protocol) is Circle's **non-custodial** native USDC
messaging rail. It does *not* lock-and-mint wrapped assets and does *not* route
liquidity through an app. It **burns native USDC on the source chain** and
**mints fresh native USDC on the destination chain**, 1:1, backed by Circle
reserves. Circle (CTS) signs an **attestation** that the burn occurred and
finalized; the destination `TokenMessenger` accepts that signature exactly once.

Key primitives from the `TokenMessengerV2` contract:
- `depositForBurn(amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold)` on **source** → burns caller's USDC, emits a `MessageSent` event.
- `receiveMessage(message, attestation)` on **destination** → mints to `mintRecipient`, runs optional `destinationCaller` hook. **Single-use**: the message hash is marked used; a second call reverts.
- Burn is initiated by, and debits USDC from, **the caller's wallet** — i.e. whoever signs the source transaction. This is the single most important fact for custody boundaries (§4).

### Domain identifiers (Circle-issued, NOT chain IDs)
CCTP uses its own **domain** numbering that does not map to public chain IDs. Relevant to JafariPay:

| Chain | CCTP domain | Standard attest | Fast Transfer | Upfront fees | Forwarding |
|---|---|---|---|---|---|
| **Arc** | **26** | ~0.5s (1 blk) | N/A (already fast) | ✅ | ✅ |
| Ethereum | 0 | ~15–19 min | ✅ | ✅ | ✅ |
| Base | 6 | ~15–19 min | ✅ | ✅ | ✅ |
| Arbitrum | 3 | ~15–19 min | ✅ | ✅ | ✅ |
| Polygon PoS | 7 | ~8s | N/A | ✅ | ✅ |
| OP Mainnet | 2 | ~15–19 min | ✅ | ✅ | ✅ |

(30 domains total; USDC native on all except BNB which is USYC-only; Noble & Sui are V1-legacy.)

**Direct relevance:** Arc is a **first-class CCTP V2 chain (domain 26)** with the
fastest class of standard attestation (~0.5s) and $0 protocol fee on standard
transfers. JafariPay's Arc-centric thesis and CCTP are naturally compatible on paper.

### Fees (verified)
- **Standard Transfers are free** (0 bps protocol fee) — you pay only gas: source burn gas + destination mint gas.
- **Fast Transfers** cost 0–13 bps depending on source (e.g. Base 1.3 bps, Linea 13 bps), **deducted from the transferred amount at mint** unless paid upfront.
- `maxFee` on `depositForBurn` caps acceptable fee; **the tx reverts on source if the real fee exceeds it** (nothing is burned). Recommended to fetch current fee (`GET /v2/burn/USDC/fees/{srcDomain}/{dstDomain}`) and add ~10–20% buffer.
- **Upfront fees**: `TokenMessengerWithFees` lets the sender pay the fee separately (in native gas or USDC) so the recipient gets the *exact* amount — important for merchant settlement guarantees.
- Circle has **no built-in app-fee mechanism**; a JafariPay fee must be layered in our own contract/backend.

---

## 2. Target architecture (NOT built) — the Payment Route

```
Customer (source wallet + source gas)
   │  signs depositForBurn → USDC burned on SOURCE
   ▼
Source Network ──(MessageSent: sourceDomain, nonce, amount, mintRecipient)
   │
   ▼
JafariPay Verification ── poll Circle Attestation REST until signed attestation ready
   │        (Arc standard finality ≈0.5s; L2s 15–30 min; Linea 6–32h; Starknet 2–4h)
   ▼
Routing Decision ── deterministic map: (sourceDomain,nonce) → Route row → destination
   │
   ▼
CCTP Settlement Rail ── receiveMessage(msg, attestation) on DESTINATION
   │        executed by: (a) merchant wallet, (b) JafariPay relayer, or (c) Circle Forwarding Service
   ▼
Destination Network ── native USDC minted to merchant settlement wallet (or hook)
   │
   ▼
Merchant Wallet  →  Reconciliation + Receipt + Webhook (reuse existing pipeline)
```

### Payment Route abstraction (design sketch — NOT added to production tables)
```
PaymentRoute {
  id                       route_<ulid>
  payment_intent_id        FK -> payment_intents (optional; a route can post-verify a payment)
  sourceNetwork, sourceChainId, sourceDomain   // Circle domain ≠ chainId — store BOTH
  sourceToken              USDC (native, contract-pinned)
  sourceAmountBaseUnits    burned amount (exact integer, 6 decimals)
  destinationNetwork, destinationChainId, destinationDomain
  destinationToken         USDC
  destinationAmountBaseUnits  expected mint (source − fastFee, or == source if upfront/no fee)
  circleMessageBytes       raw CCTP message (hash = single-use identity)
  circleAttestation        signature returned by Circle (may be null until ready)
  nonce                    Circle per-(sourceDomain,sourceAddress) nonce
  messageHash              keccak(messageBytes) — idempotency + duplicate guard
  mintRecipient, destinationCaller
  feeMode                  standard_free | fast_deducted | fast_upfront
  maxFeeBaseUnits          buffered cap
  relayerMode              merchant | jafaripay | circle_forwarding
  routeStatus              created | burned | attestation_pending | attested
                           | mint_pending | settled | failed | recovery
  created/updated/settled timestamps
}
```
A route is a **state machine**, never a synchronous call. It must be resumable from
persisted state after any crash, because attestation + destination mint are
asynchronous and can span seconds (Arc) to hours (Linea/Starknet).

---

## 3. Ownership boundaries (explicit)

| Concern | Owner |
|---|---|
| Source-side burn initiation & source gas | **Customer** wallet (signs `depositForBurn`) |
| Burn→mint value guarantee, 1:1 reserves, attestation signing, fee pricing | **Circle (CTS)** |
| Destination mint gas + executing `receiveMessage` | Depends on relayerMode: **Merchant** wallet, **JafariPay** relayer (holds destination gas, NOT custody of funds), or **Circle Forwarding Service** |
| Destination settlement address / any `destinationCaller` hook contract | **Merchant** (must control/authorize) |
| Verification, routing decision, reconciliation, receipt, webhook, crash-recovery | **JafariPay** |

**Non-custodial holds:** JafariPay never takes custody of customer USDC. During the
burn→mint window the value is custodied by **Circle's protocol/reserves**, represented
by the single-use signed message. A `destinationCaller` hook (if used) is a *merchant*
smart contract, not JafariPay custody.

---

## 4. Where funds temporarily exist & failure matrix

After burn, before mint, USDC does **not** exist on any chain for the customer — it is
a Circle obligation. It is recoverable at any time by executing `receiveMessage` with
the persisted `(message, attestation)`; **Circle messages do not expire.** There is no
"JafariPay refund": to return value you mint to a chosen destination (possibly back to
the source chain — just another CCTP transfer).

| # | Failure | Detection | Recovery / handling | Custody impact |
|---|---|---|---|---|
| 1 | Burn reverts (fee>maxFee, allowance, gas, insufficient) | source tx status | safe retry; **nothing lost** | none |
| 2 | Burn ok, attestation not ready yet | poll timeout | keep polling; persist state; async worker | value in Circle escrow, recoverable |
| 3 | Attestation ok, mint fails (dest gas, hook revert) | dest tx status | retry mint (idempotent via messageHash) | recoverable |
| 4 | Duplicate mint attempt | dest revert (single-use) | treat "already used" as success **only after confirming the mint event/balance** — never blind | must verify, not assume |
| 5 | Burned-not-minted after crash | recovery scan vs `routeStatus` | replay `receiveMessage` from persisted message+attestation | recoverable |
| 6 | Chain/domain confusion (send to wrong domain) | — | **pin domain↔chainId↔contract from Circle's authoritative list**; refuse unmapped | permanent if mis-typed — high risk |
| 7 | Amount mismatch (fast fee eats into principal) | expected vs actual mint | use upfront-fee mode for exact merchant guarantees; reconcile integer base units | settlement shortfall |
| 8 | Token confusion (native vs wrapped USDC) | burnToken/contract check | only accept Circle-native USDC contract per domain | wrong-asset |

---

## 5. What must be persisted & idempotent

**Idempotency identity (global):** `(sourceDomain, nonce)` is unique per burn and is the
natural idempotency key. Secondary guard: `messageHash = keccak(circleMessageBytes)` —
the destination contract itself enforces single-use, so our DB must mirror that
constraint (`UNIQUE(messageHash)`) and reconcile against it rather than trusting it.

Persist for every route (before any external call): route id, source/destination
domain+chainId+contract, exact integer amounts (base units, never float),
`mintRecipient`, `feeMode`+`maxFee`, `relayerMode`, and every state transition with
timestamps. Persist when observed: `MessageSent` (txHash, logIndex, block),
attestation signature, mint txHash + destination block. A route is only `settled`
when the **destination mint Transfer to the merchant's pinned address is verified**
(reuse the existing verification pipeline) — not when Circle says "attested".

---

## 6. Feasibility verdict & blockers (honest)

**Technically feasible for Arc↔major-EVM:** Arc is domain 26 with sub-second standard
attestation and free standard transfers, so the routing concept is sound and well-matched
to JafariPay's thesis. Circle's contract surface (`depositForBurn`, `receiveMessage`,
`TokenMessengerWithFees`, Forwarding Service, fee API) covers the needed guarantees.

**Why it is NOT implemented in this phase (hard blockers requiring human decisions):**
1. **Custody model mismatch with current verification.** Today JafariPay verifies a
   native USDC **Transfer to the merchant settlement wallet**. A CCTP source burn is a
   `Transfer` **to the Circle TokenMessenger contract** (not the merchant) followed by a
   destination mint. The existing "money landed at my address" gate does **not** describe
   the source leg — a genuinely different money path. Adopting CCTP changes payment
   semantics → **STOP rule** (spec: don't silently change money semantics; stop &
   document decisions affecting real-money/custody/settlement).
2. **Requires real on-chain key operations** (customer signs burn; someone funds
   destination mint gas). No keys/real-money are permitted here.
3. **Relayer/funding decision** (merchant vs JafariPay relayer vs Circle Forwarding
   Service) is a business + real-money decision, not a code decision.
4. **Per-domain contract addresses, testnet vs mainnet Mint/TestTokenMessenger, and fee
   API** must be pinned from Circle's live sources and re-fetched — not hardcoded.
5. **Production RPC for destination chains** is an open infra requirement (per the
   multi-chain certification report).

**Recommendation:** keep the Router as a documented future abstraction. If pursued, the
first safe, *non-money* increment is a read-only "quote + preview" endpoint (fee lookup +
route planning, no burn) once a Circle testnet integration decision is made by a human.
