/**
 * JafariPay — Phase 21 production-config validation tests (bun:test).
 *
 * Pure unit coverage for server/lib/production-config.ts — the fail-closed
 * boot audit added for Phase 21 closure. NO database, NO network, NO secrets:
 * the validator receives a synthetic env object and returns findings strings.
 *
 * Proven properties:
 *   - a complete, correct production environment yields ZERO findings;
 *   - every misconfiguration class is named by its VARIABLE, never its value;
 *   - no finding string ever contains a secret sentinel value (never-log rule);
 *   - livePaymentsEnabled() is strict ('true' only) — the fail-open footgun
 *     ('false'/garbage previously enabled live mode) is closed.
 */
import { test, expect } from 'bun:test';
import {
  validateProductionConfig,
  livePaymentsEnabled,
  REQUIRED_PRODUCTION_SECRETS,
  MIN_SECRET_LENGTH,
} from './lib/production-config.ts';

// A sentinel planted in every secret of the base env. If ANY finding string
// ever echoes a value, these tests catch the leak.
const SENTINEL = 'sup3r-s3cret-sentinel';

/** A fully valid production environment — the baseline every case perturbs. */
function baseEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    SESSION_SECRET: `${SENTINEL}-session-0001`,
    API_KEY_HMAC_SECRET: `${SENTINEL}-apikey-0002`,
    WEBHOOK_HMAC_SECRET: `${SENTINEL}-webhook-0003`,
    WEBHOOK_SIGNING_ENC_KEY: `${SENTINEL}-enc-0004`,
    ALLOWED_ORIGINS: 'https://jafari.co.in,https://dashboard.jafari.co.in',
    CHECKOUT_BASE_URL: 'https://jafari.co.in',
    JAFARIPAY_DOMAIN: 'jafari.co.in',
    EMAIL_TRANSPORT: 'brevo_smtp',
    EMAIL_BREVO_SMTP_LOGIN: `${SENTINEL}-login`,
    EMAIL_BREVO_SMTP_KEY: `${SENTINEL}-key`,
    EMAIL_FROM: 'noreply@jafari.co.in',
    ENABLE_LIVE_PAYMENTS: 'true',
  };
}

// ═══ Happy path ═══════════════════════════════════════════════════════════

test('PC1: a complete production environment validates with zero findings', () => {
  expect(validateProductionConfig(baseEnv())).toEqual([]);
});

test('PC2: minimal-but-valid alternatives (none/dev email, live gate off) stay clean', () => {
  const none: Record<string, string | undefined> = { ...baseEnv(), EMAIL_TRANSPORT: 'none' };
  delete none.EMAIL_BREVO_SMTP_LOGIN;
  delete none.EMAIL_BREVO_SMTP_KEY;
  delete none.EMAIL_FROM;
  expect(validateProductionConfig(none)).toEqual([]);

  const deferred: Record<string, string | undefined> = { ...baseEnv(), EMAIL_TRANSPORT: 'dev', ENABLE_LIVE_PAYMENTS: 'false' };
  expect(validateProductionConfig(deferred)).toEqual([]);

  const notYetLive: Record<string, string | undefined> = { ...baseEnv() };
  delete notYetLive.ENABLE_LIVE_PAYMENTS;
  expect(validateProductionConfig(notYetLive)).toEqual([]);
});

// ═══ Secrets ══════════════════════════════════════════════════════════════

test('PC3: every missing required secret is named; nothing else is flagged', () => {
  for (const name of REQUIRED_PRODUCTION_SECRETS) {
    const env: Record<string, string | undefined> = baseEnv();
    delete env[name];
    const issues = validateProductionConfig(env);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain(name);
    expect(issues[0]).toContain('not set');
  }
});

test('PC4: a short secret is flagged by length, and the value is NEVER echoed', () => {
  const env = baseEnv();
  const canary = 'canary-short'; // deliberately < MIN_SECRET_LENGTH, distinctive string
  expect(canary.length).toBeLessThan(MIN_SECRET_LENGTH);
  env.SESSION_SECRET = canary;
  const issues = validateProductionConfig(env);
  expect(issues.length).toBe(1);
  expect(issues[0]).toContain('SESSION_SECRET');
  expect(issues[0]).toContain(String(MIN_SECRET_LENGTH));
  for (const issue of issues) {
    expect(issue).not.toContain(canary);
    expect(issue).not.toContain(SENTINEL);
  }
});

