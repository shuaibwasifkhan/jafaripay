import { Link, useParams } from 'react-router-dom';
import { BookOpen, Code2, Webhook, Shield, Zap, TestTube, Globe, ArrowRight } from 'lucide-react';

const NAV = [
  { slug: 'quickstart', label: 'Quickstart', icon: Zap },
  { slug: 'auth', label: 'Authentication', icon: Shield },
  { slug: 'payment-intents', label: 'Payment Intents', icon: Code2 },
  { slug: 'checkout', label: 'Checkout', icon: BookOpen },
  { slug: 'sdk', label: 'JavaScript SDK', icon: Code2 },
  { slug: 'webhooks', label: 'Webhooks', icon: Webhook },
  { slug: 'webhook-verification', label: 'Webhook Verification', icon: Shield },
  { slug: 'test-mode', label: 'Test Mode', icon: TestTube },
  { slug: 'production', label: 'Production', icon: Globe },
  { slug: 'security', label: 'Security', icon: Shield },
  { slug: 'api', label: 'API Reference', icon: Code2 },
  { slug: 'troubleshooting', label: 'Troubleshooting', icon: BookOpen },
];

const CONTENT: Record<string, { title: string; body: string }> = {
  quickstart: {
    title: 'Quickstart',
    body: `## Create your first payment in 5 minutes

### 1. Sign up with your wallet

Connect your EVM wallet at the dashboard to sign in. No email or password required — your wallet address is your identity.

### 2. Configure a settlement wallet

In Settings → Settlement wallets, add the wallet address where customers will send USDC. This is where funds land directly — JafariPay never holds your money.

### 3. Get your API keys

In API Keys, create a test key pair:
- Publishable key: \`pk_test_...\` — safe for frontend/client code
- Secret key: \`sk_test_...\` — keep on your server only, shown once

### 4. Create a Payment Intent (server-side)

\`\`\`bash
curl -X POST https://your-instance.com/v1/payment-intents \\
  -H "Authorization: Bearer sk_test_..." \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-123-unique-key" \\
  -d '{
    "amount": "25.00",
    "currency": "USDC",
    "order_id": "ORDER-123",
    "description": "Order #123"
  }'
\`\`\`

### 5. Redirect to checkout

\`\`\`javascript
// Redirect your customer to the checkout URL from the response
const { checkout_url } = await createPaymentIntent(...);
window.location.href = checkout_url;
\`\`\`

Or use the SDK:

\`\`\`html
<script src="/sdk.js"></script>
<script>
JafariPay.checkout({
  paymentIntent: "pi_xxx",
  onPaymentSuccess: (data) => {
    window.location.href = "/order-confirmed";
  }
});
</script>
\`\`\`

### 6. Listen for the webhook

\`\`\`javascript
app.post('/webhooks/jafaripay', (req, res) => {
  const sig = req.headers['jafaripay-signature'];
  if (!verifySignature(req.rawBody, sig, WEBHOOK_SECRET)) {
    return res.sendStatus(400);
  }
  const event = req.body;
  if (event.type === 'payment.succeeded') {
    const { order_id } = event.data;
    await markOrderPaid(order_id);
  }
  res.sendStatus(200);
});
\`\`\`

**Important:** Always use the webhook as the source of truth, not the frontend redirect.`,
  },
  auth: {
    title: 'Wallet Authentication',
    body: `## SIWE / EIP-4361 Authentication

JafariPay uses Sign-In With Ethereum (SIWE / EIP-4361) for all merchant authentication. No email or password is ever required.

### How it works

1. **Get a nonce** — \`GET /auth/nonce?address=0x...\` returns a random, short-lived, single-use nonce.

2. **Sign the message** — Your wallet signs a structured message containing the domain, address, chain ID, nonce, issued-at timestamp, and expiration.

3. **Verify and login** — \`POST /auth/verify\` submits the message and signature. The backend verifies the ECDSA signature, checks nonce freshness, and creates a session.

### Security properties

- Nonces are random 32-character strings stored in the database
- Nonces expire after 5 minutes and are deleted after use (single-use)
- Sessions are HTTP-only cookies, never stored in localStorage
- Sessions expire after 24 hours
- Your private key never leaves your wallet

### Merchant identity

Your connected wallet address is your permanent merchant identity. You can configure a different settlement wallet — the settlement wallet receives funds; the login wallet controls the account.`,
  },
  'payment-intents': {
    title: 'Payment Intents',
    body: `## Payment Intents

A Payment Intent represents a customer's intent to pay a specific amount.

### Create a Payment Intent

\`\`\`http
POST /v1/payment-intents
Authorization: Bearer sk_test_...
Idempotency-Key: your-unique-key
Content-Type: application/json

{
  "amount": "25.00",
  "currency": "USDC",
  "order_id": "ORDER-123",
  "description": "Order #123",
  "metadata": { "user_id": "user_456" }
}
\`\`\`

### Idempotency

Always send an \`Idempotency-Key\` header. Sending the same key with the same parameters returns the original result. Sending the same key with different parameters returns a 409 Conflict.

### Immutable fields

Once created, these fields can never change:
- amount
- amount_base_units (exact amount in USDC smallest units)
- currency
- network
- settlement_address (copied from your project at creation time)

This prevents race conditions where a customer pays the original amount but your server has since updated the intent.

### Payment states

| State | Meaning |
|-------|---------|
| \`requires_payment\` | Awaiting customer payment |
| \`processing\` | Transaction submitted, awaiting verification |
| \`succeeded\` | Payment verified on-chain |
| \`failed\` | Verification failed |
| \`expired\` | Payment window closed without payment |
| \`cancelled\` | Cancelled by the merchant |`,
  },
  checkout: {
    title: 'Hosted Checkout',
    body: `## Hosted Checkout

JafariPay provides a hosted checkout page for every Payment Intent.

\`\`\`
https://your-instance.com/checkout/{paymentIntentId}
\`\`\`

The checkout page:
- Displays amount, merchant name, order ID, and network
- Handles wallet connection (MetaMask, WalletConnect, etc.)
- Automatically switches the wallet to Arc
- Sends the USDC ERC-20 transfer to the settlement wallet
- Polls the backend for verification status
- Shows the transaction explorer link on success

### Redirect flow

\`\`\`javascript
// Server-side: create intent
const payment = await jafaripay.paymentIntents.create({
  amount: "25.00",
  currency: "USDC",
  order_id: req.body.orderId,
});

// Redirect customer
res.redirect(payment.checkout_url);
\`\`\`

Do not use the frontend redirect as your payment confirmation. Listen for the \`payment.succeeded\` webhook.`,
  },
  sdk: {
    title: 'JavaScript SDK',
    body: `## JavaScript SDK

\`\`\`html
<script src="https://your-instance.com/sdk.js"></script>
\`\`\`

### JafariPay.checkout()

Opens a checkout modal overlay.

\`\`\`javascript
JafariPay.checkout({
  paymentIntent: "pi_xxx",
  baseUrl: "https://your-instance.com",
  onReady: () => console.log("Checkout ready"),
  onWalletConnected: (address) => console.log("Wallet:", address),
  onPaymentSubmitted: (txHash) => console.log("TX:", txHash),
  onPaymentProcessing: () => console.log("Processing..."),
  onPaymentSuccess: (data) => {
    console.log("Success! Payment:", data.payment_id);
    window.location.href = "/success";
  },
  onPaymentError: (error) => console.error("Error:", error),
  onClose: () => console.log("Closed"),
});
\`\`\`

### JafariPay.mount()

Embeds checkout inside an existing element.

\`\`\`javascript
JafariPay.mount("#checkout-container", {
  paymentIntent: "pi_xxx",
  baseUrl: "https://your-instance.com",
  onPaymentSuccess: (data) => { ... },
});
\`\`\`

### SDK security

The SDK only accepts a Payment Intent ID — never a secret key. Secret keys (\`sk_\`) must never appear in frontend code.`,
  },
  webhooks: {
    title: 'Webhooks',
    body: `## Webhooks

Webhooks deliver signed event notifications to your server.

### Supported events

| Event | When |
|-------|------|
| \`payment.created\` | Payment Intent created |
| \`payment.processing\` | Transaction submitted |
| \`payment.succeeded\` | **Payment fully verified** |
| \`payment.failed\` | Verification failed |
| \`payment.expired\` | Intent expired without payment |

### Event payload

\`\`\`json
{
  "id": "evt_...",
  "type": "payment.succeeded",
  "created": 1735000000,
  "data": {
    "id": "pay_...",
    "payment_intent_id": "pi_...",
    "amount": "25.00",
    "currency": "USDC",
    "order_id": "ORDER-123",
    "tx_hash": "0x...",
    "block_number": 12345,
    "network": "arc_testnet"
  }
}
\`\`\`

### Delivery

- Webhooks are retried with exponential backoff: 30s, 1m, 5m, 30m, 2h, 12h
- Maximum 6 retry attempts
- A 2xx response marks delivery as succeeded
- Use the dashboard to view delivery history and manually retry`,
  },
  'webhook-verification': {
    title: 'Webhook Verification',
    body: `## Verifying Webhook Signatures

Every webhook includes a \`JafariPay-Signature\` header.

### Signature format

\`\`\`
JafariPay-Signature: t=1735000000,v1=a1b2c3...
\`\`\`

- \`t\` — Unix timestamp of the delivery
- \`v1\` — HMAC-SHA256 signature

### Verification algorithm

\`\`\`javascript
import crypto from 'crypto';

function verifyWebhookSignature(rawBody, signature, secret) {
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t=')).slice(2);
  const sig = parts.find(p => p.startsWith('v1=')).slice(3);

  // Replay attack protection — reject events older than 5 minutes
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (age > 300) throw new Error('Timestamp too old');

  const payload = timestamp + '.' + rawBody;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(sig, 'hex'),
    Buffer.from(expected, 'hex')
  );
}
\`\`\`

**Always use the raw request body** (before JSON parsing) for signature verification.

**Always use \`crypto.timingSafeEqual\`** to prevent timing attacks.

**Reject events older than 5 minutes** to prevent replay attacks.`,
  },
  'test-mode': {
    title: 'Test Mode',
    body: `## Test Mode

Test mode uses Arc Testnet (Chain ID: 5042002).

- Use \`pk_test_\` and \`sk_test_\` API keys
- Payments use real Arc Testnet transactions (not simulated)
- USDC at \`0x3600000000000000000000000000000000000000\` on Arc Testnet
- Get free test USDC from https://faucet.circle.com

Test and live data are completely isolated. You cannot accidentally mix test payments with live payments.

### End-to-end test flow

1. Create a project in test mode
2. Get test USDC from the faucet
3. Create a Payment Intent with a test sk_ key
4. Open the checkout URL
5. Connect your wallet, switch to Arc Testnet, pay
6. Watch the dashboard — the payment should appear as succeeded within 10-30 seconds
7. Check your webhook delivery log

This is a real blockchain transaction. You can verify it on https://explorer.testnet.arc.io`,
  },
  production: {
    title: 'Production',
    body: `## Production / Live Mode

Live mode uses Arc Mainnet (Chain ID: 5042).

- Set \`ENABLE_LIVE_PAYMENTS=true\` in your server environment
- Use \`pk_live_\` and \`sk_live_\` API keys
- Never fall back to testnet in production

### Checklist before going live

- [ ] Webhook signature verification implemented and tested
- [ ] Settlement wallet address verified (triple-check it — payments go directly there)
- [ ] All test API keys removed from production code
- [ ] \`ENABLE_LIVE_PAYMENTS=true\` set in production environment
- [ ] Rate limits and error handling tested
- [ ] Webhook retry handling tested (your endpoint should be idempotent)

### Never mix environments

Live and test keys are clearly prefixed (\`sk_live_\` vs \`sk_test_\`). If you accidentally use a live key in test code, the API will return a 400 error explaining the mismatch.`,
  },
  security: {
    title: 'Security',
    body: `## Security

### Non-custodial design

USDC is transferred directly from the customer to your settlement wallet address on Arc. JafariPay never holds funds — there is no JafariPay wallet to compromise.

### Secret key handling

- Secret keys (\`sk_\`) are hashed (bcrypt) in the database — plaintext is never stored
- Keys are shown only once at creation
- Revoke keys immediately if compromised
- Never use \`sk_\` keys in frontend/browser code

### Webhook security

- All webhooks are HMAC-SHA256 signed
- Verify signatures before processing
- Reject events older than 5 minutes (replay protection)
- Use \`crypto.timingSafeEqual\` (not \`===\`) for comparison

### Payment verification

The backend independently verifies every payment by:
1. Fetching the transaction receipt from Arc RPC
2. Confirming the correct Arc network (chain ID)
3. Decoding the ERC-20 Transfer event
4. Verifying the token contract address matches configured USDC
5. Verifying the recipient matches the settlement wallet
6. Verifying the exact amount matches in base units (no floating point)
7. Checking the transaction has not been used for another payment
8. Using database constraints + row locking to prevent duplicate crediting

No frontend-reported payment status is trusted.

### SSRF protection

Webhook URLs are validated to prevent SSRF attacks. Private IP ranges, localhost, and link-local addresses are blocked.`,
  },
  api: {
    title: 'API Reference',
    body: `## API Reference

Base URL: \`https://your-instance.com/v1\`

Authentication: \`Authorization: Bearer sk_test_...\` or \`Authorization: Bearer sk_live_...\`

---

### Payment Intents

\`\`\`
POST /v1/payment-intents
GET  /v1/payment-intents/:id
POST /v1/payment-intents/:id/cancel
POST /v1/payment-intents/:id/verify
\`\`\`

### Payments

\`\`\`
GET /v1/payments
GET /v1/payments/:id
\`\`\`

### Projects

\`\`\`
GET  /v1/projects
POST /v1/projects
GET  /v1/projects/:id
\`\`\`

### API Keys

\`\`\`
GET    /v1/api-keys
POST   /v1/api-keys
DELETE /v1/api-keys/:id
\`\`\`

### Webhook Endpoints

\`\`\`
GET    /v1/webhook-endpoints
POST   /v1/webhook-endpoints
PATCH  /v1/webhook-endpoints/:id
DELETE /v1/webhook-endpoints/:id
\`\`\`

### Webhook Deliveries

\`\`\`
GET  /v1/webhook-deliveries
POST /v1/webhook-deliveries/:id/retry
\`\`\`

### Settlement Wallets

\`\`\`
GET    /v1/settlement-wallets
POST   /v1/settlement-wallets
DELETE /v1/settlement-wallets/:id
\`\`\`

---

See OpenAPI spec at \`/docs/openapi.json\`.`,
  },
  troubleshooting: {
    title: 'Troubleshooting',
    body: `## Troubleshooting

### Payment stuck in "processing"

The blockchain verifier polls for the transaction. If the RPC is slow, it may take up to 60 seconds. If the payment stays in processing after 5 minutes, check:
- Is the transaction confirmed on the Arc explorer?
- Did you send to the correct settlement wallet address?
- Did you send the exact amount?

### Webhook not received

1. Check the webhook delivery log in the dashboard
2. Ensure your endpoint returns 2xx within 10 seconds
3. Check for SSRF blocks — webhook URLs must be public, not localhost or private IPs
4. Try the manual retry button

### Signature verification fails

- Ensure you're using the **raw** request body (before parsing)
- Check you're using the webhook secret from when the endpoint was created (shown once)
- Verify timestamp tolerance — clocks must be within ~5 minutes

### Wrong network error

Ensure:
- Your project is set to the correct environment (test vs live)
- The customer switched their wallet to Arc (Testnet or Mainnet)
- You're using the matching API key (\`pk_test_\` for test, \`pk_live_\` for live)

### Invalid amount

Amounts must be positive decimal strings: \`"25.00"\`, \`"1.50"\`, \`"100"\`. Do not pass numbers, null, or floating-point values.`,
  },
};

