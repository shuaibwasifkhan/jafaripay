import { Link } from 'react-router-dom';
import { Zap, ShieldCheck, Code2, Wallet, ArrowRight, ExternalLink, CheckCircle } from 'lucide-react';

const INTEGRATION_CODE = `const payment = await jafaripay.paymentIntents.create({
  amount: "25.00",
  currency: "USDC",
  order_id: "ORDER-123"
});

JafariPay.checkout({
  paymentIntent: payment.id,
  onPaymentSuccess: (data) => {
    // Mark order paid via webhook verification
    console.log('Payment intent:', data.paymentIntentId);
  }
});`;

const SDK_CODE = `<script src="https://cdn.jafaripay.com/sdk.js"></script>

<script>
JafariPay.checkout({
  paymentIntent: "pi_abc123",
  onPaymentSuccess: (data) => {
    window.location.href = '/success';
  }
});
</script>`;

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
          <Link to="/docs" className="text-sm text-slate-500 hover:text-ink transition-all">Documentation</Link>
          <Link to="/login" className="text-sm font-medium text-slate-600 hover:text-ink transition-all">Sign in</Link>
          <Link to="/login" className="px-4 py-2 rounded-xl bg-forest-700 text-white text-sm font-semibold hover:bg-forest-600 shadow-soft transition-all">
            Start Building
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-20 pb-24 text-center">
        {/* Tag */}
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-forest-50 border border-forest-200 text-xs text-forest-700 mb-8">
          <div className="w-1.5 h-1.5 rounded-full bg-forest-500" />
          Built on Arc · USDC native · Non-custodial
        </div>

        <h1 className="text-5xl font-extrabold text-ink mb-6 leading-none" style={{ letterSpacing: '-0.03em', fontFamily: "'Space Grotesk', sans-serif" }}>
          Accept USDC payments<br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-forest-500 via-teal-500 to-lilac-400">in minutes.</span>
        </h1>
        <p className="text-xl text-slate-600 mb-10 text-pretty max-w-2xl mx-auto leading-relaxed">
          Add fast, programmable USDC checkout to your website or application with a few lines of code. Non-custodial. USDC goes directly to your wallet.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link to="/login" className="flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-forest-700 text-white font-semibold hover:bg-forest-600 shadow-soft transition-all">
            Start Building <ArrowRight size={15} />
          </Link>
          <Link to="/docs" className="flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-white text-ink border border-sand-300 font-semibold hover:bg-cream transition-all">
            Documentation <ExternalLink size={13} />
          </Link>
        </div>
      </section>

      {/* Code showcase */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="rounded-2xl bg-white border border-sand-200 overflow-hidden shadow-soft">
          <div className="px-6 py-4 border-b border-sand-200 flex items-center gap-2">
            <Code2 size={14} className="text-forest-600" />
            <span className="text-sm font-medium text-slate-600">Integration example</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y divide-sand-200 md:divide-y-0 md:divide-x">
            <div>
              <div className="px-5 py-2.5 border-b border-sand-200 text-xs text-slate-500 font-medium uppercase tracking-wider">Backend (Node.js)</div>
              <pre className="p-5 text-xs font-mono leading-relaxed text-slate-600 overflow-x-auto">{INTEGRATION_CODE}</pre>
            </div>
            <div>
              <div className="px-5 py-2.5 border-b border-sand-200 text-xs text-slate-500 font-medium uppercase tracking-wider">Frontend (HTML)</div>
              <pre className="p-5 text-xs font-mono leading-relaxed text-slate-600 overflow-x-auto">{SDK_CODE}</pre>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="text-center mb-14">
          <h2 className="text-3xl font-bold text-ink mb-3" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
            Everything you need to accept USDC
          </h2>
          <p className="text-slate-600">Built for developers. Secured by blockchain verification.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            {
              icon: ShieldCheck, tile: 'bg-forest-50', iconCls: 'text-forest-600',
              title: 'Non-custodial',
              desc: 'USDC transfers directly from customer to your settlement wallet. JafariPay never holds your funds.'
            },
            {
              icon: Zap, tile: 'bg-teal-50', iconCls: 'text-teal-600',
              title: 'Arc native',
              desc: 'Built on Arc where USDC is the native gas token. Sub-second finality, predictable fees.'
            },
            {
              icon: Wallet, tile: 'bg-lilac-50', iconCls: 'text-lilac-600',
              title: 'Wallet auth',
              desc: 'Merchant sign-in via EIP-4361 SIWE. No email or password. Your wallet is your identity.'
            },
            {
              icon: Code2, tile: 'bg-lilac-50', iconCls: 'text-lilac-600',
              title: 'Developer first',
              desc: 'REST API, JavaScript SDK, hosted checkout, OpenAPI docs, and idempotent requests.'
            },
            {
              icon: CheckCircle, tile: 'bg-forest-50', iconCls: 'text-forest-600',
              title: 'Verified on-chain',
              desc: 'Backend independently verifies every ERC-20 Transfer event. Wrong amount or recipient fails.'
            },
            {
              icon: ArrowRight, tile: 'bg-sand-100', iconCls: 'text-slate-500',
              title: 'Signed webhooks',
              desc: 'HMAC-SHA256 signed events, automatic retries, and replay protection for payment.succeeded.'
            },
          ].map(({ icon: Icon, tile, iconCls, title, desc }) => (
            <div key={title} className="p-6 rounded-2xl bg-white border border-sand-200 shadow-soft">
              <div className={`w-9 h-9 rounded-xl ${tile} flex items-center justify-center mb-4`}>
                <Icon size={15} className={iconCls} />
              </div>
              <h3 className="text-sm font-semibold text-ink mb-1.5">{title}</h3>
              <p className="text-xs text-slate-500 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Payment flow */}
      <section className="max-w-4xl mx-auto px-6 pb-24">
        <h2 className="text-2xl font-bold text-ink text-center mb-10" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
          How it works
        </h2>
        <div className="flex items-start gap-0">
          {[
            { step: '01', title: 'Create Payment Intent', desc: 'Your backend calls the API to create a payment intent with amount and order details.' },
            { step: '02', title: 'Customer pays', desc: 'Customer opens hosted checkout, connects wallet, switches to Arc, and sends USDC.' },
            { step: '03', title: 'Verified on-chain', desc: 'Backend detects the ERC-20 Transfer event and verifies recipient, amount, and token contract.' },
            { step: '04', title: 'Webhook fired', desc: 'payment.succeeded webhook is signed and delivered to your endpoint. Mark order paid.' },
          ].map(({ step, title, desc }, i) => (
            <div key={step} className="flex-1 relative">
              {i < 3 && <div className="absolute top-5 left-1/2 w-full h-px bg-sand-300" />}
              <div className="relative text-center px-4">
                <div className="w-10 h-10 rounded-2xl bg-forest-50 border border-forest-200 flex items-center justify-center mx-auto mb-4 relative">
                  <span className="text-xs font-bold text-forest-600 tabular-nums">{step}</span>
                </div>
                <h3 className="text-sm font-semibold text-ink mb-1.5">{title}</h3>
                <p className="text-xs text-slate-500 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-2xl mx-auto px-6 pb-24 text-center">
        <div className="rounded-2xl bg-white border border-sand-200 p-12 shadow-lift">
          <div className="w-12 h-12 rounded-2xl bg-forest-600 flex items-center justify-center mx-auto mb-6">
            <Zap size={20} fill="white" className="text-white" />
          </div>
          <h2 className="text-2xl font-bold text-ink mb-3" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
            Ready to accept USDC?
          </h2>
          <p className="text-slate-600 text-sm mb-8">Connect your wallet. Create an API key. Ship in minutes.</p>
          <Link to="/login" className="inline-flex items-center gap-2 px-7 py-4 rounded-2xl bg-forest-700 text-white font-bold text-sm hover:bg-forest-600 shadow-soft transition-all">
            Get started free <ArrowRight size={14} />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-sand-200 py-10">
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-forest-600 flex items-center justify-center">
              <Zap size={10} fill="white" className="text-white" />
            </div>
            <span className="text-sm font-bold text-slate-600" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>JafariPay</span>
            <span className="text-xs text-slate-500">Open source · MIT License</span>
          </div>
          <div className="flex items-center gap-6">
            <Link to="/docs" className="text-xs text-slate-500 hover:text-ink">Documentation</Link>
            <Link to="/docs#security" className="text-xs text-slate-500 hover:text-ink">Security</Link>
            <a href="https://github.com/jafaripay/jafaripay" target="_blank" rel="noopener noreferrer" className="text-xs text-slate-500 hover:text-ink">GitHub</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