test('PC5: NO finding from any failure mode ever leaks a secret value', () => {
  // Deliberately break EVERYTHING at once, then sweep every returned message.
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    SESSION_SECRET: 'tiny',
    ALLOWED_ORIGINS: 'http://insecure.example.com',
    CHECKOUT_BASE_URL: 'not a url',
    JAFARIPAY_DOMAIN: 'https://jafari.co.in',
    EMAIL_TRANSPORT: 'sendgrid',
    EMAIL_DEV_FAIL: '1',
    RPC_PROXY_BASE_URL: `https://proxy.example.com/${SENTINEL}-proxy`,
    RPC_PROXY_CHAINS: '',
    E2E_SOURCE_PK: SENTINEL,
    E2E_RELAYER_PK: SENTINEL,
    ENABLE_LIVE_PAYMENTS: 'yes',
  };
  const issues = validateProductionConfig(env);
  expect(issues.length).toBeGreaterThan(8); // every class fired
  for (const issue of issues) {
    expect(issue).not.toContain(SENTINEL);
    for (const v of Object.values(env)) {
      if (v && v.length > 3 && !['production', 'true', 'dev'].includes(v)) {
        expect(issue).not.toContain(v);
      }
    }
  }
});

// ═══ Origins / routing ════════════════════════════════════════════════════

test('PC6: ALLOWED_ORIGINS — unset, http, path-suffixed, loopback all rejected; clean https accepted', () => {
  const unset: Record<string, string | undefined> = baseEnv();
  delete unset.ALLOWED_ORIGINS;
  expect(validateProductionConfig(unset).some((i) => i.includes('ALLOWED_ORIGINS'))).toBe(true);

  const http = { ...baseEnv(), ALLOWED_ORIGINS: 'http://jafari.co.in' };
  expect(validateProductionConfig(http).some((i) => i.includes('https://'))).toBe(true);

  const pathed = { ...baseEnv(), ALLOWED_ORIGINS: 'https://jafari.co.in/app' };
  expect(validateProductionConfig(pathed).some((i) => i.includes('bare origins'))).toBe(true);

  const loop = { ...baseEnv(), ALLOWED_ORIGINS: 'http://localhost:5173' };
  expect(validateProductionConfig(loop).some((i) => i.includes('ALLOWED_ORIGINS'))).toBe(true);

  const garbage = { ...baseEnv(), ALLOWED_ORIGINS: 'jafari.co.in' };
  expect(validateProductionConfig(garbage).some((i) => i.includes('full origin URL'))).toBe(true);
});

test('PC7: CHECKOUT_BASE_URL and JAFARIPAY_DOMAIN must be present and well-shaped', () => {
  const noBase: Record<string, string | undefined> = baseEnv();
  delete noBase.CHECKOUT_BASE_URL;
  expect(validateProductionConfig(noBase).some((i) => i.includes('CHECKOUT_BASE_URL'))).toBe(true);

  const httpBase: Record<string, string | undefined> = { ...baseEnv(), CHECKOUT_BASE_URL: 'http://jafari.co.in' };
  expect(validateProductionConfig(httpBase).some((i) => i.includes('CHECKOUT_BASE_URL'))).toBe(true);

  const noDomain: Record<string, string | undefined> = baseEnv();
  delete noDomain.JAFARIPAY_DOMAIN;
  expect(validateProductionConfig(noDomain).some((i) => i.includes('JAFARIPAY_DOMAIN'))).toBe(true);

  const schemeDomain: Record<string, string | undefined> = { ...baseEnv(), JAFARIPAY_DOMAIN: 'https://jafari.co.in' };
  expect(validateProductionConfig(schemeDomain).some((i) => i.includes('bare hostname'))).toBe(true);
});

// ═══ Email (D-4 Brevo) ════════════════════════════════════════════════════

test('PC8: EMAIL_TRANSPORT unset or unknown is flagged (silent dev-sink fallthrough refused)', () => {
  const unset: Record<string, string | undefined> = baseEnv();
  delete unset.EMAIL_TRANSPORT;
  expect(validateProductionConfig(unset).some((i) => i.includes('EMAIL_TRANSPORT'))).toBe(true);

  const unknown: Record<string, string | undefined> = { ...baseEnv(), EMAIL_TRANSPORT: 'sendgrid' };
  expect(validateProductionConfig(unknown).some((i) => i.includes('EMAIL_TRANSPORT'))).toBe(true);
});

