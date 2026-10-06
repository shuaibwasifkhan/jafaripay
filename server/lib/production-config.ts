/**
 * JafariPay — PRODUCTION CONFIG VALIDATION (Phase 21 closure, fail-closed boot gate)
 *
 * Pure, side-effect-free audit of the deployment environment. It never throws,
 * never exits, and NEVER echoes a secret value — every finding names only the
 * VARIABLE (e.g. "SESSION_SECRET missing"), never its content. The caller
 * (server/index.ts) decides to fail closed at boot when NODE_ENV=production.
 *
 * WHY THIS EXISTS
 *   The original boot guard (index.ts) covers the 4 signing secrets. This module
 *   closes the remaining "silent misconfiguration" paths that would otherwise
 *   only surface AFTER go-live, as runtime failures or (worse) fail-open behavior:
 *   - CORS/origin vars unset or non-TLS while claiming production;
 *   - a half-configured Brevo transport (D-4) silently dropping every receipt;
 *   - an enabled RPC proxy without its token (per-request failure instead of
 *     boot-time failure);
 *   - testnet E2E signer keys present in a production environment — they must
 *     never become production defaults;
 *   - EMAIL_DEV_FAIL=1 (a forced-failure test flag) set in production.
 *
 * SAFETY CONTRACT: additive only. Nothing here changes any runtime money path;
 * it runs BEFORE the port opens. With a correct production env it returns [] and
 * the server boots exactly as before.
 */

/** The four signing secrets the server cannot safely run without (names only). */
export const REQUIRED_PRODUCTION_SECRETS = [
  'SESSION_SECRET',
  'API_KEY_HMAC_SECRET',
  'WEBHOOK_HMAC_SECRET',
  'WEBHOOK_SIGNING_ENC_KEY',
] as const;

/** Minimum accepted entropy for each required secret (matches the index.ts guard). */
export const MIN_SECRET_LENGTH = 16;

/** Email transports the single-switch selection (server/email/transport.ts) knows. */
const KNOWN_EMAIL_TRANSPORTS = ['none', 'dev', 'brevo_smtp'];

/** Testnet E2E signer credentials — must never exist in a production environment. */
const FORBIDDEN_PRODUCTION_TEST_KEYS = ['E2E_SOURCE_PK', 'E2E_RELAYER_PK'];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * The ONE canonical reading of the live-payments gate. A deployment accepts
 * live (mainnet-class) keys/wallets ONLY when ENABLE_LIVE_PAYMENTS is exactly
 * 'true'. Previously any non-empty string (including 'false' or a typo like
 * 'TRUE') enabled live mode — a fail-OPEN footgun this helper closes. All
 * gates (auth, api-keys, settlement-wallets) must call this, never re-parse.
 */
export function livePaymentsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return trimmed(env.ENABLE_LIVE_PAYMENTS) === 'true';
}

/**
 * Audit a candidate production environment. Returns a list of human-readable
 * findings; an EMPTY list means the configuration is complete and fail-safe.
 * Each finding string references variable NAMES and expected shapes only —
 * never the offending value itself.
 */
