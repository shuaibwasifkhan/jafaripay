import { Outlet, NavLink, useNavigate, Link } from 'react-router-dom';
import { useEffect } from 'react';
import { LayoutDashboard, CreditCard, Layers, Key, Webhook, Code2, Settings, LogOut, Zap } from 'lucide-react';
import { useDisconnect } from 'wagmi';
import { useAuth } from '../../lib/auth-context';
import { formatAddress } from '../../lib/format';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Overview', icon: LayoutDashboard, exact: true },
  { to: '/dashboard/payments', label: 'Payments', icon: CreditCard },
  { to: '/dashboard/projects', label: 'Projects', icon: Layers },
  { to: '/dashboard/api-keys', label: 'API Keys', icon: Key },
  { to: '/dashboard/webhooks', label: 'Webhooks', icon: Webhook },
  { to: '/dashboard/developers', label: 'Developers', icon: Code2 },
  { to: '/dashboard/settings', label: 'Settings', icon: Settings },
];

export default function DashboardLayout() {
  const { merchant, loading, logout } = useAuth();
  const navigate = useNavigate();
  const { disconnect } = useDisconnect();

  useEffect(() => {
    if (!loading && !merchant) void navigate('/login');
  }, [merchant, loading, navigate]);

  const handleLogout = () => {
    void logout().then(() => {
      disconnect();
      // Clear session cookie from browser too
      try { document.cookie = 'jp_session_js=; Max-Age=0; path=/'; } catch { /* ignore */ }
      window.location.href = '/';
    });
  };

  if (loading || !merchant) return null;

  return (
        <div className="min-h-dvh bg-cream flex" style={{ fontFamily: "'DM Sans', sans-serif" }}>
      {/* Sidebar */}
      <aside className="w-60 bg-forest-950 border-r border-forest-800/50 flex flex-col flex-shrink-0">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2 px-5 py-5 border-b border-forest-800/50">
          <div className="w-7 h-7 rounded-xl bg-forest-600 flex items-center justify-center">
            <Zap size={12} fill="white" className="text-white" />
          </div>
          <span className="font-bold text-white text-sm tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>JafariPay</span>
        </Link>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {NAV_ITEMS.map(({ to, label, icon: Icon, exact }) => (
            <NavLink
              key={to}
              to={to}
              end={exact}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-all ${
                  isActive ? 'bg-white/12 text-white font-medium' : 'text-forest-200 hover:text-white hover:bg-white/4'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={14} className={isActive ? 'text-gold-300' : 'text-forest-200'} />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Merchant identity */}
        <div className="border-t border-forest-800/50 p-3">
          <div className="flex items-center gap-2.5 p-2.5 rounded-xl hover:bg-forest-700/40 transition-all group cursor-default">
            <div className="w-7 h-7 rounded-xl bg-gold-400/20 flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-bold text-gold-300">{merchant.wallet_address.slice(2, 4).toUpperCase()}</span>
            </div>
            <div className="flex-1 min-w-0">
              {merchant.name && <p className="text-xs font-medium text-forest-100 truncate">{merchant.name}</p>}
              <p className="text-xs font-mono text-forest-300 truncate">{formatAddress(merchant.wallet_address)}</p>
            </div>
          </div>
          <button onClick={() => { void handleLogout(); }}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-sm text-forest-300 hover:text-red-400 hover:bg-red-500/10 transition-all mt-1">
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
