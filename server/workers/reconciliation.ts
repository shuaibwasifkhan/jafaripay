import { getDb } from '../db/schema.js';
import { processPendingDeliveries, enqueueWebhookDeliveries, emitCrossChainLifecycleWebhook } from '../webhooks/delivery.js';
import { processPendingReceiptEmails } from '../receipts/service.js';
import { generateId } from '../lib/ids.js';
import { PI_SETTLEMENT_GRACE_S } from '../blockchain/arc-provider.js';
import { requestAttestation, type FetchLike } from '../blockchain/cctp-attestation.js';
import { settleDestination } from '../blockchain/cctp-destination.js';
import type { DestinationProvider } from '../blockchain/cctp-destination.js';
import { advanceSourceFinality } from '../blockchain/cctp-source.js';
import type { SourceBurnProviderFactory } from '../blockchain/cctp-source.js';
import { advanceTransferState } from '../blockchain/cctp-state.js';

let running = false;

// Cross-chain worker tuning. Bounded so one tick can never hammer Circle or the
// Arc RPC, and every module self-gates on its stored schedule anyway.
const CROSS_CHAIN_BATCH = 25;
// An ATTESTED transfer whose destination mint never lands is parked as
// destination_failed after this window, so a stuck journey can't pin an intent
// in 'processing' forever (the expiry sweep then releases it).
const DESTINATION_TIMEOUT_S = 60 * 60;
// PHASE 21G — how long a `source_finalizing` row must sit before the worker
// re-reads its source finality. Detection only parks a row here when the source
// block has NOT yet crossed the registry boundary, so the only thing that can
// change the verdict is time passing on the source chain. The worker ticks every
// 30s; re-looking at a row every 5 min is already far tighter than any supported
// finality mode needs, and it bounds RPC load to one read per stale row per
// window (a Source that never finalizes would otherwise be re-read every tick).
// Rows are selected by `updated_at`, which advanceSourceFinality stamps on every
// non-advancing outcome — so this is a throttle, not a deadline, and it can
// never finalize anything early.
const SOURCE_FINALITY_RECHECK_S = 5 * 60;

export interface CrossChainDeps {
  /** Circle Iris fetch. Defaults to global fetch (production). Injectable in tests. */
  fetchImpl?: FetchLike;
  /** Builds the Arc destination receipt reader. Defaults to the registry provider. */
  providerFactory?: (destinationNetwork: string) => DestinationProvider;
  /**
   * PHASE 21G: builds the SOURCE-chain reader used by the source-finality
   * re-check. Defaults to the registry-pinned ArcProvider (production); tests
   * MUST inject a fake, because this sweep would otherwise issue live RPC for
   * every `source_finalizing` row in the shared test database.
   */
  sourceProviderFactory?: SourceBurnProviderFactory;
  /** Injectable clock (unixepoch seconds). */
  nowSeconds?: number;
}

export function startWorker(): void {
  if (running) return;
  running = true;
  console.log('[Worker] Starting reconciliation + webhook + cross-chain worker');
  void workerLoop();
}

async function workerLoop(): Promise<void> {
  while (running) {
    try { await tick(); } catch (err) { console.error('[Worker] Error:', err); }
    await sleep(30_000);
  }
}

// Exported for tests; also used by the internal worker loop.
export async function tick(deps?: CrossChainDeps): Promise<void> {
  const now = deps?.nowSeconds ?? Math.floor(Date.now() / 1000);

  // Same-chain sweeps (unchanged semantics; additive in-flight guard below).
  runExpirySweep(now);
  runStuckReset(now);

  // Process pending webhook deliveries
  await processPendingDeliveries();

  // Process pending receipt delivery emails (isolated from payment status —
  // this only updates receipts.email_status, never payments/payment_intents).
  await processPendingReceiptEmails();

  // Drive the cross-chain pipeline (isolated — a failure here can never corrupt
  // the same-chain sweeps above, which have already run).
  await tickCrossChain(deps);
}

