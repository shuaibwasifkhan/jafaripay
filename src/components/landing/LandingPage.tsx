import { Link } from 'react-router-dom';
import {
  Zap, ShieldCheck, Code2, Wallet, ArrowRight, ArrowUpRight, ExternalLink, CheckCircle,
  Building2, Store, Package, ShoppingBag, Heart, Check, Key, Webhook, CircleCheck, Boxes,
  BookOpen, Map, Shield, Github, Mail,
} from 'lucide-react';
import { HeroShowcase } from './HeroShowcase';

const GITHUB_URL = 'https://github.com/shuaibwasifkhan/jafaripay';
const SUPPORT_EMAIL = 'dev@jafari.co.in';

const FOOTER_LINK_CLS =
  'group flex items-center gap-1.5 text-xs font-medium text-ink/60 transition-colors hover:text-forest-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest-300 focus-visible:ring-offset-2 focus-visible:ring-offset-cream-50 rounded';

const INTEGRATION_CODE = `// 1. Create a Payment Intent on your backend (sk_ key)
const intent = await fetch("https://your-instance.com/v1/payment-intents", {
  method: "POST",
  headers: {
    "Authorization": "Bearer sk_test_...",
    "Content-Type": "application/json",
    "Idempotency-Key": "order-123",
  },
  body: JSON.stringify({ amount: "1.00", currency: "USDC" }),
}).then((r) => r.json());

// 2. Hand the customer the hosted checkout URL
res.redirect(intent.checkout_url);`;

const FRONTEND_CODE = `// Frontend — launch the checkout two supported ways:
// 1) Redirect to the hosted checkout page:
window.location.href = intent.checkout_url;

// 2) Or use the JavaScript SDK (served at /sdk.js):
//    <script src="https://jafari.co.in/sdk.js"></script>
//    JafariPay.checkout({ paymentIntent: intent.id });
//    JafariPay.mount('#jafaripay-checkout', { paymentIntent: intent.id });

// 3. Confirm on your server with the signed payment.succeeded webhook.`;

const CAPABILITIES = [
  { icon: Zap, label: 'USDC Native', desc: 'Settle in USDC on Arc' },
  { icon: ShieldCheck, label: 'Non-Custodial', desc: 'Funds go straight to your wallet' },
  { icon: CircleCheck, label: 'On-Chain Verified', desc: 'Every transfer verified on-chain' },
  { icon: Boxes, label: 'Arc', desc: 'Sub-second finality' },
  { icon: Webhook, label: 'Signed Webhooks', desc: 'HMAC-signed, auto-retried' },
];

const FEATURES = [
  {
    eyebrow: 'Fund custody',
    icon: ShieldCheck, tile: 'bg-forest-50', iconCls: 'text-forest-600',
    title: 'Non-custodial',
    desc: 'USDC transfers directly from customer to your settlement wallet. JafariPay never holds your funds.'
  },
  {
    eyebrow: 'Network',
    icon: Zap, tile: 'bg-teal-50', iconCls: 'text-teal-600',
    title: 'Arc native',
    desc: 'Built on Arc where USDC is the native gas token. Sub-second finality, predictable fees.'
  },
  {
    eyebrow: 'Authentication',
    icon: Wallet, tile: 'bg-lilac-50', iconCls: 'text-lilac-600',
    title: 'Wallet auth',
    desc: 'Merchant sign-in via EIP-4361 SIWE. No email or password. Your wallet is your identity.'
  },
  {
    eyebrow: 'Developer',
    icon: Code2, tile: 'bg-lilac-50', iconCls: 'text-lilac-600',
    title: 'Developer first',
    desc: 'REST API, JavaScript SDK, hosted checkout, signed webhooks, and idempotent requests.'
  },
  {
    eyebrow: 'Security',
    icon: CheckCircle, tile: 'bg-forest-50', iconCls: 'text-forest-600',
    title: 'Verified on-chain',
    desc: 'Backend independently verifies every ERC-20 Transfer event. Wrong amount or recipient fails.'
  },
  {
    eyebrow: 'Reliability',
    icon: Webhook, tile: 'bg-sand-100', iconCls: 'text-slate-500',
    title: 'Signed webhooks',
    desc: 'HMAC-SHA256 signed events, automatic retries, and replay protection for payment.succeeded.'
  },
];

