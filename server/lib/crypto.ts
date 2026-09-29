/**
 * JafariPay — at-rest secret encryption (Phase L / H-1)
 *
 * Small, dependency-free authenticated encryption used ONLY to store a webhook
 * endpoint's raw signing secret so the server can re-derive signatures on every
 * future delivery + retry. HMAC is symmetric, so the signing key must be
 * recoverable; it therefore cannot be a one-way hash. We encrypt it at rest with
 * AES-256-GCM under an environment key, and decrypt it in memory only at signing
 * time. The plaintext is never persisted, never returned by list/GET, and never
 * logged.
 *
 * This mirrors the app's existing server-key management model: symmetric secrets
 * come from environment variables (SESSION_SECRET, API_KEY_HMAC_SECRET,
 * WEBHOOK_HMAC_SECRET) with a dev fallback and a production fail-fast guard. It
 * deliberately introduces NO external secret-management dependency (KMS/Vault).
 *
 * Envelope format (versioned so the key/algorithm can be rotated later):
 *   `v1.<iv_b64>.<tag_b64>.<ct_b64>`
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ENV_FALLBACK = 'dev-webhook-signing-enc-key-change-me';

function encKey(): Buffer {
  const raw = process.env.WEBHOOK_SIGNING_ENC_KEY || ENV_FALLBACK;
  // Derive a fixed 32-byte key so any passphrase length works; scrypt keeps it
  // simple + deterministic. In production the value is enforced (fail-fast) and
  // should itself be a strong random string.
  return scryptSync(raw, 'jafaripay-webhook-secret-at-rest', 32);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

/**
 * Decrypt an envelope. Returns null (never throws) if the blob is malformed,
 * from a different key, or tampered — so a failed decrypt degrades to "signing
 * unavailable" rather than crashing the delivery worker or leaking material.
 */
export function decryptSecret(blob: string | null | undefined): string | null {
  if (!blob) return null;
  try {
    const [version, ivB64, tagB64, ctB64] = blob.split('.');
    if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) return null;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', encKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
