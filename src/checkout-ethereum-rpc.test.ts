/*
 * PHASE 21D — regression guard: Ethereum (chain 1) is an ENS-ONLY capability and
 * a Base Mainnet checkout must never talk to an Ethereum JSON-RPC.
 *
 * Root cause this locks down: connectkit 1.9.2's ConnectKitButton.Custom renders
 * ConnectButtonRenderer, which internally runs useEnsName({ chainId: 1, address })
 * unconditionally once a wallet is connected — even though every render-prop in
 * this app destructures ({ show }) only and NO app code consumes the ensName.
 * wagmi resolves that query against the APP config's chain-1 client; when the
 * chain-1 transport was http(undefined), viem 2.56.5 resolved mainnet's curated
 * default https://ethereum.reth.rs/rpc — a host CSP intentionally does not
 * allow-list — so every wallet connect fired a CSP-blocked browser fetch during
 * checkout. The minimal fix keeps Ethereum in SUPPORTED_CHAINS (operator
 * ENS-only rule) but binds chain 1 to an inert, zero-network transport in
 * src/config.ts (policy set: ENS_ONLY_NO_BROWSER_RPC_CHAIN_IDS).
 *
 * Also locked: dropping mainnet from SUPPORTED_CHAINS would NOT fix the request
 * (ConnectKit falls back to its own ensFallbackConfig with the same http()
 * curated default) and would break the operator rule + checkout-network.test.ts.
 */
import { describe, it, expect } from 'bun:test';
import { mainnet, base, baseSepolia, arc } from 'viem/chains';
import { http } from 'wagmi';
import {
  SUPPORTED_CHAINS,
  SUPPORTED_CHAIN_IDS,
  ENS_ONLY_NO_BROWSER_RPC_CHAIN_IDS,
} from './supported-chains';
import { CIRCLE_INVENTORY, enabledEvmRows } from '../server/db/networks.ts';
import { CSP_CONNECT_SRC } from '../server/lib/csp.ts';

// src/config.ts side-effect-imports ./tracing, which touches `window` at module
// scope. Provide the minimal globals it needs, import config dynamically (after
// the polyfill exists), then remove the globals again so the shared bun-test
// module registry/process stays clean for every other test file.
const g = globalThis as unknown as { window?: unknown; document?: unknown };
g.window = {
  addEventListener: () => {},
  // mipd (EIP-6963 discovery, pulled in by the injected() connector) probes
  // these during createConfig — no-ops are enough, no provider is announced.
  dispatchEvent: () => false,
  removeEventListener: () => {},
  parent: { postMessage: () => {} },
  location: { href: 'http://localhost:3001/' },
};
g.document = { referrer: '' };
const { transports } = await import('./config');
delete g.window;
delete g.document;

/** The subset of viem's evaluated transport config these tests inspect. */
interface EvaluatedTransport {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  value?: { url?: string } | undefined;
}

// `transports` is the EXACT map src/config.ts hands to wagmi's createConfig,
// so these assertions inspect the real per-chain transports, not a copy.

describe('Ethereum remains an ENS-only capability — not removed, not payable', () => {
  it('chain 1 stays allow-listed and is the ONLY no-browser-RPC chain', () => {
    expect(SUPPORTED_CHAIN_IDS.has(1)).toBe(true);
    expect(SUPPORTED_CHAINS.some((c) => c.id === mainnet.id)).toBe(true);
    expect(ENS_ONLY_NO_BROWSER_RPC_CHAIN_IDS.has(mainnet.id)).toBe(true);
    // Every payable capability chain (Arc, Base, all expanded mainnets/testnets)
    // keeps its real curated RPC — the inert binding must never leak to them.
    for (const chain of SUPPORTED_CHAINS) {
      if (chain.id === mainnet.id) continue;
      expect(
        ENS_ONLY_NO_BROWSER_RPC_CHAIN_IDS.has(chain.id),
        `payable capability must keep its real RPC transport: ${chain.id}`,
      ).toBe(false);
    }
  });

  it('chain 1 is never payable: the backend registry never enables it, so no intent can pin it', () => {
    // Non-payability is a server-registry invariant (the frontend resolver is
    // capability-based only): ethereum_mainnet is VERIFIED_NOT_ENABLED and has
    // no enabled row, so a payment intent can never target chain 1 — and the
    // payable balance/transfer reads therefore never resolve a chain-1 client.
    expect(CIRCLE_INVENTORY.find((n) => n.slug === 'ethereum_mainnet')?.status).toBe('VERIFIED_NOT_ENABLED');
    expect(enabledEvmRows().some((n) => n.chainId === 1)).toBe(false);
  });
});

describe('chain-1 wagmi transport is inert and never touches the network', () => {
  it('documents the hazard: viem 2.56.5 resolves an un-pinned http() for mainnet to ethereum.reth.rs', () => {
    // This is exactly what the OLD chain-1 transport silently became on every
    // wallet connect (a fetch to a host CSP forbids). Pinned here so a viem
    // upgrade that changes the curated default is also visible.
    const t = http()({ chain: mainnet }) as EvaluatedTransport;
    expect(t.value?.url).toBe('https://ethereum.reth.rs/rpc');
  });

  it('config binds chain 1 to a transport that rejects WITHOUT any fetch', async () => {
    const fetchCalls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => {
      fetchCalls.push(String(input));
      throw new Error('inert transport must never reach the network');
    }) as unknown as typeof fetch;
    try {
      const t = transports[mainnet.id]({ chain: mainnet }) as unknown as EvaluatedTransport;
      // No RPC endpoint is even resolved for the ENS-only chain.
      expect(t.value?.url).toBeUndefined();
      await expect(t.request({ method: 'eth_chainId' })).rejects.toThrow(/no browser RPC/);
      expect(fetchCalls).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Base Mainnet checkout resolves its own curated RPC — nothing from chain 1', () => {
    // The balance read pins chainId 8453, so checkout's only pre-broadcast RPC
    // traffic goes to the Base transport. Pin its curated endpoint (no network
    // is touched — viem only resolves the URL when the transport is built).
    const t = transports[base.id]({ chain: base }) as unknown as EvaluatedTransport;
    expect(t.value?.url).toBe('https://mainnet.base.org');
  });

  it('production payment chains keep their exact curated endpoints (Arc Mainnet, Base Sepolia)', () => {
    const ta = transports[arc.id]({ chain: arc }) as unknown as EvaluatedTransport;
    expect(ta.value?.url).toBe('https://rpc.mainnet.arc.io');
    const tbs = transports[baseSepolia.id]({ chain: baseSepolia }) as unknown as EvaluatedTransport;
    expect(tbs.value?.url).toBe('https://sepolia.base.org');
  });
});

describe('CSP stays least-privilege and Ethereum-RPC-free', () => {
  it('allow-lists NO Ethereum RPC host (the bug is fixed at the transport, not by widening CSP)', () => {
    expect(CSP_CONNECT_SRC.some((h) => h.includes('reth'))).toBe(false);
    expect(CSP_CONNECT_SRC.some((h) => h.includes('ethereum'))).toBe(false);
    // Existing curated hosts are untouched.
    expect(CSP_CONNECT_SRC).toContain('https://mainnet.base.org');
    expect(CSP_CONNECT_SRC).toContain('https://sepolia.base.org');
    expect(CSP_CONNECT_SRC).toContain('https://*.arc.io');
    expect(CSP_CONNECT_SRC).toContain('https://*.circle.com');
  });
});
