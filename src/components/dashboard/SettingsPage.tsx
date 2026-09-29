import { useEffect, useState } from 'react';
import { Wallet, Save, AlertCircle, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api';
import { Card } from '../shared/Card';
import { Button } from '../shared/Button';
import { useAuth } from '../../lib/auth-context';
import { formatDate } from '../../lib/format';
import { getChain } from '@/onchain-facts';
import { toast } from 'sonner';

interface SettlementWallet {
  id: string; address: string; environment: 'test' | 'live' | null; label: string | null;
  network: string; chain_id: number | null; created_at: number;
}

// Selectable networks come from the backend registry (enabled network_configs
// rows) — never a second hardcoded list in the frontend.
interface RegistryNetwork {
  network: string; chain_id: number; environment: 'test' | 'live';
}

function isValidEthAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

// Display name for a registry network: the generated onchain-facts name when the
// chain id is known, otherwise the slug. Unknown chain id never resolves to Arc.
function networkName(n: { network: string; chain_id: number }): string {
  return getChain(n.chain_id)?.name ?? n.network;
}

// Explorer link derived from the onchain-facts registry for the wallet's actual
// chain. Unknown chain (or a network with no frontend fact) → no link, never an
// Arc default. Replaces the old hardcoded `explorer.arc.io` construction.
function addressExplorer(wallet: SettlementWallet): string | null {
  const fact = wallet.chain_id != null ? getChain(wallet.chain_id) : undefined;
  return fact ? `${fact.explorerBase}/address/${wallet.address}` : null;
}

export default function SettingsPage() {
  const { merchant, refresh } = useAuth();
  const [wallets, setWallets] = useState<SettlementWallet[]>([]);
  const [_loading, setLoading] = useState(true);
  const [name, setName] = useState(merchant?.name || '');
  const [email, setEmail] = useState(merchant?.email || '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [addingWallet, setAddingWallet] = useState<'test' | 'live' | null>(null);
  const [networks, setNetworks] = useState<RegistryNetwork[]>([]);
  const [selectedNetwork, setSelectedNetwork] = useState<string>('');
  const [newAddress, setNewAddress] = useState('');
  const [walletLabel, setWalletLabel] = useState('');
  const [addressError, setAddressError] = useState('');
  const [savingWallet, setSavingWallet] = useState(false);

  const loadWallets = () => {
    api.get<{ data: SettlementWallet[] }>('/settlement-wallets')
      .then(d => setWallets(d.data))
      .catch(() => void 0)
      .finally(() => setLoading(false));
  };

  useEffect(loadWallets, []);

  // The picker is registry-driven: enabling a network in network_configs is the
  // only way a new settlement network appears here.
  useEffect(() => {
    api.get<{ data: RegistryNetwork[] }>('/settlement-wallets/networks')
      .then(d => setNetworks(d.data))
      .catch(() => void 0);
  }, []);

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      await api.patch('/auth/profile', { name: name.trim() || null, email: email.trim() || null });
      await refresh();
      toast.success('Profile updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    } finally { setSavingProfile(false); }
  };

  const addWallet = async (env: 'test' | 'live') => {
    if (!isValidEthAddress(newAddress)) { setAddressError('Must be a valid EVM address (0x…)'); return; }
    if (!selectedNetwork) { setAddressError('Select a settlement network'); return; }
    setSavingWallet(true);
    try {
      // network + environment are both sent; the backend refuses a pair that the
      // registry's is_testnet class says cannot go together.
      await api.post('/settlement-wallets', { address: newAddress.trim(), network: selectedNetwork, environment: env, label: walletLabel.trim() || null });
      toast.success('Settlement wallet added');
      setAddingWallet(null); setNewAddress(''); setWalletLabel(''); setAddressError('');
      loadWallets();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    } finally { setSavingWallet(false); }
  };

  const walletsFor = (env: 'test' | 'live') => wallets.filter(w => w.environment === env);

  const startAdding = (env: 'test' | 'live') => {
    const first = networks.find(n => n.environment === env);
    setSelectedNetwork(first?.network ?? '');
    setAddressError('');
    setAddingWallet(env);
  };

  return (
    <div className="p-8 max-w-xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ink tracking-tight mb-1" style={{ letterSpacing: '-0.02em' }}>Settings</h1>
        <p className="text-slate-500 text-sm">Merchant profile and settlement wallets</p>
      </div>

      {/* Profile */}
      <Card className="p-6 mb-6">
        <h2 className="text-sm font-semibold text-ink mb-1">Merchant profile</h2>
        <p className="text-xs text-slate-500 mb-5">Optional display name and email for your own reference</p>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-slate-600 block mb-1.5">Owner wallet</label>
            <div className="px-3.5 py-2.5 rounded-xl bg-sand-100 border border-sand-200 text-sm font-mono text-slate-600">
              {merchant?.wallet_address || '—'}
            </div>
            <p className="text-xs text-slate-500 mt-1">This is your merchant identity. It cannot be changed.</p>
          </div>
          <div>
            <label className="text-sm font-medium text-slate-600 block mb-1.5">Display name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="My Company"
              className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-sand-300 text-sm text-ink placeholder-slate-400 caret-ink focus:outline-none focus:ring-2 focus:ring-forest-500/40" />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-600 block mb-1.5">Email (optional)</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="you@yourcompany.com"
              className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-sand-300 text-sm text-ink placeholder-slate-400 caret-ink focus:outline-none focus:ring-2 focus:ring-forest-500/40" />
          </div>
          <Button onClick={() => { void saveProfile(); }} loading={savingProfile} size="sm"><Save size={13} /> Save profile</Button>
        </div>
      </Card>

      {/* Settlement wallets */}
      <Card className="p-6">
        <h2 className="text-sm font-semibold text-ink mb-1">Settlement wallets</h2>
        <p className="text-xs text-slate-500 mb-5">USDC is sent directly from customer wallets to your settlement wallet. JafariPay never holds your funds.</p>

        {(['test', 'live'] as const).map(env => {
          const envWallets = walletsFor(env);
          const isAdding = addingWallet === env;

          return (
            <div key={env} className="mb-5 last:mb-0">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-lg text-xs font-semibold ${env === 'live' ? 'bg-red-50 text-red-500' : 'bg-forest-50 text-forest-700'}`}>
                    {env.toUpperCase()}
                  </span>
                  <span className="text-sm font-medium text-ink">{env === 'test' ? 'Testnet settlement wallets' : 'Mainnet settlement wallets'}</span>
                </div>
                {!isAdding && (
                  <button onClick={() => startAdding(env)} className="text-xs text-forest-700 hover:text-forest-800 flex items-center gap-1 py-1 px-2 rounded-lg hover:bg-forest-50 transition-all">
                    + Add wallet
                  </button>
                )}
              </div>

              {envWallets.length > 0 && (
                <div className="space-y-2 mb-3">
                  {envWallets.map(wallet => {
                    const href = addressExplorer(wallet);
                    const netName = wallet.chain_id != null ? (getChain(wallet.chain_id)?.name ?? wallet.network) : wallet.network;
                    return (
                      <div key={wallet.id} className="flex items-center gap-2 p-3 rounded-xl bg-sand-100 border border-sand-200">
                        <div className="w-7 h-7 rounded-xl bg-forest-50 flex items-center justify-center flex-shrink-0">
                          <Wallet size={12} className="text-forest-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-mono text-slate-700">{wallet.address}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{netName}{wallet.label ? ` · ${wallet.label}` : ''}</p>
                          <p className="text-xs text-slate-500 mt-0.5">Added {formatDate(wallet.created_at)}</p>
                        </div>
                        {href && (
                          <a href={href} target="_blank" rel="noopener noreferrer"
                            className="p-1 rounded-md text-slate-500 hover:text-forest-700 hover:bg-forest-50">
                            <ExternalLink size={11} />
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {isAdding ? (
                <div className="p-4 rounded-xl bg-sand-100 border border-sand-200 space-y-3">
                  <div>
                    <label className="text-xs font-medium text-slate-600 block mb-1">Settlement network</label>
                    <select value={selectedNetwork} onChange={e => setSelectedNetwork(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-white border border-sand-300 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-forest-500/40">
                      {networks.filter(n => n.environment === env).map(n => (
                        <option key={n.network} value={n.network}>{networkName(n)} · {n.chain_id}</option>
                      ))}
                      {networks.filter(n => n.environment === env).length === 0 && (
                        <option value="">No enabled {env} network</option>
                      )}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-600 block mb-1">Wallet address</label>
                    <input value={newAddress} onChange={e => { setNewAddress(e.target.value); setAddressError(''); }}
                      placeholder="0x..."
                      className={`w-full px-3 py-2 rounded-lg bg-white border text-xs font-mono text-ink placeholder-slate-400 caret-ink focus:outline-none focus:ring-2 focus:ring-forest-500/40 ${addressError ? 'border-red-300' : 'border-sand-300'}`} />
                    {addressError && <p className="text-xs text-red-600 mt-1">{addressError}</p>}
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-600 block mb-1">Label (optional)</label>
                    <input value={walletLabel} onChange={e => setWalletLabel(e.target.value)} placeholder="Main wallet"
                      className="w-full px-3 py-2 rounded-lg bg-white border border-sand-300 text-xs text-ink placeholder-slate-400 caret-ink focus:outline-none focus:ring-2 focus:ring-forest-500/40" />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" loading={savingWallet} onClick={() => { void addWallet(env); }} className="flex-1">Save wallet</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setAddingWallet(null); setNewAddress(''); setAddressError(''); }}>Cancel</Button>
                  </div>
                </div>
              ) : envWallets.length === 0 ? (
                <div className="p-3 rounded-xl bg-gold-50 border border-gold-200">
                  <p className="text-xs text-gold-700/80 flex items-center gap-1.5">
                    <AlertCircle size={11} className="text-gold-600" />
                    No {env} settlement wallet configured. Add one to accept {env} payments.
                  </p>
                </div>
              ) : null}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
