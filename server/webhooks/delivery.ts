/**
 * JafariPay — Webhook delivery engine + signing
 */

import { createHmac, randomBytes } from 'crypto';
import { getDb } from '../db/schema.js';
import { generateId } from '../lib/ids.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';

const RETRY_DELAYS_S = [10, 30, 120, 300, 1800, 7200, 28800];
const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;

// CROSS-CHAIN (MASTER PHASE 12): two merchant-facing lifecycle events surface the
// intermediate milestones of a CCTP journey that the legacy events cannot express.
//   payment.cross_chain.attestation_received — the source burn is finalized and
//     Circle has attested it; settlement on Arc is pending (progress signal).
//   payment.cross_chain.failed — the journey reached a TERMINAL failure
//     (attestation timeout / signature verification failure / destination mint
//     never observed). Carries a machine reason + human detail. The intent itself
//     still expires via payment.expired once the in-flight guard releases; this
//     event gives the merchant the SPECIFIC cause at the moment it happens.
// Final success remains the canonical payment.succeeded (emitted by the verified
// destination-settlement credit), now ENRICHED with the cross-chain tx detail —
// it is deliberately NOT duplicated by a second success event.
export type WebhookEventType =
  | 'payment.created' | 'payment.processing' | 'payment.succeeded' | 'payment.failed' | 'payment.expired'
  | 'payment.cross_chain.attestation_received' | 'payment.cross_chain.failed';

export function signWebhookPayload(secret: string, payload: string, timestamp: number): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

export function verifyWebhookSignature(secret: string, rawBody: string, header: string, maxAge = 300): boolean {
  try {
    const parts = Object.fromEntries(header.split(',').map(p => p.split('=') as [string, string]));
    const ts = parseInt(parts['t'], 10);
    const v1 = parts['v1'];
    if (!ts || !v1) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > maxAge) return false;
    const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    const eBuf = Buffer.from(expected, 'hex');
    const aBuf = Buffer.from(v1, 'hex');
    if (eBuf.length !== aBuf.length) return false;
    let diff = 0;
    for (let i = 0; i < eBuf.length; i++) diff |= eBuf[i] ^ aBuf[i];
    return diff === 0;
  } catch { return false; }
}

export function enqueueWebhookDeliveries(
  paymentIntentId: string, eventType: WebhookEventType,
  eventData: Record<string, unknown>, environment: 'test' | 'live'
): void {
  const db = getDb();
  type EpRow = { id: string; url: string; secret_hash: string; events: string };
  const endpoints = db.prepare(`SELECT we.id,we.url,we.secret_hash,we.events FROM webhook_endpoints we JOIN payment_intents pi ON pi.merchant_id=we.merchant_id WHERE pi.id=? AND we.is_active=1 AND we.environment=?`).all(paymentIntentId, environment) as EpRow[];
  if (!endpoints.length) return;

  const payload = JSON.stringify({ id: generateId('evt'), type: eventType, created: Math.floor(Date.now() / 1000), data: eventData });
  for (const ep of endpoints) {
    let subs: string[];
    try { subs = JSON.parse(ep.events); } catch { subs = []; }
    if (!subs.includes(eventType)) continue;
    db.prepare('INSERT INTO webhook_deliveries(id,webhook_endpoint_id,payment_intent_id,event_type,payload,status,attempts,next_attempt_at) VALUES(?,?,?,?,?,?,?,unixepoch())').run(generateId('del'), ep.id, paymentIntentId, eventType, payload, 'pending', 0);
  }
}

/**
 * CROSS-CHAIN (MASTER PHASE 12): emit a merchant-facing cross-chain lifecycle
 * webhook. The pipeline modules (PHASE 7 attestation, PHASE 11 worker) hold only
 * the payment_intent_id, so this resolves the intent's own environment before
 * delegating to the standard, tenant/environment-gated, subscription-filtered
 * enqueue. Safe no-op when the intent is gone or has no subscribed active
 * endpoint — the SAME guards that protect every other webhook delivery.
 */
export function emitCrossChainLifecycleWebhook(
  paymentIntentId: string,
  eventType: Extract<WebhookEventType, 'payment.cross_chain.attestation_received' | 'payment.cross_chain.failed'>,
  data: Record<string, unknown>,
): void {
  const db = getDb();
  const pi = db.prepare('SELECT environment FROM payment_intents WHERE id=?').get(paymentIntentId) as { environment: string } | undefined;
  if (!pi) return;
  enqueueWebhookDeliveries(paymentIntentId, eventType, data, pi.environment as 'test' | 'live');
}

