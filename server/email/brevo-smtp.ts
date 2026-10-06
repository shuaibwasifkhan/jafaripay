/**
 * JafariPay — Brevo SMTP `EmailTransport` implementation (Phase 21, D-4 approved).
 *
 * Records the approved operational decision:
 *   • Provider:   Brevo
 *   • Host:       smtp-relay.brevo.com
 *   • Port:       587 (STARTTLS submission)
 *   • Auth:       SMTP login + SMTP key (provisioned externally by the project
 *                 owner; NEVER stored in this repository, NEVER in a test file,
 *                 NEVER in a documentation file)
 *   • Sending domain: jafari.co.in (authenticated in Brevo)
 *   • Branded subdomain: mail.jafari.co.in (authenticated/branded in Brevo)
 *   • Zoho mailbox `dev@jafari.co.in` + apex MX/SPF/DKIM remain authoritative
 *     and are unaffected by this module.
 *
 * Design — deliberately minimal:
 *   • Implements the existing `EmailTransport` interface. Adds no new
 *     abstraction, no new settings system, no new configuration surface.
 *   • Selected by the SAME single `EMAIL_TRANSPORT` env-var switch that already
 *     governs `dev` / `none` in `transport.ts`. That switch gains exactly one
 *     new case value: `brevo_smtp`.
 *   • Credentials are read from environment variables at selection time
 *     (`EMAIL_BREVO_SMTP_LOGIN`, `EMAIL_BREVO_SMTP_KEY`, `EMAIL_FROM`) and are
 *     never written to any log line, error string, or receipt row.
 *   • `send()` NEVER throws. Missing credentials, invalid recipient, or a
 *     throwing delivery boundary are all converted to `{ ok: false, error }`.
 *     This is enforced at the transport boundary so that no failure mode can
 *     propagate into the receipts service or a payment code path.
 *   • The delivery boundary is INJECTABLE via the constructor so tests can
 *     assert behaviour with a fake function and never open a socket. The
 *     production default is `smtpSend()` from `./smtp-client.js`.
 *
 * Isolation contract (inherited unchanged):
 *   A receipt-email failure leaves the payment row untouched and never
 *   transitions `payment_intents.status` away from `succeeded`. That guarantee
 *   lives in `server/receipts/service.ts` (see the R5 test in
 *   `server/master-receipts.test.ts`) and is preserved automatically because
 *   this module satisfies the same `EmailTransport` interface as `dev`.
 */

import type { EmailMessage, EmailSendResult, EmailTransport } from './transport.js';
import { smtpSend, type SmtpSendOptions } from './smtp-client.js';

/** Configuration required to reach Brevo SMTP. */
export interface BrevoSmtpConfig {
  host: string;
  port: number;
  login: string;
  password: string;
  from: string;
  timeoutMs?: number;
}

/** A pre-processed email ready to hand to the delivery boundary. */
export interface PreparedEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  /** Stable per-receipt idempotency identifier surfaced as RFC 2822 Message-ID. */
  messageId: string;
}

/**
 * Delivery boundary. Injectable for tests so no real SMTP socket is ever
 * opened. Receives only credential-free prepared content — the SMTP login +
 * key never reach this function unless the implementation itself reads them
 * from `cfg`.
 */
export type BrevoDeliverFn = (
  prepared: PreparedEmail,
  cfg: BrevoSmtpConfig,
) => Promise<EmailSendResult>;

/** Production default — hands off to the raw SMTP client. */
const defaultDeliver: BrevoDeliverFn = async (prepared, cfg) => {
  const opts: SmtpSendOptions = {
    host: cfg.host,
    port: cfg.port,
    login: cfg.login,
    password: cfg.password,
    from: prepared.from,
    to: prepared.to,
    subject: prepared.subject,
    text: prepared.text,
    html: prepared.html,
    messageId: prepared.messageId,
    timeoutMs: cfg.timeoutMs,
  };
  return smtpSend(opts);
};

/**
 * Concrete `EmailTransport` used when `EMAIL_TRANSPORT=brevo_smtp`.
 *
 * The class is intentionally small: it validates configuration, formats the
 * message for delivery, and calls the injected delivery boundary. All error
 * paths return `{ ok: false, error }`. Nothing here throws.
 */
