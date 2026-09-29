import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Zap, Clock, CheckCircle, AlertCircle, Loader2, Shield } from 'lucide-react';
import { formatUSDC } from '../../lib/format';

/**
 * Public "pay this link" landing page (Phase C — Payment Links).
 *
 * Capability-gated by the unguessable link id in the URL. It shows the merchant's
 * fixed charge and, when payable, mints a concrete Payment Intent from the LINK's
 * stored amount (never from anything the browser sends) and hands off to the
 * normal hosted checkout. This page holds NO money logic — the authoritative
 * amount/network/expiry/already-paid checks all run server-side in
 * POST /api/pay/:id/create; here we only surface the outcome.
 */
interface LinkInfo {
  id: string; merchant_name: string; amount: string; currency: string;
  description: string; order_id: string | null; expires_at: number | null;
  status: string; expired: boolean; paid: boolean; payable: boolean;
  error?: string;
}

type Load = { kind: 'loading' } | { kind: 'missing' } | { kind: 'ok'; info: LinkInfo };

export default function PayLinkPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>(() => (id ? { kind: 'loading' } : { kind: 'missing' }));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(`/api/pay/${id}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) { setLoad({ kind: 'missing' }); return; }
        setLoad({ kind: 'ok', info: await res.json() as LinkInfo });
      })
      .catch(() => { if (!cancelled) setLoad({ kind: 'missing' }); });
    return () => { cancelled = true; };
  }, [id]);

  const startCheckout = async () => {
    if (!id) return;
    setSubmitting(true);
    setError(null);
    try {
      // NOTE: nothing about the charge is sent from here — the server pins the
      // amount/network from the link row. This request only says "I want to pay".
      const res = await fetch(`/api/pay/${id}/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json() as { checkout_url?: string; id?: string; error?: string; code?: string };
      if (res.ok && data.id) {
        // checkout_url is `${CHECKOUT_BASE}/checkout/:id`; navigate within the SPA.
        navigate(`/checkout/${data.id}`);
        return;
      }
      setError(data.error || 'Could not start this payment.');
    } catch {
      setError('Network error — please retry.');
    } finally {
      setSubmitting(false);
    }
  };

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
          {load.kind === 'loading' && (
            <div className="p-10 flex items-center justify-center">
              <Loader2 className="animate-spin text-forest-600" size={20} />
            </div>
          )}

          {load.kind === 'missing' && (
            <div className="p-8 text-center">
              <div className="w-14 h-14 rounded-2xl bg-sand-100 flex items-center justify-center mx-auto mb-3">
                <AlertCircle size={24} className="text-slate-400" />
              </div>
              <p className="text-lg font-bold text-ink mb-1">Link not found</p>
              <p className="text-xs text-slate-500">This payment link is invalid. Please ask the merchant for a new one.</p>
            </div>
          )}

          {load.kind === 'ok' && (() => {
            const info = load.info;
            return (
              <>
                <div className="p-6 border-b border-sand-200">
                  <p className="text-xs text-slate-500 mb-1">{info.merchant_name || 'Merchant'}</p>
                  <p className="text-3xl font-bold text-ink tabular-nums" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
                    {formatUSDC(info.amount)} {info.currency}
                  </p>
                  {info.description && <p className="text-sm text-slate-600 mt-1">{info.description}</p>}
                  {info.order_id && <p className="text-xs text-slate-500 mt-0.5">Order: {info.order_id}</p>}
                </div>

                <div className="p-6 space-y-4">
                  {info.paid ? (
                    <Terminal icon={<CheckCircle size={24} className="text-forest-600" />} bg="bg-forest-100"
                      title="Already paid" body="This payment link has already been settled. No further charge is possible." />
                  ) : info.expired || info.status !== 'active' ? (
                    <Terminal icon={<Clock size={24} className="text-slate-400" />} bg="bg-sand-100"
                      title={info.status === 'disabled' ? 'Unavailable' : 'Link expired'}
                      body={info.status === 'disabled' ? 'The merchant disabled this payment link.' : 'This payment link is no longer active.'} />
                  ) : (
                    <>
                      {error && (
                        <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                          <AlertCircle size={11} /> {error}
                        </div>
                      )}
                      <button
                        onClick={startCheckout}
                        disabled={submitting || !info.payable}
                        className="w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl font-semibold text-sm bg-forest-700 hover:bg-forest-600 text-white active:scale-[0.98] shadow-soft transition-all disabled:opacity-60"
                      >
                        {submitting
                          ? <><Loader2 className="animate-spin" size={14} /> Preparing checkout…</>
                          : `Pay ${formatUSDC(info.amount)} ${info.currency}`}
                      </button>
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <Shield size={11} />
                        Non-custodial USDC checkout on the merchant's configured network.
                      </div>
                    </>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

function Terminal({ icon, bg, title, body }: { icon: React.ReactNode; bg: string; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <div className={`w-14 h-14 rounded-2xl ${bg} flex items-center justify-center`}>{icon}</div>
      <div className="text-center">
        <p className="text-lg font-bold text-ink mb-1">{title}</p>
        <p className="text-xs text-slate-500">{body}</p>
      </div>
    </div>
  );
}
