import { createContext, useContext, useCallback, useState, type ReactNode } from 'react';
import { api, clearSessionToken, getSessionToken } from './api';

export interface Merchant {
  id: string;
  wallet_address: string;
  name: string | null;
  email: string | null;
  created_at: number;
}

interface AuthCtx {
  merchant: Merchant | null;
  loading: boolean;
  setMerchant: (m: Merchant | null) => void;
  setSessionToken: (token: string) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [merchant, setMerchantState] = useState<Merchant | null>(null);
  const [loading, setLoading] = useState(false);

  const setMerchant = useCallback((m: Merchant | null) => {
    setMerchantState(m);
  }, []);

  // Called by AuthPage immediately after verify — stores token before navigation
  const setSessionToken = useCallback((token: string) => {
    try { localStorage.setItem('jp_session_token', token); } catch { /* ignore */ }
  }, []);

  const refresh = useCallback(async () => {
    // If we already have a token (just signed in), skip the network call
    // to avoid a race where /auth/me 401s before the cookie is established.
    if (getSessionToken()) {
      // Try to restore from server but don't clear merchant on failure
      // (the token in localStorage/cookie will be sent on every subsequent request)
      setLoading(true);
      try {
        const data = await api.get<{ merchant: Merchant }>('/auth/me');
        setMerchantState(data.merchant);
      } catch {
        // Don't clear merchant — user just signed in, token is valid in memory
        // The subsequent dashboard API calls will work via X-Session-Token header
      } finally {
        setLoading(false);
      }
      return;
    }
    // No token at all — check if there's an active session via cookie
    setLoading(true);
    try {
      const data = await api.get<{ merchant: Merchant }>('/auth/me');
      setMerchantState(data.merchant);
    } catch {
      setMerchantState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    clearSessionToken();
    try { sessionStorage.removeItem('jp_merchant'); } catch { /* ignore */ }
    setMerchantState(null);
  }, []);

  return (
    <Ctx.Provider value={{ merchant, loading, setMerchant, setSessionToken, logout, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
