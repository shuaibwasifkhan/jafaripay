import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CreditCard } from 'lucide-react';
import { api } from '../../lib/api';
import { Card } from '../shared/Card';
import { Badge } from '../shared/Badge';
import { formatUSDC, formatDate, getStatusColor, getStatusLabel } from '../../lib/format';

interface Payment { id: string; payment_intent_id: string; amount: string; status: string; order_id: string | null; created_at: number; environment: string; network: string; }

const STATUSES = ['all', 'requires_payment', 'processing', 'succeeded', 'failed', 'expired', 'cancelled'];

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;

  const load = (s: string, p: number) => {
    const params = s !== 'all' ? `?status=${s}&limit=${PAGE_SIZE}&offset=${p * PAGE_SIZE}` : `?limit=${PAGE_SIZE}&offset=${p * PAGE_SIZE}`;
    api.get<{ data: Payment[]; total: number }>(`/payments${params}`)
      .then(r => { setPayments(r.data); setTotal(r.total); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    load(status, page);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, page]);

  const changeStatus = (s: string) => { setStatus(s); setPage(0); };

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white tracking-tight mb-1" style={{ letterSpacing: '-0.02em' }}>Payments</h1>
        <p className="text-slate-400 text-sm">{total.toLocaleString()} total payments</p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        {STATUSES.map(s => (
          <button key={s} onClick={() => changeStatus(s)}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all capitalize ${status === s ? 'bg-white/10 border-white/20 text-white' : 'bg-white/4 border-white/8 text-slate-500 hover:text-slate-200'}`}>
            {s === 'all' ? 'All' : s.replace('_', ' ')}
          </button>
        ))}
      </div>

      <Card>
        <div className="px-5 py-3 border-b border-white/8 grid grid-cols-12 text-xs font-medium text-slate-500 uppercase tracking-wider">
          <span className="col-span-3">Payment Intent</span>
          <span className="col-span-2">Order</span>
          <span className="col-span-2 text-right">Amount</span>
          <span className="col-span-2 text-center">Status</span>
          <span className="col-span-1 text-center">Env</span>
          <span className="col-span-2 text-right">Date</span>
        </div>

        {loading ? (
          <div className="p-8 text-sm text-slate-500">Loading…</div>
        ) : payments.length === 0 ? (
          <div className="p-16 text-center">
            <CreditCard size={28} className="text-slate-700 mx-auto mb-3" />
            <p className="text-sm text-slate-500">No payments found</p>
          </div>
        ) : (
          <div className="divide-y divide-white/6">
            {payments.map(p => (
              <Link key={p.id} to={`/dashboard/payments/${p.id}`}
                className="grid grid-cols-12 items-center px-5 py-3.5 hover:bg-white/3 transition-all">
                <span className="col-span-3 text-xs font-mono text-slate-400 truncate pr-4">{p.payment_intent_id}</span>
                <span className="col-span-2 text-xs text-slate-500 truncate pr-4">{p.order_id || '—'}</span>
                <span className="col-span-2 text-sm font-semibold text-white tabular-nums text-right pr-4">{formatUSDC(p.amount)}</span>
                <span className="col-span-2 text-center">
                  <Badge className={getStatusColor(p.status)}>{getStatusLabel(p.status)}</Badge>
                </span>
                <span className="col-span-1 text-center">
                  <Badge variant={p.environment === 'live' ? 'error' : 'info'}>{p.environment}</Badge>
                </span>
                <span className="col-span-2 text-xs text-slate-600 text-right">{formatDate(p.created_at)}</span>
              </Link>
            ))}
          </div>
        )}

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="px-6 py-3 border-t border-white/8 flex items-center justify-between">
            <p className="text-xs text-slate-500">{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}</p>
            <div className="flex gap-2">
              <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
                className="px-3 py-1.5 rounded-xl text-xs font-medium bg-white/6 text-slate-300 border border-white/10 disabled:opacity-40 hover:bg-white/10 transition-all">
                Previous
              </button>
              <button disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(p => p + 1)}
                className="px-3 py-1.5 rounded-xl text-xs font-medium bg-white/6 text-slate-300 border border-white/10 disabled:opacity-40 hover:bg-white/10 transition-all">
                Next
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
