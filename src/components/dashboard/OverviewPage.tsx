import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, CreditCard, Clock, CheckCircle, ArrowUpRight, AlertCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { Card } from '../shared/Card';
import { Badge } from '../shared/Badge';
import { formatUSDC, formatDate, getStatusColor, getStatusLabel } from '../../lib/format';
import { useAuth } from '../../lib/auth-context';

interface Stats {
  total_volume: string;
  total_count: number;
  succeeded_count: number;
  pending_count: number;
  recent_payments: Array<{ id: string; payment_intent_id: string; amount: string; status: string; order_id: string | null; created_at: number; environment: string; }>;
}

export default function OverviewPage() {
  const { merchant } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [noWallet, setNoWallet] = useState(false);

  useEffect(() => {
    api.get<Stats>('/payments/stats')
      .then(s => setStats(s))
      .catch((err: unknown) => {
        if (err instanceof Error && err.message.includes('settlement')) setNoWallet(true);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-8">
      <div className="mb-8">
                <h1 className="text-2xl font-bold text-ink tracking-tight mb-1" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
          {merchant?.name ? `Welcome, ${merchant.name}` : 'Overview'}
        </h1>
        <p className="text-slate-500 text-sm">Your payment dashboard for Arc USDC</p>
      </div>

      {/* Setup nudge */}
      {noWallet && (
                <Link to="/dashboard/settings" className="flex items-start gap-3 p-4 rounded-2xl bg-gold-50 border border-gold-200 mb-6 hover:border-gold-300 transition-all">
          <AlertCircle size={14} className="text-gold-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-gold-800">Configure a settlement wallet</p>
            <p className="text-xs text-gold-700/70 mt-0.5">Add a settlement wallet to start accepting payments. USDC will be sent directly to it.</p>
          </div>
          <ArrowUpRight size={13} className="text-gold-600 ml-auto mt-0.5" />
        </Link>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        {[
                    { label: 'Total volume', value: loading ? '—' : `${formatUSDC(stats?.total_volume || '0')} USDC`, icon: TrendingUp, tile: 'bg-forest-50', iconCls: 'text-forest-600' },
          { label: 'Total payments', value: loading ? '—' : (stats?.total_count || 0).toLocaleString(), icon: CreditCard, tile: 'bg-lilac-50', iconCls: 'text-lilac-600' },
          { label: 'Succeeded', value: loading ? '—' : (stats?.succeeded_count || 0).toLocaleString(), icon: CheckCircle, tile: 'bg-emerald-50', iconCls: 'text-emerald-600' },
          { label: 'Pending', value: loading ? '—' : (stats?.pending_count || 0).toLocaleString(), icon: Clock, tile: 'bg-gold-50', iconCls: 'text-gold-600' },
        ].map(({ label, value, icon: Icon, tile, iconCls }) => (
          <Card key={label} className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-7 h-7 rounded-xl ${tile} flex items-center justify-center`}>
                <Icon size={13} className={iconCls} />
              </div>
              <span className="text-xs text-slate-500">{label}</span>
            </div>
            <p className="text-2xl font-bold text-ink tabular-nums" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
              {value}
            </p>
          </Card>
        ))}
      </div>

      {/* Recent payments */}
      <Card>
        <div className="px-6 py-4 border-b border-sand-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Recent payments</h2>
          <Link to="/dashboard/payments" className="text-xs text-forest-700 hover:text-forest-800 flex items-center gap-1">
            View all <ArrowUpRight size={11} />
          </Link>
        </div>

        {loading ? (
          <div className="p-8 text-sm text-slate-500">Loading…</div>
        ) : !stats?.recent_payments?.length ? (
          <div className="p-12 text-center">
            <CreditCard size={24} className="text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-500">No payments yet</p>
            <p className="text-xs text-slate-400 mt-1">Payments will appear here once you create payment intents</p>
          </div>
        ) : (
          <div className="divide-y divide-sand-200/70">
            {stats.recent_payments.map(p => (
              <Link key={p.id} to={`/dashboard/payments/${p.id}`}
                className="flex items-center gap-4 px-6 py-4 hover:bg-cream transition-all">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-mono text-slate-500 truncate">{p.payment_intent_id}</p>
                    <Badge variant={p.environment === 'live' ? 'error' : 'info'} className="text-xs">{p.environment}</Badge>
                  </div>
                  {p.order_id && <p className="text-xs text-slate-400 mt-0.5">{p.order_id}</p>}
                </div>
                <p className="text-sm font-semibold text-ink tabular-nums">{formatUSDC(p.amount)} USDC</p>
                <Badge className={getStatusColor(p.status)}>{getStatusLabel(p.status)}</Badge>
                <p className="text-xs text-slate-500 min-w-20 text-right">{formatDate(p.created_at)}</p>
                <ArrowUpRight size={13} className="text-slate-400" />
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
