/**
 * JafariPay — Auth middleware
 */

import type { Request, Response, NextFunction } from 'express';
import { verifySession } from '../auth/siwe.js';
import { getDb } from '../db/schema.js';
import { createHmac } from 'crypto';

export interface ApiKeyContext {
  merchantId: string; projectId: string | null;
  keyId: string; environment: 'test' | 'live'; isSecret: boolean;
}

export interface AuthedRequest extends Request {
  merchantId?: string; sessionId?: string; walletAddress?: string;
  requestId?: string; apiKeyContext?: ApiKeyContext;
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const token =
    (req as AuthedRequest).cookies?.['jp_session'] ||
    (req as AuthedRequest).cookies?.['jp_session_js'] ||
    req.headers['x-session-token'] as string ||
    req.headers['authorization']?.replace('Bearer ', '') ||
    (req.query as Record<string, string>)['_t'];
  if (!token) { res.status(401).json({ error: 'Unauthorized', code: 'auth.missing_session' }); return; }
  const session = verifySession(token);
  if (!session) { res.status(401).json({ error: 'Unauthorized', code: 'auth.invalid_session' }); return; }
  const ar = req as AuthedRequest;
  ar.merchantId = session.merchantId;
  ar.sessionId = session.sessionId;
  ar.walletAddress = session.walletAddress;
  next();
}

export function requireApiKey(opts?: { requireSecret?: boolean }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers['authorization'] as string;
    const bearerKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const key = bearerKey || (req.headers['x-api-key'] as string);
    if (!key) { res.status(401).json({ error: 'API key required', code: 'auth.missing_api_key' }); return; }

    const prefix = key.slice(0, 8);
    const isSecret = prefix.startsWith('sk_');
    const environment: 'test' | 'live' = prefix.includes('live') ? 'live' : 'test';

    if (opts?.requireSecret && !isSecret) {
      res.status(403).json({ error: 'This endpoint requires a secret key', code: 'auth.public_key_not_allowed' }); return;
    }
    if (environment === 'live' && !process.env.ENABLE_LIVE_PAYMENTS) {
      res.status(403).json({ error: 'Live payments are not enabled', code: 'auth.live_disabled' }); return;
    }

    const db = getDb();
    const keyHash = hashApiKey(key);

    type KeyRow = { id: string; merchant_id: string; project_id: string | null; key_hash: string; environment: string; is_secret: number };
    const rows = db.prepare(
      `SELECT id, merchant_id, project_id, key_hash, environment, is_secret
       FROM api_keys WHERE key_prefix = ? AND environment = ? AND is_active = 1 AND revoked_at IS NULL`
    ).all(prefix, environment) as KeyRow[];

    const match = rows.find(r => r.key_hash === keyHash);
    if (!match) { res.status(401).json({ error: 'Invalid API key', code: 'auth.invalid_api_key' }); return; }

    db.prepare('UPDATE api_keys SET last_used_at = unixepoch() WHERE id = ?').run(match.id);

    const ar = req as AuthedRequest;
    ar.merchantId = match.merchant_id;
    ar.apiKeyContext = {
      merchantId: match.merchant_id, projectId: match.project_id,
      keyId: match.id, environment, isSecret,
    };
    next();
  };
}

// Accepts either a session cookie OR an API key — used for dashboard + SDK shared routes
export function requireSessionOrApiKey(req: Request, res: Response, next: NextFunction): void {
  const cookie = (req as AuthedRequest).cookies?.['jp_session'];
  const authHeader = req.headers['authorization'] as string | undefined;
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
  const bearerKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (cookie) {
    const session = verifySession(cookie);
    if (session) {
      const ar = req as AuthedRequest;
      ar.merchantId = session.merchantId;
      ar.sessionId = session.sessionId;
      ar.walletAddress = session.walletAddress;
      next(); return;
    }
  }
  if (bearerKey || apiKeyHeader) {
    requireApiKey()(req, res, next); return;
  }
  res.status(401).json({ error: 'Authentication required', code: 'auth.required' });
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string) ||
    `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  (req as AuthedRequest).requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

function hashApiKey(key: string): string {
  return createHmac('sha256', process.env.API_KEY_HMAC_SECRET || 'dev-secret').update(key).digest('hex');
}
