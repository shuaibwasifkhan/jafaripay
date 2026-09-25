import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ConnectKitButton } from 'connectkit';
import { useAccount, useSignMessage } from 'wagmi';
import { Zap, ShieldCheck, Wallet, AlertCircle } from 'lucide-react';
import { Button } from '../shared/Button';
import { useAuth } from '../../lib/auth-context';
import { api } from '../../lib/api';
import { useDisconnect } from 'wagmi';
import { toast } from 'sonner';

export default function AuthPage() {
  const navigate = useNavigate();
  const { merchant, setMerchant, setSessionToken } = useAuth();
  const { address, isConnected, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (merchant) void navigate('/dashboard');
  }, [merchant, navigate]);

  const handleAuth = async () => {
    if (!address || !isConnected) return;
    setSigning(true);
    setError('');
    try {
      // Step 1: Get a nonce from the server
      const { nonce } = await api.get<{ nonce: string }>(`/auth/nonce?address=${address}`);

      // Step 2: Build EIP-4361 SIWE message
      const domain = window.location.host;
      const issuedAt = new Date().toISOString();
      const expirationTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const message = [
        `${domain} wants you to sign in with your Ethereum account:`,
        address,
        '',
        'Sign in to JafariPay. Accept USDC payments with a few lines of code.',
        '',
        `URI: ${window.location.origin}`,
        'Version: 1',
        `Chain ID: ${chainId ?? 5042002}`,
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt}`,
        `Expiration Time: ${expirationTime}`,
      ].join('\n');

      // Step 3: Sign with wallet
      const signature = await signMessageAsync({ message });

      // Step 4: Verify on backend, get session
      const { merchant: m, token } = await api.post<{ merchant: { id: string; wallet_address: string; name: string | null; email: string | null; created_at: number }; token: string }>(
        '/auth/verify',
        { message, signature, address }
      );

      // Write merchant + token to sessionStorage BEFORE navigation.
      // DashboardGuard reads sessionStorage on mount — this survives React Router
      // navigation AND hard reloads within the same browser tab session.
      try {
        sessionStorage.setItem('jp_merchant', JSON.stringify(m));
      } catch { /* ignore quota errors */ }
      // Also save token to localStorage for API calls
      try {
        localStorage.setItem('jp_session_token', token || '');
      } catch { /* ignore */ }
      if (token) setSessionToken(token);
      setMerchant(m);
      toast.success('Signed in successfully');
      void navigate('/dashboard');
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes('user rejected')) {
        setError('Signature cancelled.');
      } else {
        setError(err instanceof Error ? err.message : 'Authentication failed');
      }
    } finally {
      setSigning(false);
    }
  };

  return (
        <div className="min-h-dvh bg-cream flex items-center justify-center p-6" style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <div className="w-full max-w-sm">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2 justify-center mb-10">
          <div className="w-9 h-9 rounded-2xl bg-forest-600 flex items-center justify-center">
            <Zap size={16} fill="white" className="text-white" />
          </div>
          <span className="font-bold text-ink text-xl tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>JafariPay</span>
        </Link>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-sand-200 shadow-lift p-8">
          <div className="text-center mb-8">
            <h1 className="text-xl font-bold text-ink mb-2" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
              Sign in to JafariPay
            </h1>
            <p className="text-sm text-slate-500 text-pretty">Connect your wallet to access your merchant dashboard</p>
          </div>

          {/* Connect wallet step */}
          <div className="space-y-4">
            {!isConnected ? (
              <div className="flex flex-col items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-sand-100 border border-sand-200 flex items-center justify-center">
                  <Wallet size={20} className="text-slate-500" />
                </div>
                <div className="text-center mb-2">
                  <p className="text-sm font-medium text-ink mb-1">Step 1: Connect your wallet</p>
                  <p className="text-xs text-slate-500">Use MetaMask or any EIP-1193 compatible wallet</p>
                </div>
                <ConnectKitButton.Custom>
                  {({ show }) => (
                    <button
                      onClick={show}
                      className="w-full flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl bg-forest-700 text-white font-semibold text-sm hover:bg-forest-600 shadow-soft transition-all"
                    >
                      <Wallet size={15} /> Connect Wallet
                    </button>
                  )}
                </ConnectKitButton.Custom>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-forest-50 border border-forest-200 flex items-center justify-center">
                  <ShieldCheck size={20} className="text-forest-600" />
                </div>
                <div className="text-center mb-1">
                  <p className="text-sm font-medium text-ink mb-1">Step 2: Sign in message</p>
                  <p className="text-xs font-mono text-slate-500 break-all">{address?.slice(0, 6)}...{address?.slice(-4)}</p>
                  <p className="text-xs text-slate-500 mt-1.5">No transaction, no gas. Read-only proof of ownership.</p>
                </div>
                <Button onClick={() => { void handleAuth(); }} loading={signing} className="w-full" size="lg">
                  Sign in with wallet
                </Button>
                <button
                  onClick={() => { disconnect(); }}
                  className="text-xs text-slate-500 hover:text-ink transition-colors underline underline-offset-2"
                >
                  Use a different wallet
                </button>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200">
                <AlertCircle size={13} className="text-red-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-red-700">{error}</p>
              </div>
            )}
          </div>
        </div>

        {/* Trust note */}
        <p className="text-center text-xs text-slate-600 mt-6 leading-relaxed">
          No email. No password. Your wallet address is your identity.<br />
          JafariPay never requests private keys or seed phrases.
        </p>
      </div>
    </div>
  );
}
