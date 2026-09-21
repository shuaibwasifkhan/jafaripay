import { Router, type Request, type Response } from 'express';
import { createHmac } from 'crypto';
import { requireSession, type AuthedRequest } from '../middleware/auth.js';
import { getDb } from '../db/schema.js';
import { generateId, generateApiKey } from '../lib/ids.js';

const router = Router();

function hashApiKey(key: string): string {
  return createHmac('sha256', process.env.API_KEY_HMAC_SECRET || 'dev-secret').update(key).digest('hex');
}

router.get('/', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  type Row = { id: string; name: string | null; key_prefix: string; key_preview: string; is_secret: number; environment: string; is_active: number; last_used_at: number | null; created_at: number; revoked_at: number | null };
  const rows = db.prepare('SELECT id,name,key_prefix,key_preview,is_secret,environment,is_active,last_used_at,created_at,revoked_at FROM api_keys WHERE merchant_id=? AND revoked_at IS NULL ORDER BY created_at DESC').all(ar.merchantId!) as Row[];
  // Expose both the raw columns and the aliases the dashboard expects
  // (prefix/type/label). Never include key_hash or the full key.
  const data = rows.map(r => ({
    ...r,
    prefix: r.key_prefix,
    type: r.is_secret ? 'secret' : 'public',
    label: r.name,
  }));
  res.json({ data });
});

// Create an API key. Two supported modes, both mapped to the same schema:
//   • { type: 'public'|'secret', name } → creates ONE key (SDK/legacy contract)
//   • { name|label }                    → creates a pk_+sk_ PAIR (dashboard contract)
// The UI's "Label" is the human name for the key; accept it as `name` too.
router.post('/', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const { name, label, environment, project_id, type } = req.body as {
    name?: string; label?: string; environment: 'test' | 'live'; project_id?: string; type?: 'public' | 'secret';
  };
  // Map the dashboard's `label` onto the required `name` field.
  const keyName = (name ?? label ?? '').trim();
  if (!keyName) { res.status(400).json({ error: 'name is required' }); return; }
  if (!['test','live'].includes(environment)) { res.status(400).json({ error: 'environment must be test or live' }); return; }
  if (environment === 'live' && !process.env.ENABLE_LIVE_PAYMENTS) { res.status(403).json({ error: 'Live mode is not enabled' }); return; }
  if (type !== undefined && !['public','secret'].includes(type)) { res.status(400).json({ error: 'type must be public or secret' }); return; }

  const db = getDb();

  const insertKey = (isSecret: boolean) => {
    const prefix = `${isSecret ? 'sk' : 'pk'}_${environment === 'live' ? 'live' : 'test'}_`;
    const { fullKey, preview } = generateApiKey(prefix);
    const hash = hashApiKey(fullKey);
    const id = generateId('key');
    db.prepare('INSERT INTO api_keys(id,merchant_id,project_id,name,key_prefix,key_hash,key_preview,is_secret,environment) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, ar.merchantId!, project_id || null, keyName, prefix, hash, preview, isSecret ? 1 : 0, environment);
    // full_key/key are returned exactly once, here, and never persisted or logged.
    return { id, name: keyName, label: keyName, key_prefix: prefix, prefix, key_preview: preview, type: (isSecret ? 'secret' : 'public') as 'secret' | 'public', is_secret: isSecret, environment, is_active: true, full_key: fullKey, key: fullKey, created_at: Math.floor(Date.now() / 1000) };
  };

  // Single-key mode (explicit type) — preserves the existing/tested SDK contract.
  if (type !== undefined) {
    res.status(201).json(insertKey(type === 'secret'));
    return;
  }

  // Pair mode (dashboard) — create a publishable + secret key together.
  const public_key = insertKey(false);
  const secret_key = insertKey(true);
  res.status(201).json({ public_key, secret_key });
});

router.delete('/:id', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  if (!db.prepare('SELECT id FROM api_keys WHERE id=? AND merchant_id=?').get(req.params.id, ar.merchantId!)) {
    res.status(404).json({ error: 'API key not found' }); return;
  }
  db.prepare('UPDATE api_keys SET is_active=0, revoked_at=unixepoch() WHERE id=?').run(req.params.id);
  res.json({ id: req.params.id, revoked: true });
});

export default router;