export async function processPendingDeliveries(): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Phase L (H-1): we sign with the endpoint's RAW secret, decrypted at signing
  // time from secret_ciphertext. secret_hash is never used to sign (merchants
  // hold the raw secret and verify HMAC(rawBody, rawSecret)). Endpoints created
  // before Phase L have no ciphertext → fail closed (no send, no payment
  // mutation) until the merchant rotates the secret once.
  type DRow = { id: string; payload: string; attempts: number; url: string; secret_ciphertext: string | null };
  const pending = db.prepare(`SELECT wd.id,wd.payload,wd.attempts,we.url,we.secret_ciphertext FROM webhook_deliveries wd JOIN webhook_endpoints we ON we.id=wd.webhook_endpoint_id WHERE wd.status IN ('pending','delivering') AND wd.next_attempt_at<=? AND wd.attempts<? LIMIT 20`).all(now, MAX_ATTEMPTS) as DRow[];

  for (const d of pending) {
    db.prepare("UPDATE webhook_deliveries SET status='delivering',updated_at=unixepoch() WHERE id=?").run(d.id);
    const signingSecret = decryptSecret(d.secret_ciphertext);
    if (!signingSecret) {
      db.prepare("UPDATE webhook_deliveries SET status='failed',last_error=?,attempts=attempts+1,updated_at=unixepoch() WHERE id=?").run('signing_secret_unavailable: rotate this endpoint secret', d.id);
      continue;
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhookPayload(signingSecret, d.payload, timestamp);

    // SSRF protection
    try {
      const hostname = new URL(d.url).hostname;
      if (/^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1)/.test(hostname)) {
        db.prepare("UPDATE webhook_deliveries SET status='failed',last_error=?,attempts=attempts+1,updated_at=unixepoch() WHERE id=?").run('SSRF: private URL blocked', d.id);
        continue;
      }
    } catch {
      db.prepare("UPDATE webhook_deliveries SET status='failed',last_error=?,attempts=attempts+1,updated_at=unixepoch() WHERE id=?").run('Invalid URL', d.id);
      continue;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(d.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-JafariPay-Signature': signature, 'User-Agent': 'JafariPay-Webhook/1.0' },
        body: d.payload,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const body = (await response.text().catch(() => '')).slice(0, 2000);
      const attempts = d.attempts + 1;
      const ok = response.status >= 200 && response.status < 300;
      if (ok) {
        db.prepare("UPDATE webhook_deliveries SET status='delivered',last_response_code=?,last_response_body=?,attempts=?,delivered_at=unixepoch(),updated_at=unixepoch() WHERE id=?").run(response.status, body, attempts, d.id);
      } else {
        const nextDelay = RETRY_DELAYS_S[attempts - 1] ?? RETRY_DELAYS_S[RETRY_DELAYS_S.length - 1];
        const finalStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        db.prepare("UPDATE webhook_deliveries SET status=?,last_response_code=?,last_response_body=?,attempts=?,next_attempt_at=?,updated_at=unixepoch() WHERE id=?").run(finalStatus, response.status, body, attempts, now + nextDelay, d.id);
      }
    } catch (err) {
      const attempts = d.attempts + 1;
      const nextDelay = RETRY_DELAYS_S[attempts - 1] ?? RETRY_DELAYS_S[RETRY_DELAYS_S.length - 1];
      db.prepare("UPDATE webhook_deliveries SET status=?,last_error=?,attempts=?,next_attempt_at=?,updated_at=unixepoch() WHERE id=?").run(attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', String(err), attempts, now + nextDelay, d.id);
    }
  }
}

export function generateAndHashWebhookSecret(): { secret: string; hash: string; preview: string; ciphertext: string } {
  const secret = `whsec_${randomBytes(32).toString('hex')}`;
  // hash: lifecycle/identity digest only (never used to sign deliveries).
  const hash = createHmac('sha256', process.env.WEBHOOK_HMAC_SECRET || 'dev-wh-secret').update(secret).digest('hex');
  // ciphertext: AES-256-GCM envelope of the raw secret — the ONLY persisted form
  // from which delivery signatures are produced (decrypted in memory at send).
  return { secret, hash, preview: secret.slice(-4), ciphertext: encryptSecret(secret) };
}

export function hashWebhookSecret(secret: string): string {
  return createHmac('sha256', process.env.WEBHOOK_HMAC_SECRET || 'dev-wh-secret').update(secret).digest('hex');
}
