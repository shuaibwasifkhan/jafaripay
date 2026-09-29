/*
 * PHASE 4 — Multi-chain checkout network-resolution tests.
 *
 * These exercise the PURE resolver (@/checkout-network) + the curated allowlist
 * (@/supported-chains) that the CheckoutPage now delegates to. There is no React
 * DOM test harness in this repo, and the money-safety of the checkout lives
 * entirely in these decisions (which chain, which USDC, which explorer, may we
 * pay?), so they are unit-tested directly and deterministically — no wagmi, no
 * wallet, no network. Fixture chains come from the generated onchain-facts
 * registry. As of the MASTER PHASE the curated allowlist also covers Base
 * Mainnet (8453) and Arbitrum One (42161); and as of the MASTER EXPANSION it
 * covers the conservative Circle-native-USDC EVM subset (Polygon, Avalanche,
 * OP Mainnet, Linea, Unichain, ZKsync Era, Celo — Cronos was DEMOTED by the
 * PHASE 20 live re-validation) — DERIVED from the
 * single-source inventory so this guard cannot drift. These are frontend
 * CAPABILITY entries only — real payment stays gated by the backend registry
 * + env class.
 */
import { describe, it, expect } from 'bun:test';
import {
  resolveCheckoutNetwork,
  isWrongNetwork,
  canAttemptPayment,
  type CheckoutIntentNet,
} from './checkout-network';
import { SUPPORTED_CHAIN_IDS } from './supported-chains';
import { getChain } from './onchain-facts';
import { CIRCLE_INVENTORY, enabledEvmRows } from '../server/db/networks.ts';

const ARC_TESTNET = 5042002;
const ARC_MAINNET = 5042;
const BASE_SEPOLIA = 84532;      // in facts + curated allowlist => supported non-Arc fixture
const BASE_MAINNET = 8453;       // MASTER PHASE: now facts + curated allowlist => payable ready
const ARBITRUM_ONE = 42161;      // MASTER PHASE: now facts + curated allowlist => payable ready
const MONAD_TESTNET = 10143;     // in facts (generated) but NOT allowlisted => missing frontend chain def
const UNKNOWN = 999999;          // absent from facts AND allowlist

function intent(over: Partial<CheckoutIntentNet> & { chain_id: number }): CheckoutIntentNet {
  return {
    network: 'fixture',
    usdc_address: '0x00000000000000000000000000000000000000ee',
    settlement_address: '0x1111111111111111111111111111111111111111',
    amount_base_units: '1000000',
    ...over,
  };
}

describe('supported-chain allowlist is fixed & curated', () => {
  it('J: allowlist is a finite curated set that includes Arc + every approved payable chain, not "any chain"', () => {
    expect(SUPPORTED_CHAIN_IDS.has(ARC_TESTNET)).toBe(true);
    expect(SUPPORTED_CHAIN_IDS.has(ARC_MAINNET)).toBe(true);
    expect(SUPPORTED_CHAIN_IDS.has(BASE_SEPOLIA)).toBe(true);
    // MASTER PHASE: Base Mainnet + Arbitrum One are now curated capability entries.
    expect(SUPPORTED_CHAIN_IDS.has(BASE_MAINNET)).toBe(true);
    expect(SUPPORTED_CHAIN_IDS.has(ARBITRUM_ONE)).toBe(true);
    // MASTER EXPANSION: every inventory-enabled EVM chain id is a curated
    // capability entry — DERIVED, so a future registry change shows up here.
    for (const n of enabledEvmRows()) {
      expect(SUPPORTED_CHAIN_IDS.has(n.chainId as number), `missing capability entry for ${n.slug}`).toBe(true);
    }
    // Arbitrary / unknown / deliberately-excluded chains are categorically absent —
    // nothing client-supplied can ever appear here, so no arbitrary RPC URL can
    // reach wagmi/viem. Held chains (Polygon WAS the example, now enabled),
    // special-handling and non-EVM rails all stay out.
    expect(SUPPORTED_CHAIN_IDS.has(UNKNOWN)).toBe(false);
    expect(SUPPORTED_CHAIN_IDS.has(MONAD_TESTNET)).toBe(false);
    expect(SUPPORTED_CHAIN_IDS.has(31337)).toBe(false);
    for (const n of CIRCLE_INVENTORY.filter((x) => x.status !== 'IMPLEMENTED_ENABLED' && x.chainId != null && x.slug !== 'ethereum_mainnet')) {
      expect(SUPPORTED_CHAIN_IDS.has(n.chainId as number), `not-enabled chain leaked in: ${n.slug}`).toBe(false);
    }
    // Ethereum (1) is the ONE deliberate exception: present ONLY as an ENS-
    // resolution capability. It is in the allowlist but is NOT an inventory-
    // enabled payable network, and never will be (operator ENS-only decision).
    expect(SUPPORTED_CHAIN_IDS.has(1)).toBe(true);
    expect(enabledEvmRows().some((n) => n.chainId === 1)).toBe(false);
    // And the frontend resolver still refuses to build a payable view for it:
    // mainnet has no backend registry row, so no intent can ever target chain 1.
    expect(CIRCLE_INVENTORY.find((n) => n.slug === 'ethereum_mainnet')?.status).toBe('VERIFIED_NOT_ENABLED');
    // The set is FINITE and curated — it can never become "any chain".
    expect(SUPPORTED_CHAIN_IDS.size).toBeLessThan(50);
  });
});

