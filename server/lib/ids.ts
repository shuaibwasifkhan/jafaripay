/**
 * JafariPay — ID generation utilities
 */

import { randomBytes } from 'crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomString(len: number): string {
  const bytes = randomBytes(len);
  return Array.from(bytes).map(b => ALPHABET[b % ALPHABET.length]).join('');
}

export function generateId(prefix: string): string {
  return `${prefix}_${randomString(24)}`;
}

export function generatePaymentIntentId(): string {
  return `pi_${randomString(24)}`;
}

// Receipt and payment-link IDs are unguessable (24 random base-36 chars) — the
// public /receipt/:id and /pay/:id pages authorize by capability (the secret id)
// and are NOT enumerable, so receipt IDs cannot be guessed or walked (Phase H).
export function generateReceiptId(): string {
  return `rcpt_${randomString(24)}`;
}

export function generatePaymentLinkId(): string {
  return `plink_${randomString(24)}`;
}

export function generateApiKey(prefix: string): { fullKey: string; prefix: string; preview: string } {
  const secret = randomString(32);
  const fullKey = `${prefix}${secret}`;
  return { fullKey, prefix, preview: secret.slice(-4) };
}

export function generateWebhookSecret(): { secret: string; preview: string } {
  const s = `whsec_${randomString(32)}`;
  return { secret: s, preview: s.slice(-4) };
}
