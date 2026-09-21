import { Router, type Request, type Response } from 'express';
import { requireSession, type AuthedRequest } from '../middleware/auth.js';
import { getDb } from '../db/schema.js';
import { generateId } from '../lib/ids.js';
import { generateAndHashWebhookSecret } from '../webhooks/delivery.js';

const router = Router();
const VALID_EVENTS = ['payment.created','payment.succeeded','payment.failed','payment.expired','payment.processing'];

function isPrivateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;
    const h = parsed.hostname;
    return /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1|0\.0\.0\.0|fc00:|fd[0-9a-f]{2}:)/.test(h);
  } catch { return true; }
}

// Endpoint routes — mounted at /webhook-endpoints
router.get('/', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  res.json({ data: getDb().prepare('SELECT id,url,description,events,environment,is_active,secret_preview,created_at FROM webhook_endpoints WHERE merchant_id=?').all(ar.merchantId!) });
});

router.post('/', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const { url, description, events, environment = 'test' } = req.body as { url: string; description?: string; events?: string[]; environment?: string };
  if (!url) { res.status(400).json({ error: 'url is required' }); return; }
  if (isPrivateUrl(url)) { res.status(400).json({ error: 'Private/local URLs are blocked (SSRF protection)' }); return; }
  if (!['test','live'].includes(environment)) { res.status(400).json({ error: 'environment must be test or live' }); return; }
  try { new URL(url); } catch { res.status(400).json({ error: 'Invalid URL' }); return; }

  const { secret, hash, preview } = generateAndHashWebhookSecret();
  const db = getDb();
  const id = generateId('whe');
  const selectedEvents = events?.filter(e => VALID_EVENTS.includes(e)) || VALID_EVENTS;
  db.prepare('INSERT INTO webhook_endpoints(id,merchant_id,url,secret_hash,secret_preview,description,events,environment) VALUES(?,?,?,?,?,?,?,?)').run(id, ar.merchantId!, url, hash, preview, description || '', JSON.stringify(selectedEvents), environment);
  res.status(201).json({ id, url, description: description || '', events: selectedEvents, environment, secret, secret_preview: preview, is_active: true, created_at: Math.floor(Date.now() / 1000) });
});

router.delete('/:id', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  if (!db.prepare('SELECT id FROM webhook_endpoints WHERE id=? AND merchant_id=?').get(req.params.id, ar.merchantId!)) { res.status(404).json({ error: 'Not found' }); return; }
  db.prepare('DELETE FROM webhook_endpoints WHERE id=?').run(req.params.id);
  res.json({ id: req.params.id, deleted: true });
});

// Delivery routes — also served when mounted at /webhook-deliveries
router.get('/deliveries', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const deliveries = db.prepare(`SELECT wd.id,wd.webhook_endpoint_id,wd.payment_intent_id,wd.event_type,wd.status,wd.attempts,wd.next_attempt_at,wd.delivered_at,wd.created_at,we.url as endpoint_url FROM webhook_deliveries wd JOIN webhook_endpoints we ON we.id=wd.webhook_endpoint_id WHERE we.merchant_id=? ORDER BY wd.created_at DESC LIMIT 50`).all(ar.merchantId!);
  res.json({ data: deliveries });
});

router.post('/deliveries/:id/retry', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const delivery = db.prepare('SELECT wd.id FROM webhook_deliveries wd JOIN webhook_endpoints we ON we.id=wd.webhook_endpoint_id WHERE wd.id=? AND we.merchant_id=?').get(req.params.id, ar.merchantId!) as { id: string } | null;
  if (!delivery) { res.status(404).json({ error: 'Delivery not found' }); return; }
  db.prepare("UPDATE webhook_deliveries SET status='pending',attempts=0,next_attempt_at=unixepoch(),last_error=NULL,updated_at=unixepoch() WHERE id=?").run(req.params.id);
  res.json({ id: req.params.id, retried: true });
});

export default router;