describe('A/B — existing Arc flows unchanged', () => {
  it('A: Arc Testnet intent resolves ready with correct name, chain and explorer', () => {
    const view = resolveCheckoutNetwork(intent({ chain_id: ARC_TESTNET, network: 'arc_testnet' }));
    expect(view.status).toBe('ready');
    expect(view.isSupported).toBe(true);
    expect(view.chainId).toBe(ARC_TESTNET);
    expect(view.displayName).toBe('Arc Testnet');
    expect(view.isTestnet).toBe(true);
    expect(view.txExplorerUrl('0xabc')).toBe('https://explorer.testnet.arc.io/tx/0xabc');
  });

  it('B: Arc Mainnet intent resolves ready to the production Arc explorer', () => {
    const view = resolveCheckoutNetwork(intent({ chain_id: ARC_MAINNET, network: 'arc_mainnet' }));
    expect(view.status).toBe('ready');
    expect(view.displayName).toBe('Arc');
    expect(view.isTestnet).toBe(false);
    expect(view.addressExplorerUrl('0xdef')).toBe('https://explorer.arc.io/address/0xdef');
  });

  it('A/B: payment is allowed when connected, on-chain and not expired', () => {
    for (const cid of [ARC_TESTNET, ARC_MAINNET]) {
      const view = resolveCheckoutNetwork(intent({ chain_id: cid }));
      expect(canAttemptPayment({ view, isConnected: true, walletChainId: cid, isExpired: false })).toBe(true);
    }
  });
});

describe('C — supported non-Arc fixture network', () => {
  it('renders correct name/id/explorer and requires switching to it', () => {
    const pinned = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia USDC in facts
    const view = resolveCheckoutNetwork(intent({ chain_id: BASE_SEPOLIA, usdc_address: pinned }));
    expect(view.status).toBe('ready');
    expect(view.chainId).toBe(BASE_SEPOLIA);
    expect(view.displayName).toBe('Base Sepolia');
    expect(view.txExplorerUrl('0x123')).toBe(`${getChain(BASE_SEPOLIA)!.explorerBase}/tx/0x123`);
    // Explorer is explicitly NOT an Arc URL.
    expect(view.txExplorerUrl('0x123')!.includes('arc.io')).toBe(false);
    // Switching: wallet on Arc must switch to Base Sepolia before pay is enabled.
    expect(isWrongNetwork(ARC_MAINNET, BASE_SEPOLIA)).toBe(true);
    expect(canAttemptPayment({ view, isConnected: true, walletChainId: ARC_MAINNET, isExpired: false })).toBe(false);
    expect(canAttemptPayment({ view, isConnected: true, walletChainId: BASE_SEPOLIA, isExpired: false })).toBe(true);
  });
});

