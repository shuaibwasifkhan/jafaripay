import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Copy, Check, ShieldCheck, Clock } from 'lucide-react';
import { api } from '../../lib/api';
import { Card } from '../shared/Card';
import { Badge } from '../shared/Badge';
import { formatUSDC, formatDate, getStatusColor, getStatusLabel } from '../../lib/format';
import { toast } from 'sonner';

interface Payment {
  id: string;
  payment_intent_id: string;
  amount: string;
  status: string;
  order_id: string | null;
  description: string | null;
  metadata: string | null;
  environment: string;
  network: string;
  settlement_address: string;
  expires_at: number;
  created_at: number;
  verified_at: number;
  blockchain_transaction: {
    tx_hash: string;
    block_number: number;
    from_address: string;
    network: string;
  } | null;
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    toast.success(`${label} copied`);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
        <div className="flex items-center gap-2">
      <span className="text-xs font-mono text-slate-600 break-all">{value}</span>
      <button onClick={() => { void copy(); }} className="flex-shrink-0 p-1 rounded-md text-slate-400 hover:text-ink hover:bg-sand-100">
        {copied ? <Check size={11} className="text-forest-600" /> : <Copy size={11} />}
      </button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-sand-200/70 last:border-0">
      <span className="text-xs font-medium text-slate-500 flex-shrink-0 w-36">{label}</span>
      <div className="flex-1 text-right">{children}</div>
    </div>
  );
}

export default function PaymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [payment, setPayment] = useState<Payment | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.get<Payment>(`/payments/${id}`)
      .then(p => setPayment(p))
      .catch(err => { if ((err as { status?: number }).status === 404) setNotFound(true); })
      .finally(() => setLoading(false));
  }, [id]);

  const explorerBase = payment?.network === 'arc_mainnet'
    ? 'https://explorer.arc.io'
    : 'https://explorer.testnet.arc.io';

  if (loading) return <div className="p-8 text-sm text-slate-500">Loading…</div>;
  if (notFound || !payment) return (
    <div className="p-8">
            <Link to="/dashboard/payments" className="flex items-center gap-2 text-sm text-slate-500 hover:text-ink mb-6">
        <ArrowLeft size={14} /> Back to payments
      </Link>
      <p className="text-slate-500">Payment not found</p>
    </div>
  );

  return (
    <div className="p-8 max-w-2xl">
            <Link to="/dashboard/payments" className="flex items-center gap-2 text-sm text-slate-500 hover:text-ink mb-6 w-fit">
        <ArrowLeft size={14} /> Back to payments
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-ink mb-1 tabular-nums" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
            {formatUSDC(payment.amount)} USDC
          </h1>
          <p className="text-xs font-mono text-slate-500">{payment.payment_intent_id}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={payment.environment === 'live' ? 'error' : 'info'}>{payment.environment}</Badge>
          <Badge className={getStatusColor(payment.status)}>{getStatusLabel(payment.status)}</Badge>
        </div>
      </div>

      {/* Details */}
      <Card className="p-5 mb-4">
                <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Payment details</h2>
        <Row label="Payment ID"><CopyField value={payment.id} label="Payment ID" /></Row>
        <Row label="Payment intent"><CopyField value={payment.payment_intent_id} label="Intent ID" /></Row>
        {payment.order_id && <Row label="Order ID"><span className="text-xs text-slate-600">{payment.order_id}</span></Row>}
        {payment.description && <Row label="Description"><span className="text-xs text-slate-600">{payment.description}</span></Row>}
        <Row label="Amount"><span className="text-xs font-semibold text-ink tabular-nums">{formatUSDC(payment.amount)} USDC</span></Row>
        <Row label="Status"><Badge className={getStatusColor(payment.status)}>{getStatusLabel(payment.status)}</Badge></Row>
        <Row label="Network"><span className="text-xs text-slate-600">{payment.network.replace('_', ' ')}</span></Row>
        <Row label="Environment"><Badge variant={payment.environment === 'live' ? 'error' : 'info'}>{payment.environment}</Badge></Row>
        <Row label="Settlement wallet"><CopyField value={payment.settlement_address} label="Settlement address" /></Row>
        <Row label="Expires"><span className="text-xs text-slate-500">{formatDate(payment.expires_at)}</span></Row>
        <Row label="Created"><span className="text-xs text-slate-500">{formatDate(payment.created_at)}</span></Row>
      </Card>

      {/* Blockchain transaction */}
      {payment.blockchain_transaction ? (
                <Card className="p-5 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <ShieldCheck size={13} className="text-forest-600" />
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Verified on-chain</h2>
          </div>
          <Row label="Transaction hash">
            <div className="flex items-center gap-2 justify-end">
              <span className="text-xs font-mono text-slate-600 truncate max-w-36">{payment.blockchain_transaction.tx_hash.slice(0, 18)}…</span>
              <a href={`${explorerBase}/tx/${payment.blockchain_transaction.tx_hash}`} target="_blank" rel="noopener noreferrer"
                className="p-1 rounded-md text-forest-700 hover:text-forest-800 hover:bg-forest-50 flex-shrink-0">
                <ExternalLink size={11} />
              </a>
            </div>
          </Row>
          <Row label="Sender"><CopyField value={payment.blockchain_transaction.from_address} label="Sender" /></Row>
          <Row label="Block"><span className="text-xs text-slate-600 tabular-nums">{payment.blockchain_transaction.block_number.toLocaleString()}</span></Row>
          <Row label="Verified at"><span className="text-xs text-slate-500">{formatDate(payment.verified_at)}</span></Row>
        </Card>
      ) : payment.status === 'succeeded' ? null : (
        <Card className="p-5 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock size={13} className="text-slate-500" />
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Awaiting blockchain transaction</h2>
          </div>
          <p className="text-xs text-slate-600">No on-chain transaction recorded yet. The customer has not completed payment.</p>
        </Card>
      )}

      {/* Metadata */}
      {payment.metadata && payment.metadata !== '{}' && (
        <Card className="p-5">
                    <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Metadata</h2>
          <pre className="text-xs font-mono text-slate-600 overflow-x-auto">{JSON.stringify(JSON.parse(payment.metadata), null, 2)}</pre>
        </Card>
      )}
    </div>
  );
}
