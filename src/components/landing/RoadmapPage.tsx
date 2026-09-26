import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  Zap, Globe, Target, ShoppingCart, ShieldCheck, Wallet, Webhook, Key, Receipt,
  Globe2, Link2, Repeat, Bot, SlidersHorizontal, Fingerprint, Landmark,
  Shield, Coins, Crosshair, Code2, MessageSquare, ArrowUpRight,
  BookOpen, Map, Github, Mail,
} from 'lucide-react';

const GITHUB_URL = 'https://github.com/shuaibwasifkhan/jafaripay';
const SUPPORT_EMAIL = 'dev@jafari.co.in';

const FOOTER_LINK_CLS =
  'group flex items-center gap-1.5 text-xs font-medium text-ink/60 transition-colors hover:text-forest-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest-300 focus-visible:ring-offset-2 focus-visible:ring-offset-cream-50 rounded';

type PhaseAccent = {
  badge: string;
  tile: string;
  icon: string;
  chip: string;
  cardHover: string;
};

type PhaseItem = { icon: LucideIcon; title: string; desc: string };

type Phase = {
  key: string;
  badge: string;
  status: string;
  title: string;
  sub: string;
  cols: string;
  accent: PhaseAccent;
  items: PhaseItem[];
};

const GROTESK = { fontFamily: "'Space Grotesk', sans-serif" } as const;

const PHASES: Phase[] = [
  {
    key: 'live',
    badge: 'Live now',
    status: 'Live',
    title: 'Shipping today',
    sub: 'Production-ready on Arc Mainnet — build on it now.',
    cols: 'lg:grid-cols-4',
    accent: {
      badge: 'text-forest-700 bg-forest-50 border-forest-200',
      tile: 'bg-forest-50 border-forest-200',
      icon: 'text-forest-600',
      chip: 'text-forest-700 bg-forest-50 border-forest-200',
      cardHover: 'hover:border-forest-200',
    },
    items: [
      { icon: Globe, title: 'Arc Mainnet Payments', desc: 'Accept USDC on Arc Mainnet (chain 5042) with sub-second finality and native gas.' },
      { icon: Target, title: 'Payment Intents', desc: 'Server-side intents carry amount, currency, and order metadata. Idempotent by design.' },
      { icon: ShoppingCart, title: 'Hosted Checkout', desc: 'One SDK call: wallet connect, chain switch, and USDC transfer handled for you.' },
      { icon: ShieldCheck, title: 'On-Chain Verification', desc: 'Token contract, recipient, and exact amount verified against the ERC-20 Transfer event.' },
      { icon: Wallet, title: 'Direct Merchant Settlement', desc: 'Non-custodial transfers from your customer straight to your settlement wallet.' },
      { icon: Webhook, title: 'Signed Webhooks', desc: 'HMAC-SHA256 signed payment events with automatic retries and replay protection.' },
      { icon: Key, title: 'API Keys', desc: 'Scoped test and live keys with project isolation, managed from the dashboard.' },
      { icon: Receipt, title: 'Payment Reconciliation', desc: 'Every intent matched to a settled on-chain transfer, auditable in one ledger view.' },
    ],
  },
  {
    key: 'next',
    badge: 'Next',
    status: 'Next',
    title: 'On the agenda',
    sub: 'Up next — building and stress-testing with early users.',
    cols: 'lg:grid-cols-3',
    accent: {
      badge: 'text-teal-700 bg-teal-50 border-teal-200',
      tile: 'bg-teal-50 border-teal-200',
      icon: 'text-teal-600',
      chip: 'text-teal-700 bg-teal-50 border-teal-200',
      cardHover: 'hover:border-teal-200',
    },
    items: [
      { icon: Globe2, title: 'Multi-Chain USDC', desc: 'Same API, more networks — USDC payments across additional chains and bridges.' },
      { icon: Link2, title: 'Payment Links & Invoices', desc: 'Shareable payment links and generated invoices that settle in USDC — no integration required.' },
      { icon: Repeat, title: 'Advanced Billing', desc: 'Subscriptions, proration, and dunning handled in USDC for recurring SaaS revenue.' },
    ],
  },
  {
    key: 'exploring',
    badge: 'Exploring',
    status: 'Exploring',
    title: 'In the lab',
    sub: 'Active research, shaped by builder feedback — direction, not commitment.',
    cols: 'lg:grid-cols-4',
    accent: {
      badge: 'text-lilac-700 bg-lilac-50 border-lilac-200',
      tile: 'bg-lilac-50 border-lilac-200',
      icon: 'text-lilac-600',
      chip: 'text-lilac-700 bg-lilac-50 border-lilac-200',
      cardHover: 'hover:border-lilac-200',
    },
    items: [
      { icon: Bot, title: 'Agent Payments', desc: 'Programmable payment rails for AI agents and automated payment workloads.' },
      { icon: SlidersHorizontal, title: 'Programmable Payment Policies', desc: 'Define who can pay, how much, and under what conditions — enforced at settlement.' },
      { icon: Fingerprint, title: 'Payment Passport', desc: 'A verifiable, portable payment context that travels across apps and merchants.' },
      { icon: Landmark, title: 'Smart Settlement', desc: 'Policy-driven settlement: splits, escrow, and conditional release of funds.' },
    ],
  },
  {
    key: 'future',
    badge: 'Future',
    status: 'Future',
    title: 'The horizon',
    sub: 'Longer-range directions we are tracking as the ecosystem matures.',
    cols: 'lg:grid-cols-4',
    accent: {
      badge: 'text-gold-700 bg-gold-50 border-gold-200',
      tile: 'bg-gold-50 border-gold-200',
      icon: 'text-gold-600',
      chip: 'text-gold-700 bg-gold-50 border-gold-200',
      cardHover: 'hover:border-gold-200',
    },
    items: [
      { icon: Shield, title: 'Payment Firewall', desc: 'Risk controls and anomaly detection guarding every USDC transfer before it settles.' },
      { icon: Coins, title: 'Merchant Treasury Automation', desc: 'Automate sweeps, conversions, and treasury operations on your on-chain balances.' },
      { icon: Crosshair, title: 'Outcome-Based Payments', desc: 'Release funds when verifiable outcomes happen — not just when the charge clears.' },
      { icon: Code2, title: 'Developer SDK', desc: 'First-party SDKs and tooling beyond JavaScript, built around the builder workflow.' },
    ],
  },
];