const STEPS = [
  { step: '01', title: 'Create Payment Intent', desc: 'Your backend calls the API to create a payment intent with amount and order details.' },
  { step: '02', title: 'Customer pays', desc: 'Customer opens hosted checkout, connects wallet, switches to Arc, and sends USDC.' },
  { step: '03', title: 'Verified on-chain', desc: 'Backend detects the ERC-20 Transfer event and verifies recipient, amount, and token contract.' },
  { step: '04', title: 'Webhook fired', desc: 'payment.succeeded webhook is signed and delivered to your endpoint. Mark order paid.' },
];

const USE_CASES = [
  {
    icon: Building2, title: 'SaaS',
    desc: 'Accept monthly or annual USDC subscriptions and mark plans paid when the payment.succeeded webhook fires.'
  },
  {
    icon: ShoppingBag, title: 'Ecommerce',
    desc: 'Check out with USDC at your store — orders settle straight to your settlement wallet, no card processor between you and your funds.'
  },
  {
    icon: Store, title: 'Marketplaces',
    desc: 'Give sellers a USDC payment rail with instant on-chain proof of settlement per order.'
  },
  {
    icon: Package, title: 'Digital products',
    desc: 'Deliver licenses, keys, and downloads the moment on-chain verification confirms payment.'
  },
  {
    icon: Heart, title: 'Donations',
    desc: 'Receive transparent, direct USDC gifts from supporters worldwide — non-custodial from the first click.'
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-dvh bg-cream text-ink" style={{ fontFamily: "'DM Sans', sans-serif" }}>
      {/* Nav */}
      <nav className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-2xl bg-forest-600 flex items-center justify-center">
            <Zap size={14} fill="white" className="text-white" />
          </div>
          <span className="font-bold text-ink text-lg tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>JafariPay</span>
        </div>
        <div className="flex items-center gap-6">
          <Link to="/docs" className="hidden sm:block text-sm text-slate-500 hover:text-ink transition-all">Documentation</Link>
          <Link to="/roadmap" className="hidden sm:block text-sm text-slate-500 hover:text-ink transition-all">Roadmap</Link>
          <Link to="/login" className="text-sm font-medium text-slate-600 hover:text-ink transition-all">Sign in</Link>
          <Link to="/login" className="px-4 py-2 rounded-xl bg-forest-700 text-white text-sm font-semibold hover:bg-forest-600 shadow-soft transition-all">
            Start Building
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-12 lg:pt-20 pb-16 lg:pb-24">
        <div className="grid lg:grid-cols-12 gap-12 lg:gap-10 items-center">
          {/* Left */}
          <div className="lg:col-span-7">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-forest-50 border border-forest-200 text-xs text-forest-700 mb-8">
              <div className="w-1.5 h-1.5 rounded-full bg-forest-500" />
              Built for USDC payments
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-ink mb-6 leading-[1.05]" style={{ letterSpacing: '-0.03em', fontFamily: "'Space Grotesk', sans-serif" }}>
              USDC payment infrastructure
              <span className="block text-transparent bg-clip-text bg-gradient-to-r from-forest-500 via-teal-500 to-lilac-400">in minutes.</span>
            </h1>
            <p className="text-lg sm:text-xl text-slate-600 mb-8 text-pretty leading-relaxed max-w-xl">
              Add fast, programmable USDC checkout to your site or app with a few lines of code.
              Non-custodial — USDC goes directly to your wallet, verified on-chain.
            </p>

            <div className="flex flex-col sm:flex-row items-center sm:items-stretch gap-3 sm:gap-4">
              <Link to="/login" className="flex items-center justify-center gap-2 px-6 py-3.5 rounded-2xl bg-forest-700 text-white font-semibold hover:bg-forest-600 shadow-soft transition-all">
                Start Building <ArrowRight size={15} />
              </Link>
              <Link to="/docs" className="flex items-center justify-center gap-2 px-6 py-3.5 rounded-2xl bg-white text-ink border border-sand-300 font-semibold hover:bg-cream transition-all">
                Documentation <ExternalLink size={13} />
              </Link>
            </div>

            <p className="text-xs text-slate-500 mt-6">No email. No password. Your wallet is your identity.</p>
          </div>

          {/* Right — JafariPay product showcase */}
          <div className="lg:col-span-5">
            <HeroShowcase />
          </div>
        </div>
      </section>

      {/* Trust / capability strip */}
      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="rounded-2xl bg-white border border-sand-200 shadow-soft overflow-hidden divide-y divide-sand-200 sm:divide-y-0 sm:divide-x sm:divide-sand-200 grid sm:grid-cols-5">
          {CAPABILITIES.map(({ icon: Icon, label, desc }) => (
            <div key={label} className="flex sm:block items-start gap-3 px-5 sm:px-6 py-4 sm:py-5">
              <div className="w-8 h-8 rounded-xl bg-forest-50 flex items-center justify-center flex-shrink-0">
                <Icon size={14} className="text-forest-600" />
              </div>
              <div className="sm:mt-3">
                <p className="text-sm font-semibold text-ink">{label}</p>
                <p className="text-xs text-slate-500 mt-0.5">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Product showcase */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="text-center mb-14">
          <p className="text-xs font-semibold text-forest-600 uppercase tracking-wider mb-3">Product</p>
          <h2 className="text-3xl font-bold text-ink mb-3" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
            From intent to verified payment
          </h2>
          <p className="text-slate-600 max-w-xl mx-auto">Five stages, one flow — every step is backed by on-chain proof and a signed webhook.</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-5">
          {/* 1 · Payment intent */}
          <div className="rounded-2xl bg-white border border-sand-200 shadow-soft p-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-[10px] font-bold text-forest-600 bg-forest-50 border border-forest-200 rounded-md px-1.5 py-0.5 tabular-nums">1</span>
              <span className="text-sm font-semibold text-ink">Payment Intent</span>
            </div>
            <div className="rounded-xl bg-sand-100 border border-sand-200 p-4">
              <p className="text-xs font-mono text-slate-600 mb-3"><span className="text-forest-700 font-semibold">POST</span> /v1/payment_intents</p>
              <div className="space-y-1.5 text-xs font-mono">
                <p className="text-slate-600"><span className="text-lilac-600">"amount"</span>: <span className="text-gold-600">"1.00"</span>,</p>
                <p className="text-slate-600"><span className="text-lilac-600">"currency"</span>: <span className="text-gold-600">"USDC"</span>,</p>
                <p className="text-slate-600"><span className="text-lilac-600">"order_id"</span>: <span className="text-gold-600">"ORDER-123"</span></p>
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-3 leading-relaxed">Your backend creates an intent with amount, order, and description. Idempotent requests make retries safe.</p>
          </div>

          {/* 2 · Customer checkout */}
          <div className="rounded-2xl bg-white border border-sand-200 shadow-soft p-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-[10px] font-bold text-forest-600 bg-forest-50 border border-forest-200 rounded-md px-1.5 py-0.5 tabular-nums">2</span>
              <span className="text-sm font-semibold text-ink">Customer Checkout</span>
            </div>
            <div className="rounded-xl bg-sand-100/70 border border-sand-200 p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-forest-600 flex items-center justify-center">
                    <Zap size={11} fill="white" className="text-white" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-ink">JafariPay Checkout</p>
                  </div>
                </div>
                <span className="text-xs font-bold text-ink tabular-nums">1.00 USDC</span>
              </div>
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-white border border-sand-200 mb-2">
                <div className="flex items-center gap-1.5">
                  <Wallet size={11} className="text-slate-500" />
                  <span className="text-xs font-mono text-slate-600">0x··········64c7</span>
                </div>
                <span className="text-[10px] text-slate-400">connected</span>
              </div>
              <div className="flex items-center justify-center py-2 rounded-lg bg-forest-700 text-white text-xs font-semibold">Pay 1.00 USDC</div>
            </div>
            <p className="text-xs text-slate-500 mt-3 leading-relaxed">Hosted checkout on Arc — customer connects their wallet and sends USDC. No forms, no card data.</p>
          </div>

          {/* 3 · USDC transfer */}
          <div className="rounded-2xl bg-white border border-sand-200 shadow-soft p-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-[10px] font-bold text-forest-600 bg-forest-50 border border-forest-200 rounded-md px-1.5 py-0.5 tabular-nums">3</span>
              <span className="text-sm font-semibold text-ink">USDC Transfer</span>
            </div>
            <div className="rounded-xl bg-sand-100 border border-sand-200 p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-[10px] text-slate-400 mb-0.5">FROM</p>
                  <p className="text-xs font-mono text-slate-600">0x··········64c7</p>
                </div>
                <div className="flex flex-col items-center px-4">
                  <ArrowRight size={13} className="text-forest-600" />
                  <p className="text-[10px] text-slate-400 mt-1">USDC · Arc</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-slate-400 mb-0.5">TO</p>
                  <p className="text-xs font-mono text-slate-600">Your wallet</p>
                </div>
              </div>
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-forest-50 border border-forest-200">
                <CheckCircle size={12} className="text-forest-600 flex-shrink-0" />
                <p className="text-xs text-forest-800">On-chain confirmed</p>
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-3 leading-relaxed">Funds move directly to your settlement wallet — JafariPay is never in the money path.</p>
          </div>

          {/* 4 · On-chain verification */}
          <div className="rounded-2xl bg-white border border-sand-200 shadow-soft p-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-[10px] font-bold text-forest-600 bg-forest-50 border border-forest-200 rounded-md px-1.5 py-0.5 tabular-nums">4</span>
              <span className="text-sm font-semibold text-ink">On-Chain Verification</span>
            </div>
            <div className="rounded-xl bg-sand-100 border border-sand-200 p-4">
              <div className="space-y-2">
                {[
                  { label: 'Token contract', value: 'USDC ✓' },
                  { label: 'Amount', value: '1.00 ✓' },
                  { label: 'Recipient', value: 'Your wallet ✓' },
                ].map(row => (
                  <div key={row.label} className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">{row.label}</span>
                    <span className="text-xs font-mono text-slate-600">{row.value}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-forest-50 border border-forest-200 mt-3">
                <ShieldCheck size={12} className="text-forest-600 flex-shrink-0" />
                <p className="text-xs text-forest-800">ERC-20 Transfer event verified</p>
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-3 leading-relaxed">The backend independently verifies the transfer event. Wrong amount or recipient fails.</p>
          </div>

          {/* 5 · Webhook */}
          <div className="lg:col-span-2 rounded-2xl bg-white border border-sand-200 shadow-soft p-6">
            <div className="grid sm:grid-cols-2 gap-6 items-center">
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-[10px] font-bold text-forest-600 bg-forest-50 border border-forest-200 rounded-md px-1.5 py-0.5 tabular-nums">5</span>
                  <span className="text-sm font-semibold text-ink">Webhook Fired</span>
                </div>
                <p className="text-xs text-slate-500 leading-relaxed">
                  A <code className="text-xs text-slate-600 bg-sand-100 px-1 py-0.5 rounded">payment.succeeded</code> event is HMAC-SHA256 signed, delivered to your endpoint with automatic retries and replay protection. It is your source of truth — never the frontend redirect.
                </p>
              </div>
              <div className="rounded-xl bg-sand-100 border border-sand-200 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-mono text-slate-600">POST /webhooks/jafaripay</p>
                  <span className="text-[10px] font-semibold text-forest-700 bg-forest-50 border border-forest-200 rounded-full px-2 py-0.5 flex-shrink-0">200 OK</span>
                </div>
                <p className="text-xs font-mono text-slate-500 mt-2">event: <span className="text-lilac-600">payment.succeeded</span></p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3">
                  <p className="text-[11px] text-slate-500 flex items-center gap-1.5"><ShieldCheck size={11} className="text-forest-600" /> signature verified</p>
                  <p className="text-[11px] text-slate-500 flex items-center gap-1.5"><Check size={11} className="text-forest-600" /> retry policy: 8 attempts</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="text-center mb-14">
          <p className="text-xs font-semibold text-forest-600 uppercase tracking-wider mb-3">Capabilities</p>
          <h2 className="text-3xl font-bold text-ink mb-3" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
            Everything you need to accept USDC
          </h2>
          <p className="text-slate-600">Built for developers. Secured by blockchain verification.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map(({ eyebrow, icon: Icon, tile, iconCls, title, desc }) => (
            <div key={title} className="group p-6 rounded-2xl bg-white border border-sand-200 shadow-soft hover:shadow-lift hover:border-forest-200 transition-all">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-3">{eyebrow}</p>
              <div className={`w-9 h-9 rounded-xl ${tile} flex items-center justify-center mb-4`}>
                <Icon size={15} className={iconCls} />
              </div>
              <h3 className="text-base font-semibold text-ink mb-1.5" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{title}</h3>
              <p className="text-sm text-slate-500 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="text-center mb-14">
          <p className="text-xs font-semibold text-forest-600 uppercase tracking-wider mb-3">How it works</p>
          <h2 className="text-3xl font-bold text-ink" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
            Four steps, end to end
          </h2>
        </div>

        <div className="flex flex-col md:flex-row gap-10 md:gap-0">
          {STEPS.map(({ step, title, desc }, i) => (
            <div key={step} className="md:flex-1 flex md:flex-col items-start md:items-center gap-4 md:gap-0 relative">
              {i < 3 && <div className="hidden md:block absolute top-5 left-[calc(50%+2.5rem)] w-[calc(100%-5rem)] h-px bg-sand-300" />}
              <div className="w-10 h-10 rounded-2xl bg-forest-50 border border-forest-200 flex items-center justify-center flex-shrink-0 relative z-10">
                <span className="text-xs font-bold text-forest-600 tabular-nums">{step}</span>
              </div>
              <div className="md:text-center md:px-5">
                <h3 className="text-sm font-semibold text-ink mb-1.5">{title}</h3>
                <p className="text-xs text-slate-500 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Developer section */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <p className="text-xs font-semibold text-forest-600 uppercase tracking-wider mb-3">For developers</p>
            <h2 className="text-3xl font-bold text-ink mb-4" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
              Ship a USDC payment flow in an afternoon
            </h2>
            <p className="text-slate-600 mb-6 leading-relaxed">
              A clean REST API, a JavaScript SDK, and a hosted checkout. Create an intent on your server, launch checkout on the frontend, and confirm with a signed webhook.
            </p>

            <div className="space-y-4 mb-8">
              {[
                { icon: Code2, title: 'REST API + JS SDK', desc: 'Idempotent requests, an OpenAPI reference, and a drop-in JavaScript SDK for the frontend.' },
                { icon: CheckCircle, title: 'Hosted checkout', desc: 'One checkout URL — wallet connect, chain switch, and USDC transfer handled for you.' },
                { icon: Webhook, title: 'Signed webhooks', desc: 'HMAC-SHA256 verification, automatic retries, and replay protection.' },
              ].map(({ icon: Icon, title: t, desc }) => (
                <div key={t} className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-xl bg-forest-50 border border-forest-200 flex items-center justify-center flex-shrink-0">
                    <Icon size={13} className="text-forest-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-ink">{t}</p>
                    <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-3">
              <Link to="/docs" className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-forest-700 text-white text-sm font-semibold hover:bg-forest-600 shadow-soft transition-all">
                Read the docs <ArrowRight size={13} />
              </Link>
              <Link to="/docs#api-reference" className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white text-ink border border-sand-300 text-sm font-semibold hover:bg-cream transition-all">
                API reference
              </Link>
            </div>
          </div>

          <div className="rounded-2xl bg-white border border-sand-200 overflow-hidden shadow-lift">
            <div className="grid grid-cols-2 divide-x divide-sand-200">
              <div>
                <div className="px-4 py-2.5 border-b border-sand-200 text-[11px] text-slate-500 font-medium uppercase tracking-wider flex items-center gap-1.5">
                  <Code2 size={11} className="text-forest-600" /> Backend
                </div>
                <pre className="p-4 text-xs font-mono leading-relaxed text-slate-600 overflow-x-auto">{INTEGRATION_CODE}</pre>
              </div>
              <div>
                <div className="px-4 py-2.5 border-b border-sand-200 text-[11px] text-slate-500 font-medium uppercase tracking-wider flex items-center gap-1.5">
                  <Key size={11} className="text-lilac-600" /> Frontend
                </div>
                <pre className="p-4 text-xs font-mono leading-relaxed text-slate-600 overflow-x-auto">{FRONTEND_CODE}</pre>
              </div>
            </div>

            <div className="px-4 py-3 border-t border-sand-200 bg-sand-100/50 flex items-center gap-2">
              <Webhook size={12} className="text-forest-600 flex-shrink-0" />
              <p className="text-xs text-slate-600 truncate">
                <span className="font-mono">payment.succeeded</span> delivered · signature verified
              </p>
              <span className="ml-auto text-[10px] font-semibold text-forest-700 bg-forest-50 border border-forest-200 rounded-full px-2 py-0.5 flex-shrink-0">200 OK</span>
            </div>
          </div>
        </div>
      </section>

      {/* Use cases */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="text-center mb-12">
          <p className="text-xs font-semibold text-forest-600 uppercase tracking-wider mb-3">Use cases</p>
          <h2 className="text-3xl font-bold text-ink" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
            Built for how you sell
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {USE_CASES.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="group relative p-6 rounded-2xl bg-white border border-sand-200 shadow-soft hover:shadow-lift hover:border-forest-200 transition-all">
              <div className="w-9 h-9 rounded-xl bg-sand-100 border border-sand-200 flex items-center justify-center mb-4 group-hover:bg-forest-50 group-hover:border-forest-200 transition-all">
                <Icon size={15} className="text-slate-500 group-hover:text-forest-600 transition-all" />
              </div>
              <h3 className="text-sm font-semibold text-ink mb-1.5" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{title}</h3>
              <p className="text-xs text-slate-500 leading-relaxed">{desc}</p>
              <ArrowUpRight size={13} className="absolute top-6 right-6 text-slate-300 group-hover:text-forest-600 transition-all" />
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-3xl mx-auto px-6 pb-24">
        <div className="rounded-3xl bg-white border border-sand-200 p-10 sm:p-12 shadow-lift text-center">
          <div className="w-12 h-12 rounded-2xl bg-forest-600 flex items-center justify-center mx-auto mb-6">
            <Zap size={20} fill="white" className="text-white" />
          </div>
          <h2 className="text-3xl font-bold text-ink mb-3" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
            Ready to accept USDC?
          </h2>
          <p className="text-slate-600 text-sm mb-8">Connect your wallet. Create an API key. Ship in minutes.</p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link to="/login" className="flex items-center justify-center gap-2 px-7 py-4 rounded-2xl bg-forest-700 text-white font-bold text-sm hover:bg-forest-600 shadow-soft transition-all">
              Start Building <ArrowRight size={14} />
            </Link>
            <Link to="/docs" className="flex items-center justify-center gap-2 px-7 py-4 rounded-2xl bg-white text-ink border border-sand-300 font-semibold text-sm hover:bg-cream transition-all">
              Documentation <ExternalLink size={13} />
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-sand-200 py-10">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-forest-600 flex items-center justify-center">
              <Zap size={10} fill="white" className="text-white" />
            </div>
            <span className="text-sm font-bold text-slate-600" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>JafariPay</span>
            <span className="text-xs text-slate-500">Open source · MIT License</span>
          </div>
          <div className="flex items-center gap-6">
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
