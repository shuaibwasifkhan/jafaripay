import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CopyButton } from '../shared/CopyButton';
import {
  ArrowRight,
  BookOpen,
  Calendar,
  Code2,
  CreditCard,
  FileText,
  Github,
  Globe,
  Info,
  KeyRound,
  Mail,
  Menu,
  Search,
  Shield,
  ShieldCheck,
  TestTube,
  TriangleAlert,
  Webhook,
  X,
  Zap,
} from 'lucide-react';

const NAV = [
  { slug: 'quickstart', label: 'Quickstart', icon: Zap },
  { slug: 'auth', label: 'Authentication', icon: KeyRound },
  { slug: 'payment-intents', label: 'Payment Intents', icon: CreditCard },
  { slug: 'checkout', label: 'Checkout', icon: BookOpen },
  { slug: 'sdk', label: 'JavaScript SDK', icon: Code2 },
  { slug: 'webhooks', label: 'Webhooks', icon: Webhook },
  { slug: 'webhook-verification', label: 'Webhook Verification', icon: ShieldCheck },
  { slug: 'test-mode', label: 'Test Mode', icon: TestTube },
  { slug: 'production', label: 'Production', icon: Globe },
  { slug: 'security', label: 'Security', icon: Shield },
  { slug: 'api', label: 'API Reference', icon: FileText },
  { slug: 'error-codes', label: 'Error Codes', icon: TriangleAlert },
  { slug: 'troubleshooting', label: 'Troubleshooting', icon: Search },
  { slug: 'changelog', label: 'Changelog', icon: Calendar },
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
  'error-codes': {
    title: 'Error Codes',
    body: `## Error Codes

Every API error returns a consistent JSON body. Most errors include a machine-readable \`code\` field alongside the human-readable message:

\`\`\`json
{
  "error": "Invalid API key",
  "code": "auth.invalid_api_key"
}
\`\`\`

Retryable errors are flagged with \`"retryable": true\` — today the only case is the 503 returned when the blockchain RPC is unavailable. Use the filter below to find the status code you received.`,
  },
  changelog: {
    title: 'Changelog',
    body: `## Changelog

Platform updates for the JafariPay stack, listed newest first. Each entry reflects a shipped change.`,
  },
};

const GITHUB_URL = 'https://github.com/shuaibwasifkhan/jafaripay';
const SUPPORT_EMAIL = 'dev@jafari.co.in';

const NAV_GROUPS: Array<{ label: string; items: string[] }> = [
  { label: 'Getting Started', items: ['quickstart', 'auth', 'test-mode'] },
  { label: 'Payments', items: ['payment-intents', 'checkout', 'sdk'] },
  { label: 'Integrations', items: ['webhooks', 'webhook-verification', 'api', 'error-codes'] },
  { label: 'Operations', items: ['production', 'security', 'troubleshooting', 'changelog'] },
];

const SUBTITLES: Record<string, string> = {
  quickstart: 'Create your first payment in 5 minutes.',
  auth: 'Sign-In With Ethereum (SIWE / EIP-4361) — no email or password, your wallet address is your identity.',
  'payment-intents': 'A Payment Intent represents a customer’s intent to pay a specific amount.',
  checkout: 'A hosted checkout page for every Payment Intent — connect, pay, verify.',
  sdk: 'Open or embed the JafariPay checkout in your frontend.',
  webhooks: 'Signed event notifications delivered to your server.',
  'webhook-verification': 'HMAC-SHA256 signature verification for every webhook delivery.',
  'test-mode': 'Develop against Arc Testnet with real USDC transactions.',
  production: 'Go live on Arc Mainnet with a verified, secure setup.',
  security: 'How JafariPay keeps payments, keys, and data safe.',
  api: 'REST API for Payment Intents, payments, projects, and more.',
  'error-codes': 'Every status code the API can return — and how to fix it.',
  troubleshooting: 'Common issues, their causes, and how to resolve them.',
  changelog: 'Platform updates, listed newest first.',
};

const CHANGELOG_ENTRIES: Array<{ date: string; items: Array<{ tag: 'New' | 'Fixed' | 'Improved' | 'Docs'; text: string }> }> = [
  {
    date: '2026-09-26',
    items: [{ tag: 'Improved', text: 'Redesigned the frontend with a premium light fintech UI' }],
  },
  {
    date: '2026-09-23',
    items: [
      { tag: 'Fixed', text: 'Allowed Arc network RPC through the content security policy' },
      { tag: 'Fixed', text: 'Added a bounded payment settlement grace period' },
      { tag: 'Docs', text: 'Upgraded the README for the Arc OSS showcase' },
    ],
  },
  {
    date: '2026-09-22',
    items: [
      { tag: 'New', text: 'Arc Mainnet production support (live environment)' },
      { tag: 'Fixed', text: 'Completed the Arc USDC payment end-to-end flow' },
      { tag: 'Improved', text: 'Polished production UI inputs' },
    ],
  },
];

