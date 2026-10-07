/**
 * PHASE 21F — the checkout → server-verification bridge.
 *
 * Extracted from `CheckoutPage` so that the single decision "how does a submitted
 * transaction get reported to the backend, and what does the answer mean for the
 * UI?" lives in one pure, browser-free, testable place.
 *
 * This module verifies NOTHING. It knows no amounts, no contracts, no CCTP layout
 * and no settlement rules. It POSTs the customer's transaction hash to the
 * EXISTING public endpoint (`POST /api/checkout/:id/verify`) and maps the
 * server's answer onto checkout UI actions. All authority stays server-side:
 *   · same-chain  → the unchanged `verifyPayment()` ERC-20 credit path;
 *   · cross-chain → the unchanged `detectSourceBurn()` CCTP state machine, which
 *     owns the burn invariants (exactly M + F, maxFee = F), the source-finality
 *     gate, the `cross_chain_transfers` row and the intent → 'processing' move.
 * It is the only verification client in the app, and both payment kinds share it.
 *
 * ── Two profiles, ONE loop ──────────────────────────────────────────────────
 *   SAME_CHAIN_VERIFY_PROFILE   — byte-for-byte the behaviour shipped in Phase ≤20:
 *                                 20 polls × 3s, then the checkout FAILS with the
 *                                 same timeout message.
 *   CROSS_CHAIN_VERIFY_PROFILE  — the Phase 21F fix. A CCTP burn is only the FIRST
 *                                 step of a journey that mints on Arc minutes later,
 *                                 so: (1) the budget is long, (2) polling STOPS as
 *                                 soon as the server reports a transfer state the
 *                                 reconciliation worker owns (the journey exists and
 *                                 is finalised — re-submitting adds no information),
 *                                 and (3) running out of budget is NOT a failure:
 *                                 the burn is real and still settling, so the UI
 *                                 stays on the honest 'submitted' state instead of
 *                                 crying "payment failed" over a paid payment.
 */

/** The subset of checkout reducer actions this bridge may dispatch. */
export type VerifyBridgeAction =
  | { type: 'SUCCEEDED'; receiptId?: string | null }
  | { type: 'EXPIRED' }
  | { type: 'FAILED'; error: string }
  | { type: 'SUBMITTED'; hash: string };

/** Minimal structural `fetch` — lets tests inject a recorder, no DOM types needed. */
export type VerifyFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface VerifyProfile {
  /** Maximum number of verify POSTs. */
  attempts: number;
  /** Delay before the first POST. */
  firstDelayMs: number;
  /** Delay between subsequent POSTs. */
  delayMs: number;
  /**
   * Cross-chain only: stop as soon as the server names a transfer state that the
   * reconciliation worker drives on its own. `source_finalizing` is deliberately
   * EXCLUDED — a non-finalised burn is the one state where another submission
   * genuinely advances the journey (re-detection is idempotent server-side).
   */
  stopWhenHandedToWorker: boolean;
  /** What the UI becomes when the budget runs out with the journey unfinished. */
  onExhausted: 'failed' | 'submitted';
  /** Only used with `onExhausted: 'failed'`. */
  exhaustedError?: string;
}

/** Unchanged Phase ≤20 same-chain behaviour (20 × 3s, then a visible failure). */
export const SAME_CHAIN_VERIFY_PROFILE: VerifyProfile = Object.freeze({
  attempts: 20,
  firstDelayMs: 3000,
  delayMs: 3000,
  stopWhenHandedToWorker: false,
  onExhausted: 'failed',
  exhaustedError: 'Verification timed out. Contact the merchant with your transaction hash.',
});

/**
 * Cross-chain behaviour. 3s for the first POST (the burn usually is not mined yet —
 * the server answers retryable-'processing'), then a 20s cadence for ~13 minutes so
 * the source-finality gate has a real chance to be observed from the browser, and it
 * exits early the moment the journey is worker-owned.
 */
export const CROSS_CHAIN_VERIFY_PROFILE: VerifyProfile = Object.freeze({
  attempts: 40,
  firstDelayMs: 3000,
  delayMs: 20000,
  stopWhenHandedToWorker: true,
  onExhausted: 'submitted',
});

/**
 * `cross_chain_transfers.state` values that prove the journey exists AND is
 * attestation-eligible (or further): from here the worker owns it, so the browser
 * stops re-submitting. Mirrors ATTESTABLE_STATES / post-attestation states in
 * server/blockchain/cctp-attestation.ts — a client-side READ-ONLY mirror used only
 * to decide when to stop polling, never to decide that a payment happened.
 */
export const WORKER_OWNED_TRANSFER_STATES: readonly string[] = Object.freeze([
  'source_finalized',
  'attestation_pending',
  'attested',
  'destination_pending',
  'destination_submitted',
  'destination_confirmed',
  'settled',
]);

