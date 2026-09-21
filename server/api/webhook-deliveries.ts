import { Router, type Request, type Response } from 'express';
import { requireSession, type AuthedRequest } from '../middleware/auth.js';
import { getDb } from '../db/schema.js';

const router = Router();

// GET /webhook-deliveries — list all deliveries for this merchant
router.get('/', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const deliveries = db.prepare(
    `SELECT wd.id, wd.webhook_endpoint_id, wd.payment_intent_id, wd.event_type,
            wd.status, wd.attempts, wd.next_attempt_at, wd.delivered_at, wd.created_at,
            we.url as endpoint_url
     FROM webhook_deliveries wd
     JOIN webhook_endpoints we ON we.id = wd.webhook_endpoint_id
     WHERE we.merchant_id = ?
     ORDER BY wd.created_at DESC LIMIT 50`
  ).all(ar.merchantId!);
  res.json({ data: deliveries });
});

// POST /webhook-deliveries/:id/retry
router.post('/:id/retry', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const delivery = db.prepare(
    'SELECT wd.id FROM webhook_deliveries wd JOIN webhook_endpoints we ON we.id=wd.webhook_endpoint_id WHERE wd.id=? AND we.merchant_id=?'
  ).get(req.params.id, ar.merchantId!) as { id: string } | null;
  if (!delivery) { res.status(404).json({ error: 'Delivery not found' }); return; }
  db.prepare(
    "UPDATE webhook_deliveries SET status='pending',attempts=0,next_attempt_at=unixepoch(),last_error=NULL,updated_at=unixepoch() WHERE id=?"
  ).run(req.params.id);
  res.json({ id: req.params.id, retried: true });
});

export default router;
