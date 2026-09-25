import { useEffect, useState } from 'react';
import { Key, Plus, Trash2, Copy, Check, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { Card } from '../shared/Card';
import { Button } from '../shared/Button';
import { Badge } from '../shared/Badge';
import { formatDate } from '../../lib/format';
import { toast } from 'sonner';

interface ApiKey { id: string; prefix: string; key_preview: string; type: 'public' | 'secret'; environment: 'test' | 'live'; label: string | null; created_at: number; last_used_at: number | null; }
interface CreatedKey { id: string; full_key: string; type: string; environment: string; label: string | null; }

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [env, setEnv] = useState<'test' | 'live'>('test');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [newKey, setNewKey] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => {
    api.get<{ data: ApiKey[] }>('/api-keys')
      .then(d => { setKeys(d.data); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const create = async () => {
    setSaving(true);
    try {
      const res = await api.post<{ public_key: CreatedKey; secret_key: CreatedKey }>('/api-keys', { environment: env, label: label.trim() || null });
      setNewKey(res.secret_key);
      toast.success('API key pair created');
      setCreating(false); setLabel('');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create key');
    } finally { setSaving(false); }
  };

  const revoke = async (id: string) => {
    if (!confirm('Revoke this API key? This cannot be undone.')) return;
    try {
      await api.delete(`/api-keys/${id}`);
      toast.success('API key revoked');
      load();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed'); }
  };

  const copyKey = async (key: string) => {
    await navigator.clipboard.writeText(key);
    setCopied(true);
    toast.success('Key copied — store it securely, it will not be shown again');
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink tracking-tight mb-1" style={{ letterSpacing: '-0.02em' }}>API Keys</h1>
          <p className="text-slate-500 text-sm">Manage test and live API credentials</p>
        </div>
        <Button onClick={() => setCreating(true)} size="sm"><Plus size={14} /> Create keys</Button>
      </div>

      {/* Security note */}
            <div className="flex items-start gap-2 p-3 rounded-xl bg-gold-50 border border-gold-200 mb-6">
        <ShieldCheck size={13} className="text-gold-600 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-xs font-semibold text-gold-800 mb-0.5">Keep secret keys safe</p>
          <p className="text-xs text-gold-700/70">Secret keys (<code className="text-gold-700">sk_</code>) are only shown once. Store them in environment variables. Never expose them in frontend code or commit them to source control.</p>
        </div>
      </div>

      {/* New key reveal */}
      {newKey && (
        <div className="p-5 rounded-2xl bg-forest-50 border border-forest-200 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <ShieldCheck size={13} className="text-forest-600" />
            <p className="text-xs font-semibold text-forest-800">New secret key — copy it now, it will not be shown again</p>
          </div>
          <div className="flex items-center gap-2 bg-sand-100 rounded-xl p-3">
            <code className="flex-1 text-xs font-mono text-slate-700 break-all">{newKey.full_key}</code>
            <button onClick={() => { void copyKey(newKey.full_key); }} className="flex-shrink-0 p-1.5 rounded-lg text-slate-500 hover:text-ink hover:bg-sand-200">
              {copied ? <Check size={14} className="text-forest-600" /> : <Copy size={14} />}
            </button>
          </div>
          <button onClick={() => setNewKey(null)} className="text-xs text-slate-500 hover:text-ink mt-3">Dismiss</button>
        </div>
      )}

      {/* Create form */}
      {creating && (
        <Card className="p-6 mb-6">
          <h2 className="text-sm font-semibold text-ink mb-4">Create API key pair</h2>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-slate-600 block mb-1.5">Environment</label>
              <div className="flex gap-2">
                {(['test', 'live'] as const).map(e => (
                  <button key={e} onClick={() => setEnv(e)}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-all ${env === e ? 'bg-forest-50 border-forest-300 text-forest-800' : 'bg-white border-sand-300 text-slate-500 hover:text-ink'}`}>
                    {e === 'test' ? 'Test' : 'Live'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-600 block mb-1.5">Label (optional)</label>
              <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Production server"
                className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-sand-300 text-sm text-ink placeholder-slate-400 caret-ink focus:outline-none focus:ring-2 focus:ring-forest-500/40" />
            </div>
            <p className="text-xs text-slate-500">This will create both a publishable (<code className="text-slate-400">pk_{env}_</code>) and secret (<code className="text-slate-400">sk_{env}_</code>) key pair.</p>
            <div className="flex gap-2">
              <Button onClick={() => { void create(); }} loading={saving} className="flex-1">Create key pair</Button>
              <Button variant="ghost" onClick={() => { setCreating(false); setLabel(''); }}>Cancel</Button>
            </div>
          </div>
        </Card>
      )}

      <Card>
        {loading ? (
          <div className="p-6 text-sm text-slate-500">Loading…</div>
        ) : keys.length === 0 ? (
          <div className="p-16 text-center">
            <Key size={28} className="text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500 text-sm">No API keys yet</p>
          </div>
        ) : (
          <div className="divide-y divide-sand-200/70">
            {keys.map(k => (
              <div key={k.id} className="flex items-center gap-4 px-6 py-4">
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${k.type === 'secret' ? 'bg-red-50 border border-red-200' : 'bg-forest-50 border border-forest-200'}`}>
                  <Key size={12} className={k.type === 'secret' ? 'text-red-500' : 'text-forest-600'} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono text-slate-600">{k.prefix}…{k.key_preview}</code>
                    <Badge variant={k.environment === 'live' ? 'error' : 'info'}>{k.environment}</Badge>
                    <Badge variant={k.type === 'secret' ? 'warning' : 'info'}>{k.type}</Badge>
                  </div>
                  {k.label && <p className="text-xs text-slate-500 mt-0.5">{k.label}</p>}
                  <p className="text-xs text-slate-600 mt-0.5">
                    Created {formatDate(k.created_at)}
                    {k.last_used_at && ` · Last used ${formatDate(k.last_used_at)}`}
                  </p>
                </div>
                <button onClick={() => { void revoke(k.id); }} className="text-slate-400 hover:text-red-500 p-1.5 rounded-lg hover:bg-red-50 transition-all">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
