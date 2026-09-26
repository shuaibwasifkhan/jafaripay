/**
 * JafariPay JavaScript SDK
 * ============================================================================
 * A thin, dependency-free browser integration layer over the EXISTING JafariPay
 * hosted checkout (`/checkout/:id`) and the public REST API.
 *
 *  - No payment processing.  No blockchain verification.  No wallet custody.
 *    No credentials, no secret material, no settlement.  Actual payment
 *    verification and settlement remain entirely server-side.
 *  - No secrets.  This bundle ships no server-side material: no session
 *    signing key, no webhook signing key, no API-key signing key, and no
 *    database credentials.  Only the public, unauthenticated checkout URL
 *    is ever used.
 *
 * The SDK is a cross-origin *messenger*: it launches the existing hosted
 * checkout (new window/popup, or an embedded iframe) and listens for an
 * origin-verified postMessage notification that the checkout page emits on a
 * terminal outcome.  It can additionally *best-effort* poll the existing
 * public status endpoint (`/api/checkout/:id`).  These signals are UI
 * notifications ONLY — never proof of settlement.
 */

// Version is injected at build time from package.json by the
// `jafaripay-sdk-version` Vite transform in vite.sdk.config.ts, which
// substitutes `__JAFARIPAY_SDK_VERSION__` with the JSON-stringified version.
// The `try/catch` (NOT a `typeof` guard) is deliberate: it keeps the source
// safe to import under Node, where the global has not been substituted.
declare const __JAFARIPAY_SDK_VERSION__: string;

/** SDK version, kept in sync with the project's package.json version. */
export const SDK_VERSION: string = (function (): string {
  try {
    return __JAFARIPAY_SDK_VERSION__;
  } catch {
    return '0.0.0';
  }
})();

// ── Constants ────────────────────────────────────────────────────────────────

/** Canonical production base URL. The JafariPay product domain. */
export const DEFAULT_BASE_URL = 'https://jafari.co.in';

/** postMessage type shared between the checkout page and this SDK. */
export const JP_MESSAGE_TYPE = 'jafaripay:payment';

/**
 * Real Payment Intent ids are `pi_` + 24 lowercase alphanumeric characters
 * (see server/lib/ids.ts → generatePaymentIntentId).  We accept a slightly
 * looser shape (8–64 chars, letters/digits) so the SDK does not reject
 * fixtures from other environments while still rejecting garbage.
 */
const PI_PATTERN = /^pi_[0-9a-zA-Z]{8,64}$/;

// ── Types ────────────────────────────────────────────────────────────────────

export type TerminalStatus = 'succeeded' | 'failed' | 'expired' | 'cancelled';

/**
 * Result handed to the SDK callbacks.  This is a *UI notification* describing
 * what the checkout reported — it is NOT a settlement receipt.  Merchants
 * should treat the server webhook / their own ledger as the source of truth.
 */
export interface CheckoutResult {
  /** The payment intent id this result relates to. */
  paymentIntent: string;
  /** Terminal status as reported by the checkout. */
  status: TerminalStatus;
  /** Optional error/reason for failed/expired outcomes. */
  error?: string;
  /** How the SDK learned of the outcome. */
  source: 'postmessage' | 'poll';
  /** Epoch ms. */
  ts: number;
}

export interface CheckoutOptions {
  /** A JafariPay Payment Intent id, e.g. `pi_...`. */
  paymentIntent: string;
  /**
   * Base URL of the JafariPay deployment.  Defaults to `https://jafari.co.in`.
   * In production only `https://` origins are accepted (plus `http://` for
   * `localhost` / `127.0.0.1` for local development).
   */
  baseUrl?: string;
  /** Fired when the checkout reports a `succeeded` outcome. */
  onPaymentSuccess?: (result: CheckoutResult) => void;
  /** Fired when the checkout reports a `failed` outcome. */
  onPaymentFailed?: (result: CheckoutResult) => void;
  /** Fired when the checkout reports an `expired` outcome. */
  onPaymentExpired?: (result: CheckoutResult) => void;
  /** Fired when the customer dismisses/closes the checkout (no terminal state). */
  onClose?: () => void;
}

export interface JafariPayMountInstance {
  /** Show the checkout (open the embedded launcher / iframe). */
  open(): void;
  /** Hide the checkout. */
  close(): void;
  /** Remove all DOM the SDK created and detach all listeners. */
  destroy(): void;
}

export interface JafariPayCheckoutHandle {
  /** The hosted checkout URL that was opened. */
  url: string;
  /** The opened window reference (if any). */
  win: any | null;
  /** Close the opened window (if still open) and stop listening. */
  close(): void;
  /** Remove all listeners / timers. */
  destroy(): void;
}

