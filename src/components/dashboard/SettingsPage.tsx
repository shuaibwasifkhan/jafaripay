import { useEffect, useState } from 'react';
import { Wallet, Save, AlertCircle, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api';
import { Card } from '../shared/Card';
import { Button } from '../shared/Button';
import { useAuth } from '../../lib/auth-context';
import { formatDate } from '../../lib/format';
import { toast } from 'sonner';

interface SettlementWallet { id: string; address: string; environment: 'test' | 'live'; label: string | null; created_at: number; }

function isValidEthAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export default function SettingsPage() {
  const { merchant, refresh } = useAuth();
  const [wallets, setWallets] = useState<SettlementWallet[]>([]);
  const [_loading, setLoading] = useState(true);
  const [name, setName] = useState(merchant?.name || '');
  const [email, setEmail] = useState(merchant?.email || '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [addingWallet, setAddingWallet] = useState<'test' | 'live' | null>(null);
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
    setSavingWallet(true);
    try {
      await api.post('/settlement-wallets', { address: newAddress.trim(), environment: env, label: walletLabel.trim() || null });
      toast.success('Settlement wallet added');
      setAddingWallet(null); setNewAddress(''); setWalletLabel(''); setAddressError('');
      loadWallets();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    } finally { setSavingWallet(false); }
  };

  const testWallet = wallets.find(w => w.environment === 'test');
  const liveWallet = wallets.find(w => w.environment === 'live');

  return (
    <div className="p-8 max-w-xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white tracking-tight mb-1" style={{ letterSpacing: '-0.02em' }}>Settings</h1>
        <p className="text-slate-400 text-sm">Merchant profile and settlement wallets</p>
      </div>

      {/* Profile */}
      <Card className="p-6 mb-6">
        <h2 className="text-sm font-semibold text-slate-300 mb-1">Merchant profile</h2>
        <p className="text-xs text-slate-500 mb-5">Optional display name and email for your own reference</p>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-slate-300 block mb-1.5">Owner wallet</label>
            <div className="px-3.5 py-2.5 rounded-xl bg-white/4 border border-white/6 text-sm font-mono text-slate-400">
              {merchant?.wallet_address || '—'}
            </div>
            <p className="text-xs text-slate-600 mt-1">This is your merchant identity. It cannot be changed.</p>
          </div>
          <div>
            <label className="text-sm font-medium text-slate-300 block mb-1.5">Display name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="My Company"
              className="w-full px-3.5 py-2.5 rounded-xl bg-white/6 border border-white/10 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-300 block mb-1.5">Email (optional)</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="you@yourcompany.com"
              className="w-full px-3.5 py-2.5 rounded-xl bg-white/6 border border-white/10 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
          </div>
          <Button onClick={() => { void saveProfile(); }} loading={savingProfile} size="sm"><Save size={13} /> Save profile</Button>
        </div>
      </Card>

      {/* Settlement wallets */}
      <Card className="p-6">
        <h2 className="text-sm font-semibold text-slate-300 mb-1">Settlement wallets</h2>
        <p className="text-xs text-slate-500 mb-5">USDC is sent directly from customer wallets to your settlement wallet. JafariPay never holds your funds.</p>

        {(['test', 'live'] as const).map(env => {
          const wallet = env === 'test' ? testWallet : liveWallet;
          const isAdding = addingWallet === env;

          return (
            <div key={env} className="mb-5 last:mb-0">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-lg text-xs font-semibold ${env === 'live' ? 'bg-red-500/10 text-red-400' : 'bg-blue-500/10 text-blue-400'}`}>
                    {env.toUpperCase()}
                  </span>
                  <span className="text-sm font-medium text-slate-300">{env === 'test' ? 'Test settlement wallet' : 'Live settlement wallet'}</span>
                </div>
                {!wallet && !isAdding && (
                  <button onClick={() => setAddingWallet(env)} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 py-1 px-2 rounded-lg hover:bg-blue-500/8 transition-all">
                    + Add wallet
                  </button>
                )}
              </div>

              {wallet ? (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-white/4 border border-white/8">
                  <div className="w-7 h-7 rounded-xl bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                    <Wallet size={12} className="text-blue-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-mono text-slate-200">{wallet.address}</p>
                    {wallet.label && <p className="text-xs text-slate-500 mt-0.5">{wallet.label}</p>}
                    <p className="text-xs text-slate-600 mt-0.5">Added {formatDate(wallet.created_at)}</p>
                  </div>
                  <a href={`https://explorer.${env === 'live' ? '' : 'testnet.'}arc.io/address/${wallet.address}`}
                    target="_blank" rel="noopener noreferrer"
                    className="p-1 rounded-md text-slate-500 hover:text-blue-400 hover:bg-blue-500/8">
                    <ExternalLink size={11} />
                  </a>
                </div>
              ) : isAdding ? (
                <div className="p-4 rounded-xl bg-white/4 border border-white/8 space-y-3">
                  <div>
                    <label className="text-xs font-medium text-slate-300 block mb-1">Wallet address</label>
                    <input value={newAddress} onChange={e => { setNewAddress(e.target.value); setAddressError(''); }}
                      placeholder="0x..."
                      className={`w-full px-3 py-2 rounded-lg bg-white/6 border text-xs font-mono text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 ${addressError ? 'border-red-500/50' : 'border-white/10'}`} />
                    {addressError && <p className="text-xs text-red-400 mt-1">{addressError}</p>}
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-300 block mb-1">Label (optional)</label>
                    <input value={walletLabel} onChange={e => setWalletLabel(e.target.value)} placeholder="Main wallet"
                      className="w-full px-3 py-2 rounded-lg bg-white/6 border border-white/10 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" loading={savingWallet} onClick={() => { void addWallet(env); }} className="flex-1">Save wallet</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setAddingWallet(null); setNewAddress(''); setAddressError(''); }}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="p-3 rounded-xl bg-amber-500/4 border border-amber-500/10">
                  <p className="text-xs text-amber-400/70 flex items-center gap-1.5">
                    <AlertCircle size={11} className="text-amber-400" />
                    No {env} settlement wallet configured. Add one to accept {env} payments.
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