export default function DocsPage() {
  const { slug } = useParams<{ slug?: string }>();
  const currentSlug = slug || 'quickstart';
  const content = CONTENT[currentSlug] || CONTENT.quickstart;

  return (
    <div className="min-h-dvh bg-[#080d1a] text-white" style={{ fontFamily: "'DM Sans', sans-serif" }}>
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-white/8 max-w-screen-xl mx-auto">
        <Link to="/" className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-blue-500 flex items-center justify-center">
            <Zap size={12} className="text-white" fill="white" />
          </div>
          <span className="font-semibold text-sm tracking-tight">JafariPay</span>
          <span className="text-slate-600 text-sm ml-1">/ Docs</span>
        </Link>
        <Link to="/dashboard" className="text-sm text-slate-400 hover:text-white transition-colors flex items-center gap-1">
          Dashboard <ArrowRight size={12} />
        </Link>
      </nav>

      <div className="max-w-screen-xl mx-auto flex">
        {/* Sidebar */}
        <aside className="w-56 px-4 py-8 flex-shrink-0 sticky top-0 h-screen overflow-y-auto">
          <nav className="space-y-0.5">
            {NAV.map(({ slug: s, label, icon: Icon }) => (
              <Link key={s} to={`/docs/${s}`}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-all ${currentSlug === s ? 'bg-blue-500/10 text-blue-400' : 'text-slate-400 hover:text-slate-200 hover:bg-white/4'}`}>
                <Icon size={13} />
                {label}
              </Link>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <main className="flex-1 px-8 py-8 max-w-3xl">
          <h1 className="text-3xl font-bold mb-6" style={{ letterSpacing: '-0.02em', fontFamily: "'Space Grotesk', sans-serif" }}>
            {content.title}
          </h1>
          <div className="prose-jafaripay space-y-4 text-slate-300 text-sm leading-relaxed">
            {content.body.split('\n').map((line, i) => {
              if (line.startsWith('### ')) return <h3 key={i} className="text-base font-semibold text-white mt-6 mb-2">{line.slice(4)}</h3>;
              if (line.startsWith('## ')) return <h2 key={i} className="text-xl font-bold text-white mt-8 mb-3" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{line.slice(3)}</h2>;
              if (line.startsWith('```')) return null;
              if (line.startsWith('| ')) {
                return <div key={i} className="font-mono text-xs text-slate-400">{line}</div>;
              }
              if (line.startsWith('- ')) return <li key={i} className="ml-4 text-slate-400">{line.slice(2)}</li>;
              if (line.startsWith('- [ ] ')) return <li key={i} className="ml-4 text-slate-400 list-none">☐ {line.slice(6)}</li>;
              if (line.trim() === '') return <div key={i} className="h-1" />;
              return <p key={i} className="text-slate-400">{line}</p>;
            })}
          </div>
          {/* Code blocks rendered separately */}
          <div className="mt-8 space-y-4">
            {content.body.split('\n```').filter((_, i) => i % 2 === 1).map((block, i) => {
              const lines = block.split('\n');
              const lang = lines[0] || 'code';
              const code = lines.slice(1).join('\n');
              return (
                <div key={i} className="rounded-xl bg-[#080d1a] border border-white/8 overflow-hidden">
                  <div className="px-4 py-2 border-b border-white/6 text-xs text-slate-600 font-mono">{lang}</div>
                  <pre className="p-4 text-xs font-mono text-slate-300 overflow-x-auto leading-relaxed">{code}</pre>
                </div>
              );
            })}
          </div>
        </main>
      </div>
    </div>
  );
}