describe('D — unknown chain id: no Arc fallback, pay disabled', () => {
  it('flags unsupported, exposes no USDC/explorer, blocks payment', () => {
    const view = resolveCheckoutNetwork(intent({ chain_id: UNKNOWN }));
    expect(view.status).toBe('unsupported');
    expect(view.isSupported).toBe(false);
    expect(view.usdcAddress).toBeNull();
    expect(view.txExplorerUrl('0x1')).toBeNull();     // never an Arc explorer
    expect(view.addressExplorerUrl('0x1')).toBeNull();
    expect(canAttemptPayment({ view, isConnected: true, walletChainId: UNKNOWN, isExpired: false })).toBe(false);
  });
});

describe('E — facts-known but not allowlisted (missing frontend chain definition)', () => {
  // INTENTIONALLY UPDATED BY THE MASTER EXPANSION: Polygon PoS (137) is now a
  // curated, allowlisted capability. The same fail-closed premise is proven with
  // Monad Testnet (10143) — present in the generated facts registry but with NO
  // frontend chain definition and NO backend enablement, so checkout must refuse
  // to pay rather than silently resolve it from facts.
  it('treats Monad Testnet as unsupported rather than silently paying on it', () => {
    expect(getChain(MONAD_TESTNET)).toBeDefined();     // exists in generated facts
    expect(SUPPORTED_CHAIN_IDS.has(MONAD_TESTNET)).toBe(false); // but not curated/allowlisted
    const view = resolveCheckoutNetwork(intent({ chain_id: MONAD_TESTNET }));
    expect(view.status).toBe('unsupported');
    expect(view.isSupported).toBe(false);
    expect(view.usdcAddress).toBeNull();
    expect(view.txExplorerUrl('0x1')).toBeNull();
  });
});

describe('E2 — MASTER PHASE mainnet capability: Base Mainnet + Arbitrum One resolve ready', () => {
  it('drives both new mainnets to their own explorer + PI-pinned USDC (never Arc)', () => {
    const basePinned = getChain(BASE_MAINNET)!.usdc!.address;   // 0x8335... Circle native USDC
    const arbPinned = getChain(ARBITRUM_ONE)!.usdc!.address;    // 0xaf88... Circle native USDC

    const baseView = resolveCheckoutNetwork(intent({ chain_id: BASE_MAINNET, network: 'base_mainnet', usdc_address: basePinned }));
    expect(baseView.status).toBe('ready');
    expect(baseView.isSupported).toBe(true);
    expect(baseView.isTestnet).toBe(false);
    expect(baseView.usdcAddress).toBe(basePinned);
    expect(baseView.txExplorerUrl('0x1')).toBe(`${getChain(BASE_MAINNET)!.explorerBase}/tx/0x1`);
    expect(baseView.txExplorerUrl('0x1')!.includes('arc.io')).toBe(false);

    const arbView = resolveCheckoutNetwork(intent({ chain_id: ARBITRUM_ONE, network: 'arbitrum_one', usdc_address: arbPinned }));
    expect(arbView.status).toBe('ready');
    expect(arbView.isSupported).toBe(true);
    expect(arbView.isTestnet).toBe(false);
    expect(arbView.usdcAddress).toBe(arbPinned);
    expect(arbView.txExplorerUrl('0x1')).toBe(`${getChain(ARBITRUM_ONE)!.explorerBase}/tx/0x1`);
    expect(arbView.txExplorerUrl('0x1')!.includes('arc.io')).toBe(false);

    // Frontend capability alone does not pay: wallet must be on the pinned chain.
    expect(canAttemptPayment({ view: baseView, isConnected: true, walletChainId: ARBITRUM_ONE, isExpired: false })).toBe(false);
    expect(canAttemptPayment({ view: baseView, isConnected: true, walletChainId: BASE_MAINNET, isExpired: false })).toBe(true);
  });
});

