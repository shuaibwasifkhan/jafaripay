/**
 * CCTP MASTER PHASE 4 — pure checkout source-leg plan builder.
 *
 * Proves the frontend NEVER invents a CCTP burn param: every address/domain/
 * recipient is relayed from the server route plan, and the builder fails closed
 * (refuses to produce a plan) whenever the server did not pin a valid route.
 * Pure + side-effect free, so it runs under `bun test` with no wagmi/browser.
 */
import { test, expect } from 'bun:test';
import { buildCctpCheckoutPlan, type CctpCheckoutIntent, type CctpSourceRoute } from './cctp-checkout';

const ARC_WALLET_BYTES32 = '0x0000000000000000000000003af65566013269a1c2f6ee97d49f93a98d51d220';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia native USDC
const TM_TESTNET = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';

const route: CctpSourceRoute = {
  token_messenger: TM_TESTNET,
  destination_domain: 26,
  mint_recipient_bytes32: ARC_WALLET_BYTES32,
  destination_caller_bytes32: '0x' + '0'.repeat(64),
  burn_token: SRC_USDC,
  max_fee: '0',
  min_finality_threshold: 0,
};

function intent(over: Partial<CctpCheckoutIntent> = {}): CctpCheckoutIntent {
  return {
    chain_id: 84532, usdc_address: SRC_USDC, amount_base_units: '5000000',
    cross_chain: true, cctp_source_route: route, ...over,
  };
}

test('C4-1: same-chain intent is not a cross-chain plan (defers to ERC-20 transfer)', () => {
  expect(buildCctpCheckoutPlan(intent({ cross_chain: false, cctp_source_route: undefined })).status).toBe('not_cross_chain');
});

test('C4-2: ready plan relays server params verbatim — approve spender = TokenMessenger, burn to Arc', () => {
  const p = buildCctpCheckoutPlan(intent());
  expect(p.status).toBe('ready');
  if (p.status !== 'ready') return;
  expect(p.approve.to.toLowerCase()).toBe(SRC_USDC.toLowerCase());
  expect(p.approve.spender.toLowerCase()).toBe(TM_TESTNET.toLowerCase());
  expect(p.approve.amount).toBe(5_000_000n);
  expect(p.depositForBurn.to.toLowerCase()).toBe(TM_TESTNET.toLowerCase());
  const [amount, domain, mintRecipient, burnToken, caller, maxFee, minFin] = p.depositForBurn.args;
  expect(amount).toBe(5_000_000n);
  expect(domain).toBe(26);
  expect(mintRecipient).toBe(ARC_WALLET_BYTES32);
  expect(burnToken.toLowerCase()).toBe(SRC_USDC.toLowerCase());
  expect(caller).toBe('0x' + '0'.repeat(64));
  expect(maxFee).toBe(0n);
  expect(minFin).toBe(0);
});

test('C4-3: cross_chain with NO server route FAILS CLOSED (client never fabricates a burn)', () => {
  const p = buildCctpCheckoutPlan(intent({ cctp_source_route: undefined }));
  expect(p.status).toBe('missing_route');
});

test('C4-4: is_cross_chain=1 (raw DB flag) is also treated as cross-chain', () => {
  const p = buildCctpCheckoutPlan({ chain_id: 84532, usdc_address: SRC_USDC, amount_base_units: '1', is_cross_chain: 1, cctp_source_route: route });
  expect(p.status).toBe('ready');
});

test('C4-5: burn token that drifts from the intent-pinned USDC is refused', () => {
  const p = buildCctpCheckoutPlan(intent({ cctp_source_route: { ...route, burn_token: '0x0000000000000000000000000000000000000001' } }));
  expect(p.status).toBe('invalid_route');
});

test('C4-6: malformed server values are refused, never forwarded to a money tx', () => {
  expect(buildCctpCheckoutPlan(intent({ cctp_source_route: { ...route, token_messenger: 'not-an-address' } })).status).toBe('invalid_route');
  expect(buildCctpCheckoutPlan(intent({ cctp_source_route: { ...route, mint_recipient_bytes32: '0xdeadbeef' } })).status).toBe('invalid_route');
  expect(buildCctpCheckoutPlan(intent({ cctp_source_route: { ...route, destination_domain: -1 } })).status).toBe('invalid_route');
});