/**
 * Expire overdue payment intents — only once the settlement grace has also
 * elapsed, so a slightly late but valid on-chain payment can still be verified
 * and credited. No blockchain scanning is performed here.
 *
 * CROSS-CHAIN (PHASE 11): a cross-chain journey legitimately takes minutes
 * (source finality + Circle attestation + Arc mint), so an intent backed by an
 * IN-FLIGHT (non-terminal) cross_chain_transfers row must NOT be expired just
 * because it passed expires_at+grace. Same-chain intents have no such row, so
 * the NOT EXISTS is TRUE for them and their behaviour is byte-for-byte the prior
 * code — the same-chain expiry path is provably untouched. When a cross-chain
 * leg reaches a terminal failure state the guard releases and it expires next
 * tick.
 */
export function runExpirySweep(now: number): number {
  const db = getDb();
  type PiRow = { id: string; environment: string };
  const expired = db.prepare(
    `SELECT id,environment FROM payment_intents pi
      WHERE status IN ('requires_payment','processing') AND expires_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM cross_chain_transfers cct
           WHERE cct.payment_intent_id = pi.id
             AND cct.state NOT IN ('settled','attestation_timeout','destination_failed','source_reorg','verification_failed')
        )`,
  ).all(now - PI_SETTLEMENT_GRACE_S) as PiRow[];
  for (const pi of expired) {
    db.prepare("UPDATE payment_intents SET status='expired',updated_at=unixepoch() WHERE id=?").run(pi.id);
    db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,to_status) VALUES(?,?,?,?)').run(generateId('pe'), pi.id, 'payment.expired', 'expired');
    enqueueWebhookDeliveries(pi.id, 'payment.expired', { payment_intent_id: pi.id }, pi.environment as 'test' | 'live');
  }
  return expired.length;
}

/**
 * Reset stuck 'processing' intents (>5 min with no payment). CROSS-CHAIN: skip
 * intents whose journey is in-flight (same NOT EXISTS rule), otherwise we would
 * bounce an attested/pending cross-chain intent back to 'requires_payment' and
 * let a customer re-pay it mid-settlement.
 */
export function runStuckReset(now: number): number {
  const db = getDb();
  type StuckRow = { id: string };
  const stuck = db.prepare(
    `SELECT pi.id FROM payment_intents pi
       LEFT JOIN payments p ON p.payment_intent_id=pi.id
      WHERE pi.status='processing' AND p.id IS NULL AND pi.updated_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM cross_chain_transfers cct
           WHERE cct.payment_intent_id = pi.id
             AND cct.state NOT IN ('settled','attestation_timeout','destination_failed','source_reorg','verification_failed')
        )`,
  ).all(now - 300) as StuckRow[];
  for (const pi of stuck) {
    db.prepare("UPDATE payment_intents SET status='requires_payment',updated_at=unixepoch() WHERE id=?").run(pi.id);
  }
  return stuck.length;
}

/**
 * Advance every in-flight cross-chain transfer by ONE step. Each stage is fully
 * idempotent and self-gated (attestation backoff, settle idempotency, storage
 * replay), so re-running this tick is always safe and a restart resumes exactly
 * where it left off. Errors are isolated per-transfer: one poisoned row can
 * never stall the batch or crash the loop.
 *
 * PHASE 21G added step 0: recovering a `source_finalizing` row whose source block
 * has since become final. It runs FIRST so a transfer that finalizes in this tick
 * is eligible for the attestation sweep in the same tick.
 */
