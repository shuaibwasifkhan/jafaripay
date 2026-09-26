/**
 * JafariPay SDK — browser entry point.
 *
 * This is what the standalone IIFE build bundles, so
 * `<script src="https://jafari.co.in/sdk.js">` attaches `window.JafariPay`.
 * Because the IIFE format assigns the bundle's *default export* to the global
 * name (`build.lib.name` = "JafariPay"), the default export here is the live
 * SDK namespace: `window.JafariPay.checkout` / `.mount` / `.version`.
 *
 * `init()` is idempotent (it only assigns when `window.JafariPay` is unset), so
 * the two assignments above always produce the same object.
 */
import { init } from './index';

export default init();