export function validateProductionConfig(env: Record<string, string | undefined> = process.env): string[] {
  const issues: string[] = [];

  // ── 1. Signing secrets: same rule as the index.ts guard, names-only output ──
  for (const name of REQUIRED_PRODUCTION_SECRETS) {
    const v = trimmed(env[name]);
    if (!v) {
      issues.push(`${name} is not set (required in production, >= ${MIN_SECRET_LENGTH} random chars)`);
    } else if (v.length < MIN_SECRET_LENGTH) {
      issues.push(`${name} is shorter than ${MIN_SECRET_LENGTH} characters`);
    }
  }

  // ── 2. Public origin / routing — production must be HTTPS everywhere ───────
  // ALLOWED_ORIGINS is the CORS allowlist; the two dev-server fallback origins
  // are removed from the list in production (see index.ts), so the env value
  // must fully cover every legitimate calling origin.
  const origins = trimmed(env.ALLOWED_ORIGINS);
  if (!origins) {
    issues.push('ALLOWED_ORIGINS is not set (production CORS allowlist must name every calling origin)');
  } else {
    for (const raw of origins.split(',')) {
      const o = raw.trim();
      if (!o) continue; // tolerate empty segments between commas
      let url: URL | null = null;
      try { url = new URL(o); } catch { url = null; }
      if (!url) {
        issues.push('ALLOWED_ORIGINS contains an entry that is not a full origin URL (e.g. https://app.example.com)');
        continue;
      }
      if (url.protocol !== 'https:') {
        issues.push('ALLOWED_ORIGINS entries must use https:// in production (TLS is mandatory — Operator Runbook §6)');
      }
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        issues.push('ALLOWED_ORIGINS must not contain localhost/loopback origins in production');
      }
      if (url.pathname !== '/' && url.pathname !== '') {
        issues.push('ALLOWED_ORIGINS entries must be bare origins (no path) — a path can never match a browser Origin header');
      }
    }
  }

  const checkoutBase = trimmed(env.CHECKOUT_BASE_URL);
  if (!checkoutBase) {
    issues.push('CHECKOUT_BASE_URL is not set (checkout links handed to merchants would fall back to an unverified default)');
  } else {
    let url: URL | null = null;
    try { url = new URL(checkoutBase); } catch { url = null; }
    if (!url) issues.push('CHECKOUT_BASE_URL is not a valid URL');
    else if (url.protocol !== 'https:') issues.push('CHECKOUT_BASE_URL must use https:// in production');
  }

  const domain = trimmed(env.JAFARIPAY_DOMAIN);
  if (!domain) {
    issues.push('JAFARIPAY_DOMAIN is not set (SIWE login would silently verify against the built-in default domain)');
  } else if (/[:/\s]/.test(domain) || !/^[a-zA-Z0-9.-]+$/.test(domain)) {
    issues.push('JAFARIPAY_DOMAIN must be a bare hostname (no scheme, port, path or whitespace)');
  }

  // ── 3. Email (D-4 Brevo) — a half-configured provider must fail at boot ────
  // The transport switch itself never throws; missing credentials only surface
  // much later as per-receipt send() failures. That silent-degradation path is
  // exactly what a boot gate should refuse up front.
  const transport = trimmed(env.EMAIL_TRANSPORT).toLowerCase();
  if (!transport) {
    issues.push('EMAIL_TRANSPORT is not set (choose none | dev | brevo_smtp explicitly for a production deployment)');
  } else if (!KNOWN_EMAIL_TRANSPORTS.includes(transport)) {
    issues.push('EMAIL_TRANSPORT is not a known transport (none | dev | brevo_smtp) — an unknown value silently falls back to the dev sink');
  } else if (transport === 'brevo_smtp') {
    if (!trimmed(env.EMAIL_BREVO_SMTP_LOGIN)) issues.push('EMAIL_TRANSPORT=brevo_smtp but EMAIL_BREVO_SMTP_LOGIN is not set');
    if (!trimmed(env.EMAIL_BREVO_SMTP_KEY)) issues.push('EMAIL_TRANSPORT=brevo_smtp but EMAIL_BREVO_SMTP_KEY is not set');
    const from = trimmed(env.EMAIL_FROM);
    if (!from) {
      issues.push('EMAIL_TRANSPORT=brevo_smtp but EMAIL_FROM is not set');
    } else if (!EMAIL_SHAPE.test(from)) {
      issues.push('EMAIL_FROM is not a valid address (must be the Brevo-verified sender)');
    }
  }
  if (trimmed(env.EMAIL_DEV_FAIL) === '1') {
    issues.push('EMAIL_DEV_FAIL=1 is a test-only forced-failure flag and must never be set in production');
  }

  // ── 4. RPC proxy integrity — boot-time instead of per-request ──────────────
  // arc-provider.ts already refuses proxy calls without a token (fail closed);
  // catching it at boot prevents serving traffic into a guaranteed-broken read
  // path.
  const proxyBase = trimmed(env.RPC_PROXY_BASE_URL);
  if (proxyBase) {
    if (!trimmed(env.RPC_PROXY_TOKEN)) issues.push('RPC_PROXY_BASE_URL is set but RPC_PROXY_TOKEN is missing — every proxied RPC read would fail closed at runtime');
    if (!trimmed(env.RPC_PROXY_CHAINS)) issues.push('RPC_PROXY_BASE_URL is set but RPC_PROXY_CHAINS is empty — no network would route through the proxy');
  }

  // ── 5. Testnet E2E credentials must not live in a production environment ───
  for (const name of FORBIDDEN_PRODUCTION_TEST_KEYS) {
    if (trimmed(env[name])) {
      issues.push(`${name} is set — testnet E2E signer keys must never exist in the production environment`);
    }
  }

  // ── 6. Live-payments flag shape ────────────────────────────────────────────
  // The API gates treat ANY non-empty value as enabled; this checks that the
  // operator's intent is explicit: exactly 'true' (accept live money) or
  // unset / 'false' (testnet-only). Anything else is almost certainly a typo
  // ("TRUE", "1", "yes") that would silently enable live mode.
  const live = trimmed(env.ENABLE_LIVE_PAYMENTS);
  if (live && live !== 'true' && live !== 'false') {
    issues.push('ENABLE_LIVE_PAYMENTS must be exactly true or false (an arbitrary value is treated as enabled by the live-mode gate)');
  }

  return issues;
}