export class BrevoSmtpTransport implements EmailTransport {
  readonly name = 'brevo_smtp' as const;

  constructor(
    private readonly cfg: BrevoSmtpConfig,
    private readonly deliver: BrevoDeliverFn = defaultDeliver,
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    // Fail safe: verify credentials FIRST so a misconfigured production env
    // never reaches the network. The service records the outcome; the payment
    // stays 'succeeded' regardless.
    const missing = firstMissingConfig(this.cfg);
    if (missing) return { ok: false, error: `brevo_smtp_${missing}` };

    if (!message || typeof message.to !== 'string' || !isSimpleAddress(message.to)) {
      return { ok: false, error: 'brevo_smtp_invalid_recipient' };
    }

    const messageId = toMessageId(message.idempotencyKey);
    const prepared: PreparedEmail = {
      to: message.to,
      from: this.cfg.from,
      subject: message.subject ?? '',
      text: message.text ?? '',
      html: message.html ?? '',
      messageId,
    };

    try {
      const r = await this.deliver(prepared, this.cfg);
      // Defensive: a broken injectable that returns undefined must not
      // propagate as a truthy result.
      if (!r || typeof r.ok !== 'boolean') {
        return { ok: false, error: 'brevo_smtp_bad_delivery_result' };
      }
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'brevo_smtp_send_failed' };
    } catch (err) {
      // Contract violation from the delivery boundary. Never propagate.
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: 'brevo_smtp_delivery_thrown:' + redact(msg) };
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function firstMissingConfig(cfg: BrevoSmtpConfig): string | null {
  if (!cfg.host) return 'missing_host';
  if (!cfg.port || !Number.isFinite(cfg.port) || cfg.port <= 0) return 'missing_port';
  if (!cfg.login) return 'missing_login';
  if (!cfg.password) return 'missing_key';
  if (!cfg.from) return 'missing_from';
  return null;
}

/**
 * Simple shape check mirroring the `isValidEmail` contract already enforced
 * upstream in `receipts/service.ts`. We keep it local so the transport can
 * never be the first thing to see a malformed address if a future caller
 * forgets the upstream check.
 */
function isSimpleAddress(s: string): boolean {
  return s.length > 3 && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function toMessageId(key: string | undefined): string {
  const raw = key && key.trim().length > 0
    ? key
    : `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  // RFC 2822 addr-spec safe subset — anything else is replaced with '_'.
  return raw.replace(/[^A-Za-z0-9._+-]/g, '_').slice(0, 96);
}

/**
 * Guard against a hypothetical delivery boundary that echoes part of the
 * password in an error string. We redact any long opaque token that looks
 * like a base64/hex secret. This is defence-in-depth: the production
 * `defaultDeliver` never returns such strings, and injected test mocks won't
 * either, but a third-party deliver implementation might.
 */
function redact(s: string): string {
  return s
    .replace(/[A-Za-z0-9+/]{30,}={0,2}/g, '[redacted_b64]')
    .replace(/\b0x[0-9a-fA-F]{20,}\b/g, '[redacted_hex]')
    .slice(0, 240);
}

// ── Factory (used by getEmailTransport() switch) ────────────────────────────

/**
 * Construct a production BrevoSmtpTransport from environment variables.
 *
 * Never logs any credential. Never returns a value that could be mistaken for
 * a secret. Any missing configuration surfaces through the transport's own
 * `send()` result (`brevo_smtp_missing_*`), so `makeBrevoSmtpTransport()`
 * itself NEVER throws — the server boots cleanly even if the operator has not
 * yet injected the SMTP credentials.
 */
export function makeBrevoSmtpTransport(): EmailTransport {
  const cfg: BrevoSmtpConfig = {
    host: (process.env.EMAIL_BREVO_SMTP_HOST || 'smtp-relay.brevo.com').trim(),
    port: Number(process.env.EMAIL_BREVO_SMTP_PORT || '587'),
    login: (process.env.EMAIL_BREVO_SMTP_LOGIN || '').trim(),
    password: (process.env.EMAIL_BREVO_SMTP_KEY || '').trim(),
    from: (process.env.EMAIL_FROM || '').trim(),
    timeoutMs: Number(process.env.EMAIL_BREVO_TIMEOUT_MS || '15000'),
  };
  return new BrevoSmtpTransport(cfg);
}
