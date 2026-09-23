import { getDb } from '../db/schema.js';
import { processPendingDeliveries, enqueueWebhookDeliveries } from '../webhooks/delivery.js';
import { generateId } from '../lib/ids.js';
import { PI_SETTLEMENT_GRACE_S } from '../blockchain/arc-provider.js';

let running = false;

export function startWorker(): void {
  if (running) return;
  running = true;
  console.log('[Worker] Starting reconciliation + webhook worker');
  void workerLoop();
}

async function workerLoop(): Promise<void> {
  while (running) {
    try { await tick(); } catch (err) { console.error('[Worker] Error:', err); }
    await sleep(30_000);
  }
}

// Exported for tests; also used by the internal worker loop.
export async function tick(): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Expire overdue payment intents — only once the settlement grace has also
  // elapsed, so a slightly late but valid on-chain payment can still be
  // verified and credited. No blockchain scanning is performed here.
  type PiRow = { id: string; environment: string };
  const expired = db.prepare("SELECT id,environment FROM payment_intents WHERE status IN ('requires_payment','processing') AND expires_at < ?").all(now - PI_SETTLEMENT_GRACE_S) as PiRow[];
  for (const pi of expired) {
    db.prepare("UPDATE payment_intents SET status='expired',updated_at=unixepoch() WHERE id=?").run(pi.id);
    db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,to_status) VALUES(?,?,?,?)').run(generateId('pe'), pi.id, 'payment.expired', 'expired');
    enqueueWebhookDeliveries(pi.id, 'payment.expired', { payment_intent_id: pi.id }, pi.environment as 'test' | 'live');
  }

  // Reset stuck 'processing' intents (>5 min with no payment)
  type StuckRow = { id: string };
  const stuck = db.prepare(`SELECT pi.id FROM payment_intents pi LEFT JOIN payments p ON p.payment_intent_id=pi.id WHERE pi.status='processing' AND p.id IS NULL AND pi.updated_at < ?`).all(now - 300) as StuckRow[];
  for (const pi of stuck) {
    db.prepare("UPDATE payment_intents SET status='requires_payment',updated_at=unixepoch() WHERE id=?").run(pi.id);
  }

  // Process pending webhook deliveries
  await processPendingDeliveries();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function stopWorker(): void { running = false; }
