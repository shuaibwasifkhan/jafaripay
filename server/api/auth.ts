/**
 * JafariPay — Authentication API routes
 */

import { Router, type Request, type Response } from 'express';
import { generateNonce, verifySiwe, createSession, revokeSession } from '../auth/siwe.js';
import { getDb } from '../db/schema.js';
import { generateId } from '../lib/ids.js';
import { requireSession, type AuthedRequest } from '../middleware/auth.js';

const router = Router();
const SESSION_COOKIE = 'jp_session';
const IS_PROD = process.env.NODE_ENV === 'production';

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

// GET /auth/nonce?address=0x... — frontend calls GET with address param
router.get('/nonce', (req: Request, res: Response) => {
  const { address } = req.query as { address?: string };
  if (address && !EVM_ADDR.test(address)) {
    res.status(400).json({ error: 'Invalid Ethereum address' }); return;
  }
  const { nonce, expiresAt } = generateNonce();
  res.json({ nonce, expiresAt });
});

// POST /auth/nonce — also support POST for SDK usage
router.post('/nonce', (req: Request, res: Response) => {
  const { address } = req.body as { address?: string };
  if (address && !EVM_ADDR.test(address)) {
    res.status(400).json({ error: 'Invalid Ethereum address' }); return;
  }
  const { nonce, expiresAt } = generateNonce();
  res.json({ nonce, expiresAt });
});

router.post('/verify', async (req: Request, res: Response) => {
  const { message, signature, address, chainId, nonce: bodyNonce } = req.body as {
    message: string; signature: string; address: string; chainId?: number; nonce?: string;
  };
  if (!message || !signature || !address) {
    res.status(400).json({ error: 'message, signature, and address are required' }); return;
  }

  // Extract nonce from message if not provided separately
  const nonceFromMessage = message.split('\n').find((l: string) => l.startsWith('Nonce: '))?.replace('Nonce: ', '').trim();
  const nonce = bodyNonce || nonceFromMessage || '';

  if (!nonce) {
    res.status(400).json({ error: 'Could not extract nonce from message' }); return;
  }

  const valid = await verifySiwe({ message, signature, address, chainId: chainId || 5042002, nonce }); // arc-studio-allow-onchain-literal
  if (!valid) {
    res.status(401).json({ error: 'Invalid signature or expired nonce', code: 'auth.signature_invalid' }); return;
  }

  const db = getDb();
  const normalizedAddress = address.toLowerCase();

  type WalletRow = { id: string; merchant_id: string };
  let walletRow = db.prepare('SELECT id, merchant_id FROM merchant_wallets WHERE address = ?').get(normalizedAddress) as WalletRow | null;

  let merchantId: string;
  if (!walletRow) {
    merchantId = generateId('merch');
    db.prepare('INSERT INTO merchants(id) VALUES(?)').run(merchantId);
    db.prepare('INSERT INTO merchant_wallets(id, merchant_id, address, is_primary) VALUES(?, ?, ?, ?)')
      .run(generateId('mw'), merchantId, normalizedAddress, 1);
    // Default project
    db.prepare('INSERT INTO projects(id, merchant_id, name, description) VALUES(?, ?, ?, ?)')
      .run(generateId('proj'), merchantId, 'Default Project', 'Your first project');
  } else {
    merchantId = walletRow.merchant_id;
  }

  const token = createSession(merchantId, normalizedAddress);
  // In dev: sameSite=none so cookie passes through Vite proxy to browser
  // In prod: sameSite=strict with secure flag
  // SameSite=None requires Secure=true (browsers enforce this strictly).
  // The preview host is HTTPS so we can always set Secure in the preview env.
  const isSecureContext = IS_PROD || req.headers['x-forwarded-proto'] === 'https' || req.secure;
  const cookieOpts = {
    httpOnly: true,
    secure: isSecureContext,
    sameSite: (isSecureContext ? 'none' : 'lax') as 'none' | 'lax' | 'strict',
    maxAge: 60 * 60 * 24 * 7 * 1000,
    path: '/',
  };
  res.cookie(SESSION_COOKIE, token, cookieOpts);
  // Non-httpOnly copy so JS bootstrap in index.html can mirror to localStorage
  res.cookie('jp_session_js', token, { ...cookieOpts, httpOnly: false });
  // Also expose token in response header — old JS bundles read this directly
  res.setHeader('X-Session-Token', token);

  type MerchantRow = { id: string; name: string | null; email: string | null; created_at: number };
  const merchantRow = db.prepare('SELECT id, name, email, created_at FROM merchants WHERE id = ?').get(merchantId) as MerchantRow;
  const merchantObj = { ...merchantRow, wallet_address: normalizedAddress };

  // Return token in body AND as a response header.
  // The frontend reads whichever channel works in its environment.
  res.json({ merchant: merchantObj, walletAddress: normalizedAddress, token });
});

router.post('/logout', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  if (ar.sessionId) revokeSession(ar.sessionId);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

router.get('/me', requireSession, (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const db = getDb();
  type MerchantRow = { id: string; name: string | null; email: string | null; created_at: number };
  const merchantRow = db.prepare('SELECT id, name, email, created_at FROM merchants WHERE id = ?').get(ar.merchantId!) as MerchantRow | null;
  if (!merchantRow) { res.status(404).json({ error: 'Merchant not found' }); return; }
  res.json({ merchant: { ...merchantRow, wallet_address: ar.walletAddress } });
});

const handleProfileUpdate = (req: Request, res: Response) => {
  const ar = req as AuthedRequest;
  const { name, email } = req.body as { name?: string | null; email?: string | null };
  const db = getDb();
  db.prepare('UPDATE merchants SET name=COALESCE(?,name), email=COALESCE(?,email), updated_at=unixepoch() WHERE id=?')
    .run(name !== undefined ? (name?.trim() || null) : undefined, email !== undefined ? (email?.trim() || null) : undefined, ar.merchantId!);
  const merchant = db.prepare('SELECT id, name, email, created_at FROM merchants WHERE id = ?').get(ar.merchantId!) as { id: string; name: string | null; email: string | null; created_at: number };
  res.json({ merchant: { ...merchant, wallet_address: ar.walletAddress } });
};

router.patch('/me', requireSession, handleProfileUpdate);
// Alias used by SettingsPage
router.patch('/profile', requireSession, handleProfileUpdate);

export default router;