describe('F — wrong wallet network blocks payment', () => {
  it('detects mismatch and disables pay until switched', () => {
    const view = resolveCheckoutNetwork(intent({ chain_id: ARC_MAINNET }));
    expect(isWrongNetwork(ARC_TESTNET, view.chainId)).toBe(true);
    expect(isWrongNetwork(ARC_MAINNET, view.chainId)).toBe(false);
    expect(isWrongNetwork(undefined, view.chainId)).toBe(false); // not connected → handled elsewhere
    expect(canAttemptPayment({ view, isConnected: true, walletChainId: ARC_TESTNET, isExpired: false })).toBe(false);
  });
});

describe('G — loading intent never defaults to Arc Testnet', () => {
  it('null/absent intent yields a neutral loading view with no chain', () => {
    for (const v of [null, undefined]) {
      const view = resolveCheckoutNetwork(v);
      expect(view.status).toBe('loading');
      expect(view.chainId).toBeNull();
      expect(view.displayName).toBeNull();            // NOT 'Arc Testnet'
      expect(view.usdcAddress).toBeNull();
      expect(view.isSupported).toBe(false);
      expect(canAttemptPayment({ view, isConnected: true, walletChainId: ARC_TESTNET, isExpired: false })).toBe(false);
    }
  });
  it('non-integer chain id is treated as loading, never defaulted', () => {
    const view = resolveCheckoutNetwork({ ...intent({ chain_id: 0 }), chain_id: undefined as unknown as number });
    expect(view.status).toBe('loading');
  });
});

describe('H — explorer URL is always the pinned chain’s, never Arc by default', () => {
  it('non-Arc transaction does not resolve to an Arc explorer', () => {
    const view = resolveCheckoutNetwork(intent({ chain_id: BASE_SEPOLIA }));
    const url = view.txExplorerUrl('0xff')!;
    expect(url.startsWith('https://')).toBe(true);
    expect(url.includes('arc.io')).toBe(false);
    expect(url).toContain(getChain(BASE_SEPOLIA)!.explorerBase);
  });
});

describe('I — Payment Intent pinned USDC address is authoritative', () => {
  it('uses the PI-pinned address verbatim, never substitutes the registry value', () => {
    const pinned = '0x9999999999999999999999999999999999999999'; // deliberately != facts USDC
    const view = resolveCheckoutNetwork(intent({ chain_id: BASE_SEPOLIA, usdc_address: pinned }));
    expect(view.usdcAddress).toBe(pinned);
    // And the chain’s own facts USDC differs — proving we did NOT read from facts.
    expect(getChain(BASE_SEPOLIA)!.usdc!.address).not.toBe(pinned);
  });

  it('a PI for chain X never adopts chain Y USDC: each view returns its own pinned token', () => {
    const a = resolveCheckoutNetwork(intent({ chain_id: ARC_MAINNET, usdc_address: '0xaaaa000000000000000000000000000000000001' }));
    const b = resolveCheckoutNetwork(intent({ chain_id: BASE_SEPOLIA, usdc_address: '0xbbbb000000000000000000000000000000000002' }));
    expect(a.usdcAddress).toBe('0xaaaa000000000000000000000000000000000001');
    expect(b.usdcAddress).toBe('0xbbbb000000000000000000000000000000000002');
    // Chain id always mirrors the intent (verify must send this, never a hardcoded Arc id).
    expect(a.chainId).toBe(ARC_MAINNET);
    expect(b.chainId).toBe(BASE_SEPOLIA);
  });
});

describe('security: 1/2 — a PI for chain X cannot be paid using chain Y', () => {
  it('chain id + explorer + usdc all track the pinned intent chain, not the wallet chain', () => {
    const view = resolveCheckoutNetwork(intent({ chain_id: BASE_SEPOLIA }));
    // Even though the wallet sits on Arc, the view targets Base Sepolia.
    const walletOnArc = ARC_MAINNET;
    expect(view.chainId).not.toBe(walletOnArc);
    expect(isWrongNetwork(walletOnArc, view.chainId)).toBe(true);
    expect(canAttemptPayment({ view, isConnected: true, walletChainId: walletOnArc, isExpired: false })).toBe(false);
  });
});