export interface VerifyBridgeDeps {
  /** Payment intent id — also the unguessable capability of the checkout. */
  checkoutId: string;
  /** The intent's PINNED chain id, asserted to the server (never selects a chain). */
  chainId: number;
  /** The customer's transaction hash (same-chain transfer or source CCTP burn). */
  txHash: string;
  profile: VerifyProfile;
  dispatch: (action: VerifyBridgeAction) => void;
  fetchImpl: VerifyFetch;
  /** Optional receipt address typed at pay time; empty is omitted. */
  receiptEmail?: string;
  /** Injectable timer so tests never actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Why the loop stopped — returned for assertions/logging, never used for money. */
export type VerifyBridgeOutcome =
  | 'succeeded'
  | 'expired'
  | 'failed'
  | 'handed_off'
  | 'exhausted'
  | 'aborted';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The `fetchImpl` every browser caller should pass.
 *
 * Do NOT pass a bare `fetch` reference. `fetchImpl` is a parameter, so the loop below
 * calls it as `fetchImpl(url, init)`: handing it the global function turns the request
 * into a DETACHED global-method call, whose receiver is `undefined` (measured under
 * bun/JSC) and is host-dependent for a WebIDL method otherwise. The wrapper keeps the
 * call site the plain unqualified `fetch(...)` — byte-for-byte the form the inline
 * checkout loop has always used and that ships in production today. That matters here
 * because the bridge intentionally treats every throw as transient: a receiver problem
 * would not surface as an error, it would just silently burn the whole poll budget.
 */
export const browserFetch: VerifyFetch = (input, init) => fetch(input, init);

/**
 * Poll the existing verify endpoint until the server reports a terminal outcome (or,
 * for cross-chain, until the journey is worker-owned). Idempotent by construction:
 * the endpoint is designed to be re-called with the same hash, and the guard that
 * prevents a double submission lives with the caller (`verifyingRef` in CheckoutPage).
 */
export async function verifyCheckoutTransaction(deps: VerifyBridgeDeps): Promise<VerifyBridgeOutcome> {
  const { checkoutId, chainId, txHash, profile, dispatch, fetchImpl } = deps;
  if (!checkoutId) return 'aborted'; // never POST at an unknown checkout
  const sleep = deps.sleep ?? wait;

  for (let attempt = 0; attempt < profile.attempts; attempt++) {
    await sleep(attempt === 0 ? profile.firstDelayMs : profile.delayMs);
    try {
      const res = await fetchImpl(`/api/checkout/${checkoutId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx_hash: txHash,
          chain_id: chainId,
          // Optional receipt destination. Empty is omitted; the server validates it
          // BEFORE the money path and is now the single place that persists it.
          ...(deps.receiptEmail && deps.receiptEmail.trim() ? { receipt_email: deps.receiptEmail.trim() } : {}),
        }),
      });
      const data = (await res.json()) as {
        status?: string; error?: string; receipt_id?: string | null;
        transfer_id?: string; state?: string;
      };

      // Terminal outcomes — stop polling immediately.
      if (data.status === 'succeeded') { dispatch({ type: 'SUCCEEDED', receiptId: data.receipt_id ?? null }); return 'succeeded'; }
      if (data.status === 'expired') { dispatch({ type: 'EXPIRED' }); return 'expired'; }
      if (data.status === 'failed') { dispatch({ type: 'FAILED', error: data.error ?? 'Verification failed' }); return 'failed'; }

      // Permanent HTTP errors (e.g. 400 malformed tx_hash / wrong_network, 422
      // verification failure) must NOT be retried — surface them instead of
      // waiting indefinitely.
      if (res.status === 400 || res.status === 422) {
        dispatch({ type: 'FAILED', error: data.error ?? 'Payment verification failed' });
        return 'failed';
      }

      // CROSS-CHAIN handoff: the server now holds a transfer row that the
      // reconciliation worker can drive (finalised, attested, or past that). Keep
      // the 'submitted' message the customer already saw and stop re-submitting.
      if (profile.stopWhenHandedToWorker && typeof data.transfer_id === 'string'
        && typeof data.state === 'string' && WORKER_OWNED_TRANSFER_STATES.includes(data.state)) {
        dispatch({ type: 'SUBMITTED', hash: txHash });
        return 'handed_off';
      }
      // Otherwise (e.g. status 'processing' — tx not yet confirmed / source burn not
      // finalised yet) keep polling.
    } catch { /* network/RPC transient error — keep polling */ }
  }

  if (profile.onExhausted === 'submitted') {
    // A cross-chain burn that is still settling is NOT a failed payment. Keep the
    // honest 'submitted' state (and the burn hash, for explorer tracking).
    dispatch({ type: 'SUBMITTED', hash: txHash });
    return 'exhausted';
  }
  dispatch({ type: 'FAILED', error: profile.exhaustedError ?? 'Verification timed out.' });
  return 'exhausted';
}
