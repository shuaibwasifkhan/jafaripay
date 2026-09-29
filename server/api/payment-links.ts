/**
 * JafariPay — Payment Links / Invoices (Phase C, minimal MVP).
 *
 * Conceptual model (exactly the mandated flow, reusing existing infrastructure):
 *
 *   Payment Link (this table, a durable merchant-owned CHARGE definition)
 *     → Payment Intent (minted on demand by /pay/:id/create)
 *     → Checkout → Verification → Receipt (all UNCHANGED)
 *
 * A Payment Link stores NO money state. It pins an amount, currency (USDC-only),
 * description/order ref, allowed networks and an optional expiry. When a customer
 * opens the link a concrete payment intent is created from the LINK's own stored
 * amount — the client can NEVER set or override it (amount integrity).
 *
 * MVP semantics (conservative, safe): a link represents ONE charge. Once any
 * intent it minted reaches 'succeeded', the link is considered paid and further
 * checkout is refused (already-paid + replay protection). No subscriptions, no
 * recurring billing, no tax/accounting — explicitly out of scope this phase.
 */

import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/schema.js';
import { requireApiKey, requireSessionOrApiKey, type AuthedRequest } from '../middleware/auth.js';
import { generatePaymentLinkId, generatePaymentIntentId, generateId } from '../lib/ids.js';
import { validatePositiveAmount } from '../lib/money.js';
import { listEnabledNetworks, getNetworkMeta } from '../blockchain/arc-provider.js';
import { enqueueWebhookDeliveries } from '../webhooks/delivery.js';

const router = Router();
// Separate router for the PUBLIC /pay surface so it can be mounted at its own
// prefix (index.ts) without exposing the merchant CRUD paths as public.
export const payRouter = Router();
const CHECKOUT_BASE = process.env.CHECKOUT_BASE_URL || 'https://jafari.co.in';
const LINK_DEFAULT_INTENT_EXPIRY_S = 60 * 60; // minted intents live 1h (capped by link expiry)

// A link is 'paid' iff one of its minted intents reached 'succeeded'.
function linkPaidIntent(db = getDb(), linkId: string): { paid: boolean; intent_id: string | null } {
  const row = db.prepare(
    "SELECT id FROM payment_intents WHERE payment_link_id=? AND status='succeeded' LIMIT 1"
  ).get(linkId) as { id: string } | undefined;
  return { paid: !!row, intent_id: row?.id ?? null };
}

// ── Merchant: POST /v1/payment-links — create a link ───────────────────────
router.post('/', requireApiKey({ requireSecret: true }), (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const merchantId = ar.merchantId!;
  const env = ar.apiKeyContext!.environment;
  const projectId = ar.apiKeyContext?.projectId || null;

  const { amount, currency = 'USDC', description = '', order_id, metadata = {}, allowed_networks, expires_at } = req.body as {
    amount: string; currency?: string; description?: string; order_id?: string;
    metadata?: Record<string, unknown>; allowed_networks?: unknown; expires_at?: unknown;
  };

  if (!amount) { res.status(400).json({ error: 'amount is required' }); return; }
  if (currency !== 'USDC') { res.status(400).json({ error: 'Only USDC is supported' }); return; }

  let amountBaseUnits: bigint;
  try { amountBaseUnits = validatePositiveAmount(amount); }
  catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid amount' }); return; }

  // allowed_networks: optional array of registry slugs. Each MUST exist, be
  // enabled, and match the key's environment class — a test key cannot mint a
  // link that offers mainnet-class networks and vice-versa. Empty/absent means
  // "any network of the correct class" (resolved at checkout time).
  let allowed: string[] = [];
  if (allowed_networks !== undefined && allowed_networks !== null) {
    if (!Array.isArray(allowed_networks)) { res.status(400).json({ error: 'allowed_networks must be an array of slugs', code: 'invalid_network' }); return; }
    const wantTestnet = env === 'test';
    for (const slug of allowed_networks) {
      if (typeof slug !== 'string') { res.status(400).json({ error: 'allowed_networks entries must be strings', code: 'invalid_network' }); return; }
      const meta = getNetworkMeta(slug.trim());
      if (!meta || !meta.isEnabled) { res.status(400).json({ error: `Network "${slug}" is unknown or disabled`, code: 'invalid_network' }); return; }
      if (meta.isTestnet !== wantTestnet) { res.status(400).json({ error: `Network "${slug}" class does not match key environment "${env}"`, code: 'environment_network_mismatch' }); return; }
      allowed.push(meta.network);
    }
  }

  // Optional absolute expiry (unix seconds). If given it must be in the future.
  let linkExpiry: number | null = null;
  if (expires_at !== undefined && expires_at !== null && expires_at !== '') {
    const n = Number(expires_at);
    if (!Number.isInteger(n) || n <= Math.floor(Date.now() / 1000)) {
      res.status(400).json({ error: 'expires_at must be a future unix timestamp (seconds)', code: 'invalid_expiry' }); return;
    }
    linkExpiry = n;
  }

  const id = generatePaymentLinkId();
  const amountDecimal = amount.trim();
  db.prepare(
    `INSERT INTO payment_links(id,merchant_id,project_id,amount_decimal,amount_base_units,currency,description,order_id,metadata,allowed_networks,expires_at,status,environment)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',?)`
  ).run(id, merchantId, projectId, amountDecimal, amountBaseUnits.toString(), currency, description || '', order_id || null, JSON.stringify(metadata), JSON.stringify(allowed), linkExpiry, env);

  const row = db.prepare('SELECT * FROM payment_links WHERE id=?').get(id);
  res.status(201).json({ ...(row as Record<string, unknown>), pay_url: `${CHECKOUT_BASE}/pay/${id}` });
});