test('PC9: brevo_smtp with any credential missing fails closed; complete config passes', () => {
  for (const name of ['EMAIL_BREVO_SMTP_LOGIN', 'EMAIL_BREVO_SMTP_KEY', 'EMAIL_FROM'] as const) {
    const env: Record<string, string | undefined> = baseEnv();
    delete env[name];
    const issues = validateProductionConfig(env);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain(name);
  }
  const badFrom: Record<string, string | undefined> = { ...baseEnv(), EMAIL_FROM: 'not-an-email' };
  expect(validateProductionConfig(badFrom).some((i) => i.includes('EMAIL_FROM'))).toBe(true);
  expect(validateProductionConfig(baseEnv())).toEqual([]);
});

test('PC10: EMAIL_DEV_FAIL=1 (forced test failure) is refused in production', () => {
  const env: Record<string, string | undefined> = { ...baseEnv(), EMAIL_DEV_FAIL: '1' };
  expect(validateProductionConfig(env).some((i) => i.includes('EMAIL_DEV_FAIL'))).toBe(true);
});

// ═══ RPC proxy integrity ══════════════════════════════════════════════════

test('PC11: enabling the RPC proxy without token or chains fails at boot, not per-request', () => {
  const noToken = { ...baseEnv(), RPC_PROXY_BASE_URL: 'https://proxy.example.com', RPC_PROXY_CHAINS: '5042' };
  expect(validateProductionConfig(noToken).some((i) => i.includes('RPC_PROXY_TOKEN'))).toBe(true);

  const noChains = { ...baseEnv(), RPC_PROXY_BASE_URL: 'https://proxy.example.com', RPC_PROXY_TOKEN: 'x'.repeat(32) };
  expect(validateProductionConfig(noChains).some((i) => i.includes('RPC_PROXY_CHAINS'))).toBe(true);

  const complete = { ...baseEnv(), RPC_PROXY_BASE_URL: 'https://proxy.example.com', RPC_PROXY_TOKEN: 'x'.repeat(32), RPC_PROXY_CHAINS: '5042' };
  expect(validateProductionConfig(complete)).toEqual([]);
});

test('PC12: proxy unset needs no token/chains (direct-RPC model stays clean)', () => {
  expect(validateProductionConfig(baseEnv())).toEqual([]);
});

// ═══ Testnet E2E credentials ═════════════════════════════════════════════

test('PC13: testnet E2E signer keys in a production env are refused by name', () => {
  const src: Record<string, string | undefined> = { ...baseEnv(), E2E_SOURCE_PK: SENTINEL };
  expect(validateProductionConfig(src).some((i) => i.includes('E2E_SOURCE_PK'))).toBe(true);
  const rel: Record<string, string | undefined> = { ...baseEnv(), E2E_RELAYER_PK: SENTINEL };
  expect(validateProductionConfig(rel).some((i) => i.includes('E2E_RELAYER_PK'))).toBe(true);
});

// ═══ Live-payments gate semantics ════════════════════════════════════════

test('PC14: ENABLE_LIVE_PAYMENTS garbage values are flagged; true/false/unset are not', () => {
  for (const bad of ['yes', 'TRUE', '1', 'on']) {
    const env: Record<string, string | undefined> = { ...baseEnv(), ENABLE_LIVE_PAYMENTS: bad };
    expect(validateProductionConfig(env).some((i) => i.includes('ENABLE_LIVE_PAYMENTS'))).toBe(true);
  }
});

test('PC15: livePaymentsEnabled() is strict — only exactly "true" enables live mode', () => {
  expect(livePaymentsEnabled({ ENABLE_LIVE_PAYMENTS: 'true' })).toBe(true);
  expect(livePaymentsEnabled({ ENABLE_LIVE_PAYMENTS: 'false' })).toBe(false);
  expect(livePaymentsEnabled({ ENABLE_LIVE_PAYMENTS: 'TRUE' })).toBe(false);
  expect(livePaymentsEnabled({ ENABLE_LIVE_PAYMENTS: '1' })).toBe(false);
  expect(livePaymentsEnabled({ ENABLE_LIVE_PAYMENTS: '' })).toBe(false);
  expect(livePaymentsEnabled({})).toBe(false);
});
