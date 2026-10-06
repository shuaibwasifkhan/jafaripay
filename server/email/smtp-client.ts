/**
 * JafariPay — Minimal raw SMTP client (STARTTLS submission).
 *
 * Deliberately provider-agnostic, dependency-free and self-contained. This is
 * the ONLY module in the repository that knows how to speak SMTP, and it is
 * used exclusively by `brevo-smtp.ts` (the D-4-approved transport). It is
 * never referenced by payment, webhook, blockchain, CCTP, or database code.
 *
 * Safety guarantees (enforced by this file):
 *   • `smtpSend()` NEVER throws. Every failure — connect, TLS, protocol,
 *     authentication, timeout, socket error — surfaces as
 *     `{ ok: false, error }`. Callers can therefore treat this as a pure
 *     value-returning function and never wrap it in try/catch.
 *   • Credentials are NEVER included in the returned `error` string. Only
 *     short static tokens like `smtp_auth_code_535`, `smtp_starttls_timeout`,
 *     `tcp_econnrefused` etc. are produced.
 *   • The `login` / `password` fields are only used to write base64-encoded
 *     AUTH LOGIN lines to the socket. They are never logged, never stored on
 *     any state that outlives the promise, never echoed.
 *   • All sockets are destroyed on every terminal path (success or failure)
 *     so nothing leaks on the payment path.
 *   • Test boundary: `deliver` is injectable at the transport layer, so tests
 *     never invoke `smtpSend()` at all. Nothing in this file opens a network
 *     socket unless it is actually called.
 *
 * Wire sequence (Brevo `smtp-relay.brevo.com:587` STARTTLS submission):
 *   TCP connect → 220 greeting → EHLO → 250 → STARTTLS → 220 →
 *   TLS upgrade → EHLO over TLS → 250 (advertisers AUTH) →
 *   AUTH LOGIN → 334 → base64(login) → 334 → base64(password) → 235 →
 *   MAIL FROM → 250 → RCPT TO → 250/251 → DATA → 354 → payload+CRLF.CRLF →
 *   250 queued → QUIT.
 */

import * as net from 'node:net';
import * as tls from 'node:tls';

export interface SmtpSendOptions {
  host: string;
  port: number;
  login: string;
  password: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  /** EHLO hostname advertised to the server. Defaults to the host. */
  ehloName?: string;
  /** Per-phase read/write timeout. Default 15000 ms. */
  timeoutMs?: number;
}

export interface SmtpSendResult {
  ok: boolean;
  error?: string;
}

/**
 * Deliver a single email over SMTP + STARTTLS. Never throws.
 */
