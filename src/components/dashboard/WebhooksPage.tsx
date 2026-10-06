import { useEffect, useState } from 'react';
import { Webhook, Plus, Trash2, CheckCircle, XCircle, AlertCircle, RotateCcw, Copy, KeyRound } from 'lucide-react';
import { api } from '../../lib/api';
import { Card } from '../shared/Card';
import { Button } from '../shared/Button';
import { Badge } from '../shared/Badge';
import { formatDate } from '../../lib/format';
import { toast } from 'sonner';

interface WebhookEndpoint {
  id: string;
  url: string;
  enabled: boolean;
  events: string;
  secret_preview: string;
  created_at: number;
}

interface Delivery {
  id: string;
  endpoint_id: string;
  event_type: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  created_at: number;
  last_attempted_at: number | null;
  next_retry_at: number | null;
}

// PHASE 12: the two cross-chain lifecycle events are subscribable alongside the
// legacy set; the backend (webhooks.ts VALID_EVENTS + delivery.ts) already gates
// and signs them through the identical, tenant/environment-scoped path.
const EVENT_TYPES = [
  'payment.created', 'payment.processing', 'payment.succeeded', 'payment.failed', 'payment.expired',
  'payment.cross_chain.attestation_received', 'payment.cross_chain.failed',
];

