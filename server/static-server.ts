/**
 * Production static file server — serves dist/ on port 5173
 * and proxies /api/* to Express on port 3001.
 * This replaces the Vite dev server for the preview panel so
 * the browser always loads fresh compiled JS.
 */
import express from 'express';
import { createServer } from 'node:http';
import { createProxyServer } from 'http-proxy';
import { join } from 'node:path';

const app = express();
const proxy = createProxyServer({ target: 'http://localhost:3001', changeOrigin: true });

proxy.on('error', (err, _req, res) => {
  if (res && 'writeHead' in res) {
    (res as import('node:http').ServerResponse).writeHead(502);
    (res as import('node:http').ServerResponse).end('API proxy error');
  }
});

// Proxy /api/* → Express (strip /api prefix)
app.use('/api', (req, res) => {
  req.url = req.url; // keep as-is; Express mounts at /api already
  proxy.web(req, res, { target: 'http://localhost:3001' });
});

// Serve static dist/ files
const dist = join(import.meta.dir, '..', 'dist');
app.use(express.static(dist));

// SPA fallback
app.get('/{*path}', (_req, res) => {
  res.sendFile(join(dist, 'index.html'));
});

createServer(app).listen(5173, () => {
  console.log('[Static] Serving dist/ on http://localhost:5173');
});
