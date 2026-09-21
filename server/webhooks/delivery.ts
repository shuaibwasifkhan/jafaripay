/**
 * JafariPay — Webhook delivery engine + signing
 */

import { createHmac, randomBytes } from 'crypto';
import { getDb } from '../db/schema.js';
import { generateId } from '../lib/ids.js';

const RETRY_DELAYS_S = [10, 30, 120, 300, 1800, 7200, 28800];
const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;

export type WebhookEventType = 'payment.created' | 'payment.processing' | 'payment.succeeded' | 'payment.failed' | 'payment.expired';

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

export async function processPendingDeliveries(): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  type DRow = { id: string; payload: string; attempts: number; url: string; secret_hash: string };
  const pending = db.prepare(`SELECT wd.id,wd.payload,wd.attempts,we.url,we.secret_hash FROM webhook_deliveries wd JOIN webhook_endpoints we ON we.id=wd.webhook_endpoint_id WHERE wd.status IN ('pending','delivering') AND wd.next_attempt_at<=? AND wd.attempts<? LIMIT 20`).all(now, MAX_ATTEMPTS) as DRow[];

  for (const d of pending) {
    db.prepare("UPDATE webhook_deliveries SET status='delivering',updated_at=unixepoch() WHERE id=?").run(d.id);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhookPayload(d.secret_hash, d.payload, timestamp);

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

export function generateAndHashWebhookSecret(): { secret: string; hash: string; preview: string } {
  const secret = `whsec_${randomBytes(32).toString('hex')}`;
  const hash = createHmac('sha256', process.env.WEBHOOK_HMAC_SECRET || 'dev-wh-secret').update(secret).digest('hex');
  return { secret, hash, preview: secret.slice(-4) };
}

export function hashWebhookSecret(secret: string): string {
  return createHmac('sha256', process.env.WEBHOOK_HMAC_SECRET || 'dev-wh-secret').update(secret).digest('hex');
}
