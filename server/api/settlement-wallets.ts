import { Router, type Request, type Response } from 'express';
import { requireSession, type AuthedRequest } from '../middleware/auth.js';
import { getDb } from '../db/schema.js';
import { generateId } from '../lib/ids.js';
import { isAddress } from 'viem';

const router = Router();

router.get('/', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const rows = getDb().prepare('SELECT * FROM settlement_wallets WHERE merchant_id=? AND is_active=1 ORDER BY created_at DESC').all(ar.merchantId!) as Array<Record<string, unknown>>;
  // Add `environment` field (test/live) derived from network
  const data = rows.map(r => ({
    ...r,
    environment: r['network'] === 'arc_mainnet' ? 'live' : 'test',
  }));
  res.json({ data });
});

router.post('/', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  // Accept either `environment` (test/live) or `network` (arc_testnet/arc_mainnet)
  const { address, network: rawNetwork, environment, label, project_id } = req.body as {
    address: string; network?: string; environment?: 'test' | 'live'; label?: string; project_id?: string;
  };
  if (!address) { res.status(400).json({ error: 'address is required' }); return; }

  const envToNetwork: Record<string, string> = { test: 'arc_testnet', live: 'arc_mainnet' };
  const network = rawNetwork || (environment ? envToNetwork[environment] : undefined);

  if (!network || !['arc_testnet','arc_mainnet'].includes(network)) {
    res.status(400).json({ error: 'network (arc_testnet|arc_mainnet) or environment (test|live) is required' }); return;
  }
  if (!isAddress(address)) { res.status(400).json({ error: 'Not a valid EVM address' }); return; }
  if (network === 'arc_mainnet' && !process.env.ENABLE_LIVE_PAYMENTS) { res.status(403).json({ error: 'Live mode not enabled. Set ENABLE_LIVE_PAYMENTS=true.' }); return; }

  const db = getDb();
  const id = generateId('sw');
  try {
    db.prepare('INSERT INTO settlement_wallets(id,merchant_id,project_id,address,network,label) VALUES(?,?,?,?,?,?)')
      .run(id, ar.merchantId!, project_id || null, address.toLowerCase(), network, label?.trim() || '');
  } catch (err) {
    if (String(err).includes('UNIQUE')) { res.status(409).json({ error: 'Address already registered for this network' }); return; }
    throw err;
  }
  const row = db.prepare('SELECT * FROM settlement_wallets WHERE id=?').get(id) as Record<string, unknown>;
  // Return `environment` field alongside `network` for frontend convenience
  const envLabel = network === 'arc_mainnet' ? 'live' : 'test';
  res.status(201).json({ ...row, environment: envLabel });
});

router.patch('/:id', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  if (!db.prepare('SELECT id FROM settlement_wallets WHERE id=? AND merchant_id=?').get(req.params.id, ar.merchantId!)) { res.status(404).json({ error: 'Not found' }); return; }
  const { label } = req.body as { label?: string };
  db.prepare('UPDATE settlement_wallets SET label=COALESCE(?,label), updated_at=unixepoch() WHERE id=?').run(label || null, req.params.id);
  res.json(db.prepare('SELECT * FROM settlement_wallets WHERE id=?').get(req.params.id));
});

router.delete('/:id', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  if (!db.prepare('SELECT id FROM settlement_wallets WHERE id=? AND merchant_id=?').get(req.params.id, ar.merchantId!)) { res.status(404).json({ error: 'Not found' }); return; }
  if (db.prepare("SELECT id FROM payment_intents WHERE settlement_wallet_id=? AND status IN ('requires_payment','processing') LIMIT 1").get(req.params.id)) {
    res.status(409).json({ error: 'Active payment intents reference this wallet' }); return;
  }
  db.prepare('UPDATE settlement_wallets SET is_active=0, updated_at=unixepoch() WHERE id=?').run(req.params.id);
  res.json({ id: req.params.id, deleted: true });
});

export default router;
