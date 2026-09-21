/**
 * JafariPay — Frontend API client
 *
 * Session token stored in localStorage and sent via X-Session-Token header.
 * This avoids cross-origin cookie issues in the preview sandbox environment.
 */

const BASE = '/api';
const SESSION_KEY = 'jp_session_token';

export function saveSessionToken(token: string): void {
  localStorage.setItem(SESSION_KEY, token);
}

export function clearSessionToken(): void {
  localStorage.removeItem(SESSION_KEY);
  // Also clear the JS-readable cookie
  document.cookie = 'jp_session_js=; Max-Age=0; path=/';
}

function readCookieToken(): string | null {
  const match = document.cookie.split('; ').find(row => row.startsWith('jp_session_js='));
  return match ? match.split('=')[1] ?? null : null;
}

export function getSessionToken(): string | null {
  // Prefer localStorage, fall back to JS-readable cookie set by server
  const stored = localStorage.getItem(SESSION_KEY);
  if (stored) return stored;
  const fromCookie = readCookieToken();
  if (fromCookie) {
    // Persist to localStorage so future calls don't need to parse cookies
    localStorage.setItem(SESSION_KEY, fromCookie);
    return fromCookie;
  }
  return null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getSessionToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (token) headers['X-Session-Token'] = token;

  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...opts,
    headers,
  });

  // Auto-capture session token from response header — works even when the proxy
  // strips the response body, because headers are never stripped.
  const headerToken = res.headers.get('X-Session-Token');
  if (headerToken) {
    localStorage.setItem(SESSION_KEY, headerToken);
  }

  const text = await res.text();
  let body: Record<string, unknown>;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { error: text }; }

  // Also capture token from body as belt-and-suspenders fallback
  if (body.token && typeof body.token === 'string') {
    localStorage.setItem(SESSION_KEY, body.token);
  }

  if (!res.ok) throw new ApiError(res.status, (body.error as string) || 'Request failed', body.code as string | undefined);
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(data) }),
  patch: <T>(path: string, data?: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// Public checkout endpoints (no auth)
export const publicApi = {
  get: <T>(path: string) => fetch(`${BASE}${path}`).then(r => r.json() as Promise<T>),
};
