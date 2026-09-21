/**
 * Ambient type declaration for `@circlefin/compass-chains`.
 *
 * This module is provided by the Arc Studio build sandbox at deploy time and is
 * NOT published to the public npm registry, so it is intentionally absent from
 * package.json / node_modules in an exported app. It is only consumed by the
 * optional contract-deploy scaffolding in `scripts/compass-deploy.ts`, never by
 * the JafariPay server or frontend runtime.
 *
 * Declaring the module here lets `tsc --noEmit` and `oxlint --type-aware`
 * resolve the import and its return type so local verification passes, without
 * changing any deploy logic. At actual deploy time inside the Arc Studio
 * sandbox the real package supplies the implementation.
 */
declare module '@circlefin/compass-chains' {
  export interface CompassChainDef {
    /** Compass chain id, e.g. "Arc_Testnet". */
    id: string;
    /** Human-readable chain name, e.g. "Arc Testnet". */
    name: string;
    /** Block explorer base URL. */
    explorerUrl?: string;
    /** Native currency descriptor. */
    nativeCurrency: {
      symbol: string;
      decimals: number;
    };
  }

  /**
   * Resolve a Compass chain definition by its Compass chain id.
   * Throws if the chain id is unknown.
   */
  export function getChain(compassChain: string): CompassChainDef;
}