const ERROR_GROUPS: Array<{
  status: number;
  label: string;
  tone: 'red' | 'amber' | 'slate';
  note?: string;
  rows: Array<{ code: string | null; message: string; guidance: string }>;
}> = [
  {
    status: 400,
    label: 'Bad Request',
    tone: 'red',
    rows: [
      { code: null, message: 'amount is required', guidance: 'Include an amount as a positive decimal string, e.g. "25.00".' },
      { code: null, message: 'Only USDC is supported', guidance: 'JafariPay settles exclusively in USDC.' },
      { code: null, message: 'Invalid amount', guidance: 'Send decimal strings ("25.00", "1.50", "100") — never numbers, null, or floating-point values.' },
      { code: null, message: 'name is required', guidance: 'Include a name when creating the project.' },
      { code: null, message: 'environment must be test or live', guidance: 'The environment field only accepts "test" or "live".' },
      { code: null, message: 'type must be public or secret', guidance: 'API key types are "public" (pk_) or "secret" (sk_).' },
      { code: null, message: 'address is required', guidance: 'Include the wallet address.' },
      { code: null, message: 'Invalid Ethereum address / Not a valid EVM address', guidance: 'Check that the address is a valid EVM address (0x + 40 hex characters).' },
      { code: null, message: 'url is required', guidance: 'Include the webhook endpoint URL.' },
      { code: null, message: 'Invalid URL', guidance: 'Use a well-formed public HTTPS URL.' },
      { code: null, message: 'Private/local URLs are blocked (SSRF protection)', guidance: 'Webhook URLs must be public — localhost and private IP ranges are blocked.' },
      { code: null, message: 'tx_hash is required', guidance: 'Pass the transaction hash to verify a payment.' },
      { code: null, message: 'tx_hash must be a valid 32-byte hex hash (0x + 64 hex characters)', guidance: 'Send the full ERC-20 transfer transaction hash.' },
      { code: null, message: 'Payment intent is in "{state}" state', guidance: 'Check the intent’s current state before calling the operation.' },
      { code: null, message: 'Cannot cancel in "{state}" state', guidance: 'Intents can only be cancelled while pending.' },
      { code: 'setup.no_settlement_wallet', message: 'No settlement wallet configured. Add one in the dashboard.', guidance: 'Add a settlement wallet before creating payments.' },
      { code: null, message: 'Settlement wallet not found or wrong network', guidance: 'The configured settlement wallet must match the project environment’s network.' },
      { code: null, message: 'message, signature, and address are required', guidance: 'SIWE verification requires all three fields.' },
      { code: null, message: 'Could not extract nonce from message', guidance: 'Sign a fresh SIWE message — the nonce must be embedded in it.' },
    ],
  },
  {
    status: 401,
    label: 'Unauthorized',
    tone: 'amber',
    note: 'Authentication problems — missing, invalid, or expired credentials.',
    rows: [
      { code: 'auth.missing_api_key', message: 'API key required', guidance: 'Send the key as Authorization: Bearer pk_... / sk_... (or X-Api-Key).' },
      { code: 'auth.invalid_api_key', message: 'Invalid API key', guidance: 'Verify the key exists and matches the environment (test vs live).' },
      { code: 'auth.required', message: 'Authentication required', guidance: 'This route requires either a session or an API key.' },
      { code: 'auth.missing_session', message: 'Unauthorized', guidance: 'No session cookie — sign in via the wallet flow.' },
      { code: 'auth.invalid_session', message: 'Unauthorized', guidance: 'Session expired (24h) or was revoked — sign in again.' },
      { code: 'auth.signature_invalid', message: 'Invalid signature or expired nonce', guidance: 'Re-request a nonce and sign the fresh SIWE message — nonces expire after 5 minutes.' },
    ],
  },
  {
    status: 403,
    label: 'Forbidden',
    tone: 'amber',
    note: 'The credential is valid, but it is not allowed to do this.',
    rows: [
      { code: 'auth.public_key_not_allowed', message: 'This endpoint requires a secret key', guidance: 'Use an sk_ key for write operations — pk_ keys are read-only.' },
      { code: 'auth.live_disabled', message: 'Live payments are not enabled', guidance: 'Set ENABLE_LIVE_PAYMENTS=true on the server.' },
      { code: null, message: 'Live mode is not enabled', guidance: 'Creating live-mode resources requires ENABLE_LIVE_PAYMENTS=true.' },
      { code: null, message: 'Live mode not enabled. Set ENABLE_LIVE_PAYMENTS=true.', guidance: 'The deployment has not enabled the live environment.' },
    ],
  },
  {
    status: 404,
    label: 'Not Found',
    tone: 'slate',
    rows: [
      { code: null, message: 'Payment intent not found', guidance: 'Check the payment intent ID and the environment it belongs to.' },
      { code: null, message: 'Payment not found', guidance: 'Check the payment ID and environment.' },
      { code: null, message: 'Project not found', guidance: 'Check the project ID and environment.' },
      { code: null, message: 'API key not found', guidance: 'Check the key ID and environment.' },
      { code: null, message: 'Delivery not found', guidance: 'Check the webhook delivery ID.' },
      { code: null, message: 'Merchant not found', guidance: 'The signed-in merchant no longer exists in this environment.' },
    ],
  },
  {
    status: 409,
    label: 'Conflict',
    tone: 'slate',
    rows: [
      { code: 'idempotency.conflict', message: 'Idempotency key reused with different request', guidance: 'The same key with the same parameters safely returns the original result; different parameters conflict.' },
      { code: null, message: 'Address already registered for this network', guidance: 'A settlement wallet for this address already exists on the network.' },
      { code: null, message: 'Active payment intents reference this wallet', guidance: 'Settlement wallets with active intents cannot be deleted.' },
    ],
  },
  {
    status: 422,
    label: 'Unprocessable Entity',
    tone: 'red',
    note: 'Payment verification finished, and the on-chain result was a failure.',
    rows: [
      { code: null, message: 'Payment verification failed', guidance: 'The response body includes the failure reason — e.g. wrong amount, wrong recipient, or an already-used transaction.' },
    ],
  },
  {
    status: 503,
    label: 'Service Unavailable',
    tone: 'slate',
    note: 'Retryable — the response sets "retryable": true.',
    rows: [
      { code: null, message: 'Blockchain RPC error — please retry', guidance: 'The Arc RPC node was unreachable. Back off and retry; do not mark the payment failed on a 503.' },
    ],
  },
];

