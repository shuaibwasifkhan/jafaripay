/**
 * PHASE 1 — CCTP registry validation.
 *
 * These tests are the PHASE 1 gate. They assert that the single source of truth
 * (server/db/cctp.ts) agrees with (a) the audited Circle/Arc protocol facts and
 * (b) the Arc-Studio-generated onchain-facts, so a future edit cannot silently
 * move a domain, flip an unsupported chain into "supported", or drift an address.
 * Pure assertions — no DB, no network, no live money.
 */
import { test, expect, describe } from 'bun:test';
import {
  CCTP_REGISTRY,
  CCTP_CONTRACTS_MAINNET,
  CCTP_CONTRACTS_TESTNET,
  ARC_MAINNET_SLUG,
  ARC_TESTNET_SLUG,
  ARC_CCTP_DOMAIN,
  NOT_A_CCTP_SOURCE,
  isCctpSource,
  isCctpDestination,
  cctpDomainOf,
  cctpContractsFor,
  arcDestinationForEnvironment,
} from './db/cctp.ts';
import { EVM_PROTOCOL_CONTRACTS } from '../src/onchain-facts.ts';

// The eight cross-chain source mainnets named by the master plan (Arc excluded —
// Arc is the destination / same-chain rail, never a CCTP source here).
const PRODUCTION_SOURCES = ['base_mainnet', 'arbitrum_one', 'polygon_pos', 'avalanche_c', 'op_mainnet', 'linea', 'unichain'] as const;

describe('Arc destination', () => {
  test('Arc mainnet + testnet are the destination (domain 26), never a source', () => {
    expect(ARC_CCTP_DOMAIN).toBe(26);
    for (const arc of [ARC_MAINNET_SLUG, ARC_TESTNET_SLUG]) {
      expect(isCctpDestination(arc)).toBe(true);
      expect(isCctpSource(arc)).toBe(false);
      expect(cctpDomainOf(arc)).toBe(26);
    }
  });

  test('environment maps to the correct Arc destination slug (same domain)', () => {
    expect(arcDestinationForEnvironment('live')).toEqual({ slug: ARC_MAINNET_SLUG, domain: 26 });
    expect(arcDestinationForEnvironment('test')).toEqual({ slug: ARC_TESTNET_SLUG, domain: 26 });
  });
});

describe('Production CCTP sources', () => {
  test.each(
    [
      ['base_mainnet', 6],
      ['arbitrum_one', 3],
      ['polygon_pos', 7],
      ['avalanche_c', 1],
      ['op_mainnet', 2],
      ['linea', 11],
      ['unichain', 10],
    ] as [string, number][],
  )('%s is a supported source with Circle domain %d', (slug: string, domain: number) => {
    expect(isCctpSource(slug)).toBe(true);
    expect(isCctpDestination(slug)).toBe(false);
    expect(cctpDomainOf(slug)).toBe(domain);
    expect(CCTP_REGISTRY[slug]!.supportedAsSource).toBe(true);
  });

  test('the Base Sepolia pilot is testnet-class; production sources are mainnet-class', () => {
    expect(isCctpSource('base_sepolia')).toBe(true);
    expect(CCTP_REGISTRY['base_sepolia']!.isTestnet).toBe(true);
    for (const s of PRODUCTION_SOURCES) {
      expect(CCTP_REGISTRY[s]!.isTestnet).toBe(false);
    }
  });
});

describe('Chains that are NOT Circle-native cross-chain sources', () => {
  test('zkSync Era and Celo are explicitly unsupported as cross-chain sources', () => {
    expect(NOT_A_CCTP_SOURCE).toContain('zksync_era');
    expect(NOT_A_CCTP_SOURCE).toContain('celo');
    expect(isCctpSource('zksync_era')).toBe(false);
    expect(isCctpSource('celo')).toBe(false);
    expect(cctpDomainOf('zksync_era')).toBeNull();
    expect(cctpDomainOf('celo')).toBeNull();
  });

  test('an unknown slug resolves to no domain and no source/destination role', () => {
    expect(cctpDomainOf('not_a_network')).toBeNull();
    expect(isCctpSource('not_a_network')).toBe(false);
    expect(isCctpDestination('not_a_network')).toBe(false);
  });
});

describe('CCTP contract addresses agree with the audited onchain-facts', () => {
  // CCTP v2 MessageTransmitter/TokenMessenger are cross-chain-constant, so the
  // single mainnet/testnet pair in onchain-facts is authoritative for every
  // EVM route AND for the Arc destination mint.
  const factsMainnetTM = EVM_PROTOCOL_CONTRACTS.find((c) => c.name === 'TokenMessengerV2' && c.networkKind === 'mainnet')!;
  const factsMainnetMT = EVM_PROTOCOL_CONTRACTS.find((c) => c.name === 'MessageTransmitterV2' && c.networkKind === 'mainnet')!;
  const factsTestTM = EVM_PROTOCOL_CONTRACTS.find((c) => c.name === 'TokenMessengerV2' && c.networkKind === 'testnet')!;
  const factsTestMT = EVM_PROTOCOL_CONTRACTS.find((c) => c.name === 'MessageTransmitterV2' && c.networkKind === 'testnet')!;

  test('mainnet pair matches onchain-facts', () => {
    expect(CCTP_CONTRACTS_MAINNET.tokenMessengerV2.toLowerCase()).toBe(factsMainnetTM.address.toLowerCase());
    expect(CCTP_CONTRACTS_MAINNET.messageTransmitterV2.toLowerCase()).toBe(factsMainnetMT.address.toLowerCase());
  });

  test('testnet pair matches onchain-facts', () => {
    expect(CCTP_CONTRACTS_TESTNET.tokenMessengerV2.toLowerCase()).toBe(factsTestTM.address.toLowerCase());
    expect(CCTP_CONTRACTS_TESTNET.messageTransmitterV2.toLowerCase()).toBe(factsTestMT.address.toLowerCase());
  });

  test('cctpContractsFor selects the pair by environment class (not per chain)', () => {
    expect(cctpContractsFor(false)).toBe(CCTP_CONTRACTS_MAINNET);
    expect(cctpContractsFor(true)).toBe(CCTP_CONTRACTS_TESTNET);
  });
});

describe('Registry hygiene', () => {
  test('slugs are unique and each entry slug equals its key', () => {
    const entries = Object.entries(CCTP_REGISTRY);
    const seen = new Set<string>();
    for (const [key, cfg] of entries) {
      expect(cfg.slug).toBe(key);
      expect(seen.has(cfg.slug)).toBe(false);
      seen.add(cfg.slug);
    }
  });

  test('no cross-chain source is simultaneously the destination', () => {
    for (const cfg of Object.values(CCTP_REGISTRY)) {
      expect(cfg.supportedAsSource && cfg.supportedAsDestination).toBe(false);
    }
  });

  test('every source/destination entry carries a positive domain', () => {
    for (const cfg of Object.values(CCTP_REGISTRY)) {
      expect(cfg.cctpDomain).toBeGreaterThan(0);
    }
  });
});
