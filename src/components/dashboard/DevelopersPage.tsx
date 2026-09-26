import { Link } from 'react-router-dom';
import { Code2, ArrowRight } from 'lucide-react';
import { Card } from '../shared/Card';

const NODEJS_EXAMPLE = `const JafariPay = require('@jafaripay/node');
const client = new JafariPay({ apiKey: process.env.SK_TEST_KEY });

const intent = await client.paymentIntents.create({
  amount: "25.00",
  currency: "USDC",
  order_id: "ORDER-123",
  description: "Premium subscription"
}, { idempotencyKey: "order-123-attempt-1" });

console.log(intent.checkout_url);`;

const SDK_EXAMPLE = `// Embed the JafariPay JavaScript SDK on the frontend (served at /sdk.js).
// No secrets: the SDK only takes a Payment Intent id and launches the
// existing hosted checkout — verification/settlement stay server-side.

<script src="https://jafari.co.in/sdk.js"></script>

// Open the hosted checkout in a new window:
JafariPay.checkout({
  paymentIntent: intent.id,
  onPaymentSuccess: (r) => { /* UI only — confirm via your webhook */ },
  onPaymentFailed:  (r) => {},
  onClose: () => {},
});

// Or embed a "Pay with USDC" launcher into an element:
// JafariPay.mount('#jafaripay-checkout', { paymentIntent: intent.id });

// Confirm on your server with the signed payment.succeeded webhook.`;

const WEBHOOK_EXAMPLE = `const crypto = require('crypto');

app.post('/webhooks/jafaripay', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-jafaripay-signature'];
  const timestamp = req.headers['x-jafaripay-timestamp'];
  const body = req.body;

  // Verify HMAC-SHA256 signature
  const payload = \`\${timestamp}.\${body}\`;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  if (sig !== expected) {
    return res.status(400).send('Invalid signature');
  }
  // Check timestamp within 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
    return res.status(400).send('Replay attack detected');
  }

  const event = JSON.parse(body);
  if (event.type === 'payment.succeeded') {
    const { paymentIntentId, amount, settlementAddress } = event.data;
    // Mark order paid in your database
  }

  res.json({ received: true });
});`;

const VERIFY_ENDPOINT = `// Do NOT use frontend redirect as payment confirmation.
// Always use the payment.succeeded webhook on your server.

// Optionally, also verify via the API:
const payment = await client.paymentIntents.retrieve(paymentIntentId);
if (payment.status === 'succeeded') {
  // Confirmed via API — but webhook is the source of truth
}`;

export default function DevelopersPage() {
  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ink tracking-tight mb-1" style={{ letterSpacing: '-0.02em' }}>Developers</h1>
        <p className="text-slate-500 text-sm">Integration guides and API reference</p>
      </div>

      <div className="space-y-5">
        {/* Quick start */}
        <Card className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Code2 size={14} className="text-forest-600" />
            <h2 className="text-sm font-semibold text-ink">Quick integration</h2>
          </div>
          <p className="text-xs text-slate-500 mb-3">1. Create a payment intent on your backend using your <code className="text-forest-700">sk_test_</code> key:</p>
          <pre className="p-4 bg-sand-100 rounded-xl text-xs font-mono text-slate-600 overflow-x-auto">{NODEJS_EXAMPLE}</pre>

          <p className="text-xs text-slate-500 mt-5 mb-3">2. Launch the checkout on the frontend via the JavaScript SDK (served at <code className="text-forest-700">/sdk.js</code>):</p>
          <pre className="p-4 bg-sand-100 rounded-xl text-xs font-mono text-slate-600 overflow-x-auto">{SDK_EXAMPLE}</pre>
        </Card>

        {/* Webhook */}
        <Card className="p-6">
          <h2 className="text-sm font-semibold text-ink mb-1">Webhook verification</h2>
          <p className="text-xs text-slate-500 mb-4">Use webhooks as your source of truth — never trust the frontend redirect.</p>
          <pre className="p-4 bg-sand-100 rounded-xl text-xs font-mono text-slate-600 overflow-x-auto">{WEBHOOK_EXAMPLE}</pre>
        </Card>

        {/* Payment verification */}
        <Card className="p-6">
          <h2 className="text-sm font-semibold text-ink mb-1">Payment verification</h2>
          <p className="text-xs text-slate-500 mb-4">The backend independently verifies every ERC-20 Transfer event on Arc.</p>
          <pre className="p-4 bg-sand-100 rounded-xl text-xs font-mono text-slate-600 overflow-x-auto">{VERIFY_ENDPOINT}</pre>
        </Card>

        {/* Docs links */}
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Full documentation', to: '/docs' },
            { label: 'API Reference', to: '/docs#api-reference' },
            { label: 'Webhook guide', to: '/docs#webhooks' },
            { label: 'Test mode', to: '/docs#test-mode' },
          ].map(({ label, to }) => (
            <Link key={to} to={to}
              className="flex items-center justify-between p-4 rounded-xl bg-white border border-sand-200 text-sm text-slate-600 hover:text-ink hover:border-forest-300 shadow-soft transition-all">
              {label}
              <ArrowRight size={12} className="text-slate-500" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