export function smtpSend(o: SmtpSendOptions): Promise<SmtpSendResult> {
  return new Promise<SmtpSendResult>((resolve) => {
    const timeoutMs = o.timeoutMs ?? 15_000;
    const ehloName = o.ehloName || o.host;

    let settled = false;
    let buffer = '';
    let pending: ((lines: string[]) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sock: net.Socket | tls.TLSSocket | null = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = null;
      try { sock?.removeAllListeners(); } catch { /* ignore */ }
      try { sock?.destroy(); } catch { /* ignore */ }
    };

    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      // NOTE: `code` is a static, credential-free short reason token (e.g.
      // "smtp_auth_code_535"). We never interpolate user- or credential-derived
      // values into the returned error string.
      resolve({ ok: false, error: code });
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: true });
    };

    /**
     * Try to consume one complete SMTP reply from the buffer. An SMTP reply is
     * a run of "NNN-…" continuation lines followed by a final "NNN <text>"
     * line, each terminated by CRLF. Returns null if not yet complete.
     */
    const tryConsumeReply = (): string[] | null => {
      let cursor = 0;
      const lines: string[] = [];
      while (cursor < buffer.length) {
        const nl = buffer.indexOf('\r\n', cursor);
        if (nl < 0) return null;
        const line = buffer.slice(cursor, nl);
        lines.push(line);
        cursor = nl + 2;
        // "NNN " (space) — final line of the reply.
        if (line.length >= 4 && line.charCodeAt(3) === 0x20 && /^\d{3}/.test(line)) {
          buffer = buffer.slice(cursor);
          return lines;
        }
        // "NNN-" — continuation. Anything else is a protocol violation and
        // we let the read timeout handle it rather than mis-parsing.
        if (!(line.length >= 4 && line.charCodeAt(3) === 0x2d && /^\d{3}/.test(line))) {
          return null;
        }
      }
      return null;
    };

    const pump = () => {
      if (!pending) return;
      const reply = tryConsumeReply();
      if (reply) {
        const cb = pending;
        pending = null;
        if (timer) { clearTimeout(timer); timer = null; }
        cb(reply);
      }
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      pump();
    };

    const write = (line: string) => {
      if (!sock) throw new Error('smtp_socket_unbound');
      sock.write(line + '\r\n');
    };

    const expect = (codes: number[], label: string): Promise<string[]> =>
      new Promise<string[]>((res, rej) => {
        // If a reply is already in the buffer, deliver synchronously.
        const already = tryConsumeReply();
        if (already) {
          const last = already[already.length - 1] ?? '';
          const code = parseInt(last.slice(0, 3), 10);
          if (codes.includes(code)) { res(already); return; }
          rej(new Error(`smtp_${label}_code_${Number.isFinite(code) ? code : 'malformed'}`));
          return;
        }
        timer = setTimeout(() => { pending = null; rej(new Error(`smtp_${label}_timeout`)); }, timeoutMs);
        pending = (lines) => {
          const last = lines[lines.length - 1] ?? '';
          const code = parseInt(last.slice(0, 3), 10);
          if (codes.includes(code)) res(lines);
          else rej(new Error(`smtp_${label}_code_${Number.isFinite(code) ? code : 'malformed'}`));
        };
      });

    const connectTcp = (): Promise<void> =>
      new Promise<void>((res, rej) => {
        if (!sock) throw new Error('smtp_socket_unbound');
        const t = setTimeout(() => rej(new Error('smtp_connect_timeout')), timeoutMs);
        sock.once('connect', () => { clearTimeout(t); res(); });
        sock.once('error', (e) => { clearTimeout(t); rej(new Error('smtp_connect_' + classifyNodeError(e))); });
      });

    const upgradeToTls = (): Promise<void> =>
      new Promise<void>((res, rej) => {
        if (!sock) return rej(new Error('smtp_socket_unbound'));
        const plain = sock as net.Socket;
        // Remove any prior handlers on the plain socket; TLS re-uses the same
        // fd and we don't want raw bytes to reach the plaintext feed.
        plain.removeAllListeners('data');
        plain.removeAllListeners('error');
        const tlsSock = tls.connect(
          { socket: plain, servername: o.host, rejectUnauthorized: true },
          () => {
            tlsSock.removeAllListeners('secureConnect');
            tlsSock.on('data', onData);
            tlsSock.on('error', (e) => fail('tls_' + classifyNodeError(e)));
            sock = tlsSock;
            res();
          },
        );
        tlsSock.once('error', (e) => rej(new Error('tls_handshake_' + classifyNodeError(e))));
      });

    (async () => {
      try {
        // ── TCP connect ────────────────────────────────────────────────────
        sock = net.connect({ host: o.host, port: o.port });
        sock.on('error', (e) => fail('tcp_' + classifyNodeError(e)));
        sock.on('timeout', () => fail('tcp_idle_timeout'));
        sock.on('close', () => fail('tcp_closed'));
        await connectTcp();

        // ── Greeting ───────────────────────────────────────────────────────
        sock.on('data', onData);
        await expect([220], 'greeting');

        // ── Plain EHLO → STARTTLS ──────────────────────────────────────────
        write(`EHLO ${ehloName}`);
        await expect([250], 'ehlo');
        write('STARTTLS');
        await expect([220], 'starttls');

        // ── TLS upgrade ────────────────────────────────────────────────────
        await upgradeToTls();
        buffer = '';

        // ── TLS EHLO ───────────────────────────────────────────────────────
        write(`EHLO ${ehloName}`);
        await expect([250], 'ehlo_tls');

        // ── AUTH LOGIN (base64 challenge → login → base64 challenge → key) ─
        write('AUTH LOGIN');
        await expect([334], 'auth_start');
        write(Buffer.from(o.login, 'utf8').toString('base64'));
        await expect([334], 'auth_user');
        write(Buffer.from(o.password, 'utf8').toString('base64'));
        await expect([235], 'auth_ok');

        // ── Envelope ───────────────────────────────────────────────────────
        write(`MAIL FROM:<${o.from}>`);
        await expect([250], 'mail_from');
        write(`RCPT TO:<${o.to}>`);
        await expect([250, 251], 'rcpt_to');
        write('DATA');
        await expect([354], 'data_start');

        // ── Body ───────────────────────────────────────────────────────────
        const payload = buildPayload(o);
        // Write payload directly (already CRLF-terminated with the trailing
        // "\r\n.\r\n" that closes the DATA block per RFC 5321).
        sock!.write(payload);
        await expect([250], 'queued');

        // ── QUIT ───────────────────────────────────────────────────────────
        try { write('QUIT'); } catch { /* ignore — we're already successful */ }
        succeed();
      } catch (err) {
        // Any error thrown inside our own helpers is a code-shaped,
        // credential-free token (e.g. "smtp_auth_ok_code_535"). Convert to a
        // failure result rather than propagating.
        const msg = err instanceof Error ? err.message : String(err);
        fail(msg.startsWith('smtp_') || msg.startsWith('tls_') || msg.startsWith('tcp_')
          ? msg
          : 'smtp_internal');
      }
    })();
  });
}