/* ---------- docs rendering helpers ---------- */

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/g).filter(Boolean);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('`')) {
      return (
        <code key={key} className="rounded-md border border-sand-200 bg-sand-100/80 px-1.5 py-0.5 font-mono text-[0.85em] text-forest-800">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**')) {
      return <strong key={key} className="font-semibold text-ink">{part.slice(2, -2)}</strong>;
    }
    if (/^https?:\/\//.test(part)) {
      return (
        <a key={key} href={part} target="_blank" rel="noopener noreferrer" className="font-medium text-forest-700 underline decoration-forest-300 underline-offset-4 hover:text-forest-600">
          {part}
        </a>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

type MBlock =
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'list'; items: string[]; ordered: boolean; tasks: boolean }
  | { kind: 'hr' }
  | { kind: 'p'; text: string };

function parseBlocks(body: string): MBlock[] {
  const lines = body.split('\n');
  const blocks: MBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') { i += 1; continue; }
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i += 1; }
      i += 1;
      blocks.push({ kind: 'code', lang, code: buf.join('\n') });
      continue;
    }
    if (trimmed.startsWith('### ')) { blocks.push({ kind: 'h3', text: trimmed.slice(4) }); i += 1; continue; }
    if (trimmed.startsWith('## ')) { blocks.push({ kind: 'h2', text: trimmed.slice(3) }); i += 1; continue; }
    if (trimmed === '---') { blocks.push({ kind: 'hr' }); i += 1; continue; }
    if (trimmed.startsWith('|')) {
      const tbl: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { tbl.push(lines[i].trim()); i += 1; }
      const parseRow = (row: string) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = parseRow(tbl[0]);
      const rows = tbl.slice(1).filter((row) => !/^[\s|:-]+$/.test(row)).map(parseRow);
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    const isTask = /^\s*- \[ \] /.test(line);
    const isBullet = /^\s*[-*]\s+/.test(line);
    const isOrdered = /^\s*\d+\. /.test(line);
    if (isTask || isBullet) {
      const items: string[] = [];
      while (i < lines.length && (/^\s*- \[ \] /.test(lines[i]) || /^\s*[-*]\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*- \[ \] /, '').replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'list', items, ordered: false, tasks: isTask });
      continue;
    }
    if (isOrdered) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\. /, ''));
        i += 1;
      }
      blocks.push({ kind: 'list', items, ordered: true, tasks: false });
      continue;
    }
    blocks.push({ kind: 'p', text: trimmed });
    i += 1;
  }
  return blocks;
}

type CalloutSpec = { tone: 'info' | 'warn' | 'security'; title: string; rest: string };

function calloutFor(text: string): CalloutSpec | null {
  let t = text.trim();
  if (/^[-*]\s+/.test(t)) t = t.replace(/^[-*]\s+/, '').trim();
  if (t.startsWith('**Important:**')) return { tone: 'info', title: 'Important', rest: t.slice('**Important:**'.length).trim() };
  if (/^\*\*(Always|Never|Reject)\b/.test(t)) return { tone: 'security', title: 'Security', rest: t };
  if (/^Do not /.test(t)) return { tone: 'warn', title: 'Security', rest: t };
  return null;
}

