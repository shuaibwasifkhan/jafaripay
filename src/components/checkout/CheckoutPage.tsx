import { useEffect, useReducer, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useAccount, useSwitchChain, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi';
import { ConnectKitButton } from 'connectkit';
import { erc20Abi } from 'viem';
import { Zap, ExternalLink, Shield, CheckCircle, AlertCircle, Clock, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { getUsdc, buildTxExplorerUrl, buildAddressExplorerUrl, ONCHAIN_CHAINS } from '@/onchain-facts';
import { Amount, usdcDecimalsFor } from '@/onchain-money';
import { formatAddress, formatUSDC } from '../../lib/format';

const ARC_TESTNET_ID = 5042002; // arc-studio-allow-onchain-literal
const ARC_MAINNET_ID = 5042;    // arc-studio-allow-onchain-literal

interface PaymentIntent {
  id: string; status: string; amount: string; amount_base_units: string;
  currency: string; network: string; chain_id: number;
  settlement_address: string; expires_at: number;
  merchant_name: string | null; order_id: string | null; description: string | null;
}

type CheckoutStep = 'loading' | 'ready' | 'wallet-sign' | 'confirming' | 'verifying' | 'succeeded' | 'failed' | 'expired' | 'cancelled';

interface State {
  step: CheckoutStep;
  intent: PaymentIntent | null;
  txHash: string | undefined;
  verifyError: string | null;
  nowSec: number;
}

type Action =
  | { type: 'LOADED'; intent: PaymentIntent }
  | { type: 'LOAD_FAILED' }
  | { type: 'PAY' }
  | { type: 'TX_HASH'; hash: string }
  | { type: 'CONFIRMING' }
  | { type: 'VERIFYING'; hash: string }
  | { type: 'SUCCEEDED' }
  | { type: 'FAILED'; error: string }
  | { type: 'EXPIRED' }
  | { type: 'TICK'; nowSec: number };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'LOADED': {
      const st = a.intent.status;
      const step: CheckoutStep = st === 'succeeded' ? 'succeeded'
        : st === 'expired' ? 'expired'
        : st === 'cancelled' ? 'cancelled'
        : 'ready';
      return { ...s, intent: a.intent, step };
    }
    case 'LOAD_FAILED': return { ...s, step: 'failed', verifyError: 'Could not load payment' };
    case 'PAY':         return { ...s, step: 'wallet-sign' };
    case 'TX_HASH':     return { ...s, txHash: a.hash, step: 'confirming' };
    case 'CONFIRMING':  return { ...s, step: 'confirming' };
    case 'VERIFYING':   return { ...s, txHash: a.hash, step: 'verifying' };
    case 'SUCCEEDED':   return { ...s, step: 'succeeded' };
    case 'FAILED':      return { ...s, step: 'failed', verifyError: a.error };
    case 'EXPIRED':     return { ...s, step: 'expired' };
    case 'TICK':        return { ...s, nowSec: a.nowSec };
    default:            return s;
  }
}

