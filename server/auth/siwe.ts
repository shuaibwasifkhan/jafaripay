/**
 * JafariPay — SIWE / EIP-4361 authentication
 */

import { randomBytes, createHmac } from 'crypto';
import { verifyMessage } from 'viem';
import { getDb } from '../db/schema.js';
import { generateId } from '../lib/ids.js';

const SESSION_TTL_S = 60 * 60 * 24 * 7; // 7 days
const NONCE_TTL_S   = 60 * 5;            // 5 minutes

const DOMAIN = process.env.JAFARIPAY_DOMAIN || 'jafaripay.com';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

export function generateNonce(): { nonce: string; expiresAt: number } {
  const db = getDb();
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + NONCE_TTL_S;
  const now = Math.floor(Date.now() / 1000);

  db.prepare('DELETE FROM auth_nonces WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO auth_nonces(nonce, expires_at) VALUES(?, ?)').run(nonce, expiresAt);

  return { nonce, expiresAt };
}

export function buildSiweMessage(params: {
  address: string; chainId: number; nonce: string;
  issuedAt: string; expirationTime: string;
}): string {
  return [
    `${DOMAIN} wants you to sign in with your Ethereum account:`,
    params.address,
    '',
    'Sign in to JafariPay — accept USDC payments with a few lines of code.',
    '',
    `URI: https://${DOMAIN}`,
    'Version: 1',
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
    `Expiration Time: ${params.expirationTime}`,
  ].join('\n');
}

export interface SiwePayload {
  message: string; signature: string; address: string; chainId: number; nonce: string;
}

export async function verifySiwe(payload: SiwePayload): Promise<boolean> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const lines = payload.message.split('\n');
  const nonceMatch  = lines.find(l => l.startsWith('Nonce: '));
  const expiresMatch = lines.find(l => l.startsWith('Expiration Time: '));
  const chainMatch  = lines.find(l => l.startsWith('Chain ID: '));
  const addressLine = lines[1];

  if (!nonceMatch || !expiresMatch || !chainMatch) return false;

  const msgNonce   = nonceMatch.replace('Nonce: ', '').trim();
  const msgChainId = parseInt(chainMatch.replace('Chain ID: ', '').trim(), 10);
  const expTime    = new Date(expiresMatch.replace('Expiration Time: ', '').trim());
  const msgAddress = addressLine?.trim().toLowerCase();

  if (msgNonce !== payload.nonce) return false;
  if (msgAddress !== payload.address.toLowerCase()) return false;

  const supportedChains = [5042002, 5042]; // arc-studio-allow-onchain-literal
  if (!supportedChains.includes(msgChainId)) return false;
  if (expTime.getTime() < Date.now()) return false;

  type NonceRow = { nonce: string; expires_at: number; used: number };
  const nonceRow = db.prepare('SELECT nonce, expires_at, used FROM auth_nonces WHERE nonce = ?').get(msgNonce) as NonceRow | null;
  if (!nonceRow) return false;
  if (nonceRow.used) return false;
  if (nonceRow.expires_at < now) return false;

  try {
    const valid = await verifyMessage({
      address: payload.address as `0x${string}`,
      message: payload.message,
      signature: payload.signature as `0x${string}`,
    });
    if (!valid) return false;
  } catch { return false; }

  db.prepare('UPDATE auth_nonces SET used = 1 WHERE nonce = ?').run(msgNonce);
  return true;
}

export function createSession(merchantId: string, walletAddress: string): string {
  const db = getDb();
  const sessionId = generateId('sess');
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  db.prepare('INSERT INTO sessions(id, merchant_id, wallet_address, expires_at) VALUES(?, ?, ?, ?)')
    .run(sessionId, merchantId, walletAddress, expiresAt);
  return signSessionToken(sessionId, expiresAt);
}

export function verifySession(token: string): { sessionId: string; merchantId: string; walletAddress: string } | null {
  const db = getDb();
  const parsed = parseSessionToken(token);
  if (!parsed) return null;

  const now = Math.floor(Date.now() / 1000);
  type SessionRow = { id: string; merchant_id: string; wallet_address: string; expires_at: number; revoked: number };
  const row = db.prepare('SELECT id, merchant_id, wallet_address, expires_at, revoked FROM sessions WHERE id = ?')
    .get(parsed.sessionId) as SessionRow | null;

  if (!row || row.revoked || row.expires_at < now) return null;
  return { sessionId: row.id, merchantId: row.merchant_id, walletAddress: row.wallet_address };
}

export function revokeSession(sessionId: string): void {
  getDb().prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(sessionId);
}

function signSessionToken(sessionId: string, expiresAt: number): string {
  const payload = `${sessionId}:${expiresAt}`;
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function parseSessionToken(token: string): { sessionId: string; expiresAt: number } | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    const [sessionId, expiresAtStr, sig] = parts;
    const payload = `${sessionId}:${expiresAtStr}`;
    const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    return { sessionId, expiresAt: parseInt(expiresAtStr, 10) };
  } catch { return null; }
}