// ── Payload builder ───────────────────────────────────────────────────────

/**
 * Build an RFC 5322 `multipart/alternative` payload terminated by
 * `CRLF.CRLF` for SMTP DATA. All lines are dot-stuffed per RFC 5321 §4.5.2.
 * Subject is RFC 2047 Base64-encoded only when it contains non-ASCII.
 */
export function buildPayload(o: SmtpSendOptions): string {
  const boundary = 'jafari_' + randomToken() + '_' + Date.now().toString(36);
  const date = new Date().toUTCString();
  const parts = [
    'From: ' + o.from,
    'To: ' + o.to,
    'Subject: ' + encodeSubjectIfNeeded(o.subject),
    'Date: ' + date,
    'Message-ID: <' + o.messageId + '>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    prepareBody(o.text),
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    prepareBody(o.html),
    '--' + boundary + '--',
    '',
    '.',
    '',
  ];
  return parts.join('\r\n');
}

/**
 * Normalise line endings to CRLF and dot-stuff every line whose first byte is
 * '.' (RFC 5321 §4.5.2). Receipt content never legitimately starts a line with
 * '.' but the guard is cheap and prevents protocol corruption.
 */
function prepareBody(s: string): string {
  const norm = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return norm.split('\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
}

function encodeSubjectIfNeeded(s: string): string {
  // Printable ASCII (with a couple of reserved characters stripped for safety)
  // passes through; anything else becomes an RFC 2047 encoded-word.
  if (/^[\x20-\x7E]*$/.test(s) && !/^=/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

function randomToken(): string {
  try {
    const b = new Uint8Array(6);
    globalThis.crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  } catch {
    return Math.random().toString(36).slice(2, 14);
  }
}

/**
 * Map a Node socket error to a short static code. The message text is
 * intentionally NOT included so no server-supplied content can leak into our
 * logs / errors.
 */
function classifyNodeError(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code ?? 'unknown';
  switch (code) {
    case 'ECONNREFUSED': return 'econnrefused';
    case 'ECONNRESET': return 'econnreset';
    case 'EHOSTUNREACH': return 'ehostunreach';
    case 'ENETUNREACH': return 'enetunreach';
    case 'ENOTFOUND': return 'enotfound';
    case 'ETIMEDOUT': return 'etimedout';
    case 'EAI_AGAIN': return 'eai_again';
    case 'EPIPE': return 'epipe';
    default: return 'socket_error';
  }
}
