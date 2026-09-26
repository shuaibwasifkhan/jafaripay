/**
 * JafariPay JavaScript SDK — unit tests (bun:test).
 *
 * The SDK is dependency-injected (createJafariPay(env)), so these tests run in
 * Node with a minimal fake window/document — no browser, no React.  They cover
 * the required SDK behaviours: global exposure, option validation, URL
 * construction, mount lifecycle, postMessage origin/PI filtering, close/destroy,
 * and the guarantee that no production secrets ship in the SDK source.
 */
import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';

import {
  createJafariPay, init,
  isValidPaymentIntent, requirePaymentIntent,
  resolveBaseUrl, buildCheckoutUrl, buildStatusUrl, originOf,
  isTrustedPaymentMessage, statusToCallback,
  DEFAULT_BASE_URL, JP_MESSAGE_TYPE,
} from './index';

const PI = 'pi_' + 'abcdef1234567890abcdef12'; // 24 chars, matches the real format

// ── Minimal DOM / window fakes ────────────────────────────────────────────
function makeNode(tag: string) {
  const node: any = {
    tag,
    style: {} as Record<string, string>,
    children: [] as any[],
    attributes: {} as Record<string, string>,
    listeners: {} as Record<string, Array<(e: any) => void>>,
    parentNode: null as any,
    type: undefined,
    textContent: undefined,
    closed: false,
  };
  node.setAttribute = (k: string, v: string) => { node.attributes[k] = v; };
  node.getAttribute = (k: string) => node.attributes[k];
  node.removeAttribute = (k: string) => { delete node.attributes[k]; };
  node.addEventListener = (t: string, fn: (e: any) => void) => { (node.listeners[t] = node.listeners[t] || []).push(fn); };
  node.removeEventListener = (t: string, fn: (e: any) => void) => {
    const arr = node.listeners[t] || []; const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1);
  };
  node.dispatch = (t: string, event: any) => { (node.listeners[t] || []).forEach((fn) => fn(event)); };
  node.appendChild = (c: any) => { node.children.push(c); c.parentNode = node; return c; };
  node.removeChild = (c: any) => { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); };
  node.remove = () => { if (node.parentNode) node.parentNode.removeChild(node); };
  return node;
}

function makeWindow() {
  const win = makeNode('window');
  win.open = (url: string) => { win.lastOpen = url; return makeNode('popup'); };
  win.addEventListener = (t: string, fn: (e: any) => void) => { (win.listeners[t] = win.listeners[t] || []).push(fn); };
  win.removeEventListener = (t: string, fn: (e: any) => void) => {
    const arr = win.listeners[t] || []; const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1);
  };
  win.dispatchMessage = (event: any) => win.dispatch('message', event);
  win.close = () => { win.closed = true; };
  win.closed = false;
  return win;
}

function makeDocument(hostSelector?: string, host?: any) {
  const doc = makeNode('document');
  doc.querySelector = (sel: string) => {
    if (sel === hostSelector) return host ?? makeNode('div');
    return null;
  };
  doc.createElement = (tag: string) => makeNode(tag);
  return doc;
}

