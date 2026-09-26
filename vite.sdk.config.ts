/**
 * JafariPay SDK — standalone browser build.
 *
 * Builds ONLY the vanilla TypeScript SDK (src/sdk/browser.ts) into a single
 * dependency-free IIFE bundle at `dist/sdk.js`, exposing the global
 * `window.JafariPay`.  This is a SEPARATE build from the main React SPA:
 *
 *   - `vite build`                      → dist/ (the normal SPA bundle)
 *   - `vite build --config vite.sdk.config.ts` → dist/sdk.js (the SDK)
 *
 * `emptyOutDir: false` is set so the SDK build ADDS `sdk.js` next to the
 * already-built SPA without wiping it.  Run the SPA build first, then the SDK
 * build (the package.json `build` script does both).
 */
import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

/**
 * Substitute `__JAFARIPAY_SDK_VERSION__` with the JSON-stringified package
 * version inside the SDK sources before bundling.  Using a `transform` hook
 * (instead of relying on Vite `define` with IIFE lib output) guarantees the
 * version literal lands in the bundle.  When the source runs under Node
 * (tests) the identifier is untouched and the `try/catch` in index.ts falls
 * back to "0.0.0".
 */
function sdkVersion(pluginVersion: string): Plugin {
  const key = '__JAFARIPAY_SDK_VERSION__';
  const literal = JSON.stringify(pluginVersion);
  const sentinel = '\u0001';
  return {
    name: 'jafaripay-sdk-version',
    enforce: 'pre',
    transform(code, id) {
      if (!/src[\\/]+sdk[\\/]/.test(id) || !code.includes(key)) return null;
      // Protect the ambient declaration, substitute every other occurrence,
      // then restore the declaration.  (Comment mentions of the key also get
      // replaced — harmless.)
      let out = code.replace(
        new RegExp('declare const ' + key + ': string;'),
        'declare const ' + sentinel + ': string;',
      );
      out = out.split(key).join(literal);
      out = out.split(sentinel).join(key);
      return { code: out, map: null };
    },
  };
}

export default defineConfig({
  plugins: [sdkVersion(pkg.version)],
  // No React, no node polyfills — the SDK is a pure browser IIFE.
  build: {
    outDir: 'dist',
    emptyOutDir: false, // never delete the SPA bundle that lives here
    sourcemap: true,
    minify: 'esbuild',
    lib: {
      entry: 'src/sdk/browser.ts',
      // IIFE so a bare <script> tag works with no import map / no modules.
      formats: ['iife'],
      // Vite requires a name for IIFE; the bundle's default export (the live
      // namespace from browser.ts) becomes the `window.JafariPay` global.
      name: 'JafariPay',
      fileName: () => 'sdk.js',
    },
    rollupOptions: {
      output: {
        // Keep global names tidy inside the IIFE.
        inlineDynamicImports: true,
      },
    },
    target: 'es2018',
  },
});