const VISION_CHIPS = ['Commerce', 'SaaS', 'Marketplaces', 'AI & agent payments', 'Open USDC applications'];

export default function RoadmapPage() {
  return (
    <div className="min-h-dvh bg-cream text-ink" style={{ fontFamily: "'DM Sans', sans-serif" }}>
      {/* Nav */}
      <nav className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-2xl bg-forest-600 flex items-center justify-center">
            <Zap size={14} fill="white" className="text-white" />
          </div>
          <span className="font-bold text-ink text-lg tracking-tight" style={GROTESK}>JafariPay</span>
        </Link>
        <div className="flex items-center gap-6">
          <Link to="/docs" className="hidden sm:block text-sm text-slate-500 hover:text-ink transition-all">Documentation</Link>
          <Link to="/roadmap" className="hidden sm:block text-sm font-medium text-ink transition-all">Roadmap</Link>
          <Link to="/login" className="text-sm font-medium text-slate-600 hover:text-ink transition-all">Sign in</Link>
          <Link to="/login" className="px-4 py-2 rounded-xl bg-forest-700 text-white text-sm font-semibold hover:bg-forest-600 shadow-soft transition-all">
            Start Building
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-12 sm:pt-16 lg:pt-20 pb-14 lg:pb-16 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-forest-50 border border-forest-200 text-xs text-forest-700 mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-forest-500 animate-pulse" />
          Product roadmap · JafariPay on Arc
        </div>
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-ink mb-6 leading-[1.05]" style={{ letterSpacing: '-0.03em', ...GROTESK }}>
          JafariPay Roadmap
        </h1>
        <p className="text-lg sm:text-xl text-slate-600 mb-4 text-pretty leading-relaxed max-w-2xl mx-auto">
          Building the future of programmable USDC payments on Arc.
        </p>
        <p className="text-sm sm:text-base text-slate-500 leading-relaxed max-w-2xl mx-auto">
          This roadmap is a living document, not a delivery schedule. The plan evolves with the Arc
          ecosystem and builder feedback — labels like Live, Next, Exploring, and Future describe
          direction, not dates.
        </p>
      </section>

      {/* Phase sections */}
      {PHASES.map(({ key, badge, status, title, sub, cols, accent, items }) => (
        <section key={key} className="max-w-6xl mx-auto px-6 pb-16">
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-3">
              <span className={`text-[10px] font-bold uppercase tracking-wider rounded-md px-2 py-1 border ${accent.badge}`}>{badge}</span>
              <h2 className="text-xl sm:text-2xl font-bold text-ink" style={{ letterSpacing: '-0.02em', ...GROTESK }}>{title}</h2>
            </div>
            <p className="text-sm text-slate-500">{sub}</p>
          </div>

          <div className={`grid grid-cols-1 sm:grid-cols-2 ${cols} gap-4`}>
            {items.map(({ icon: Icon, ...rest }) => (
              <div
                key={rest.title}
                className={`group relative p-5 rounded-2xl bg-white border border-sand-200 shadow-soft hover:shadow-lift transition-all ${accent.cardHover}`}
              >
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className={`w-9 h-9 rounded-xl border ${accent.tile} flex items-center justify-center flex-shrink-0`}>
                    <Icon size={15} className={accent.icon} />
                  </div>
                  <span className={`text-[10px] font-semibold uppercase tracking-wide rounded-full border px-2 py-0.5 ${accent.chip} flex-shrink-0`}>
                    {status}
                  </span>
                </div>
                <h3 className="text-sm font-semibold text-ink mb-1.5" style={GROTESK}>{rest.title}</h3>
                <p className="text-xs text-slate-500 leading-relaxed">{rest.desc}</p>
              </div>
            ))}
          </div>
        </section>
      ))}

      {/* Product vision */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="rounded-3xl bg-forest-950 border border-forest-800 p-10 sm:p-14 text-center shadow-lift">
          <p className="text-xs font-bold uppercase tracking-wider text-teal-300 mb-4">Product vision</p>
          <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-5 leading-tight" style={{ letterSpacing: '-0.02em', ...GROTESK }}>
            From accepting payments to programmable payment infrastructure.
          </h2>
          <p className="text-sm sm:text-base text-forest-200 leading-relaxed max-w-2xl mx-auto mb-8">
            JafariPay starts with checkout and grows into reusable, composable payment primitives —
            one non-custodial, on-chain-verified rail powering commerce, SaaS, marketplaces, AI and
            agent payments, and the next wave of USDC applications.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {VISION_CHIPS.map((chip) => (
              <span key={chip} className="text-xs text-forest-100 bg-white/5 border border-white/10 rounded-full px-3 py-1.5">
                {chip}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-3xl mx-auto px-6 pb-24">
        <div className="rounded-3xl bg-white border border-sand-200 p-10 sm:p-12 shadow-lift text-center">
          <div className="w-12 h-12 rounded-2xl bg-forest-600 flex items-center justify-center mx-auto mb-6">
            <MessageSquare size={20} className="text-white" />
          </div>
          <h2 className="text-3xl font-bold text-ink mb-3" style={{ letterSpacing: '-0.02em', ...GROTESK }}>
            Shape the Future of USDC Payments
          </h2>
          <p className="text-slate-600 text-sm mb-8">Have an idea, integration request, or use case you want JafariPay to support?</p>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            aria-label={`Email us at ${SUPPORT_EMAIL}`}
            className="inline-flex items-center justify-center gap-2 px-7 py-4 rounded-2xl bg-forest-700 text-white font-bold text-sm hover:bg-forest-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest-300 focus-visible:ring-offset-2 focus-visible:ring-offset-cream-50 shadow-soft transition-all"
          >
            <Mail size={14} /> Talk to us
          </a>
          <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-slate-400">
            <Mail size={12} aria-hidden="true" /> {SUPPORT_EMAIL}
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-sand-200 py-10">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-forest-600 flex items-center justify-center">
              <Zap size={10} fill="white" className="text-white" />
            </div>
            <span className="text-sm font-bold text-slate-600" style={GROTESK}>JafariPay</span>
            <span className="text-xs text-slate-500">Open source · MIT License</span>
          </div>
          <div className="flex items-center gap-6 flex-wrap justify-center">
            <Link to="/docs" className={FOOTER_LINK_CLS} aria-label="Documentation">
              <BookOpen size={13} className="text-ink/40 transition-colors group-hover:text-forest-600" /> Documentation
            </Link>
            <Link to="/roadmap" className={FOOTER_LINK_CLS} aria-label="Roadmap">
              <Map size={13} className="text-ink/40 transition-colors group-hover:text-forest-600" /> Roadmap
            </Link>
            <Link to="/docs#security" className={FOOTER_LINK_CLS} aria-label="Security">
              <Shield size={13} className="text-ink/40 transition-colors group-hover:text-forest-600" /> Security
            </Link>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" title={GITHUB_URL} className={FOOTER_LINK_CLS} aria-label="JafariPay on GitHub">
              <Github size={13} className="text-ink/40 transition-colors group-hover:text-forest-600" /> GitHub
            </a>
            <a href={`mailto:${SUPPORT_EMAIL}`} title={`Email ${SUPPORT_EMAIL}`} className={FOOTER_LINK_CLS} aria-label="Contact support by email">
              <Mail size={13} className="text-ink/40 transition-colors group-hover:text-forest-600" /> Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

