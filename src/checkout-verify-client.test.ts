/**
 * PHASE 21F — regression coverage for the checkout → verification bridge.
 *
 * The production bug was pure wiring: the cross-chain checkout dispatched
 * 'submitted' after the burn and NEVER told the backend, so detectSourceBurn() —
 * the only creator of a cross_chain_transfers row — never ran, and a real,
 * fully-settled CCTP Forwarding payment left no intent state, no transfer row, no
 * event, no payment, no receipt and no webhook.
 *
 * These tests are browser-free (no wagmi, no DOM) and assert the ACTUAL HTTP
 * contract the customer's browser now performs, plus the state-machine mapping.
 * The server side of the same contract is proven against the real Express route in
 * server/cctp21f-checkout-bridge.test.ts.
 */
import { test, expect } from 'bun:test';
import {
  CROSS_CHAIN_VERIFY_PROFILE, SAME_CHAIN_VERIFY_PROFILE, WORKER_OWNED_TRANSFER_STATES,
  browserFetch, verifyCheckoutTransaction,
  type VerifyBridgeAction, type VerifyFetch, type VerifyProfile,
} from './checkout-verify-client';

const BURN_HASH = '0x' + 'b1'.repeat(32);
const SRC_CHAIN = 8453; // Base Mainnet — the intent's pinned SOURCE chain

interface Responder {
  status?: number;
  body?: Record<string, unknown>;
  throwOnce?: boolean;
}

function bridge(profile: VerifyProfile, queue: Responder[], extra: { receiptEmail?: string } = {}) {
  const actions: VerifyBridgeAction[] = [];
  const delays: number[] = [];
  const { calls, fetchImpl, requestCount } = recorderWithFetch(queue);
  const outcome = verifyCheckoutTransaction({
    checkoutId: 'pi_bridge_test',
    chainId: SRC_CHAIN,
    txHash: BURN_HASH,
    profile,
    dispatch: (a) => { actions.push(a); },
    fetchImpl,
    sleep: async (ms) => { delays.push(ms); },
    ...extra,
  });
  return { actions, delays, calls, outcome, requestCount };
}

function recorderWithFetch(queue: Responder[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  let i = 0;
  const fetchImpl: VerifyFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const next = queue[Math.min(i, queue.length - 1)]!;
    i += 1;
    if (next.throwOnce) throw new Error('network down');
    return { status: next.status ?? 200, json: async () => next.body ?? {} };
  };
  return { calls, fetchImpl, requestCount: () => i };
}

const processing = (state: string, over: Record<string, unknown> = {}) => ({ status: 200, body: { status: 'processing', transfer_id: 'cct_x', state, ...over } });

// ── A + B: the cross-chain burn reaches the EXISTING verification path ───────
test('21F-1: cross-chain submission POSTs the burn hash to the existing checkout verify endpoint', async () => {
  const t = bridge(CROSS_CHAIN_VERIFY_PROFILE, [processing('source_finalized')]);
  expect(await t.outcome).toBe('handed_off');
  expect(t.calls).toHaveLength(1);
  expect(t.calls[0]!.url).toBe('/api/checkout/pi_bridge_test/verify');
  expect(t.calls[0]!.method).toBe('POST');
  expect(t.calls[0]!.headers['Content-Type']).toBe('application/json');
  // The burn hash is passed verbatim, and the chain asserted is the intent's PINNED
  // source chain — the same body the same-chain flow sends.
  expect(t.calls[0]!.body).toEqual({ tx_hash: BURN_HASH, chain_id: SRC_CHAIN });
});

test('21F-2: an optional receipt email is trimmed into the body, empty is omitted', async () => {
  const withEmail = bridge(CROSS_CHAIN_VERIFY_PROFILE, [processing('source_finalized')], { receiptEmail: '  Buyer@Example.com  ' });
  await withEmail.outcome;
  expect(withEmail.calls[0]!.body).toEqual({ tx_hash: BURN_HASH, chain_id: SRC_CHAIN, receipt_email: 'Buyer@Example.com' });

  const without = bridge(CROSS_CHAIN_VERIFY_PROFILE, [processing('source_finalized')], { receiptEmail: '   ' });
  await without.outcome;
  expect('receipt_email' in without.calls[0]!.body).toBe(false);
});

// ── The cross-chain budget: keep going while detection still needs help ──────
test('21F-3: a not-yet-final burn keeps re-submitting; a worker-owned transfer stops the loop', async () => {
  const t = bridge(CROSS_CHAIN_VERIFY_PROFILE, [
    { status: 200, body: { status: 'processing', message: 'Transaction not yet confirmed' } }, // no transfer yet
    processing('source_finalizing'),   // row created, still needs another look
    processing('source_finalized'),    // worker can take it from here
  ]);
  expect(await t.outcome).toBe('handed_off');
  expect(t.requestCount()).toBe(3);
  expect(t.actions).toEqual([{ type: 'SUBMITTED', hash: BURN_HASH }]);
  // 3s to catch the burn landing quickly, then the long 20s cross-chain cadence.
  expect(t.delays).toEqual([3000, 20000, 20000]);
});

