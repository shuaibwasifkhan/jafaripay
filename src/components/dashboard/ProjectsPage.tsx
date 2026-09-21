import { useEffect, useState } from 'react';
import { Layers, Plus, AlertCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { Card } from '../shared/Card';
import { Button } from '../shared/Button';
import { Badge } from '../shared/Badge';
import { formatDate } from '../../lib/format';
import { toast } from 'sonner';

interface Project { id: string; name: string; description: string | null; environment: 'test' | 'live'; created_at: number; }

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [env, setEnv] = useState<'test' | 'live'>('test');
  const [saving, setSaving] = useState(false);

  const load = () => {
    api.get<{ data: Project[] }>('/projects')
      .then(d => { setProjects(d.data); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.post('/projects', { name: name.trim(), description: desc.trim() || null, environment: env });
      toast.success('Project created');
      setCreating(false); setName(''); setDesc('');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create project');
    } finally { setSaving(false); }
  };

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight mb-1" style={{ letterSpacing: '-0.02em' }}>Projects</h1>
          <p className="text-slate-400 text-sm">Separate test and live environments per project</p>
        </div>
        <Button onClick={() => setCreating(true)} size="sm"><Plus size={14} /> New project</Button>
      </div>

      {creating && (
        <Card className="p-6 mb-6">
          <h2 className="text-sm font-semibold text-slate-200 mb-4">New project</h2>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-slate-300 block mb-1.5">Project name</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="My Store"
                className="w-full px-3.5 py-2.5 rounded-xl bg-white/6 border border-white/10 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-300 block mb-1.5">Description (optional)</label>
              <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="E-commerce store"
                className="w-full px-3.5 py-2.5 rounded-xl bg-white/6 border border-white/10 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-300 block mb-1.5">Environment</label>
              <div className="flex gap-2">
                {(['test', 'live'] as const).map(e => (
                  <button key={e} onClick={() => setEnv(e)}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-all ${env === e ? 'bg-blue-500/10 border-blue-500/30 text-blue-400' : 'bg-white/4 border-white/10 text-slate-400'}`}>
                    {e === 'test' ? 'Test' : 'Live'}
                  </button>
                ))}
              </div>
            </div>
            {env === 'live' && (
              <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/6 border border-amber-500/15">
                <AlertCircle size={12} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-300">Live projects process real USDC on Arc Mainnet. Make sure <code>ENABLE_LIVE_PAYMENTS=true</code> is set in production.</p>
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={() => { void create(); }} loading={saving} className="flex-1">Create project</Button>
              <Button variant="ghost" onClick={() => { setCreating(false); setName(''); setDesc(''); }}>Cancel</Button>
            </div>
          </div>
        </Card>
      )}

      <Card>
        {loading ? (
          <div className="p-6 text-sm text-slate-500">Loading…</div>
        ) : projects.length === 0 ? (
          <div className="p-16 text-center">
            <Layers size={28} className="text-slate-700 mx-auto mb-3" />
            <p className="text-slate-500 text-sm">No projects yet</p>
            <p className="text-xs text-slate-600 mt-1">Create a project to organize your API keys and payments</p>
          </div>
        ) : (
          <div className="divide-y divide-white/6">
            {projects.map(p => (
              <div key={p.id} className="flex items-center gap-4 px-6 py-4">
                <div className="w-9 h-9 rounded-xl bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                  <Layers size={14} className="text-blue-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-slate-200">{p.name}</p>
                    <Badge variant={p.environment === 'live' ? 'error' : 'info'}>{p.environment}</Badge>
                  </div>
                  {p.description && <p className="text-xs text-slate-500 mt-0.5">{p.description}</p>}
                  <p className="text-xs text-slate-600 mt-0.5">Created {formatDate(p.created_at)}</p>
                </div>
                <p className="text-xs font-mono text-slate-600">{p.id.slice(0, 12)}…</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
