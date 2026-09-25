import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth-context';
import LandingPage from './components/landing/LandingPage';
import AuthPage from './components/dashboard/AuthPage';
import DashboardLayout from './components/dashboard/DashboardLayout';
import OverviewPage from './components/dashboard/OverviewPage';
import PaymentsPage from './components/dashboard/PaymentsPage';
import PaymentDetailPage from './components/dashboard/PaymentDetailPage';
import ProjectsPage from './components/dashboard/ProjectsPage';
import ApiKeysPage from './components/dashboard/ApiKeysPage';
import WebhooksPage from './components/dashboard/WebhooksPage';
import DevelopersPage from './components/dashboard/DevelopersPage';
import SettingsPage from './components/dashboard/SettingsPage';
import CheckoutPage from './components/checkout/CheckoutPage';
import DocsPage from './components/docs/DocsPage';

/**
 * Checks for an existing session on first mount.
 * Priority order:
 * 1. merchant already in React context (just signed in this SPA session)
 * 2. sessionStorage snapshot written by AuthPage after verify
 * 3. /auth/me API call (page refresh with valid cookie/token)
 *
 * Only redirects to /login when ALL three fail.
 */
function DashboardGuard({ children }: { children: React.ReactNode }) {
  const { merchant, setMerchant, refresh } = useAuth();
  const didCheck = useRef(false);

  // Eagerly restore from sessionStorage before first render
  const [checked, setChecked] = useState(() => {
    if (merchant !== null) return true;
    // Try sessionStorage snapshot (written by AuthPage right after verify)
    try {
      const raw = sessionStorage.getItem('jp_merchant');
      if (raw) {
        const parsed = JSON.parse(raw) as { id: string; wallet_address: string; name: string | null; email: string | null; created_at: number };
        if (parsed?.id) {
          // Will call setMerchant below in useEffect — can't call hooks in lazy init
          return false; // still need to set it
        }
      }
    } catch { /* ignore */ }
    return false;
  });

  useEffect(() => {
    if (didCheck.current) return;
    didCheck.current = true;

    // Already authenticated (in-memory context)
    if (merchant) { setChecked(true); return; }

    // Try sessionStorage first — avoids network call on fresh page load after sign-in
    try {
      const raw = sessionStorage.getItem('jp_merchant');
      if (raw) {
        const parsed = JSON.parse(raw) as { id: string; wallet_address: string; name: string | null; email: string | null; created_at: number };
        if (parsed?.id) {
          setMerchant(parsed);
          setChecked(true);
          return;
        }
      }
    } catch { /* ignore */ }

    // sessionStorage miss — try API (page reload with valid token/cookie)
    void refresh().finally(() => setChecked(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!checked) {
    return (
            <div className="min-h-dvh bg-cream flex items-center justify-center">
        <svg className="animate-spin w-6 h-6 text-forest-600" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  if (!merchant) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public */}
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<AuthPage />} />
          <Route path="/checkout/:id" element={<CheckoutPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/docs/:slug" element={<DocsPage />} />

          {/* Protected dashboard */}
          <Route path="/dashboard" element={
            <DashboardGuard>
              <DashboardLayout />
            </DashboardGuard>
          }>
            <Route index element={<OverviewPage />} />
            <Route path="payments" element={<PaymentsPage />} />
            <Route path="payments/:id" element={<PaymentDetailPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="api-keys" element={<ApiKeysPage />} />
            <Route path="webhooks" element={<WebhooksPage />} />
            <Route path="developers" element={<DevelopersPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