export async function tickCrossChain(deps?: CrossChainDeps): Promise<{ finalized: number; attested: number; settled: number; timedOut: number }> {
  const db = getDb();
  const now = deps?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const stats = { finalized: 0, attested: 0, settled: 0, timedOut: 0 };

  // ── 0. Source-finality recovery sweep (PHASE 21G). The browser submits the burn
  // via POST /checkout/:id/verify; if the source chain is not final yet the row is
  // recorded 'source_finalizing' and detection is the ONLY thing that ever re-read
  // finality — i.e. the journey waited on another browser visit. These rows are
  // picked up here instead, so the payment completes after the tab is closed.
  // advanceSourceFinality reuses the existing PHASE 6 registry finality gate and
  // the PHASE 9 state router; a row whose block is still short stays exactly where
  // it is (only `updated_at` moves) and is re-checked next window. It never marks a
  // transfer failed and never emits an event, so this sweep cannot duplicate or
  // manufacture anything.
  const dueForFinality = db.prepare(
    `SELECT id FROM cross_chain_transfers
      WHERE state='source_finalizing'
        AND source_tx_hash IS NOT NULL
        AND updated_at <= ?
      ORDER BY updated_at ASC LIMIT ?`,
  ).all(now - SOURCE_FINALITY_RECHECK_S, CROSS_CHAIN_BATCH) as Array<{ id: string }>;
  for (const { id } of dueForFinality) {
    try {
      const res = await advanceSourceFinality({
        transferId: id, providerFactory: deps?.sourceProviderFactory, nowSeconds: now,
      });
      if (res.ok && res.outcome === 'finalized') {
        stats.finalized += 1;
      } else if (!res.ok && !res.retryable) {
        // A source tx that can never be valid stays parked (existing semantics:
        // this project has no writer for a failed/reorg source state). Loud in the
        // logs, silent in the database — nothing here is allowed to invent progress.
        console.warn(`[Worker] source-finality recovery permanently refused for ${id}: ${res.code} - ${res.reason}`);
      }
    } catch (err) {
      console.error(`[Worker] source-finality tick failed for ${id}:`, err);
    }
  }

  // ── 1. Attestation sweep (PHASE 7). Only due, finalized, attestation-stage rows.
  // requestAttestation itself enforces the back-off/timeout/finality gates, so
  // the WHERE here is just a coarse pre-filter to avoid needless function calls.
  const dueForAttestation = db.prepare(
    `SELECT id FROM cross_chain_transfers
      WHERE state IN ('source_finalized','attestation_pending')
        AND source_tx_hash IS NOT NULL
        AND (next_attestation_attempt_at IS NULL OR next_attestation_attempt_at <= ?)
      ORDER BY next_attestation_attempt_at ASC LIMIT ?`,
  ).all(now, CROSS_CHAIN_BATCH) as Array<{ id: string }>;
  for (const { id } of dueForAttestation) {
    try {
      const res = await requestAttestation({ transferId: id, fetchImpl: deps?.fetchImpl ?? defaultFetch, nowSeconds: now });
      if (res.ok && (res.outcome === 'attested' || res.outcome === 'pending')) stats.attested += 1;
    } catch (err) {
      console.error(`[Worker] attestation tick failed for ${id}:`, err);
    }
  }

  // ── 2. Destination settlement sweep (PHASE 8). A transfer reaches here only
  // once its destination mint tx is known (recorded by the claim executor /
  // Circle Forwarding integration via recordDestinationClaim). settleDestination
  // re-verifies the on-Arc mint before it credits ANY money — an attestation or
  // a recorded tx hash alone is never enough.
  const dueForSettlement = db.prepare(
    `SELECT id FROM cross_chain_transfers
      WHERE attestation_status='complete'
        AND state IN ('attested','destination_pending','destination_submitted')
        AND destination_tx_hash IS NOT NULL
      ORDER BY updated_at LIMIT ?`,
  ).all(CROSS_CHAIN_BATCH) as Array<{ id: string }>;
  for (const { id } of dueForSettlement) {
    try {
      const tx = db.prepare('SELECT destination_tx_hash FROM cross_chain_transfers WHERE id=?').get(id) as { destination_tx_hash: string };
      const res = await settleDestination({
        transferId: id, destinationTxHash: tx.destination_tx_hash,
        providerFactory: deps?.providerFactory, nowSeconds: now,
      });
      if (res.ok && res.outcome === 'settled') stats.settled += 1;
    } catch (err) {
      console.error(`[Worker] settlement tick failed for ${id}:`, err);
    }
  }

  // ── 3. Destination-timeout sweep. An ATTESTED transfer that never received a
  // destination mint tx within DESTINATION_TIMEOUT_S is parked as
  // destination_failed (terminal), releasing the intent to the expiry sweep.
  // Only touches rows with NO destination tx yet, so an in-flight claim is safe.
  const timedOutRows = db.prepare(
    `SELECT id,payment_intent_id FROM cross_chain_transfers
      WHERE attestation_status='complete'
        AND state IN ('attested','destination_pending','destination_submitted')
        AND destination_tx_hash IS NULL
        AND updated_at < ?`,
  ).all(now - DESTINATION_TIMEOUT_S) as Array<{ id: string; payment_intent_id: string }>;
  for (const r of timedOutRows) {
    try {
      const adv = advanceTransferState(r.id, 'destination_failed', { nowSeconds: now, reason: 'destination mint not observed within window' });
      if (adv.ok) {
        db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,to_status,data) VALUES(?,?,?,?,?)').run(
          generateId('pe'), r.payment_intent_id, 'payment.cross_chain.destination_failed', 'processing',
          JSON.stringify({ transfer_id: r.id, window_seconds: DESTINATION_TIMEOUT_S }),
        );
        // PHASE 12: the attested destination mint never landed within the window
        // — a terminal cross-chain failure. Notify the merchant with the cause.
        emitCrossChainLifecycleWebhook(r.payment_intent_id, 'payment.cross_chain.failed', {
          payment_intent_id: r.payment_intent_id,
          transfer_id: r.id,
          reason: 'destination_timeout',
          detail: 'destination mint not observed within window',
          window_seconds: DESTINATION_TIMEOUT_S,
        });
        stats.timedOut += 1;
      }
    } catch (err) {
      console.error(`[Worker] destination-timeout tick failed for ${r.id}:`, err);
    }
  }

  return stats;
}

