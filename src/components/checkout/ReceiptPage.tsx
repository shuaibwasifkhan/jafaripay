import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Zap, ExternalLink, CheckCircle, Shield, Receipt as ReceiptIcon } from 'lucide-react';
import { formatUSDC } from '../../lib/format';

/**
 * Public customer receipt page (Phase B).
 *
 * Authorized purely by the unguessable capability id in the URL (/receipt/:id)
 * — there is NO session/API-key gate here, so it reads the PUBLIC projection
 * returned by GET /api/receipts/:id. That projection deliberately omits internal
 * linkage (payment_id / merchant_id), so this page can only ever show what
 * belongs on a customer's own receipt. A wrong / revoked / never-issued id is a
 * 404 from the server and simply renders "receipt not found".
 */
interface ReceiptView {
  id: string;
  payment_intent_id: string;
  order_id: string | null;
  merchant_name: string;
  amount: string;
  amount_base_units: string;
  currency: string;
  network: string;
  chain_id: number;
  tx_hash: string;
  explorer_url: string;
  timestamp: number;
  status: string;
  customer_email: string | null;
  email_status: string;
}

type LoadState = { kind: 'loading' } | { kind: 'missing' } | { kind: 'error' } | { kind: 'ok'; r: ReceiptView };

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  // No-id is resolved during render (a route without :id is a hard miss), so the
  // effect below only ever performs async data-fetching state updates.
  const [state, setState] = useState<LoadState>(() => (id ? { kind: 'loading' } : { kind: 'missing' }));

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(`/api/receipts/${id}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) { setState({ kind: 'missing' }); return; }
        if (!res.ok) { setState({ kind: 'error' }); return; }
        setState({ kind: 'ok', r: await res.json() as ReceiptView });
      })
      .catch(() => { if (!cancelled) setState({ kind: 'error' }); });
    return () => { cancelled = true; };
  }, [id]);

  return (
    <div className="min-h-dvh bg-cream flex items-center justify-center px-4 py-12">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-24 -right-24 w-96 h-96 bg-forest-500/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-24 -left-24 w-96 h-96 bg-lilac-500/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm">
        <div className="flex items-center gap-2 justify-center mb-8">
          <div className="w-8 h-8 rounded-xl bg-forest-600 flex items-center justify-center">
            <Zap size={13} fill="white" className="text-white" />
          </div>
          <span className="font-bold text-ink text-base tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>JafariPay</span>
        </div>

        <div className="bg-white rounded-2xl border border-sand-200 overflow-hidden shadow-lift">
          {state.kind === 'loading' && (
            <div className="p-10 flex items-center justify-center text-slate-400 text-sm">Loading receipt…</div>
          )}

          {state.kind === 'missing' && (
            <div className="p-8 text-center">
              <div className="w-14 h-14 rounded-2xl bg-sand-100 flex items-center justify-center mx-auto mb-3">
                <ReceiptIcon size={24} className="text-slate-400" />
              </div>
              <p className="text-lg font-bold text-ink mb-1">Receipt not found</p>
              <p className="text-xs text-slate-500">This receipt link is invalid or was never issued. A receipt is only created after a payment is verified on-chain.</p>
            </div>
          )}

          {state.kind === 'error' && (
            <div className="p-8 text-center">
              <p className="text-lg font-bold text-ink mb-1">Could not load receipt</p>
              <p className="text-xs text-slate-500">Please try again later.</p>
            </div>
          )}

          {state.kind === 'ok' && (() => {
            const r = state.r;
            const dateStr = new Date(r.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
            return (
              <>
                <div className="p-6 border-b border-sand-200">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs text-slate-500">{r.merchant_name || 'Merchant'}</p>
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-forest-700 bg-forest-50 border border-forest-200 rounded-full px-2 py-0.5">
                      <CheckCircle size={11} /> {r.status.toUpperCase()}
                    </span>
                  </div>
                  <p className="text-3xl font-bold text-ink tabular-nums" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
                    {formatUSDC(r.amount)} {r.currency}
                  </p>
                  {r.order_id && <p className="text-xs text-slate-500 mt-1">Order: {r.order_id}</p>}
                </div>

                <div className="p-6 space-y-3">
                  <Row label="Network" value={`${r.network} · chain ${r.chain_id}`} />
                  <Row label="Date" value={dateStr} />
                  <Row label="Payment intent" value={r.payment_intent_id} mono />
                  <Row label="Receipt ID" value={r.id} mono />
                  <div className="flex items-center justify-between py-1">
                    <span className="text-xs text-slate-500">Transaction</span>
                    {r.explorer_url ? (
                      <a href={r.explorer_url} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs font-mono text-forest-700 hover:text-forest-800">
                        <ExternalLink size={11} /> View on explorer
                      </a>
                    ) : (
                      <span className="text-xs font-mono text-slate-400">{shortHash(r.tx_hash)}</span>
                    )}
                  </div>

                  {r.customer_email ? (
                    <p className="text-[11px] text-slate-500 pt-2">
                      {r.email_status === 'sent'
                        ? `A copy was emailed to ${r.customer_email}.`
                        : `A receipt copy will be sent to ${r.customer_email}.`}
                    </p>
                  ) : (
                    <Link to="/login" className="block">
                      <p className="text-[11px] text-slate-500 pt-2">
                        No email on this payment. It lives permanently at this link.
                      </p>
                    </Link>
                  )}

                  <div className="flex items-center gap-2 text-xs text-slate-500 pt-3 border-t border-sand-200">
                    <Shield size={11} />
                    Verified independently on-chain by JafariPay. Non-custodial — USDC went directly to the merchant.
                  </div>
                </div>
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-xs text-slate-500 shrink-0">{label}</span>
      <span className={mono ? 'text-xs font-mono text-slate-700 text-right break-all' : 'text-xs text-slate-700 text-right'}>{value}</span>
    </div>
  );
}

function shortHash(h: string): string {
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}