// ── Merchant: GET /v1/payment-links — list (isolated) ──────────────────────
router.get('/', requireSessionOrApiKey, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 100);
  const offset = parseInt((req.query.offset as string) || '0', 10);
  const rows = db.prepare('SELECT * FROM payment_links WHERE merchant_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(ar.merchantId!, limit, offset) as Array<Record<string, unknown>>;
  res.json({ data: rows.map((r) => ({ ...r, pay_url: `${CHECKOUT_BASE}/pay/${r.id}`, ...linkPaidIntent(db, String(r.id)) })), limit, offset });
});

// ── Merchant: GET /v1/payment-links/:id — detail (isolated) ────────────────
router.get('/:id', requireSessionOrApiKey, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const row = db.prepare('SELECT * FROM payment_links WHERE id=? AND merchant_id=?').get(req.params.id, ar.merchantId!) as Record<string, unknown> | null;
  if (!row) { res.status(404).json({ error: 'Payment link not found' }); return; }
  res.json({ ...row, pay_url: `${CHECKOUT_BASE}/pay/${row.id}`, ...linkPaidIntent(db, String(row.id)) });
});

// ── Merchant: POST /v1/payment-links/:id/disable ───────────────────────────
router.post('/:id/disable', requireApiKey({ requireSecret: true }), (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  const row = db.prepare('SELECT id FROM payment_links WHERE id=? AND merchant_id=?').get(req.params.id, ar.merchantId!) as { id: string } | null;
  if (!row) { res.status(404).json({ error: 'Payment link not found' }); return; }
  db.prepare("UPDATE payment_links SET status='disabled',updated_at=unixepoch() WHERE id=?").run(row.id);
  res.json({ id: row.id, status: 'disabled' });
});

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC checkout surface — served by `payRouter`, mounted at /pay (and /api/pay).
// Capability-gated by the unguessable link id; returns only non-sensitive display
// fields.
// ═══════════════════════════════════════════════════════════════════════════

// GET /pay/:id — public link info for the "pay this link" landing page (no side effect).
payRouter.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const link = db.prepare('SELECT id,merchant_id,amount_decimal,currency,description,order_id,allowed_networks,expires_at,status,environment FROM payment_links WHERE id=?')
    .get(req.params.id) as { id: string; merchant_id: string; amount_decimal: string; currency: string; description: string; order_id: string | null; allowed_networks: string; expires_at: number | null; status: string; environment: string } | null;
  if (!link) { res.status(404).json({ error: 'Payment link not found' }); return; }

  const merchant_name = (db.prepare('SELECT name FROM merchants WHERE id=?').get(link.merchant_id) as { name: string } | undefined)?.name ?? '';
  const now = Math.floor(Date.now() / 1000);
  const expired = link.expires_at !== null && link.expires_at < now;
  const paid = linkPaidIntent(db, link.id);
  const payable = link.status === 'active' && !expired && !paid.paid;

  res.json({
    id: link.id, merchant_name, amount: link.amount_decimal, currency: link.currency,
    description: link.description, order_id: link.order_id, expires_at: link.expires_at,
    status: link.status, expired, paid: paid.paid, payable,
  });
});

