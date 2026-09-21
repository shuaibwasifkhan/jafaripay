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

export function generateApiKey(prefix: string): { fullKey: string; prefix: string; preview: string } {
  const secret = randomString(32);
  const fullKey = `${prefix}${secret}`;
  return { fullKey, prefix, preview: secret.slice(-4) };
}

export function generateWebhookSecret(): { secret: string; preview: string } {
  const s = `whsec_${randomString(32)}`;
  return { secret: s, preview: s.slice(-4) };
}
