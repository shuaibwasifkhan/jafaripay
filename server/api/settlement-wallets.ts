import { Router, type Request, type Response } from 'express';
import { requireSession, type AuthedRequest } from '../middleware/auth.js';
import { getDb } from '../db/schema.js';
import { generateId } from '../lib/ids.js';
import { livePaymentsEnabled } from '../lib/production-config.js';
import { getNetworkMeta, listEnabledNetworks } from '../blockchain/arc-provider.js';
import { isAddress } from 'viem';

const router = Router();

// ── Registry-driven network resolution (Phase 5E) ──────────────────────────
// There is deliberately NO hardcoded list of selectable networks here. The
// single trust anchor for every multi-chain decision is `network_configs`:
//   - a slug with no row is unknown  -> 400 (never an Arc fallback)
//   - a row with is_enabled = 0      -> 400 (disabled networks are not selectable)
//   - test/live classification comes from the row's `is_testnet`, NOT from the
//     slug name (`network === 'arc_mainnet' ? 'live' : 'test'` used to force
//     every non-Arc network into the test bucket — that is exactly the Arc-only
//     assumption this phase removes).
// Payment-intent creation already resolves networks this way (Phase 3), so the
// two surfaces cannot drift apart: one registry, one rule.
interface ResolvedNetwork {
  network: string;
  chainId: number;
  environment: 'test' | 'live';
}

function resolveNetworkSelection(
  rawNetwork: unknown,
  environment: unknown,
): { ok: true; resolved: ResolvedNetwork } | { ok: false; status: number; body: Record<string, string> } {
  const trimmed = typeof rawNetwork === 'string' ? rawNetwork.trim() : '';
  const envArg = typeof environment === 'string' ? environment.trim().toLowerCase() : '';

  // `environment` alone remains accepted for backward compatibility, but it is
  // no longer a secret Arc-only mapping: it selects the environment CLASS and
  // the registry then supplies the single matching enabled network. An
  // environment with an ambiguous or empty registry match is refused rather
  // than guessed.
  if (!trimmed) {
    if (envArg !== 'test' && envArg !== 'live') {
      return {
        ok: false, status: 400,
        body: { error: 'network (a registry-enabled slug) or environment (test|live) is required', code: 'invalid_network' },
      };
    }
    const wantTestnet = envArg === 'test';
    const matches = listEnabledNetworks().filter((n) => n.isTestnet === wantTestnet);
    if (matches.length !== 1) {
      return {
        ok: false, status: 400,
        body: {
          error: `environment "${envArg}" no longer maps to exactly one enabled network — select network explicitly`,
          code: 'network_ambiguous',
        },
      };
    }
    const only = matches[0]!;
    return { ok: true, resolved: { network: only.network, chainId: only.chainId, environment: envArg } };
  }

  const meta = getNetworkMeta(trimmed);
  if (!meta) {
    return { ok: false, status: 400, body: { error: `Network "${trimmed}" is not registered`, code: 'invalid_network' } };
  }
  if (!meta.isEnabled) {
    return { ok: false, status: 400, body: { error: `Network "${trimmed}" is disabled`, code: 'network_disabled' } };
  }

  // When both are supplied they must agree — the registry is authoritative, so a
  // client cannot relabel a mainnet-class network as "test" (or vice versa).
  if (envArg) {
    if (envArg !== 'test' && envArg !== 'live') {
      return { ok: false, status: 400, body: { error: 'environment must be test or live', code: 'invalid_environment' } };
    }
    if ((envArg === 'test') !== meta.isTestnet) {
      return {
        ok: false, status: 400,
        body: {
          error: `Network "${trimmed}" is ${meta.isTestnet ? 'testnet' : 'mainnet'}-class and does not match environment "${envArg}"`,
          code: 'environment_network_mismatch',
        },
      };
    }
  }
  return { ok: true, resolved: { network: meta.network, chainId: meta.chainId, environment: meta.isTestnet ? 'test' : 'live' } };
}

// ── GET /v1/networks — the registry, as the dashboard sees it ──────────────
// Enables the wallet picker to be driven by enabled rows instead of a second
// hardcoded list in the frontend. Disabled/unknown rows are simply absent.
router.get('/networks', requireSession, (_req: Request, res: Response) => {
  const data = listEnabledNetworks().map((n) => ({
    network: n.network,
    chain_id: n.chainId,
    environment: n.isTestnet ? 'test' : 'live',
    is_testnet: n.isTestnet,
  }));
  res.json({ data });
});

router.get('/', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  // Join network_configs so each wallet carries its chain_id + testnet class.
  // `environment` is derived from the registry's is_testnet flag (network-agnostic).
  // A wallet whose registry row is missing gets `null` — the frontend falls back to
  // showing the raw slug; we never guess 'test' from a non-Arc name.
  const rows = getDb().prepare(
    `SELECT sw.*, nc.chain_id AS chain_id, nc.is_testnet AS is_testnet
     FROM settlement_wallets sw
     LEFT JOIN network_configs nc ON nc.network = sw.network
     WHERE sw.merchant_id=? AND sw.is_active=1
     ORDER BY sw.created_at DESC`,
  ).all(ar.merchantId!) as Array<Record<string, unknown>>;
  const data = rows.map(r => ({
    ...r,
    environment: r['is_testnet'] === 0 ? 'live' : r['is_testnet'] === 1 ? 'test' : null,
  }));
  res.json({ data });
});

router.post('/', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const { address, network: rawNetwork, environment, label, project_id } = req.body as {
    address: string; network?: string; environment?: 'test' | 'live'; label?: string; project_id?: string;
  };
  if (!address) { res.status(400).json({ error: 'address is required' }); return; }

  const selection = resolveNetworkSelection(rawNetwork, environment);
  if (!selection.ok) { res.status(selection.status).json(selection.body); return; }
  const { network, environment: envLabel } = selection.resolved;

  if (!isAddress(address)) { res.status(400).json({ error: 'Not a valid EVM address' }); return; }
  // Live-class gating is driven by the registry class, not by one Arc slug: no
  // mainnet-class settlement wallet can be registered while the deployment has
  // not enabled live payments. Testnet-class rows are unaffected.
  if (envLabel === 'live' && !livePaymentsEnabled()) { res.status(403).json({ error: 'Live mode not enabled. Set ENABLE_LIVE_PAYMENTS=true.' }); return; }

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
  res.status(201).json({ ...row, environment: envLabel, chain_id: selection.resolved.chainId });
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