export default function CheckoutPage() {
  const { id } = useParams<{ id: string }>();
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  const [state, dispatch] = useReducer(reducer, undefined, (): State => ({
    step: 'loading', intent: null, txHash: undefined, verifyError: null,
    nowSec: Math.floor(Date.now() / 1000),
  }));
  const { step, intent, txHash, verifyError, nowSec } = state;

  // Fetch payment intent
  useEffect(() => {
    if (!id) return;
    fetch(`/api/checkout/${id}`)
      .then(r => r.json() as Promise<PaymentIntent & { error?: string }>)
      .then(pi => { if (pi.error) { dispatch({ type: 'LOAD_FAILED' }); } else { dispatch({ type: 'LOADED', intent: pi }); } })
      .catch(() => dispatch({ type: 'LOAD_FAILED' }));
  }, [id]);

  // Tick every 5s for expiry countdown
  useEffect(() => {
    const t = setInterval(() => dispatch({ type: 'TICK', nowSec: Math.floor(Date.now() / 1000) }), 5000);
    return () => clearInterval(t);
  }, []);

  const chainId = intent?.chain_id ?? ARC_TESTNET_ID;
  const usdcFact = getUsdc(chainId);

  const chain = useMemo(
    () => ONCHAIN_CHAINS.find(c => c.chainId === chainId) ?? null,
    [chainId]
  );

  // USDC balance
  const { data: usdcBalance } = useReadContract({
    address: usdcFact?.address as `0x${string}` | undefined,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: !!address && !!usdcFact },
  });

  const formattedBalance = usdcBalance != null
    ? Amount.fromRaw(usdcBalance, usdcDecimalsFor(chainId)).toFixed(2)
    : null;

  const isWrongChain = isConnected && walletChainId !== chainId;

  // Write contract
  const { writeContract, data: hash, isPending: isWalletPending, error: writeError } = useWriteContract();
  const { isSuccess: isOnchain } = useWaitForTransactionReceipt({ hash });

  // Backend verification loop
  const verifyingRef = useRef(false);
  const verifyPayment = useCallback(async (txh: string) => {
    if (verifyingRef.current) return;
    verifyingRef.current = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise<void>(r => setTimeout(r, 3000));
      try {
        const res = await fetch(`/api/checkout/${id}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tx_hash: txh, chain_id: chainId }),
        });
        const data = await res.json() as { status?: string; error?: string };

        // Terminal outcomes — stop polling immediately.
        if (data.status === 'succeeded') { dispatch({ type: 'SUCCEEDED' }); verifyingRef.current = false; return; }
        if (data.status === 'expired') { dispatch({ type: 'EXPIRED' }); verifyingRef.current = false; return; }
        if (data.status === 'failed') { dispatch({ type: 'FAILED', error: data.error ?? 'Verification failed' }); verifyingRef.current = false; return; }

        // Permanent HTTP errors (e.g. 400 malformed tx_hash / wrong_network, 422 verification
        // failure) must NOT be retried — surface them instead of waiting indefinitely.
        if (res.status === 400 || res.status === 422) {
          dispatch({ type: 'FAILED', error: data.error ?? 'Payment verification failed' });
          verifyingRef.current = false; return;
        }
        // Otherwise (e.g. status 'processing' — tx not yet confirmed) keep polling.
      } catch { /* network/RPC transient error — keep polling */ }
    }
    dispatch({ type: 'FAILED', error: 'Verification timed out. Contact the merchant with your transaction hash.' });
    verifyingRef.current = false;
  }, [id, chainId]);

  // React to wagmi tx hash appearing — use ref to avoid re-running on step changes
  const prevHash = useRef<string | undefined>();
  useEffect(() => {
    if (hash && hash !== prevHash.current) {
      prevHash.current = hash;
      dispatch({ type: 'TX_HASH', hash });
    }
  }, [hash]);

  // React to onchain confirmation
  const prevOnchain = useRef(false);
  useEffect(() => {
    if (isOnchain && !prevOnchain.current && hash) {
      prevOnchain.current = true;
      dispatch({ type: 'VERIFYING', hash });
      void verifyPayment(hash);
    }
  }, [isOnchain, hash, verifyPayment]);

  // React to write error
  const prevWriteError = useRef<Error | null>(null);
  useEffect(() => {
    if (writeError && writeError !== prevWriteError.current && step === 'wallet-sign') {
      prevWriteError.current = writeError;
      const msg = writeError.message.toLowerCase();
      if (msg.includes('user rejected') || msg.includes('denied')) {
        dispatch({ type: 'LOADED', intent: intent! }); // reset to ready
      } else {
        dispatch({ type: 'FAILED', error: writeError.message });
      }
    }
  }, [writeError, step, intent]);

  const handlePay = () => {
    if (!intent || !usdcFact || !isConnected) return;
    dispatch({ type: 'PAY' });
    writeContract({
      address: usdcFact.address as `0x${string}`,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [intent.settlement_address as `0x${string}`, BigInt(intent.amount_base_units)],
      chainId,
    });
  };

  const expirySecs = intent?.expires_at != null ? intent.expires_at - nowSec : null;
  const isExpired = expirySecs !== null && expirySecs <= 0;
  const networkName = chainId === ARC_MAINNET_ID ? 'Arc' : 'Arc Testnet';
  const explorerTx = useMemo(() => txHash ? buildTxExplorerUrl(chainId, txHash) : null, [txHash, chainId]);
  const explorerSettlement = useMemo(() => intent ? buildAddressExplorerUrl(chainId, intent.settlement_address) : null, [intent, chainId]);

  // Unused var suppressor for chain (used conditionally below)
  void chain;

  return (
        <div className="min-h-dvh bg-cream flex items-center justify-center px-4 py-12">
      {/* Background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-24 -right-24 w-96 h-96 bg-forest-500/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-24 -left-24 w-96 h-96 bg-lilac-500/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center gap-2 justify-center mb-8">
          <div className="w-8 h-8 rounded-xl bg-forest-600 flex items-center justify-center">
            <Zap size={13} fill="white" className="text-white" />
          </div>
          <span className="font-bold text-ink text-base tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>JafariPay</span>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-sand-200 overflow-hidden shadow-lift">
          {/* Header */}
          <div className="p-6 border-b border-sand-200">
            {step === 'loading' ? (
              <div className="flex items-center justify-center h-16">
                <Loader2 className="animate-spin text-forest-600" size={20} />
              </div>
            ) : intent ? (
              <>
                <p className="text-xs text-slate-500 mb-1">{intent.merchant_name || 'Merchant'}</p>
                <p className="text-3xl font-bold text-ink tabular-nums" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
                  {formatUSDC(intent.amount)} USDC
                </p>
                {intent.description && <p className="text-sm text-slate-600 mt-1">{intent.description}</p>}
                {intent.order_id && <p className="text-xs text-slate-500 mt-0.5">Order: {intent.order_id}</p>}
                <div className="flex items-center gap-1.5 mt-3">
                  <span className="w-2 h-2 rounded-full bg-forest-500" />
                  <span className="text-xs text-slate-500">{networkName} · USDC</span>
                </div>
              </>
            ) : null}
          </div>

          {/* Body */}
          <div className="p-6 space-y-4">
            {/* Succeeded */}
            {step === 'succeeded' && (
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="w-14 h-14 rounded-2xl bg-forest-100 flex items-center justify-center">
                  <CheckCircle size={24} className="text-forest-600" />
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-ink mb-1">Payment complete</p>
                  <p className="text-xs text-slate-500">USDC received and verified on-chain</p>
                </div>
                {txHash && explorerTx && (
                  <a href={explorerTx} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-forest-700 hover:text-forest-800">
                    <ExternalLink size={11} /> View transaction
                  </a>
                )}
              </div>
            )}

            {/* Failed */}
            {step === 'failed' && (
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center">
                  <AlertCircle size={24} className="text-red-500" />
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-ink mb-1">Payment failed</p>
                  <p className="text-xs text-slate-500">{verifyError ?? 'Something went wrong'}</p>
                </div>
              </div>
            )}

            {/* Expired / Cancelled */}
            {(step === 'expired' || step === 'cancelled') && (
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="w-14 h-14 rounded-2xl bg-sand-100 flex items-center justify-center">
                  <Clock size={24} className="text-slate-400" />
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-ink mb-1">{step === 'expired' ? 'Payment expired' : 'Payment cancelled'}</p>
                  <p className="text-xs text-slate-500">This payment link is no longer active.</p>
                </div>
              </div>
            )}

            {/* Verifying */}
            {step === 'verifying' && (
              <div className="flex flex-col items-center gap-3 py-4">
                <Loader2 className="animate-spin text-forest-600" size={24} />
                <div className="text-center">
                  <p className="text-sm font-semibold text-ink mb-1">Verifying payment</p>
                  <p className="text-xs text-slate-500">Confirming on-chain transfer…</p>
                  {txHash && explorerTx && (
                    <a href={explorerTx} target="_blank" rel="noopener noreferrer"
                      className="flex items-center justify-center gap-1.5 text-xs text-forest-700 hover:text-forest-800 mt-2">
                      <ExternalLink size={11} /> View on explorer
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Confirming onchain */}
            {step === 'confirming' && (
              <div className="flex flex-col items-center gap-3 py-4">
                <Loader2 className="animate-spin text-forest-600" size={24} />
                <div className="text-center">
                  <p className="text-sm font-semibold text-ink mb-1">Waiting for confirmation</p>
                  <p className="text-xs text-slate-500">Transaction submitted — waiting for block…</p>
                  {txHash && explorerTx && (
                    <a href={explorerTx} target="_blank" rel="noopener noreferrer"
                      className="flex items-center justify-center gap-1.5 text-xs text-forest-700 hover:text-forest-800 mt-2">
                      <ExternalLink size={11} /> View on explorer
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Ready / wallet-sign — main payment UI */}
            {(step === 'ready' || step === 'wallet-sign') && intent && (
              <>
                {/* Expiry */}
                {expirySecs !== null && expirySecs > 0 && expirySecs < 600 && (
                  <div className="flex items-center gap-2 text-xs text-gold-700 bg-gold-50 border border-gold-200 rounded-xl px-3 py-2">
                    <Clock size={11} />
                    Expires in {Math.floor(expirySecs / 60)}m {expirySecs % 60}s
                  </div>
                )}
                {isExpired && (
                  <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                    <AlertCircle size={11} /> This payment has expired
                  </div>
                )}

                {/* Wallet section */}
                {!isConnected ? (
                  <ConnectKitButton.Custom>
                    {({ show }) => (
                      <button onClick={show}
                        className="w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl bg-forest-700 text-white font-semibold text-sm hover:bg-forest-600 shadow-soft transition-all">
                        Connect Wallet to Pay
                      </button>
                    )}
                  </ConnectKitButton.Custom>
                ) : (
                  <div className="space-y-3">
                    {/* Connected wallet info */}
                    <div className="flex items-center justify-between p-3 rounded-xl bg-sand-100 border border-sand-200">
                      <div>
                        <p className="text-xs text-slate-500 mb-0.5">Connected wallet</p>
                        <p className="text-sm font-mono text-slate-700">{formatAddress(address!)}</p>
                        {formattedBalance !== null && (
                          <p className="text-xs text-slate-500 mt-0.5">{formattedBalance} USDC</p>
                        )}
                      </div>
                      <ConnectKitButton.Custom>
                        {({ show }) => (
                          <button onClick={show} className="text-xs text-slate-500 hover:text-ink transition-colors">
                            Change
                          </button>
                        )}
                      </ConnectKitButton.Custom>
                    </div>

                    {/* Wrong network warning */}
                    {isWrongChain && (
                      <div className="flex items-center justify-between p-3 rounded-xl bg-gold-50 border border-gold-200">
                        <div className="flex items-center gap-2">
                          <AlertCircle size={13} className="text-gold-600" />
                          <p className="text-xs text-gold-800">Switch to {networkName}</p>
                        </div>
                        <button
                          onClick={() => switchChain({ chainId })}
                          disabled={isSwitching}
                          className="text-xs font-medium text-gold-700 hover:text-gold-800 disabled:opacity-50 transition-colors"
                        >
                          {isSwitching ? 'Switching…' : 'Switch'}
                        </button>
                      </div>
                    )}

                    {/* Settlement address */}
                    <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-sand-100/60 border border-sand-200">
                      <p className="text-xs text-slate-500">Sending to</p>
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs font-mono text-slate-600">{formatAddress(intent.settlement_address)}</p>
                        {explorerSettlement && (
                          <a href={explorerSettlement} target="_blank" rel="noopener noreferrer">
                            <ExternalLink size={10} className="text-slate-400 hover:text-ink" />
                          </a>
                        )}
                      </div>
                    </div>

                    {/* Pay button */}
                    <button
                      onClick={handlePay}
                      disabled={!isConnected || isWrongChain || isExpired || step === 'wallet-sign' || isWalletPending}
                      className={clsx(
                        'w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl font-semibold text-sm transition-all',
                        isWrongChain || isExpired
                          ? 'bg-sand-300 text-slate-400 cursor-not-allowed'
                          : step === 'wallet-sign' || isWalletPending
                          ? 'bg-forest-600/50 text-white/70 cursor-wait'
                          : 'bg-forest-700 hover:bg-forest-600 text-white active:scale-[0.98] shadow-soft'
                      )}
                    >
                      {step === 'wallet-sign' || isWalletPending
                        ? <><Loader2 className="animate-spin" size={14} /> Waiting for wallet…</>
                        : `Pay ${formatUSDC(intent.amount)} USDC`}
                    </button>
                  </div>
                )}
              </>
            )}

            {/* Security note */}
            {(step === 'ready' || step === 'wallet-sign') && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Shield size={11} />
                Non-custodial. USDC goes directly to merchant. JafariPay never holds funds.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
