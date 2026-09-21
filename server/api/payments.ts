import { Router, type Request, type Response } from 'express';
import { requireSession, requireSessionOrApiKey, type AuthedRequest } from '../middleware/auth.js';
import { getDb } from '../db/schema.js';

const router = Router();

// GET /payments/stats — dashboard overview stats (session auth)
router.get('/stats', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(CAST(amount_decimal AS REAL)),0) as vol FROM payments WHERE merchant_id=? AND status='succeeded'").get(ar.merchantId!) as { n: number; vol: number });
  const pending = (db.prepare("SELECT COUNT(*) as n FROM payment_intents WHERE merchant_id=? AND status IN ('requires_payment','processing')").get(ar.merchantId!) as { n: number });
  const allCount = (db.prepare('SELECT COUNT(*) as n FROM payments WHERE merchant_id=?').get(ar.merchantId!) as { n: number }).n;
  const recent = db.prepare('SELECT p.id,p.payment_intent_id,p.amount_decimal AS amount,p.status,p.created_at,pi.order_id,pi.environment FROM payments p JOIN payment_intents pi ON pi.id=p.payment_intent_id WHERE p.merchant_id=? ORDER BY p.created_at DESC LIMIT 5').all(ar.merchantId!);
  res.json({
    total_volume: total.vol.toFixed(6),
    total_count: allCount,
    succeeded_count: total.n,
    pending_count: pending.n,
    recent_payments: recent,
  });
});

router.get('/', requireSessionOrApiKey, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const limit = Math.min(parseInt((req.query.limit as string) || '20', 10), 100);
  const offset = parseInt((req.query.offset as string) || '0', 10);
  const status = req.query.status as string | undefined;

  const params: (string | number)[] = [ar.merchantId!];
  let where = 'WHERE p.merchant_id=?';
  if (status) { where += ' AND p.status=?'; params.push(status); }
  params.push(limit, offset);

  const payments = db.prepare(`SELECT p.*,p.amount_decimal AS amount,pi.order_id,pi.description,pi.environment FROM payments p JOIN payment_intents pi ON pi.id=p.payment_intent_id ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`).all(...params);
  const total = (db.prepare(`SELECT COUNT(*) as n FROM payments WHERE merchant_id=?`).get(ar.merchantId!) as { n: number }).n;
  res.json({ data: payments, total, limit, offset });
});

router.get('/:id', requireSessionOrApiKey, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const payment = db.prepare(`SELECT p.*,p.amount_decimal AS amount,pi.order_id,pi.description,pi.metadata,pi.environment,pi.settlement_address,pi.expires_at FROM payments p JOIN payment_intents pi ON pi.id=p.payment_intent_id WHERE p.id=? AND p.merchant_id=?`).get(req.params.id, ar.merchantId!) as Record<string, unknown> | null;
  if (!payment) { res.status(404).json({ error: 'Payment not found' }); return; }
  const btx = db.prepare('SELECT * FROM blockchain_transactions WHERE payment_id=?').get(req.params.id);
  res.json({ ...payment, blockchain_transaction: btx || null });
});

export default router;
