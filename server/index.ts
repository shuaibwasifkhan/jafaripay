/**
 * JafariPay — Backend server entry point
 *
 * Runs on PORT (default 3001), fronted by Vite dev-server proxy for preview.
 */

import express, { static as serveStatic } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { migrate } from './db/schema.js';
import { requestId } from './middleware/auth.js';
import { startWorker } from './workers/reconciliation.js';

// Routes
import authRouter from './api/auth.js';
import projectsRouter from './api/projects.js';
import apiKeysRouter from './api/api-keys.js';
import settlementWalletsRouter from './api/settlement-wallets.js';
import paymentIntentsRouter from './api/payment-intents.js';
import paymentsRouter from './api/payments.js';
import webhooksRouter from './api/webhooks.js';
import webhookDeliveriesRouter from './api/webhook-deliveries.js';
import checkoutRouter from './api/checkout.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Production secret guard ────────────────────────────────────────────────
// In production, refuse to boot with default/dev secrets. These are used for
// session token signing and API-key/webhook HMACs — running with the shared
// dev fallbacks in production would let anyone forge sessions or API keys.
// Never log the values themselves, only which var is missing.
if (IS_PROD) {
  const requiredSecrets = ['SESSION_SECRET', 'API_KEY_HMAC_SECRET', 'WEBHOOK_HMAC_SECRET'];
  const missing = requiredSecrets.filter((name) => {
    const v = process.env[name];
    return !v || v.length < 16;
  });
  if (missing.length > 0) {
    console.error(
      `[JafariPay] FATAL: production requires strong secrets for: ${missing.join(', ')}. ` +
      'Set each to a unique random value of at least 16 characters and restart.'
    );
    process.exit(1);
  }
}

// ── Run migrations ─────────────────────────────────────────────────────────
migrate();

// ── Express app ────────────────────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // allow SDK embed
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", 'https://*.arc.io', 'https://*.circle.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS — allow the frontend dev server + production domain
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  ...(process.env.ALLOWED_ORIGINS?.split(',') || []),
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) { cb(null, true); return; }
    cb(new Error('CORS not allowed'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(requestId);

// Global rate limiting
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as { merchantId?: string }).merchantId || ipKeyGenerator(req.ip ?? ''),
}));

// Stricter limit on auth endpoints
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => ipKeyGenerator(req.ip ?? '') });
app.use('/auth', authLimiter);
app.use('/api/auth', authLimiter);

// ── Routes ─────────────────────────────────────────────────────────────────
// Dashboard API — mounted at /api/* so frontend BASE='/api' works without a proxy
app.use('/api/auth', authRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/api-keys', apiKeysRouter);
app.use('/api/settlement-wallets', settlementWalletsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/webhook-endpoints', webhooksRouter);
app.use('/api/webhook-deliveries', webhookDeliveriesRouter);
// Also keep the un-prefixed paths for the Vite proxy (strips /api before forwarding)
app.use('/auth', authRouter);
app.use('/projects', projectsRouter);
app.use('/api-keys', apiKeysRouter);
app.use('/settlement-wallets', settlementWalletsRouter);
app.use('/payments', paymentsRouter);
app.use('/webhook-endpoints', webhooksRouter);
app.use('/webhook-deliveries', webhookDeliveriesRouter);

// Public/SDK API (authenticated via API key Bearer token)
app.use('/v1/payment-intents', paymentIntentsRouter);
app.use('/v1/payments', paymentsRouter);
app.use('/api/v1/payment-intents', paymentIntentsRouter);
app.use('/api/v1/payments', paymentsRouter);

// Public checkout JSON API — canonical path, always available.
// The frontend hosted checkout page (CheckoutPage.tsx) fetches from /api/checkout/:id.
app.use('/api/checkout', checkoutRouter);
// Bare /checkout JSON API exists ONLY for the Vite dev-server proxy, which strips
// the /api prefix before forwarding. When THIS server serves the built frontend
// (dist/ present), /checkout/:id is a BROWSER route (the React hosted checkout),
// so we must not shadow it with the JSON API. hasDist is computed below.
const distPath = join(import.meta.dir, '..', 'dist');
const hasDist = existsSync(distPath);
if (!hasDist) {
  app.use('/checkout', checkoutRouter);
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), env: IS_PROD ? 'production' : 'development' });
});

// ── Serve production frontend build ─────────────────────────────────────────
// When dist/ exists (after `vite build`), serve it directly from Express
// so the frontend and API share one origin — eliminating all cookie/proxy issues.
if (hasDist) {
  // Serve static assets with long cache, but index.html must never be cached
  app.use(serveStatic(distPath, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
      }
    },
  }));
  // SPA fallback — all non-API/non-file routes return index.html.
  // NOTE: /checkout is a BROWSER route (hosted checkout UI), so it is intentionally
  // NOT in this API list — the JSON checkout API lives under /api/checkout.
  app.get('/{*path}', (req, res) => {
    const isApi = req.path.startsWith('/auth') || req.path.startsWith('/v1')
      || req.path.startsWith('/api/') || req.path.startsWith('/health')
      || req.path.startsWith('/projects') || req.path.startsWith('/api-keys')
      || req.path.startsWith('/settlement-wallets') || req.path.startsWith('/payments')
      || req.path.startsWith('/webhook');
    if (isApi) { res.status(404).json({ error: 'Not found' }); return; }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.sendFile(join(distPath, 'index.html'));
  });
} else {
  // No build — 404 for unknown routes (Vite proxy handles frontend)
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
}

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Server Error]', err);
  res.status(500).json({ error: IS_PROD ? 'Internal server error' : err.message });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[JafariPay] Server running on http://localhost:${PORT}`);
  startWorker();
});

// Also listen on 5173 so the Arc Studio preview panel gets the production build
// directly — no Vite dev server, no stale bundle, no proxy cookie issues.
// Only in non-production: a real VPS deployment listens solely on PORT and is
// fronted by Nginx, so it must not bind an extra unintended port.
if (!IS_PROD && PORT !== 5173) {
  app.listen(5173, () => {
    console.log('[JafariPay] Also serving on http://localhost:5173 (preview)');
  });
}

export default app;