export type RecordClaimResult =
  | { ok: true; outcome: 'recorded' | 'already_recorded'; state: string }
  | { ok: false; code: 'transfer_not_found' | 'not_attested' | 'invalid_tx_hash' | 'already_settled' | 'destination_conflict' | 'state_not_eligible'; reason: string };

/**
 * Sanctioned way to attach the destination Arc mint tx to an ATTESTED transfer
 * once the claim has been submitted (by the operational relayer or Circle
 * Forwarding). It NEVER credits — crediting stays exclusively inside
 * settleDestination's verified atomic path. This only records WHERE to look and
 * advances the operational state to 'destination_submitted'.
 *
 * Guards: the transfer must be attested (attestation_status 'complete') and in a
 * pre-settlement state. Re-recording the SAME tx is an idempotent no-op; a
 * DIFFERENT tx for an already-recorded transfer is refused, and the storage
 * UNIQUE index uq_cct_dest_tx blocks two transfers claiming one mint.
 */
export function recordDestinationClaim(transferId: string, destinationTxHash: string, nowSeconds?: number): RecordClaimResult {
  const db = getDb();
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!/^0x[0-9a-fA-F]{64}$/.test(destinationTxHash)) {
    return { ok: false, code: 'invalid_tx_hash', reason: 'destination tx hash must be 0x + 64 hex' };
  }
  const row = db.prepare('SELECT attestation_status,state,destination_tx_hash FROM cross_chain_transfers WHERE id=?').get(transferId) as
    { attestation_status: string; state: string; destination_tx_hash: string | null } | undefined;
  if (!row) return { ok: false, code: 'transfer_not_found', reason: `transfer "${transferId}" not found` };
  if (row.attestation_status !== 'complete') return { ok: false, code: 'not_attested', reason: 'only an attested transfer may record a destination claim' };
  if (row.state === 'settled' || row.state === 'destination_confirmed') return { ok: false, code: 'already_settled', reason: `transfer already in terminal settlement state "${row.state}"` };
  if (!['attested', 'destination_pending', 'destination_submitted'].includes(row.state)) {
    return { ok: false, code: 'state_not_eligible', reason: `state "${row.state}" cannot record a destination claim` };
  }
  if (row.destination_tx_hash && row.destination_tx_hash !== destinationTxHash) {
    return { ok: false, code: 'destination_conflict', reason: `transfer already bound to ${row.destination_tx_hash}` };
  }
  if (row.destination_tx_hash === destinationTxHash && row.state === 'destination_submitted') {
    return { ok: true, outcome: 'already_recorded', state: row.state };
  }
  try {
    db.prepare(
      `UPDATE cross_chain_transfers SET destination_tx_hash=?, state='destination_submitted', updated_at=?
        WHERE id=? AND (destination_tx_hash IS NULL OR destination_tx_hash=?)`,
    ).run(destinationTxHash, now, transferId, destinationTxHash);
  } catch (err) {
    // uq_cct_dest_tx violated → another transfer already owns this mint.
    return { ok: false, code: 'destination_conflict', reason: `destination tx already claimed by another transfer: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, outcome: 'recorded', state: 'destination_submitted' };
}

// Production fetch for Circle. Response is structurally compatible with the
// minimal FetchLike contract (status/ok/json).
const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function stopWorker(): void { running = false; }