function makeEnv() {
  const win = makeWindow();
  const doc = makeDocument('#jafaripay-checkout', makeNode('div'));
  // No fetch + no-op timers → deterministic, no auto-ticking between tests.
  const jp = createJafariPay({
    window: win,
    document: doc,
    isProduction: true,
    fetch: undefined,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  return { win, doc, jp, host: doc.querySelector('#jafaripay-checkout') };
}

test('exposes the JafariPay global with checkout/mount/version', () => {
  const win = makeWindow();
  const ns = init({ window: win, isProduction: true });
  expect(typeof (win as any).JafariPay).toBe('object');
  expect((win as any).JafariPay).toBe(ns);
  expect(typeof ns.checkout).toBe('function');
  expect(typeof ns.mount).toBe('function');
  expect(typeof ns.version).toBe('string');
});

test('checkout() rejects a missing paymentIntent', () => {
  const { jp } = makeEnv();
  expect(() => jp.checkout({} as any)).toThrow();
  expect(() => jp.checkout({ paymentIntent: '' } as any)).toThrow();
  expect(requirePaymentIntent(PI)).toBe(PI);
});

test('checkout() builds the correct hosted-checkout URL', () => {
  const { jp, win } = makeEnv();
  const handle = jp.checkout({ paymentIntent: PI });
  expect(handle.url).toBe(`https://jafari.co.in/checkout/${PI}`);
  expect(win.lastOpen).toBe(handle.url);
  expect(buildCheckoutUrl(DEFAULT_BASE_URL, PI)).toBe(handle.url);
  expect(buildStatusUrl(DEFAULT_BASE_URL, PI)).toBe(`https://jafari.co.in/api/checkout/${PI}`);
});

test('mount() rejects a missing / empty selector', () => {
  const { jp } = makeEnv();
  expect(() => jp.mount('', { paymentIntent: PI })).toThrow();
  expect(() => jp.mount(undefined as any, { paymentIntent: PI })).toThrow();
});

test('mount() rejects a selector that matches no element', () => {
  const { jp } = makeEnv();
  expect(() => jp.mount('#does-not-exist', { paymentIntent: PI })).toThrow();
});

test('mount() renders a Pay-with-USDC launcher plus an embedded iframe', () => {
  const { jp, host } = makeEnv();
  const inst = jp.mount('#jafaripay-checkout', { paymentIntent: PI });
  const wrapper = host.children.find((c: any) => c.getAttribute('data-jafaripay-sdk') === 'mount') as any;
  expect(wrapper).toBeTruthy();
  const button = wrapper.children.find((c: any) => c.tag === 'button') as any;
  const frameBox = wrapper.children.find((c: any) => c.tag === 'div') as any;
  const frame = frameBox.children.find((c: any) => c.tag === 'iframe') as any;
  expect(button.textContent).toBe('Pay with USDC');
  expect(frame).toBeTruthy();
  expect(typeof inst.open).toBe('function');
  expect(typeof inst.close).toBe('function');
  expect(typeof inst.destroy).toBe('function');
  inst.destroy();
});

test('checkout() opens the hosted checkout in a new window', () => {
  const { jp, win } = makeEnv();
  const handle = jp.checkout({ paymentIntent: PI });
  expect(win.lastOpen).toContain(`/checkout/${PI}`);
  expect(handle.win).toBeTruthy();
  handle.destroy();
});

test('checkout() close/destroy stop listening and fire onClose', () => {
  const { jp, win } = makeEnv();
  let closed = 0;
  const handle = jp.checkout({ paymentIntent: PI, onClose: () => { closed++; } });
  expect(win.listeners['message'].length).toBe(1);
  handle.close();
  expect(closed).toBe(1);
  expect(win.listeners['message'].length).toBe(0);
  handle.destroy(); // idempotent
});

test('mount() open/close/destroy manage the embedded checkout', () => {
  const { jp, host, win } = makeEnv();
  const inst = jp.mount('#jafaripay-checkout', { paymentIntent: PI });
  const wrapper = host.children[0] as any;
  const frameBox = wrapper.children.find((c: any) => c.tag === 'div') as any;
  const frame = frameBox.children[0] as any;
  inst.open();
  expect(frame.attributes['src']).toBe(`https://jafari.co.in/checkout/${PI}`);
  inst.close();
  expect(frame.attributes['src']).toBeUndefined();
  expect(win.listeners['message'].length).toBe(1);
  inst.destroy();
  expect(win.listeners['message'].length).toBe(0);
});

test('postMessage outcomes are accepted only from the trusted origin', () => {
  const { jp, win } = makeEnv();
  let success = 0;
  const handle = jp.checkout({ paymentIntent: PI, onPaymentSuccess: () => { success++; } });
  win.dispatchMessage({ origin: 'https://jafari.co.in', source: handle.win, data: { type: JP_MESSAGE_TYPE, status: 'succeeded', paymentIntent: PI } });
  expect(success).toBe(1);
  // duplicate terminal message must be ignored (settled guard):
  win.dispatchMessage({ origin: 'https://jafari.co.in', source: handle.win, data: { type: JP_MESSAGE_TYPE, status: 'succeeded', paymentIntent: PI } });
  expect(success).toBe(1);
  handle.destroy();
});

test('a postMessage from a different origin is ignored', () => {
  const { jp, win } = makeEnv();
  let success = 0;
  const handle = jp.checkout({ paymentIntent: PI, onPaymentSuccess: () => { success++; } });
  win.dispatchMessage({ origin: 'https://evil.example', source: handle.win, data: { type: JP_MESSAGE_TYPE, status: 'succeeded', paymentIntent: PI } });
  expect(success).toBe(0);
  // And the pure helper must agree:
  expect(isTrustedPaymentMessage({ type: JP_MESSAGE_TYPE, status: 'succeeded', paymentIntent: PI }, { origin: 'https://evil.example', allowedOrigins: ['https://jafari.co.in'], paymentIntent: PI })).toBe(false);
  expect(isTrustedPaymentMessage({ type: JP_MESSAGE_TYPE, status: 'succeeded', paymentIntent: PI }, { origin: 'https://jafari.co.in', allowedOrigins: ['https://jafari.co.in'], paymentIntent: PI })).toBe(true);
  handle.destroy();
});

test('messages for a different paymentIntent are ignored', () => {
  const { jp, win } = makeEnv();
  let success = 0;
  const other = 'pi_' + 'z'.repeat(24);
  const handle = jp.checkout({ paymentIntent: PI, onPaymentSuccess: () => { success++; } });
  win.dispatchMessage({ origin: 'https://jafari.co.in', source: handle.win, data: { type: JP_MESSAGE_TYPE, status: 'succeeded', paymentIntent: other } });
  expect(success).toBe(0);
  handle.destroy();
});

test('no production secrets ship in the SDK source', () => {
  const forbidden = [
    'SESSION_SECRET', 'WEBHOOK_HMAC_SECRET', 'API_KEY_HMAC_SECRET',
    'process.env', 'DATABASE_URL', 'USDC_ADDRESS', 'PRIVATE_KEY', 'seed phrase',
  ];
  for (const f of ['index.ts', 'browser.ts']) {
    const text = readFileSync(new URL(`./${f}`, import.meta.url), 'utf-8');
    for (const s of forbidden) {
      expect(text.includes(s), `${f} must not contain "${s}"`).toBe(false);
    }
  }
});

test('the SDK build config targets dist/sdk.js', () => {
  const cfg = readFileSync(new URL('../../vite.sdk.config.ts', import.meta.url), 'utf-8');
  expect(cfg).toContain('sdk.js');
  expect(cfg).toContain('iife');
  expect(cfg).toContain('src/sdk/browser.ts');
  expect(cfg).toContain('emptyOutDir: false');
});

// ── Pure-helper sanity checks (support the tests above) ───────────────────
test('pure helpers behave correctly', () => {
  expect(isValidPaymentIntent(PI)).toBe(true);
  expect(isValidPaymentIntent('pi_xxx')).toBe(false);
  expect(isValidPaymentIntent('not-an-id')).toBe(false);
  expect(resolveBaseUrl(undefined, { isProduction: true })).toBe('https://jafari.co.in');
  expect(resolveBaseUrl('https://jafari.co.in/', { isProduction: true })).toBe('https://jafari.co.in');
  expect(originOf('https://jafari.co.in/checkout/pi')).toBe('https://jafari.co.in');
  expect(statusToCallback('succeeded')).toBe('success');
  expect(statusToCallback('failed')).toBe('failed');
  expect(statusToCallback('expired')).toBe('expired');
  expect(statusToCallback('cancelled')).toBe('closed');
  expect(statusToCallback('processing')).toBe(null);
  // http for a non-local host is rejected in production:
  expect(() => resolveBaseUrl('http://example.com', { isProduction: true })).toThrow();
  // http for localhost is allowed:
  expect(resolveBaseUrl('http://localhost:3000', { isProduction: true })).toBe('http://localhost:3000');
});