test('21F-4: exhausting the cross-chain budget keeps the honest submitted state, never a fake failure', async () => {
  const t = bridge(CROSS_CHAIN_VERIFY_PROFILE, [{ status: 200, body: { status: 'processing', message: 'not final yet' } }]);
  expect(await t.outcome).toBe('exhausted');
  expect(t.requestCount()).toBe(CROSS_CHAIN_VERIFY_PROFILE.attempts);
  expect(t.actions).toEqual([{ type: 'SUBMITTED', hash: BURN_HASH }]);   // hash stays visible for tracking
  expect(t.actions.some((a) => a.type === 'FAILED')).toBe(false);
});

test('21F-5: a hard rejection (422) fails the checkout ONCE and stops submitting', async () => {
  const t = bridge(CROSS_CHAIN_VERIFY_PROFILE, [{ status: 422, body: { error: 'Burned 5000000 base units; requires 10167120', code: 'amount_mismatch' } }]);
  expect(await t.outcome).toBe('failed');
  expect(t.requestCount()).toBe(1);                                     // never retried
  expect(t.actions).toEqual([{ type: 'FAILED', error: 'Burned 5000000 base units; requires 10167120' }]);
});

test('21F-6: a wrong_network 400 surfaces immediately instead of burning the whole budget', async () => {
  const t = bridge(CROSS_CHAIN_VERIFY_PROFILE, [{ status: 400, body: { error: 'Chain ID mismatch', code: 'wrong_network' } }]);
  expect(await t.outcome).toBe('failed');
  expect(t.requestCount()).toBe(1);
  expect(t.actions[0]!.type).toBe('FAILED');
});

test('21F-7: terminal server states map to terminal UI states for both payment kinds', async () => {
  const ok = bridge(CROSS_CHAIN_VERIFY_PROFILE, [{ status: 200, body: { status: 'succeeded', receipt_id: 'rcpt_1' } }]);
  expect(await ok.outcome).toBe('succeeded');
  expect(ok.actions).toEqual([{ type: 'SUCCEEDED', receiptId: 'rcpt_1' }]);

  const noReceipt = bridge(SAME_CHAIN_VERIFY_PROFILE, [{ status: 200, body: { status: 'succeeded', payment: {} } }]);
  expect(await noReceipt.outcome).toBe('succeeded');
  expect(noReceipt.actions).toEqual([{ type: 'SUCCEEDED', receiptId: null }]);

  const gone = bridge(SAME_CHAIN_VERIFY_PROFILE, [{ status: 200, body: { status: 'expired' } }]);
  expect(await gone.outcome).toBe('expired');
  expect(gone.actions).toEqual([{ type: 'EXPIRED' }]);

  const failed = bridge(SAME_CHAIN_VERIFY_PROFILE, [{ status: 200, body: { status: 'failed', error: 'Payment verification failed' } }]);
  expect(await failed.outcome).toBe('failed');
  expect(failed.actions).toEqual([{ type: 'FAILED', error: 'Payment verification failed' }]);
});

// ── E: same-chain behaviour is UNCHANGED ─────────────────────────────────────
test('21F-8: the same-chain profile keeps the shipped 20 x 3s schedule and timeout wording', async () => {
  const t = bridge(SAME_CHAIN_VERIFY_PROFILE, [{ status: 200, body: { status: 'processing', message: 'Transaction not yet confirmed' } }]);
  expect(await t.outcome).toBe('exhausted');
  expect(SAME_CHAIN_VERIFY_PROFILE.attempts).toBe(20);
  expect(t.requestCount()).toBe(20);
  expect(t.delays).toEqual(Array.from({ length: 20 }, () => 3000));
  expect(t.actions).toEqual([{ type: 'FAILED', error: 'Verification timed out. Contact the merchant with your transaction hash.' }]);
});

test('21F-9: same-chain never stops on a transfer state — it waits for the credit it owns', async () => {
  const t = bridge(SAME_CHAIN_VERIFY_PROFILE, [processing('source_finalized')]);
  expect(await t.outcome).toBe('exhausted');   // stopWhenHandedToWorker is cross-chain only
  expect(t.requestCount()).toBe(SAME_CHAIN_VERIFY_PROFILE.attempts);
});

// ── Transient errors must never look like success or duplicate a submission ──
test('21F-10: a transient network error is retried, not reported', async () => {
  const t = bridge(CROSS_CHAIN_VERIFY_PROFILE, [{ throwOnce: true }, processing('source_finalized')]);
  expect(await t.outcome).toBe('handed_off');
  expect(t.requestCount()).toBe(2);
  expect(t.actions).toEqual([{ type: 'SUBMITTED', hash: BURN_HASH }]);
});

