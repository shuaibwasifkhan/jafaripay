import { Router, type Request, type Response } from 'express';
import { requireSession, type AuthedRequest } from '../middleware/auth.js';
import { getDb } from '../db/schema.js';
import { generateId } from '../lib/ids.js';

const router = Router();

router.get('/', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  res.json({ data: db.prepare('SELECT id, name, description, is_active, created_at FROM projects WHERE merchant_id = ? ORDER BY created_at ASC').all(ar.merchantId!) });
});

router.post('/', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const { name, description } = req.body as { name: string; description?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
  const db = getDb();
  const id = generateId('proj');
  db.prepare('INSERT INTO projects(id, merchant_id, name, description) VALUES(?, ?, ?, ?)').run(id, ar.merchantId!, name.trim(), description?.trim() || '');
  res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
});

router.get('/:id', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND merchant_id = ?').get(req.params.id, ar.merchantId!);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json(project);
});

router.patch('/:id', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const { name, description, is_active } = req.body as { name?: string; description?: string; is_active?: boolean };
  const db = getDb();
  if (!db.prepare('SELECT id FROM projects WHERE id = ? AND merchant_id = ?').get(req.params.id, ar.merchantId!)) {
    res.status(404).json({ error: 'Project not found' }); return;
  }
  db.prepare('UPDATE projects SET name=COALESCE(?,name), description=COALESCE(?,description), is_active=COALESCE(?,is_active), updated_at=unixepoch() WHERE id=?')
    .run(name?.trim() || null, description ?? null, is_active != null ? (is_active ? 1 : 0) : null, req.params.id);
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
});

export default router;