export interface JafariPayNamespace {
  /** SDK version (kept in sync with the project's package.json). */
  version: string;
  /**
   * Launch the JafariPay hosted checkout in a new window and return a handle.
   * Does NOT process USDC, request keys, or custody funds.
   */
  checkout(options: CheckoutOptions): JafariPayCheckoutHandle;
  /**
   * Mount an embedded "Pay with USDC" launcher into the given element.  The
   * launcher opens the existing hosted checkout in a same-origin iframe.
   */
  mount(selector: string, options: CheckoutOptions): JafariPayMountInstance;
}

/** Minimal environment surface the SDK needs (dependency-injected for tests). */
export interface JafariPayEnv {
  window: any;
  document: any;
  /** Default base URL if `options.baseUrl` is omitted. */
  baseUrl?: string;
  /** When true, only `https:` base URLs are accepted. */
  isProduction?: boolean;
  /** Injectable fetch (defaults to `env.window.fetch`). */
  fetch?: (url: string, init?: any) => Promise<any>;
  /** Injectable timers (defaults to global setTimeout/clearTimeout). */
  setTimeout?: (fn: () => void, ms: number) => any;
  clearTimeout?: (id: any) => void;
}

// ── Pure, exported helpers (unit-testable without a DOM) ─────────────────────

/** True when the value looks like a JafariPay Payment Intent id. */
export function isValidPaymentIntent(pi: unknown): boolean {
  return typeof pi === 'string' && PI_PATTERN.test(pi);
}

/** Throw a descriptive Error when a paymentIntent is missing/invalid. */
export function requirePaymentIntent(pi: unknown): string {
  if (typeof pi !== 'string' || pi.length === 0) {
    throw new Error('JafariPay: options.paymentIntent is required (a non-empty string).');
  }
  if (!isValidPaymentIntent(pi)) {
    throw new Error(
      `JafariPay: invalid paymentIntent ${JSON.stringify(pi)}. ` +
      `Expected the form "pi_<id>" (e.g. "pi_abc123...").`,
    );
  }
  return pi;
}

/**
 * Resolve and validate the deployment base URL.
 *  - omits → `defaultBase` (or `https://jafari.co.in`).
 *  - must be an absolute http(s) URL.
 *  - in production: `http:` only allowed for localhost / 127.0.0.1.
 */
export function resolveBaseUrl(
  input: string | undefined,
  opts: { defaultBase?: string; isProduction?: boolean } = {},
): string {
  const defaultBase = opts.defaultBase ?? DEFAULT_BASE_URL;
  const raw = (input && input.trim()) ? input.trim() : defaultBase;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`JafariPay: baseUrl is not a valid URL: ${JSON.stringify(raw)}.`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`JafariPay: baseUrl must be http(s), got "${parsed.protocol}".`);
  }

  const host = parsed.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  // In production, plain http is only acceptable for local development hosts.
  if (opts.isProduction && parsed.protocol === 'http:' && !isLocal) {
    throw new Error(
      'JafariPay: baseUrl must use https:// in production ' +
      '(http:// is only allowed for localhost / 127.0.0.1).',
    );
  }

  // Normalise: strip trailing slash.
  return parsed.origin ? parsed.origin : raw.replace(/\/+$/, '');
}

/** Build the existing hosted-checkout URL for a payment intent. */
export function buildCheckoutUrl(baseUrl: string, paymentIntent: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/checkout/${encodeURIComponent(paymentIntent)}`;
}

/** Build the existing public payment-intent status URL. */
export function buildStatusUrl(baseUrl: string, paymentIntent: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/api/checkout/${encodeURIComponent(paymentIntent)}`;
}

/** The origin of a URL string (e.g. "https://jafari.co.in"). */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export interface MessageCheck {
  /** Exact origin that emitted the message (event.origin). */
  origin: string;
  /** The set of origins we accept (exactly the baseUrl origin). */
  allowedOrigins: string[];
  /** The paymentIntent this SDK instance is bound to. */
  paymentIntent: string;
}

/**
 * Decide whether an arbitrary `message` event payload is a trusted JafariPay
 * outcome for THIS SDK instance.  We never trust arbitrary origins: the
 * message origin must equal the configured baseUrl origin, the payload must be
 * our exact message type, and the paymentIntent must match.  A passing check
 * is a UI notification only — NOT settlement proof.
 */
export function isTrustedPaymentMessage(payload: any, check: MessageCheck): boolean {
  if (!check.allowedOrigins.includes(check.origin)) return false;
  if (!payload || typeof payload !== 'object') return false;
  if (payload.type !== JP_MESSAGE_TYPE) return false;
  if (typeof payload.paymentIntent !== 'string') return false;
  if (payload.paymentIntent !== check.paymentIntent) return false;
  if (typeof payload.status !== 'string') return false;
  return (
    payload.status === 'succeeded' ||
    payload.status === 'failed' ||
    payload.status === 'expired' ||
    payload.status === 'cancelled'
  );
}