test('21F-11: every attempt throwing never produces a success state (cross-chain submitted / same-chain failed)', async () => {
  const cross = bridge(CROSS_CHAIN_VERIFY_PROFILE, [{ throwOnce: true }]);
  expect(await cross.outcome).toBe('exhausted');
  expect(cross.actions).toEqual([{ type: 'SUBMITTED', hash: BURN_HASH }]);

  const same = bridge(SAME_CHAIN_VERIFY_PROFILE, [{ throwOnce: true }]);
  expect(await same.outcome).toBe('exhausted');
  expect(same.actions).toEqual([{ type: 'FAILED', error: 'Verification timed out. Contact the merchant with your transaction hash.' }]);
});

// ── Contract guards ─────────────────────────────────────────────────────────
test('21F-12: source_finalizing is NOT worker-owned; source_finalized and beyond ARE', () => {
  expect(WORKER_OWNED_TRANSFER_STATES).not.toContain('source_finalizing');
  expect(WORKER_OWNED_TRANSFER_STATES).not.toContain('source_payment_submitted');
  for (const s of ['source_finalized', 'attestation_pending', 'attested', 'destination_submitted', 'settled']) {
    expect(WORKER_OWNED_TRANSFER_STATES).toContain(s);
  }
});

test('21F-13: one bridge, two frozen profiles — cross-chain budget is strictly longer', async () => {
  expect(SAME_CHAIN_VERIFY_PROFILE.stopWhenHandedToWorker).toBe(false);
  expect(SAME_CHAIN_VERIFY_PROFILE.onExhausted).toBe('failed');
  expect(CROSS_CHAIN_VERIFY_PROFILE.stopWhenHandedToWorker).toBe(true);
  expect(CROSS_CHAIN_VERIFY_PROFILE.onExhausted).toBe('submitted');
  expect(CROSS_CHAIN_VERIFY_PROFILE.attempts * CROSS_CHAIN_VERIFY_PROFILE.delayMs)
    .toBeGreaterThan(SAME_CHAIN_VERIFY_PROFILE.attempts * SAME_CHAIN_VERIFY_PROFILE.delayMs);
  expect(Object.isFrozen(CROSS_CHAIN_VERIFY_PROFILE)).toBe(true);
  expect(Object.isFrozen(SAME_CHAIN_VERIFY_PROFILE)).toBe(true);

  // An empty checkout id never fires a request at all (no stray /api/checkout//verify).
  const actions: VerifyBridgeAction[] = [];
  const { calls, fetchImpl } = recorderWithFetch([{ body: {} }]);
  const outcome = await verifyCheckoutTransaction({
    checkoutId: '', chainId: SRC_CHAIN, txHash: BURN_HASH,
    profile: CROSS_CHAIN_VERIFY_PROFILE, dispatch: (a) => { actions.push(a); }, fetchImpl,
  });
  expect(outcome).toBe('aborted');
  expect(calls).toHaveLength(0);
  expect(actions).toHaveLength(0);
});

// ── browserFetch is the exact value CheckoutPage hands to the bridge ─────────
// It must behave like the ORIGINAL inline loop, which called the global `fetch(...)`
// directly from inside the component. `fetchImpl` is a parameter, so the bridge calls
// `fetchImpl(url, init)` — handing it a bare `fetch` would turn that into a detached
// global-method call with a different receiver (measured here: `this` is undefined).
// Wrapping keeps the call site the plain unqualified `fetch(...)` the app has always
// used, and matters because the bridge deliberately treats every throw as transient.
test('21F-14: browserFetch drives the bridge through the ambient fetch, request for request', async () => {
  const realFetch = globalThis.fetch;
  const seen: { url: string; method: string; contentType: string | undefined; body: Record<string, unknown> }[] = [];
  (globalThis as { fetch: unknown }).fetch = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    seen.push({ url: String(input), method: init.method, contentType: init.headers['Content-Type'], body: JSON.parse(init.body) as Record<string, unknown> });
    return Promise.resolve({ status: 200, json: async () => ({ status: 'succeeded', receipt_id: 'rcpt_21f' }) });
  };
  try {
    const actions: VerifyBridgeAction[] = [];
    const outcome = await verifyCheckoutTransaction({
      checkoutId: 'pi_bridge_test', chainId: SRC_CHAIN, txHash: BURN_HASH,
      profile: SAME_CHAIN_VERIFY_PROFILE, dispatch: (a) => { actions.push(a); },
      fetchImpl: browserFetch, sleep: async () => {}, receiptEmail: ' Buyer@Example.com ',
    });
    expect(outcome).toBe('succeeded');
    expect(actions).toEqual([{ type: 'SUCCEEDED', receiptId: 'rcpt_21f' }]);
    expect(seen).toHaveLength(1);   // terminal answer ⇒ no further polling
    expect(seen[0]!.url).toBe('/api/checkout/pi_bridge_test/verify');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.contentType).toBe('application/json');
    expect(seen[0]!.body).toEqual({ tx_hash: BURN_HASH, chain_id: SRC_CHAIN, receipt_email: 'Buyer@Example.com' });
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
});
