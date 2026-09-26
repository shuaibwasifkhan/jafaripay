import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Bot,
  CheckCircle,
  ChevronRight,
  Coins,
  Copy,
  Globe,
  Link2,
  Repeat,
  Receipt,
  Shield,
  ShieldCheck,
  Wallet,
  Zap,
} from 'lucide-react';

type ShowcaseStatus = 'Live' | 'Coming' | 'Exploring' | 'Future';

type Slide = {
  id: string;
  title: string;
  status: ShowcaseStatus;
  url: string;
  body: ReactNode | null;
  supporting: string;
  floating?: { title: string; sub: string };
};

const STATUS_BADGE: Record<ShowcaseStatus, string> = {
  Live: 'text-forest-700 bg-forest-50 border-forest-200',
  Coming: 'text-slate-600 bg-sand-100 border-sand-300',
  Exploring: 'text-teal-700 bg-teal-50 border-teal-200',
  Future: 'text-gold-700 bg-gold-50 border-gold-200',
};

function StatusBadge({ status }: { status: ShowcaseStatus }) {
  return (
    <span className={`text-[9px] font-bold uppercase tracking-wider rounded-full border px-1.5 py-0.5 ${STATUS_BADGE[status]}`}>
      {status}
    </span>
  );
}

/* ---------- shared slide structure ---------- */

function SlideHeader({ icon, title, badge }: { icon: ReactNode; title: string; badge?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 mb-4">
      <div className="w-8 h-8 rounded-lg bg-forest-600 flex items-center justify-center flex-shrink-0">
        {icon}
      </div>
      <p className="text-[13px] font-semibold text-ink truncate">{title}</p>
      {badge && <span className="ml-auto flex-shrink-0">{badge}</span>}
    </div>
  );
}

function RowList({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between p-2.5 rounded-lg bg-white border border-sand-200 mb-1.5">
      {children}
    </div>
  );
}

function RowLabel({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] text-slate-400">{label}</p>
      <p className="text-xs font-medium text-ink truncate">{value}</p>
      {hint && <p className="text-[10px] text-slate-400 truncate">{hint}</p>}
    </div>
  );
}

/* ---------- slide 1 · Live Checkout ---------- */

function CheckoutBody() {
  return (
    <>
      <SlideHeader
        icon={<Zap size={14} fill="white" className="text-white" />}
        title="JafariPay Checkout"
        badge={
          <span className="text-[10px] font-semibold text-forest-700 bg-forest-50 border border-forest-200 rounded-full px-2 py-0.5">
            USDC · Arc
          </span>
        }
      />
      <p className="text-2xl sm:text-3xl font-bold text-ink tabular-nums mb-3" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
        1.00 USDC
      </p>
      <RowList>
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-lg bg-sand-100 border border-sand-200 flex items-center justify-center flex-shrink-0">
            <Wallet size={11} className="text-slate-500" />
          </div>
          <RowLabel label="Connected wallet" value="0x••••••••••64c7" />
        </div>
        <span className="text-[10px] font-mono text-slate-400 flex-shrink-0">on Arc</span>
      </RowList>
      <div className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-forest-700 text-white text-xs font-semibold shadow-soft mb-1.5">
        Pay 1.00 USDC
      </div>
      <div className="flex items-center gap-2 p-2.5 rounded-lg bg-forest-50 border border-forest-200">
        <CheckCircle size={12} className="text-forest-600 flex-shrink-0" />
        <p className="text-[11px] font-medium text-forest-800">On-chain confirmed</p>
      </div>
    </>
  );
}

/* ---------- slide 2 · Payment Links ---------- */

function PaymentLinkBody() {
  return (
    <>
      <SlideHeader
        icon={<Link2 size={14} className="text-white" />}
        title="Payment Link"
        badge={
          <span className="text-[10px] font-semibold text-ink/70 bg-white border border-sand-300 rounded-full px-2 py-0.5">
            Accept USDC anywhere
          </span>
        }
      />
      <div className="flex items-center gap-2 p-2.5 rounded-lg bg-sand-100/70 border border-sand-200 mb-1.5">
        <span className="text-[11px] font-mono text-slate-600 truncate flex-1">jafari.co.in/pay/lnk_8s2v</span>
        <span className="text-xs font-bold text-ink tabular-nums flex-shrink-0">25.00 USDC</span>
      </div>
      <div className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-white border border-sand-300 text-ink text-xs font-semibold">
        <Copy size={12} className="text-slate-400" aria-hidden="true" /> Copy payment link
      </div>
      <div className="flex items-center gap-2 p-2.5 rounded-lg bg-forest-50 border border-forest-200">
        <CheckCircle size={12} className="text-forest-600 flex-shrink-0" />
        <p className="text-[11px] font-medium text-forest-800">Ready to share</p>
      </div>
    </>
  );
}