/** Map a terminal status string to the appropriate callback name. */
export function statusToCallback(status: string): 'success' | 'failed' | 'expired' | 'closed' | null {
  switch (status) {
    case 'succeeded': return 'success';
    case 'failed': return 'failed';
    case 'expired': return 'expired';
    case 'cancelled': return 'closed';
    default: return null;
  }
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Build the JafariPay SDK namespace against an injectable environment.  Kept
 * side-effect-free so it is trivially unit-testable under Node.  The real
 * browser build calls {@link init}, which passes the actual `window`/`document`.
 */
export function createJafariPay(env: JafariPayEnv): JafariPayNamespace {
  const w = env.window;
  const doc = env.document;
  const isProd = !!env.isProduction;
  const defBase = env.baseUrl ?? DEFAULT_BASE_URL;
  const fetchFn: ((url: string, init?: any) => Promise<any>) | undefined =
    env.fetch ?? (typeof w?.fetch === 'function' ? (w.fetch.bind(w) as any) : undefined);
  const timer = {
    set: env.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)),
    clear: env.clearTimeout ?? ((id: any) => clearTimeout(id)),
  };

  const TICK_MS = 2000;
  const MAX_TICKS = 300; // ~10 minutes of window-close + status polling

  function dispatchOutcome(
    opts: CheckoutOptions,
    status: TerminalStatus,
    source: 'postmessage' | 'poll',
    error?: string,
  ) {
    const result: CheckoutResult = {
      paymentIntent: opts.paymentIntent,
      status,
      source,
      ts: Date.now(),
      ...(error ? { error } : {}),
    };
    const kind = statusToCallback(status);
    if (kind === 'success') opts.onPaymentSuccess?.(result);
    else if (kind === 'failed') opts.onPaymentFailed?.(result);
    else if (kind === 'expired') opts.onPaymentExpired?.(result);
    else if (kind === 'closed') opts.onClose?.();
  }

  // ── JafariPay.checkout(options) ─────────────────────────────────────────
  function checkout(opts: CheckoutOptions): JafariPayCheckoutHandle {
    requirePaymentIntent(opts?.paymentIntent);
    const base = resolveBaseUrl(opts?.baseUrl, { defaultBase: defBase, isProduction: isProd });
    const url = buildCheckoutUrl(base, opts.paymentIntent);
    const allowedOrigins = [originOf(base)];

    // Open the EXISTING hosted checkout in a new window (popup or new tab).
    let popup: any = null;
    try {
      popup = w.open(url, '_blank', 'noopener,width=480,height=720');
      if (!popup) popup = w.open(url, '_blank');
    } catch {
      popup = null;
    }

    let settled = false;
    let stopped = false;
    let timerId: any = null;
    let ticks = 0;

    const onMessage = (event: any) => {
      if (settled) return;
      if (popup && event.source && event.source !== popup) return;
      if (!isTrustedPaymentMessage(event.data, { origin: event.origin, allowedOrigins, paymentIntent: opts.paymentIntent })) return;
      settled = true;
      dispatchOutcome(opts, event.data.status as TerminalStatus, 'postmessage', event.data.error);
      stop();
    };

    function runTick() {
      if (stopped) return;
      ticks++;
      // (1) Detect the popup being dismissed with no terminal state → onClose.
      let popupClosed = false;
      try { popupClosed = popup ? !!popup.closed : true; } catch { popupClosed = true; }

      // (2) Best-effort poll of the EXISTING public status endpoint.
      if (!settled && typeof fetchFn === 'function') {
        Promise.resolve(
          fetchFn(buildStatusUrl(base, opts.paymentIntent), { headers: { Accept: 'application/json' } }),
        )
          .then((r: any) => (r && r.ok ? r.json() : null))
          .then((data: any) => {
            if (!data || settled) return;
            const st = data.status;
            if (st === 'succeeded' || st === 'failed' || st === 'expired') {
              settled = true;
              dispatchOutcome(opts, st as TerminalStatus, 'poll', data.error);
              stop();
            }
          })
          .catch(() => {
            /* CORS / transient network error — rely on postMessage instead. */
          });
      }

      if (popupClosed && !settled) {
        settled = true;
        opts.onClose?.();
        stop();
        return;
      }
      if (ticks < MAX_TICKS) timerId = timer.set(runTick, TICK_MS);
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      if (timerId != null) timer.clear(timerId);
      w.removeEventListener?.('message', onMessage);
    }

    w.addEventListener?.('message', onMessage);
    timerId = timer.set(runTick, TICK_MS);

    return {
      url,
      win: popup,
      close() {
        if (!settled) { settled = true; opts.onClose?.(); }
        stop();
        try { popup?.close?.(); } catch { /* cross-origin window cannot be closed */ }
      },
      destroy() {
        stop();
        try { popup?.close?.(); } catch { /* ignore */ }
      },
    };
  }

  // ── JafariPay.mount(selector, options) ─────────────────────────────────
  function mount(selector: string, opts: CheckoutOptions): JafariPayMountInstance {
    if (typeof selector !== 'string' || selector.trim().length === 0) {
      throw new Error('JafariPay.mount: selector must be a non-empty string (e.g. "#jafaripay-checkout").');
    }
    requirePaymentIntent(opts?.paymentIntent);
    if (!doc || typeof doc.querySelector !== 'function') {
      throw new Error('JafariPay.mount: no document available to render the launcher.');
    }
    const host = doc.querySelector(selector);
    if (!host) {
      throw new Error(`JafariPay.mount: no element found for selector "${selector}".`);
    }
    const base = resolveBaseUrl(opts.baseUrl, { defaultBase: defBase, isProduction: isProd });
    const url = buildCheckoutUrl(base, opts.paymentIntent);
    const allowedOrigins = [originOf(base)];

    // Render a lightweight "Pay with USDC" launcher + an embedded iframe that
    // loads the EXISTING hosted checkout. No payment logic is duplicated here.
    const frame = doc.createElement('iframe');
    frame.setAttribute('title', 'JafariPay checkout');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    frame.style.width = '100%';
    frame.style.height = '680px';
    frame.style.border = '0';
    frame.style.display = 'none';
    frame.style.borderRadius = '16px';

    const frameBox = doc.createElement('div');
    frameBox.style.display = 'none';
    frameBox.appendChild(frame);

    const launcher = doc.createElement('button');
    launcher.type = 'button';
    launcher.textContent = 'Pay with USDC';
    launcher.setAttribute('aria-label', 'Open JafariPay checkout');
    launcher.style.cssText = [
      'width:100%', 'padding:14px 16px', 'border-radius:12px', 'border:0',
      'background:#1e5c4a', 'color:#fff', 'font-weight:600', 'font-size:14px',
      'cursor:pointer', 'font-family:inherit', 'box-sizing:border-box',
    ].join(';');

    const wrapper = doc.createElement('div');
    wrapper.setAttribute('data-jafaripay-sdk', 'mount');
    wrapper.appendChild(launcher);
    wrapper.appendChild(frameBox);
    host.appendChild(wrapper);

    let settled = false;
    const onMessage = (event: any) => {
      if (settled) return;
      // Extra source guard: only accept messages from OUR iframe.
      const frameWin = (frame as any).contentWindow;
      if (frameWin && event.source && event.source !== frameWin) return;
      if (!isTrustedPaymentMessage(event.data, { origin: event.origin, allowedOrigins, paymentIntent: opts.paymentIntent })) return;
      settled = true;
      dispatchOutcome(opts, event.data.status as TerminalStatus, 'postmessage', event.data.error);
      if (event.data.status === 'succeeded' || event.data.status === 'failed' || event.data.status === 'expired') {
        close();
      }
    };
    w.addEventListener?.('message', onMessage);

    function open() {
      launcher.style.display = 'none';
      frameBox.style.display = 'block';
      if (!frame.getAttribute('src')) frame.setAttribute('src', url);
    }
    function close() {
      frameBox.style.display = 'none';
      launcher.style.display = '';
      try { (frame as any).contentWindow?.close?.(); } catch { /* ignore */ }
      frame.removeAttribute('src');
    }
    function destroy() {
      w.removeEventListener?.('message', onMessage);
      try { (wrapper as any).remove?.(); } catch { try { host.removeChild(wrapper); } catch { /* gone */ } }
    }

    return { open, close, destroy };
  }

  return {
    version: SDK_VERSION,
    checkout,
    mount,
  };
}

/**
 * Initialise the SDK in the real browser and attach `window.JafariPay`.
 * Idempotent: safe to call more than once (only assigns if not already set).
 */
export function init(target?: { window?: any; isProduction?: boolean; baseUrl?: string }): JafariPayNamespace {
  const g = target?.window ?? (typeof window !== 'undefined' ? window : globalThis);
  const protoHttps = !!(typeof location !== 'undefined' && location?.protocol === 'https:');
  const ns = createJafariPay({
    window: g,
    document: g && g.document ? g.document : (typeof document !== 'undefined' ? document : undefined),
    isProduction: target?.isProduction ?? protoHttps,
    baseUrl: target?.baseUrl,
  });
  if (g && typeof g.JafariPay === 'undefined') {
    g.JafariPay = ns;
  }
  return ns;
}


