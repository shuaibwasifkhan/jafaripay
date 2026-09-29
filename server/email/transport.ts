/**
 * JafariPay — Provider-agnostic email transport (Phase B).
 *
 * DESIGN GOALS
 *  • ONE clean abstraction. There is deliberately NO second settings/config
 *    system: transport selection comes from a single env var (EMAIL_TRANSPORT),
 *    exactly like the existing single RPC deployment switch. No credentials or
 *    real provider secrets are ever stored or hardcoded here.
 *  • Email is an ANNOUNCEMENT, never part of payment correctness. Callers treat
 *    a send failure as "email = pending/failed" while the payment stays
 *    'succeeded'. This module NEVER throws into a money path — send() returns a
 *    result object instead.
 *  • Testable by construction: the default transport is a deterministic,
 *    in-memory dev transport that records messages (and can be told to fail),
 *    so receipt tests exercise the full success/failure/retry paths with no
 *    network and no secrets.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stable key so a retried receipt email can be de-duplicated by a provider. */
  idempotencyKey?: string;
}

export interface EmailSendResult {
  ok: boolean;
  error?: string;
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

// ── Dev / test transport ──────────────────────────────────────────────────
// Records every message in-memory (bounded) and can be forced to fail via
// EMAIL_DEV_FAIL=1 so the "email fails but payment stays succeeded" contract is
// actually exercised, not asserted. It performs NO network I/O and reads no
// secrets, so it is safe as the default in every environment.
class DevTransport implements EmailTransport {
  readonly name = 'dev';
  readonly sent: EmailMessage[] = [];
  readonly failures: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (process.env.EMAIL_DEV_FAIL === '1') {
      this.failures.push(message);
      return { ok: false, error: 'dev transport forced failure (EMAIL_DEV_FAIL=1)' };
    }
    this.sent.push(message);
    // Keep a bounded log; this is a dev sink, not a queue (the durable queue is
    // the receipts table itself, retried by the worker).
    if (this.sent.length > 100) this.sent.shift();
    console.log(`[Email:dev] to=${message.to} subject="${message.subject}"`);
    return { ok: true };
  }
}

const devTransport = new DevTransport();

// A not-configured transport is an explicit no-op that reports success-without-
// sending is FALSE — actually it returns ok:true but the caller records 'skipped'
// when there is no recipient. For EMAIL_TRANSPORT=none we short-circuit sends so
// nothing is attempted, but we never surface an error that could disturb a flow.
class NoopTransport implements EmailTransport {
  readonly name = 'none';
  async send(): Promise<EmailSendResult> {
    return { ok: true };
  }
}
const noopTransport = new NoopTransport();

// ── Selection ──────────────────────────────────────────────────────────────
// A future real provider (SMTP/SES/Postmark/…) is added by implementing
// EmailTransport and returning it here behind its env var — WITHOUT touching any
// caller. Until then only 'dev' and 'none' exist, and NOTHING sends real email,
// which is the safe default. We intentionally do not add an SMTP transport now:
// that would require credentials/host config, which this phase must not add.
export function getEmailTransport(): EmailTransport {
  switch ((process.env.EMAIL_TRANSPORT || 'dev').toLowerCase()) {
    case 'none':
      return noopTransport;
    case 'dev':
      return devTransport;
    default:
      // An unknown EMAIL_TRANSPORT value is treated as the safe dev sink rather
      // than silently pretending a real provider is wired up. Fail-safe, not
      // fail-open to a fake sender.
      return devTransport;
  }
}

// Exposed for tests to assert what the dev sink captured and to toggle it.
export function getDevTransport(): DevTransport {
  return devTransport;
}

// ── Email validation ───────────────────────────────────────────────────────
// Deliberately strict-but-simple. A malformed address is rejected BEFORE it is
// ever persisted as a receipt destination, so an invalid email can never reach a
// transport. This is NOT a full RFC 5322 parser — it is an abuse guard that
// blocks the obvious invalid/oversized inputs.
const EMAIL_MAX_LEN = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return (
    typeof email === 'string' &&
    email.length > 0 &&
    email.length <= EMAIL_MAX_LEN &&
    EMAIL_RE.test(email)
  );
}

/** Normalize a customer-supplied address for storage/comparison. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