test('C4-7: non-positive amount is refused', () => {
  expect(buildCctpCheckoutPlan(intent({ amount_base_units: '0' })).status).toBe('invalid_route');
});

// ── STEP 5 — CCTP V2 Forwarding plan (server-approved fee F > 0) ────────────
// Locked DEDUCTED model: merchant target M = intent.amount_base_units (never
// changes); server-approved fee F = intent.forwarding_max_fee_base_units. Source
// gross burn = M + F; approve covers exactly M + F (never unlimited); the WITH-
// HOOK burn uses the Standard(2000) finality and the server-authored hook. A
// DIRECT route (no/zero fee) stays byte-identical to the pre-STEP-5 plan.
const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000';
const FEE = 20_380n;
const fwdRoute: CctpSourceRoute = { ...route, hook_data: FORWARD_HOOK };

function fwdIntent(over: Partial<CctpCheckoutIntent> = {}): CctpCheckoutIntent {
  return intent({ cctp_source_route: fwdRoute, forwarding_max_fee_base_units: FEE.toString(), ...over });
}

test('C5-1: forwarding plan approves the GROSS M+F and emits depositForBurnWithHook with exact args', () => {
  const p = buildCctpCheckoutPlan(fwdIntent());
  expect(p.status).toBe('ready');
  if (p.status !== 'ready') return;
  expect(p.forwarding).toBe(true);
  // Approve covers exactly the gross the TokenMessenger pulls: M + F.
  expect(p.approve.amount).toBe(5_000_000n + FEE);
  expect(p.depositForBurnWithHook).toBeDefined();
  if (!p.depositForBurnWithHook) return;
  const [amount, domain, mintRecipient, burnToken, caller, maxFee, minFin, hook] = p.depositForBurnWithHook.args;
  expect(amount).toBe(5_000_000n + FEE); // gross M + F
  expect(domain).toBe(26);
  expect(mintRecipient).toBe(ARC_WALLET_BYTES32);
  expect(burnToken.toLowerCase()).toBe(SRC_USDC.toLowerCase());
  expect(caller).toBe('0x' + '0'.repeat(64));
  expect(maxFee).toBe(FEE); // F, not 0, not gross
  expect(minFin).toBe(2000); // Standard finality, never Fast(1000)
  expect(hook).toBe(FORWARD_HOOK); // server-authored cctp-forward bytes, verbatim
});

test('C5-2: forwarding finality is pinned to 2000 even if the route value is lower (cannot downgrade)', () => {
  const p = buildCctpCheckoutPlan(fwdIntent({ cctp_source_route: { ...fwdRoute, min_finality_threshold: 1000 } }));
  expect(p.status).toBe('ready');
  if (p.status !== 'ready') return;
  expect(p.depositForBurnWithHook?.args[6]).toBe(2000);
});

test('C5-3: forwarding intent MISSING the server hook FAILS CLOSED (never a silent direct M+F burn)', () => {
  const p = buildCctpCheckoutPlan(fwdIntent({ cctp_source_route: { ...route } })); // fee>0 but no hook_data
  expect(p.status).toBe('invalid_route');
});

test('C5-4: forwarding intent with a MALFORMED hook is refused, never forwarded to a money tx', () => {
  const p = buildCctpCheckoutPlan(fwdIntent({ cctp_source_route: { ...route, hook_data: '0x12345' } })); // odd-length hex
  expect(p.status).toBe('invalid_route');
});

test('C5-5: DIRECT route stays byte-identical — forwarding false, no WithHook, approve = M', () => {
  const p = buildCctpCheckoutPlan(intent()); // no forwarding_max_fee_base_units
  expect(p.status).toBe('ready');
  if (p.status !== 'ready') return;
  expect(p.forwarding).toBe(false);
  expect(p.depositForBurnWithHook).toBeUndefined();
  expect(p.approve.amount).toBe(5_000_000n);
  expect(p.depositForBurn.args[5]).toBe(0n); // route max_fee passthrough
});

test('C5-6: an explicit zero forwarding fee is treated as DIRECT (F=0 => burn M)', () => {
  const p = buildCctpCheckoutPlan(fwdIntent({ forwarding_max_fee_base_units: '0' }));
  expect(p.status).toBe('ready');
  if (p.status !== 'ready') return;
  expect(p.forwarding).toBe(false);
  expect(p.approve.amount).toBe(5_000_000n);
});