export default function WebhooksPage() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'endpoints' | 'deliveries'>('endpoints');
  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>(['payment.succeeded']);
  const [saving, setSaving] = useState(false);
  const [urlError, setUrlError] = useState('');
  // Reveal-once: the raw signing secret is only ever available immediately after
  // create/rotate. We keep it in component state (never persisted) until the
  // merchant dismisses the banner; then it is gone from the UI forever.
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);

  const load = () => {
    Promise.all([
      api.get<{ data: WebhookEndpoint[] }>('/webhook-endpoints').then(d => setEndpoints(d.data)),
      api.get<{ data: Delivery[] }>('/webhook-deliveries').then(d => setDeliveries(d.data)),
    ]).catch(() => void 0).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const validateUrl = (u: string) => {
    try {
      const parsed = new URL(u);
      if (!['https:', 'http:'].includes(parsed.protocol)) { setUrlError('Must be http or https'); return false; }
      if (['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname)) { setUrlError('Private/local URLs not allowed'); return false; }
      setUrlError(''); return true;
    } catch { setUrlError('Invalid URL'); return false; }
  };

  const create = async () => {
    if (!validateUrl(url)) return;
    if (selectedEvents.length === 0) { toast.error('Select at least one event'); return; }
    setSaving(true);
    try {
      const res = await api.post<{ secret?: string }>('/webhook-endpoints', { url: url.trim(), events: selectedEvents, enabled: true });
      toast.success('Webhook endpoint created');
      if (res.secret) setRevealedSecret(res.secret);
      setCreating(false); setUrl(''); setSelectedEvents(['payment.succeeded']);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    } finally { setSaving(false); }
  };

  const rotateSecret = async (id: string) => {
    if (!confirm('Rotate this endpoint\'s signing secret? The old secret will stop working immediately and any in-flight deliveries signed with it will fail verification.')) return;
    setRotating(true);
    try {
      const res = await api.post<{ secret?: string }>(`/webhook-endpoints/${id}/rotate-secret`);
      toast.success('Signing secret rotated');
      if (res.secret) setRevealedSecret(res.secret);
      load();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed'); }
    finally { setRotating(false); }
  };

  const copySecret = async () => {
    if (!revealedSecret) return;
    try { await navigator.clipboard.writeText(revealedSecret); toast.success('Secret copied'); }
    catch { toast.error('Copy failed — select and copy manually'); }
  };

  const deleteEndpoint = async (id: string) => {
    if (!confirm('Delete this webhook endpoint?')) return;
    try {
      await api.delete(`/webhook-endpoints/${id}`);
      toast.success('Endpoint deleted');
      load();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed'); }
  };

  const retry = async (id: string) => {
    try {
      await api.post(`/webhook-deliveries/${id}/retry`);
      toast.success('Retry queued');
      load();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed'); }
  };

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink tracking-tight mb-1" style={{ letterSpacing: '-0.02em' }}>Webhooks</h1>
          <p className="text-slate-500 text-sm">Receive signed events when payments change state</p>
        </div>
        {tab === 'endpoints' && <Button onClick={() => setCreating(true)} size="sm"><Plus size={14} /> Add endpoint</Button>}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-sand-100 p-1 rounded-xl w-fit">
        {(['endpoints', 'deliveries'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium capitalize transition-all ${tab === t ? 'bg-white text-ink shadow-soft' : 'text-slate-500 hover:text-ink'}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'endpoints' && (
        <>
          {revealedSecret && (
            <Card className="p-5 mb-6 border-gold-300 bg-gold-50">
              <div className="flex items-start gap-3">
                <KeyRound size={18} className="text-gold-700 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <h2 className="text-sm font-semibold text-ink mb-1">Copy your signing secret now — it is shown only once</h2>
                  <p className="text-xs text-slate-600 mb-3">Store it in your environment now. JafariPay keeps only an encrypted copy for signing and can never display it again. If you lose it, rotate to get a new one.</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 min-w-0 truncate px-3 py-2 rounded-lg bg-white border border-gold-200 text-xs font-mono text-ink">{revealedSecret}</code>
                    <Button size="sm" variant="secondary" onClick={() => { void copySecret(); }}><Copy size={13} /> Copy</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRevealedSecret(null)}>Done</Button>
                  </div>
                </div>
              </div>
            </Card>
          )}
          {creating && (
            <Card className="p-6 mb-6">
              <h2 className="text-sm font-semibold text-ink mb-4">New webhook endpoint</h2>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-slate-600 block mb-1.5">Endpoint URL</label>
                  <input value={url} onChange={e => { setUrl(e.target.value); validateUrl(e.target.value); }}
                    placeholder="https://yourapp.com/webhooks/jafaripay"
                    className={`w-full px-3.5 py-2.5 rounded-xl bg-white border text-sm text-ink placeholder-slate-400 caret-ink focus:outline-none focus:ring-2 focus:ring-forest-500/40 ${urlError ? 'border-red-300' : 'border-sand-300'}`} />
                  {urlError && <p className="text-xs text-red-600 mt-1">{urlError}</p>}
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-600 block mb-2">Events to send</label>
                  <div className="space-y-2">
                    {EVENT_TYPES.map(e => (
                      <label key={e} className="flex items-center gap-2.5 cursor-pointer">
                        <input type="checkbox" checked={selectedEvents.includes(e)}
                          onChange={ev => setSelectedEvents(p => ev.target.checked ? [...p, e] : p.filter(x => x !== e))}
                          className="accent-forest-600" />
                        <code className="text-xs text-slate-600">{e}</code>
                        {e === 'payment.succeeded' && <span className="text-xs text-gold-700 bg-gold-100 px-1.5 py-0.5 rounded-md">recommended</span>}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex items-start gap-2 p-3 rounded-xl bg-forest-50 border border-forest-200">
                  <AlertCircle size={12} className="text-forest-600 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-forest-700/80">A webhook signing secret will be generated. Verify HMAC-SHA256 signatures on every delivery. See the Developers tab for example code.</p>
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => { void create(); }} loading={saving} className="flex-1">Create endpoint</Button>
                  <Button variant="ghost" onClick={() => { setCreating(false); setUrl(''); }}>Cancel</Button>
                </div>
              </div>
            </Card>
          )}

          <Card>
            {loading ? (
              <div className="p-6 text-sm text-slate-500">Loading…</div>
            ) : endpoints.length === 0 ? (
              <div className="p-16 text-center">
                <Webhook size={28} className="text-slate-300 mx-auto mb-3" />
                <p className="text-slate-500 text-sm">No webhook endpoints</p>
              </div>
            ) : (
              <div className="divide-y divide-sand-200/70">
                {endpoints.map(ep => (
                  <div key={ep.id} className="px-6 py-4">
                    <div className="flex items-start gap-4">
                      <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${ep.enabled ? 'bg-forest-500' : 'bg-slate-300'}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-ink font-medium truncate">{ep.url}</p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {(JSON.parse(ep.events) as string[]).join(', ')}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Secret: <code className="text-slate-400">…{ep.secret_preview}</code> · Created {formatDate(ep.created_at)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { void rotateSecret(ep.id); }} disabled={rotating} title="Rotate signing secret" className="text-slate-400 hover:text-forest-700 p-1.5 rounded-lg hover:bg-forest-50 transition-all disabled:opacity-50">
                          <KeyRound size={13} />
                        </button>
                        <button onClick={() => { void deleteEndpoint(ep.id); }} className="text-slate-400 hover:text-red-500 p-1.5 rounded-lg hover:bg-red-50 transition-all">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {tab === 'deliveries' && (
        <Card>
          {loading ? (
            <div className="p-6 text-sm text-slate-500">Loading…</div>
          ) : deliveries.length === 0 ? (
            <div className="p-16 text-center">
              <Webhook size={28} className="text-slate-300 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">No webhook deliveries</p>
            </div>
          ) : (
            <div className="divide-y divide-sand-200/70">
              {deliveries.map(d => (
                <div key={d.id} className="flex items-center gap-4 px-6 py-3.5">
                  {d.status === 'delivered'
                    ? <CheckCircle size={14} className="text-forest-600 flex-shrink-0" />
                    : d.status === 'failed'
                      ? <XCircle size={14} className="text-red-500 flex-shrink-0" />
                      : <AlertCircle size={14} className="text-gold-600 flex-shrink-0" />
                  }
                  <div className="flex-1 min-w-0">
                    <code className="text-xs text-slate-600">{d.event_type}</code>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Attempt {d.attempts} · {formatDate(d.created_at)}
                      {d.next_retry_at && d.status !== 'delivered' && ` · Retry at ${formatDate(d.next_retry_at)}`}
                    </p>
                  </div>
                  <Badge variant={d.status === 'delivered' ? 'success' : d.status === 'failed' ? 'error' : 'warning'}>
                    {d.status}
                  </Badge>
                  {d.status === 'failed' && (
                    <button onClick={() => { void retry(d.id); }} className="text-slate-500 hover:text-forest-700 p-1.5 rounded-lg hover:bg-forest-50 transition-all">
                      <RotateCcw size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