// POST /pay/:id/create — mint a payment intent from the link and return checkout_url.
// The link's stored amount is authoritative; NOTHING about the money comes from the
// request body. Guards: disabled / expired / already-paid / network restriction.
payRouter.post('/:id/create', (req: Request, res: Response) => {
  const db = getDb();
  const link = db.prepare('SELECT * FROM payment_links WHERE id=?').get(req.params.id) as {
    id: string; merchant_id: string; project_id: string | null; amount_decimal: string; amount_base_units: string;
    currency: string; description: string; order_id: string | null; metadata: string; allowed_networks: string;
    expires_at: number | null; status: string; environment: string;
  } | null;
  if (!link) { res.status(404).json({ error: 'Payment link not found' }); return; }
  if (link.status !== 'active') { res.status(410).json({ error: 'Payment link is disabled', code: 'link_disabled' }); return; }

  const now = Math.floor(Date.now() / 1000);
  if (link.expires_at !== null && link.expires_at < now) {
    res.status(410).json({ error: 'Payment link has expired', code: 'link_expired' }); return;
  }
  // Already-paid / replay: refuse to mint a second payable intent for a settled link.
  const paidState = linkPaidIntent(db, link.id);
  if (paidState.paid) {
    res.status(409).json({ error: 'This payment link has already been paid', code: 'link_paid', payment_intent_id: paidState.intent_id }); return;
  }

  // Resolve the network: honor allowed_networks (already class-validated at
  // creation) and the environment class. The FIRST enabled, class-matching,
  // wallet-backed network wins. Never a cross-class or disabled network.
  const wantTestnet = link.environment === 'test';
  let allowed: string[] = [];
  try { allowed = JSON.parse(link.allowed_networks) as string[]; } catch { allowed = []; }
  const candidates = allowed.length
    ? allowed.map((s) => getNetworkMeta(s)).filter((m): m is NonNullable<typeof m> => !!m && m.isEnabled && m.isTestnet === wantTestnet)
    : listEnabledNetworks().filter((n) => n.isTestnet === wantTestnet);

  let chosen: { network: string; chainId: number } | null = null;
  let sw: { id: string; address: string; network: string } | null = null;
  for (const c of candidates) {
    const w = db.prepare('SELECT id,address,network FROM settlement_wallets WHERE merchant_id=? AND network=? AND is_active=1 LIMIT 1')
      .get(link.merchant_id, c.network) as { id: string; address: string; network: string } | null;
    if (w) { chosen = { network: c.network, chainId: c.chainId }; sw = w; break; }
  }
  if (!chosen || !sw) {
    res.status(503).json({ error: 'Merchant has no settlement wallet configured for this link', code: 'setup.no_settlement_wallet' }); return;
  }

  const netConfig = db.prepare('SELECT chain_id,usdc_address FROM network_configs WHERE network=? AND is_enabled=1').get(chosen.network) as { chain_id: number; usdc_address: string } | null;
  if (!netConfig) { res.status(503).json({ error: 'Network configuration unavailable', code: 'setup.no_settlement_wallet' }); return; }

  // Idempotent replay within an active session: if this link already has an OPEN
  // (unpaid) intent on the SAME network, reuse it instead of stacking new rows —
  // a customer refreshing /pay should not accumulate dangling intents.
  const existingOpen = db.prepare(
    "SELECT id FROM payment_intents WHERE payment_link_id=? AND network=? AND status IN ('requires_payment','processing') LIMIT 1"
  ).get(link.id, chosen.network) as { id: string } | null;
  if (existingOpen) {
    res.json({ id: existingOpen.id, status: 'requires_payment', checkout_url: `${CHECKOUT_BASE}/checkout/${existingOpen.id}`, network: chosen.network, chain_id: netConfig.chain_id, reused: true }); return;
  }

  const id = generatePaymentIntentId();
  const intentExpiry = Math.min(now + LINK_DEFAULT_INTENT_EXPIRY_S, link.expires_at ?? Number.MAX_SAFE_INTEGER);
  db.prepare(
    `INSERT INTO payment_intents(id,merchant_id,project_id,settlement_wallet_id,settlement_address,network,chain_id,usdc_address,amount_decimal,amount_base_units,currency,order_id,description,metadata,environment,expires_at,payment_link_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, link.merchant_id, link.project_id, sw.id, sw.address, chosen.network, netConfig.chain_id, netConfig.usdc_address,
    link.amount_decimal, link.amount_base_units, link.currency, link.order_id, link.description, link.metadata, link.environment, intentExpiry, link.id);
  db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,to_status) VALUES(?,?,?,?)').run(generateId('pe'), id, 'payment.created', 'requires_payment');

  enqueueWebhookDeliveries(id, 'payment.created', { payment_intent_id: id, payment_link_id: link.id }, link.environment as 'test' | 'live');

  res.status(201).json({
    id, status: 'requires_payment', amount: link.amount_decimal, amount_base_units: link.amount_base_units,
    currency: link.currency, network: chosen.network, chain_id: netConfig.chain_id, usdc_address: netConfig.usdc_address,
    settlement_address: sw.address, checkout_url: `${CHECKOUT_BASE}/checkout/${id}`, expires_at: intentExpiry,
  });
});

export default router;