/* ---------- slide 3 · Invoices ---------- */

function InvoiceBody({ paid }: { paid: boolean }) {
  return (
    <>
      <SlideHeader
        icon={<Receipt size={14} className="text-white" />}
        title="Invoice #INV-1042"
        badge={<span className="text-[10px] font-semibold text-slate-500">Order #1042</span>}
      />
      <RowList>
        <RowLabel label="Customer" value="Acme Studio" />
        <span className="text-[10px] text-slate-400">USDC · Arc</span>
      </RowList>
      <p className="text-2xl sm:text-3xl font-bold text-ink tabular-nums mb-1.5" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
        250.00 USDC
      </p>
      <div
        className={`flex items-center gap-2 p-2.5 rounded-lg border transition-colors duration-500 ${
          paid ? 'bg-forest-50 border-forest-200' : 'bg-sand-100/70 border-sand-200'
        }`}
        role="status"
      >
        {paid ? (
          <>
            <CheckCircle size={12} className="text-forest-600 flex-shrink-0" />
            <p className="text-[11px] font-medium text-forest-800">
              Paid <span aria-hidden="true">✓</span>
            </p>
          </>
        ) : (
          <>
            <span className="w-2 h-2 rounded-full bg-gold-500" aria-hidden="true" />
            <p className="text-[11px] font-medium text-slate-600">Pending</p>
          </>
        )}
      </div>
    </>
  );
}

/* ---------- slide 4 · Recurring Billing ---------- */

function RecurringBody() {
  return (
    <>
      <SlideHeader
        icon={<Repeat size={14} className="text-white" />}
        title="Recurring Billing"
        badge={<span className="text-[10px] font-semibold text-slate-500">Pro Plan</span>}
      />
      <p className="text-2xl sm:text-3xl font-bold text-ink tabular-nums mb-3" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
        19.00 USDC <span className="text-sm font-semibold text-slate-400">/ month</span>
      </p>
      <RowList>
        <RowLabel label="Status" value="Active" />
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-forest-500" aria-hidden="true" />
          <span className="text-[10px] font-medium text-forest-700">Active</span>
        </span>
      </RowList>
      <RowList>
        <RowLabel label="Next payment" value="Oct 26" />
        <Coins size={12} className="text-slate-400" aria-hidden="true" />
      </RowList>
    </>
  );
}

/* ---------- slide 5 · Multi-chain USDC ---------- */

function MultiChainBody() {
  return (
    <>
      <SlideHeader
        icon={<Globe size={14} className="text-white" />}
        title="USDC Payment"
        badge={<span className="text-[10px] font-semibold text-slate-500 tabular-nums">100.00 USDC</span>}
      />
      <div className="flex items-center gap-1.5 mb-1.5">
        <div className="flex-1 p-2.5 rounded-lg bg-white border border-sand-200 min-w-0">
          <p className="text-[10px] text-slate-400">Source</p>
          <p className="text-xs font-semibold text-ink">Ethereum</p>
        </div>
        <ChevronRight size={13} className="text-forest-600 flex-shrink-0" aria-hidden="true" />
        <div className="flex-1 p-2.5 rounded-lg bg-teal-50 border border-teal-200 min-w-0">
          <p className="text-[10px] text-teal-600">Settle</p>
          <p className="text-xs font-semibold text-ink">Arc</p>
        </div>
      </div>
      <div className="flex items-center gap-2 p-2.5 rounded-lg bg-forest-50 border border-forest-200">
        <CheckCircle size={12} className="text-forest-600 flex-shrink-0" />
        <p className="text-[11px] font-medium text-forest-800">Settlement completed</p>
      </div>
    </>
  );
}

/* ---------- slide 6 · Agent Payments ---------- */

function AgentBody() {
  return (
    <>
      <SlideHeader
        icon={<Bot size={14} className="text-white" />}
        title="AI Agent Payment"
        badge={<span className="text-[10px] font-semibold text-slate-500">Shopping Agent</span>}
      />
      <RowList>
        <RowLabel label="Request" value="12.40 USDC" />
        <Bot size={11} className="text-slate-400" aria-hidden="true" />
      </RowList>
      <div className="p-2.5 rounded-lg bg-white border border-sand-200 mb-1.5">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[10px] text-slate-400">Budget</p>
          <p className="text-[10px] font-mono text-slate-500 tabular-nums">12.40 / 50.00 USDC</p>
        </div>
        <div className="h-1 rounded-full bg-sand-200 overflow-hidden">
          <div className="h-full rounded-full bg-forest-500" style={{ width: '25%' }} />
        </div>
      </div>
      <div className="flex items-center gap-2 p-2.5 rounded-lg bg-forest-50 border border-forest-200">
        <ShieldCheck size={12} className="text-forest-600 flex-shrink-0" />
        <p className="text-[11px] font-medium text-forest-800">
          Policy: Approved <span aria-hidden="true">✓</span>
        </p>
      </div>
    </>
  );
}

/* ---------- slide 7 · Payment Firewall ---------- */

const FIREWALL_CHECKS = [
  'Amount limit',
  'Approved recipient',
  'Duplicate check',
  'Agent budget',
  'Payment policy',
];

function FirewallBody() {
  return (
    <>
      <SlideHeader
        icon={<Shield size={14} className="text-white" />}
        title="Payment Firewall"
        badge={<span className="text-[10px] font-semibold text-slate-500">Policy engine</span>}
      />
      <div className="mb-1.5">
        {FIREWALL_CHECKS.map((item) => (
          <div key={item} className="flex items-center gap-2 py-1.5">
            <CheckCircle size={12} className="text-forest-600 flex-shrink-0" aria-hidden="true" />
            <span className="text-[11px] text-ink">{item}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 p-2.5 rounded-lg bg-forest-50 border border-forest-200">
        <ShieldCheck size={12} className="text-forest-600 flex-shrink-0" />
        <p className="text-[11px] font-medium text-forest-800">Payment approved</p>
      </div>
    </>
  );
}

/* ---------- slides ---------- */

const SLIDES: Slide[] = [
  {
    id: 'checkout',
    title: 'Live Checkout',
    status: 'Live',
    url: 'checkout.jafari.co.in/pay/pi_9f4k2',
    body: <CheckoutBody />,
    supporting: 'Non-custodial. USDC goes directly to the merchant.',
    floating: { title: 'Payment verified', sub: 'USDC · Arc · On-chain confirmed' },
  },
  {
    id: 'payment-links',
    title: 'Payment Links',
    status: 'Coming',
    url: 'jafari.co.in/pay/lnk_8s2v',
    body: <PaymentLinkBody />,
    supporting: 'Create a simple payment link for customers.',
    floating: { title: 'Ready to share', sub: 'Payment link · planned' },
  },
  {
    id: 'invoices',
    title: 'Invoices',
    status: 'Coming',
    url: 'jafari.co.in/invoices/INV-1042',
    body: null,
    supporting: 'Create and track USDC invoices.',
    floating: { title: 'Invoice tracking', sub: 'USDC · planned' },
  },
  {
    id: 'recurring',
    title: 'Recurring Billing',
    status: 'Exploring',
    url: 'jafari.co.in/billing/pro',
    body: <RecurringBody />,
    supporting: 'Programmable recurring USDC payments.',
    floating: { title: 'Subscriptions', sub: 'USDC / month · exploring' },
  },
  {
    id: 'multi-chain',
    title: 'Multi-chain USDC',
    status: 'Exploring',
    url: 'jafari.co.in/settlement/usdc',
    body: <MultiChainBody />,
    supporting: 'Accept supported-chain USDC and settle to Arc.',
    floating: { title: 'Cross-chain', sub: 'Ethereum → Arc · exploring' },
  },
  {
    id: 'agent-payments',
    title: 'Agent Payments',
    status: 'Exploring',
    url: 'jafari.co.in/agents/shopping',
    body: <AgentBody />,
    supporting: 'Let agents pay within defined limits.',
    floating: { title: 'Payment authorized', sub: 'Within agent budget · exploring' },
  },
  {
    id: 'firewall',
    title: 'Payment Firewall',
    status: 'Future',
    url: 'jafari.co.in/policies/firewall',
    body: <FirewallBody />,
    supporting: 'Control how payments are allowed to move.',
    floating: { title: 'Payment approved', sub: 'Policy engine · future' },
  },
];

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

const ROTATE_MS = 3500;

export function HeroShowcase() {
  const [active, setActive] = useState(0);
  const [hovering, setHovering] = useState(false);
  const [invoicePaid, setInvoicePaid] = useState(false);
  const reduced = usePrefersReducedMotion();

  /* auto-rotate — paused on hover, disabled with reduced motion */
  useEffect(() => {
    if (reduced || hovering) return;
    const t = window.setTimeout(() => setActive((a) => (a + 1) % SLIDES.length), ROTATE_MS);
    return () => window.clearTimeout(t);
  }, [active, hovering, reduced]);

  /* invoice slide: Pending → Paid mid-slide */
  useEffect(() => {
    if (active !== 2) {
      setInvoicePaid(false);
      return;
    }
    if (reduced) {
      setInvoicePaid(true);
      return;
    }
    const t = window.setTimeout(() => setInvoicePaid(true), 1400);
    return () => window.clearTimeout(t);
  }, [active, reduced]);

  const slideCls = (i: number) => {
    if (i === active) return 'opacity-100 translate-x-0 z-10';
    if (i < active) return 'opacity-0 -translate-x-4 z-0 pointer-events-none';
    return 'opacity-0 translate-x-4 z-0 pointer-events-none';
  };

  const transitionCls = reduced
    ? 'transition-none'
    : 'transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]';

  const jump = (i: number) => setActive(i);

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (i + 1) % SLIDES.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (i - 1 + SLIDES.length) % SLIDES.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = SLIDES.length - 1;
        break;
      case 'Enter':
      case ' ':
        next = i;
        break;
      default:
        return;
    }
    e.preventDefault();
    jump(next);
    requestAnimationFrame(() => e.currentTarget.focus());
  };

  return (
    <div
      className="relative max-w-sm mx-auto lg:mx-0"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      aria-roledescription="carousel"
      aria-label="JafariPay product showcase"
    >
      {/* Floating status card */}
      <div
        key={`float-${active}`}
        className={`absolute -top-4 -right-3 sm:-right-4 z-10 bg-white rounded-2xl border border-sand-200 shadow-lift px-4 py-3 ${
          reduced ? 'transition-none' : 'animate-[heroFade_0.5s_ease-out]'
        }`}
      >
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-forest-50 flex items-center justify-center">
            <CheckCircle size={13} className="text-forest-600" />
          </div>
          <div>
            <p className="text-xs font-semibold text-ink leading-tight">{SLIDES[active].floating?.title}</p>
            <p className="text-[10px] text-slate-500 leading-tight">{SLIDES[active].floating?.sub}</p>
          </div>
        </div>
      </div>

      {/* Browser frame */}
      <div className="relative bg-white rounded-3xl border border-sand-200 shadow-lift overflow-hidden">
        <div className="px-5 py-3 border-b border-sand-200 flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-sand-300" aria-hidden="true" />
          <div className="w-2 h-2 rounded-full bg-sand-300" aria-hidden="true" />
          <div className="w-2 h-2 rounded-full bg-sand-300" aria-hidden="true" />
          <span className="ml-2 text-[11px] text-slate-400 truncate">{SLIDES[active].url}</span>
          <span className="ml-auto flex-shrink-0">
            <StatusBadge status={SLIDES[active].status} />
          </span>
        </div>

        <div className="relative h-[350px]">
          {SLIDES.map((s, i) => (
            <div
              key={s.id}
              id={`hero-slide-${s.id}`}
              role="group"
              aria-roledescription="slide"
              aria-label={`${s.title} — ${s.status}`}
              aria-hidden={i !== active}
              className={`absolute inset-0 p-5 ${slideCls(i)} ${transitionCls}`}
            >
              <div className="h-full flex flex-col">
                <div className="flex-1 min-h-0 pb-3">{i === 2 ? <InvoiceBody paid={invoicePaid} /> : s.body}</div>
                <div className="pt-3 border-t border-sand-100 flex items-center gap-2 text-[11px] text-slate-500">
                  <ShieldCheck size={11} className="text-forest-600 flex-shrink-0" aria-hidden="true" />
                  <p>{s.supporting}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Indicators */}
      <div
        className="mt-5 flex items-center justify-center gap-1.5"
        role="tablist"
        aria-label="Showcase capabilities"
      >
        {SLIDES.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={i === active}
            tabIndex={i === active ? 0 : -1}
            onClick={() => jump(i)}
            onKeyDown={(e) => onTabKeyDown(e, i)}
            className="group -m-1.5 p-1.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest-400"
          >
            <span
              className={`block h-2 rounded-full transition-all duration-300 ${
                i === active ? 'w-6 bg-forest-500' : 'w-2 bg-sand-300 group-hover:bg-sand-400'
              }`}
              aria-hidden="true"
            />
            <span className="sr-only">{`Show ${s.title} — ${s.status}`}</span>
          </button>
        ))}
      </div>
      {reduced && (
        <p className="mt-2 text-center text-[10px] text-slate-400">
          Auto-rotation paused — use the indicators to explore each capability.
        </p>
      )}
    </div>
  );
}