const CALLOUT_STYLES = {
  info: { box: 'border-forest-200 bg-forest-50/70', chip: 'bg-forest-100 text-forest-700', Icon: Info },
  warn: { box: 'border-gold-200 bg-gold-50', chip: 'bg-gold-100 text-gold-700', Icon: TriangleAlert },
  security: { box: 'border-lilac-200 bg-lilac-50', chip: 'bg-lilac-100 text-lilac-700', Icon: ShieldCheck },
};

function CalloutBox({ tone, title, children }: { tone: 'info' | 'warn' | 'security'; title: string; children: ReactNode }) {
  const s = CALLOUT_STYLES[tone];
  return (
    <div className={`rounded-2xl border p-4 ${s.box}`}>
      <div className="mb-2 flex items-center gap-2.5">
        <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${s.chip}`}>
          <s.Icon size={14} />
        </span>
        <span className="text-[11px] font-bold uppercase tracking-wider text-ink/55">{title}</span>
      </div>
      <div className="text-sm leading-6 text-ink/75">{children}</div>
    </div>
  );
}

function CodeCard({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-ink/60 bg-ink shadow-soft">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-slate-400">{lang || 'code'}</span>
        <CopyButton value={code} className="px-2.5 py-1 text-[11px]" />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-6 text-cream-100">{code}</pre>
    </div>
  );
}

const METHOD_STYLES: Record<string, string> = {
  GET: 'border-forest-200 bg-forest-50 text-forest-700',
  POST: 'border-teal-200 bg-teal-50 text-teal-700',
  PATCH: 'border-gold-200 bg-gold-50 text-gold-700',
  DELETE: 'border-red-200 bg-red-50 text-red-600',
  PUT: 'border-lilac-200 bg-lilac-50 text-lilac-700',
};

function EndpointList({ code }: { code: string }) {
  const rows = code
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(GET|POST|PATCH|DELETE|PUT)\s+(\S+)$/);
      return m ? { method: m[1], path: m[2] } : null;
    })
    .filter((r): r is { method: string; path: string } => r !== null);

  if (rows.length === 0) return <CodeCard lang="" code={code} />;

  return (
    <div className="divide-y divide-sand-100 overflow-hidden rounded-2xl border border-sand-200 bg-white shadow-soft">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-sand-50/70">
          <span className={`w-16 shrink-0 rounded-lg border px-2 py-1 text-center font-mono text-[11px] font-bold ${METHOD_STYLES[row.method] ?? METHOD_STYLES.PUT}`}>
            {row.method}
          </span>
          <code className="font-mono text-[13px] text-ink/80">{row.path}</code>
        </div>
      ))}
    </div>
  );
}

function TableBlock({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-sand-200 bg-white shadow-soft">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-sand-200 bg-sand-100/80">
              {head.map((h, i) => (
                <th key={i} className="whitespace-nowrap px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink/50">
                  {renderInline(h, `th-${i}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-100">
            {rows.map((row, ri) => (
              <tr key={ri} className="transition-colors hover:bg-sand-50/50">
                {row.map((cell, ci) => (
                  <td key={ci} className="align-top px-4 py-3 text-ink/70">
                    {renderInline(cell, `td-${ri}-${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BlockView({ block, pageSlug, pageTitle }: { block: MBlock; pageSlug: string; pageTitle: string }) {
  switch (block.kind) {
    case 'h2':
      if (block.text === pageTitle) return null;
      return (
        <h2 id={slugify(block.text)} className="mt-12 mb-1 scroll-mt-24 border-b border-sand-200 pb-3 font-display text-[22px] font-bold tracking-tight text-ink">
          {block.text}
        </h2>
      );
    case 'h3':
      return (
        <h3 id={slugify(block.text)} className="mt-8 scroll-mt-24 font-display text-lg font-semibold text-ink">
          {block.text}
        </h3>
      );
    case 'hr':
      return (
        <div className="my-4 flex items-center gap-2">
          <span className="h-px flex-1 bg-sand-200" />
          <span className="h-1.5 w-1.5 rotate-45 bg-sand-300" />
          <span className="h-px flex-1 bg-sand-200" />
        </div>
      );
    case 'code': {
      const isEndpointList = pageSlug === 'api' && block.code
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .every((l) => /^(GET|POST|PATCH|DELETE|PUT)\s+\S+$/.test(l));
      return isEndpointList ? <EndpointList code={block.code} /> : <CodeCard lang={block.lang} code={block.code} />;
    }
    case 'table':
      return <TableBlock head={block.head} rows={block.rows} />;
    case 'list': {
      if (block.tasks) {
        return (
          <div className="space-y-3 rounded-2xl border border-sand-200 bg-white p-5 shadow-soft">
            {block.items.map((item, i) => (
              <div key={i} className="flex items-start gap-3">
                <span className="mt-0.5 h-4 w-4 shrink-0 rounded-md border-2 border-sand-300 bg-white" />
                <span className="text-sm leading-6 text-ink/70">{renderInline(item, `task-${i}`)}</span>
              </div>
            ))}
          </div>
        );
      }
      if (block.ordered) {
        return (
          <ol className="space-y-3">
            {block.items.map((item, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-forest-200 bg-forest-50 text-[11px] font-bold text-forest-700">
                  {i + 1}
                </span>
                <span className="text-sm leading-6 text-ink/70">{renderInline(item, `ol-${i}`)}</span>
              </li>
            ))}
          </ol>
        );
      }
      return (
        <ul className="space-y-2.5">
          {block.items.map((item, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-forest-500" />
              <span className="text-sm leading-6 text-ink/70">{renderInline(item, `ul-${i}`)}</span>
            </li>
          ))}
        </ul>
      );
    }
    case 'p': {
      const spec = calloutFor(block.text);
      if (spec) return <CalloutBox tone={spec.tone} title={spec.title}>{renderInline(spec.rest, 'co')}</CalloutBox>;
      return <p className="text-sm leading-7 text-ink/70">{renderInline(block.text, 'p')}</p>;
    }
  }
}

/* ---------- per-page presentation blocks ---------- */

const QUICKSTART_STEPS = ['Set up wallet', 'Get API keys', 'Create payment', 'Accept payment', 'Verify on-chain'];

function QuickstartSteps() {
  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-5 shadow-soft">
      <div className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-ink/35">Five steps to your first payment</div>
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-3">
        {QUICKSTART_STEPS.map((step, i) => (
          <li key={i} className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-forest-600 text-xs font-bold text-white shadow-glow">{i + 1}</span>
            <span className="text-sm font-medium text-ink/80">{step}</span>
            {i < QUICKSTART_STEPS.length - 1 && <span className="h-px w-6 bg-sand-300" />}
          </li>
        ))}
      </ol>
    </div>
  );
}

const STATUS_PATH = [
  { label: 'requires_payment', cls: 'border-sand-300 bg-sand-100 text-ink/70' },
  { label: 'processing', cls: 'border-gold-200 bg-gold-50 text-gold-700' },
  { label: 'succeeded', cls: 'border-forest-200 bg-forest-50 text-forest-700' },
];

const TERMINAL_STATES = [
  { label: 'succeeded', cls: 'border-forest-200 bg-forest-50 text-forest-700' },
  { label: 'failed', cls: 'border-red-200 bg-red-50 text-red-600' },
  { label: 'expired', cls: 'border-sand-300 bg-sand-100 text-ink/50' },
  { label: 'cancelled', cls: 'border-lilac-200 bg-lilac-50 text-lilac-700' },
];

function StatusFlowCard() {
  return (
    <div className="space-y-4 rounded-2xl border border-sand-200 bg-white p-5 shadow-soft">
      <div>
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink/35">Happy path</div>
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_PATH.map((s, i) => (
            <Fragment key={s.label}>
              <span className={`rounded-lg border px-2.5 py-1 font-mono text-xs font-medium ${s.cls}`}>{s.label}</span>
              {i < STATUS_PATH.length - 1 && <ArrowRight size={13} className="text-ink/30" />}
            </Fragment>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink/35">Terminal states</div>
        <div className="flex flex-wrap gap-2">
          {TERMINAL_STATES.map((s) => (
            <span key={s.label} className={`rounded-lg border px-2.5 py-1 font-mono text-xs font-medium ${s.cls}`}>{s.label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

const API_SECTIONS = ['Payment Intents', 'Payments', 'Projects', 'API Keys', 'Webhook Endpoints', 'Webhook Deliveries', 'Settlement Wallets'];

function ApiChips() {
  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-5 shadow-soft">
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink/35">On this page</div>
      <div className="flex flex-wrap gap-2">
        {API_SECTIONS.map((s) => (
          <a key={s} href={`#${slugify(s)}`} className="rounded-full border border-sand-300 bg-sand-50 px-3 py-1.5 text-xs font-medium text-ink/60 transition-colors hover:border-forest-300 hover:bg-forest-50 hover:text-forest-700">
            {s}
          </a>
        ))}
      </div>
    </div>
  );
}

const CHANGELOG_TAG_STYLES: Record<string, string> = {
  New: 'border-forest-200 bg-forest-50 text-forest-700',
  Fixed: 'border-gold-200 bg-gold-50 text-gold-700',
  Improved: 'border-teal-200 bg-teal-50 text-teal-700',
  Docs: 'border-lilac-200 bg-lilac-50 text-lilac-700',
};

function ChangelogTimeline() {
  return (
    <div className="relative space-y-8 pl-6">
      <span className="absolute top-2 bottom-2 left-[7px] w-px bg-sand-300" />
      {CHANGELOG_ENTRIES.map((entry) => (
        <div key={entry.date} className="relative">
          <span className="absolute top-0.5 -left-6 flex h-4 w-4 items-center justify-center rounded-full border-2 border-forest-500 bg-white">
            <span className="h-1.5 w-1.5 rounded-full bg-forest-500" />
          </span>
          <div className="mb-2 font-mono text-sm font-semibold text-ink">{entry.date}</div>
          <div className="space-y-2">
            {entry.items.map((item, i) => (
              <div key={i} className="flex items-start gap-3 rounded-xl border border-sand-200 bg-white px-4 py-3 shadow-soft">
                <span className={`mt-0.5 shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${CHANGELOG_TAG_STYLES[item.tag]}`}>{item.tag}</span>
                <p className="text-sm leading-6 text-ink/70">{item.text}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const ERROR_TONE_STYLES = {
  red: 'border-red-200 bg-red-50 text-red-600',
  amber: 'border-gold-200 bg-gold-50 text-gold-700',
  slate: 'border-sand-300 bg-sand-100 text-ink/60',
};

function ErrorsExplorer() {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const visible = ERROR_GROUPS
    .map((g) => ({
      ...g,
      rows: g.rows.filter((r) => !q || [`${g.status} ${g.label}`, r.message, r.code ?? '', r.guidance].join(' ').toLowerCase().includes(q)),
    }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="space-y-4">
      <div className="relative max-w-md">
        <Search size={14} className="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink/30" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search codes, messages, or fixes…"
          className="w-full rounded-xl border border-sand-300 bg-white py-2.5 pr-3 pl-9 text-sm text-ink shadow-soft placeholder:text-ink/30 focus:border-forest-400 focus:ring-2 focus:ring-forest-500/20 focus:outline-none"
        />
      </div>
      {visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-sand-300 bg-white p-8 text-center text-sm text-ink/45">No matching error codes.</div>
      ) : (
        visible.map((group) => (
          <div key={group.status} className="overflow-hidden rounded-2xl border border-sand-200 bg-white shadow-soft">
            <div className="flex flex-wrap items-center gap-3 border-b border-sand-100 bg-sand-50/60 px-5 py-3.5">
              <span className={`rounded-lg border px-2.5 py-1 font-mono text-sm font-bold ${ERROR_TONE_STYLES[group.tone]}`}>{group.status}</span>
              <span className="text-sm font-semibold text-ink">{group.label}</span>
              {group.note && <span className="text-xs text-ink/45">{group.note}</span>}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-sand-100 text-[11px] uppercase tracking-wider text-ink/40">
                    <th className="px-5 py-2.5 font-semibold">Code</th>
                    <th className="px-5 py-2.5 font-semibold">Message</th>
                    <th className="px-5 py-2.5 font-semibold">What to do</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-sand-100">
                  {group.rows.map((row, i) => (
                    <tr key={i} className="transition-colors hover:bg-sand-50/50">
                      <td className="px-5 py-3 align-top whitespace-nowrap">
                        {row.code ? (
                          <code className="rounded-md border border-sand-200 bg-sand-100/80 px-1.5 py-0.5 font-mono text-xs text-forest-800">{row.code}</code>
                        ) : (
                          <span className="text-ink/30">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 align-top text-ink/75">{row.message}</td>
                      <td className="px-5 py-3 align-top text-ink/55">{row.guidance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function PrevNext({ slug }: { slug: string }) {
  const idx = NAV.findIndex((n) => n.slug === slug);
  const prev = idx > 0 ? NAV[idx - 1] : null;
  const next = idx >= 0 && idx < NAV.length - 1 ? NAV[idx + 1] : null;
  return (
    <div className="mt-12 grid gap-3 sm:grid-cols-2">
      {prev ? (
        <Link to={`/docs/${prev.slug}`} className="group rounded-2xl border border-sand-200 bg-white p-4 shadow-soft transition-all hover:border-forest-300">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink/35">Previous</div>
          <div className="mt-1 flex items-center gap-1 text-sm font-semibold text-ink group-hover:text-forest-700">
            <ArrowRight size={13} className="rotate-180" /> {prev.label}
          </div>
        </Link>
      ) : (
        <div />
      )}
      {next ? (
        <Link to={`/docs/${next.slug}`} className="group rounded-2xl border border-sand-200 bg-white p-4 text-right shadow-soft transition-all hover:border-forest-300">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink/35">Next</div>
          <div className="mt-1 flex items-center justify-end gap-1 text-sm font-semibold text-ink group-hover:text-forest-700">
            {next.label} <ArrowRight size={13} />
          </div>
        </Link>
      ) : (
        <div />
      )}
    </div>
  );
}

/* ---------- shell components ---------- */

function SidebarNav({ active, onNavigate }: { active: string; onNavigate?: () => void }) {
  return (
    <nav className="space-y-5">
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-ink/35">{group.label}</div>
          <div className="space-y-0.5">
            {group.items.map((s) => {
              const meta = NAV.find((n) => n.slug === s) ?? NAV[0];
              const Icon = meta.icon;
              const isActive = active === s;
              return (
                <Link
                  key={s}
                  to={`/docs/${s}`}
                  onClick={onNavigate}
                  className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-[13px] transition-all ${
                    isActive
                      ? 'border-forest-100 bg-forest-50 font-semibold text-forest-800'
                      : 'border-transparent text-ink/55 hover:bg-sand-100/70 hover:text-ink'
                  }`}
                >
                  <Icon size={14} className={isActive ? 'text-forest-600' : 'text-ink/35'} />
                  {meta.label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function DocsHeader({ onToggleNav }: { onToggleNav: () => void }) {
  return (
    <header className="sticky top-0 z-40 border-b border-sand-200 bg-cream-50/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" onClick={onToggleNav} className="-ml-2 rounded-lg p-2 text-ink/60 transition-colors hover:bg-sand-100 lg:hidden" aria-label="Toggle navigation">
            <Menu size={18} />
          </button>
          <Link to="/" className="flex shrink-0 items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-forest-700 text-white shadow-soft">
              <Zap size={15} fill="white" />
            </span>
            <span className="font-display text-[15px] font-bold tracking-tight text-ink">JafariPay</span>
            <span className="hidden rounded-full border border-sand-200 bg-sand-100 px-2.5 py-0.5 text-[11px] font-semibold text-ink/55 sm:inline-flex">Docs</span>
          </Link>
        </div>
        <nav className="hidden items-center gap-6 text-[13px] lg:flex">
          <Link to="/docs" className="font-medium text-ink/60 transition-colors hover:text-ink">Documentation</Link>
          <Link to="/roadmap" className="text-ink/45 transition-colors hover:text-ink">Roadmap</Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" title={GITHUB_URL} className="flex items-center gap-1.5 rounded text-ink/45 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest-300">
            <Github size={14} aria-hidden="true" /> GitHub
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            title={`Email ${SUPPORT_EMAIL}`}
            aria-label={`Contact support at ${SUPPORT_EMAIL}`}
            className="hidden items-center gap-1.5 rounded-xl border border-sand-300 bg-white px-3.5 py-2 text-[13px] font-medium text-ink/70 shadow-soft transition-all hover:border-sand-400 hover:bg-cream-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest-300 md:flex"
          >
            <Mail size={13} aria-hidden="true" /> Contact
          </a>
          <Link to="/dashboard" className="flex items-center gap-1.5 rounded-xl bg-forest-700 px-4 py-2 text-[13px] font-semibold text-white shadow-soft transition-all hover:bg-forest-600">
            Dashboard <ArrowRight size={13} />
          </Link>
        </div>
      </div>
    </header>
  );
}

function DocsFooter() {
  const linkCls = 'text-xs text-ink/50 transition-colors hover:text-ink';
  return (
    <footer className="border-t border-sand-200 bg-white">
      <div className="mx-auto max-w-[1440px] px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-forest-700 text-white shadow-soft">
                <Zap size={15} fill="white" />
              </span>
              <span className="font-display text-[15px] font-bold tracking-tight text-ink">JafariPay</span>
            </div>
            <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-ink/50">
              Non-custodial USDC payments on Arc — accept stablecoins and settle directly to your own wallet.
            </p>
          </div>
          <div>
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink/35">Product</div>
            <div className="space-y-2">
              <Link to="/dashboard" className={linkCls}>Dashboard</Link>
              <Link to="/docs" className={linkCls}>Documentation</Link>
              <Link to="/roadmap" className={linkCls}>Roadmap</Link>
            </div>
          </div>
          <div>
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink/35">Resources</div>
            <div className="space-y-2">
              <Link to="/docs/api" className={linkCls}>API Reference</Link>
              <Link to="/docs/webhooks" className={linkCls}>Webhooks</Link>
              <Link to="/docs/error-codes" className={linkCls}>Error Codes</Link>
              <Link to="/docs/changelog" className={linkCls}>Changelog</Link>
            </div>
          </div>
          <div>
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink/35">Connect</div>
            <div className="space-y-2">
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" title={GITHUB_URL} aria-label="JafariPay on GitHub" className={`flex items-center gap-1.5 rounded transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest-300 ${linkCls}`}>
                <Github size={12} aria-hidden="true" /> GitHub
              </a>
              <a href={`mailto:${SUPPORT_EMAIL}`} title={`Email ${SUPPORT_EMAIL}`} aria-label="Contact support by email" className={`flex items-center gap-1.5 rounded transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest-300 ${linkCls}`}>
                <Mail size={12} aria-hidden="true" /> Support
              </a>
            </div>
          </div>
        </div>
        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-sand-100 pt-6 text-xs text-ink/40">
          <span>© 2026 JafariPay. All rights reserved.</span>
          <span className="flex items-center gap-1.5">
            <Globe size={12} /> Built on Arc
          </span>
        </div>
      </div>
    </footer>
  );
}

/* ---------- page ---------- */

export default function DocsPage() {
  const { slug } = useParams<{ slug?: string }>();
  const currentSlug = slug || 'quickstart';
  const content = CONTENT[currentSlug] || CONTENT.quickstart;
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    window.scrollTo(0, 0);
    setNavOpen(false);
  }, [currentSlug]);

  const blocks = useMemo(() => parseBlocks(content.body), [content.body]);

  return (
    <div className="min-h-dvh bg-cream-50 font-body text-ink">
      <DocsHeader onToggleNav={() => setNavOpen((o) => !o)} />

      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-ink/40" onClick={() => setNavOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[290px] overflow-y-auto border-r border-sand-200 bg-cream-50 p-4 shadow-lift">
            <div className="mb-4 flex items-center justify-between">
              <span className="font-display text-sm font-bold text-ink">JafariPay Docs</span>
              <button type="button" onClick={() => setNavOpen(false)} className="rounded-lg p-1.5 text-ink/50 transition-colors hover:bg-sand-100" aria-label="Close navigation">
                <X size={16} />
              </button>
            </div>
            <SidebarNav active={currentSlug} onNavigate={() => setNavOpen(false)} />
          </div>
        </div>
      )}

      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <div className="flex items-start gap-8 lg:gap-12">
          <aside className="sticky top-20 hidden max-h-[calc(100vh-96px)] w-60 shrink-0 self-start overflow-y-auto py-8 pr-1 lg:block xl:w-72">
            <div className="mb-5 px-3">
              <div className="font-display text-sm font-bold text-ink">Documentation</div>
              <p className="mt-1 text-xs leading-relaxed text-ink/45">Everything you need to integrate JafariPay into your application.</p>
            </div>
            <SidebarNav active={currentSlug} />
            <div className="mt-6 rounded-2xl border border-sand-200 bg-white p-4 shadow-soft">
              <div className="mb-1.5 flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
                  <Mail size={15} />
                </span>
                <div className="text-[13px] font-semibold text-ink">Need help?</div>
              </div>
              <p className="text-xs leading-relaxed text-ink/50">Have questions or need integration support?</p>
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                title={`Email ${SUPPORT_EMAIL}`}
                aria-label={`Contact support at ${SUPPORT_EMAIL}`}
                className="mt-3.5 flex items-center justify-center gap-1.5 rounded-xl bg-ink px-3 py-2 text-xs font-semibold text-cream-50 transition-colors hover:bg-ink/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest-300 focus-visible:ring-offset-2"
              >
                <Mail size={12} aria-hidden="true" /> Contact Us
              </a>
              <div className="mt-2 flex items-center justify-center gap-1 text-center text-[11px] text-ink/35">
                <Mail size={10} aria-hidden="true" /> {SUPPORT_EMAIL}
              </div>
            </div>
          </aside>

          <main className="min-w-0 flex-1 py-8 lg:py-10">
            <div className="max-w-3xl">
              <div className="mb-4 flex items-center gap-1.5 text-xs text-ink/40">
                <Link to="/docs" className="transition-colors hover:text-ink/70">Docs</Link>
                <span>/</span>
                <span className="font-medium text-ink/70">{content.title}</span>
              </div>

              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h1 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">{content.title}</h1>
                  <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink/55">{SUBTITLES[currentSlug] ?? ''}</p>
                </div>
                {currentSlug === 'test-mode' && (
                  <div className="flex items-center gap-2.5 rounded-xl border border-forest-200 bg-forest-50 px-4 py-3">
                    <TestTube size={15} className="text-forest-600" />
                    <span className="text-[13px] font-semibold text-forest-800">Test Mode</span>
                    <span className="text-xs text-forest-600">Arc Testnet · Chain ID 5042002</span>
                  </div>
                )}
                {currentSlug === 'production' && (
                  <div className="flex items-center gap-2.5 rounded-xl border border-gold-200 bg-gold-50 px-4 py-3">
                    <Globe size={15} className="text-gold-600" />
                    <span className="text-[13px] font-semibold text-gold-800">Production</span>
                    <span className="text-xs text-gold-600">Arc Mainnet · Chain ID 5042002</span>
                  </div>
                )}
              </div>

              {currentSlug === 'quickstart' && (
                <div className="mt-6">
                  <QuickstartSteps />
                </div>
              )}
              {currentSlug === 'payment-intents' && (
                <div className="mt-6">
                  <StatusFlowCard />
                </div>
              )}
              {currentSlug === 'api' && (
                <div className="mt-6">
                  <ApiChips />
                </div>
              )}
              {currentSlug === 'error-codes' && (
                <div className="mt-6">
                  <ErrorsExplorer />
                </div>
              )}
              {currentSlug === 'changelog' && (
                <div className="mt-6">
                  <ChangelogTimeline />
                </div>
              )}

              <div className="mt-8 space-y-5">
                {blocks.map((block, i) => (
                  <BlockView key={i} block={block} pageSlug={currentSlug} pageTitle={content.title} />
                ))}
              </div>

              <PrevNext slug={currentSlug} />
            </div>
          </main>
        </div>
      </div>

      <DocsFooter />
    </div>
  );
}

