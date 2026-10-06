/**
 * PRODUCT PHASE 1 — money-facing checkout fee disclosure (pure, no browser).
 *
 * Proves the checkout displays EXACTLY what the verified engine executes for a
 * FORWARDING payment (customer M + F, merchant M), keeps same-chain and DIRECT
 * (F = 0) payments on their unchanged single-amount UX, never lets a frontend
 * value define the fee, and that the public copy no longer claims "1:1" or
 * "maxFee = 0" for Forwarding. The displayed gross is asserted against the SAME
 * number buildCctpCheckoutPlan puts on-chain (approve.amount / burn arg 0), so
 * label and transaction can never drift apart.
 */
import { test, expect } from 'bun:test';
import { file } from 'bun';
import { join } from 'path';
import { describeCheckoutAmounts } from './checkout-fees';
import { buildCctpCheckoutPlan, type CctpCheckoutIntent, type CctpSourceRoute } from './cctp-checkout';
// The fee PRESENTATION module is server-authored; the test shares it so the
// UI helper is asserted against the real server breakdown object, not a copy.
import { describeCrossChainFees, describeForwardingFees } from '../server/lib/fees';

const ARC_WALLET_BYTES32 = '0x0000000000000000000000003af65566013269a1c2f6ee97d49f93a98d51d220';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TM_TESTNET = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000';
const M = '5000000';           // merchant amount 5.00 USDC
const F = '20380';             // server-approved Circle forwarding fee 0.020380

const route: CctpSourceRoute = {
  token_messenger: TM_TESTNET,
  destination_domain: 26,
  mint_recipient_bytes32: ARC_WALLET_BYTES32,
  destination_caller_bytes32: '0x' + '0'.repeat(64),
  burn_token: SRC_USDC,
  max_fee: '0',
  min_finality_threshold: 0,
};
const fwdRoute: CctpSourceRoute = { ...route, hook_data: FORWARD_HOOK };

function fwdIntent(over: Partial<CctpCheckoutIntent> = {}): CctpCheckoutIntent {
  return {
    chain_id: 84532, usdc_address: SRC_USDC, amount_base_units: M,
    cross_chain: true, cctp_source_route: fwdRoute, forwarding_max_fee_base_units: F, ...over,
  };
}

const fwdFees = describeForwardingFees({ merchantAmountBaseUnits: M, forwardingFeeBaseUnits: F });

// ── P1-U1 (§14 A): Forwarding F > 0 yields exactly the three honest lines ────
test('U1: a Forwarding checkout shows merchant M, fee F and total M + F from server fields', () => {
  const lines = describeCheckoutAmounts({ cross_chain: true, forwarding: true, fees: fwdFees });
  expect(lines).not.toBeNull();
  expect(lines!.merchantAmount).toBe('5.000000');
  expect(lines!.forwardingFee).toBe('0.020380');
  expect(lines!.total).toBe('5.020380');
  expect(lines!.totalBaseUnits).toBe(5_000_000n + 20_380n);
});

// ── P1-U2 (§14 B): same-chain and DIRECT (F = 0) never grow a fee row ────────
test('U2: same-chain and DIRECT Standard (F = 0) intents return no forwarding lines', () => {
  // Same-chain: no cross_chain, no fees at all.
  expect(describeCheckoutAmounts({} as never)).toBeNull();
  expect(describeCheckoutAmounts({ cross_chain: false })).toBeNull();
  // DIRECT cross-chain: the Standard 1:1 model must NOT render a fee row.
  const direct = describeCrossChainFees({ amountBaseUnits: M, feeBaseUnits: '0' });
  expect(direct.model).toBe('cctp_standard_1to1');
  expect(describeCheckoutAmounts({ cross_chain: true, forwarding: false, fees: direct })).toBeNull();
  // A stray forwarding flag cannot force a fee row without the server model.
  expect(describeCheckoutAmounts({ cross_chain: true, forwarding: true, fees: direct })).toBeNull();
});

// ── P1-U3 (§14 C): displayed total == wallet approval == burn amount ─────────
test('U3: the displayed total equals plan.approve.amount and the burn first arg (M + F)', () => {
  const lines = describeCheckoutAmounts({ cross_chain: true, forwarding: true, fees: fwdFees })!;
  const p = buildCctpCheckoutPlan(fwdIntent());
  expect(p.status).toBe('ready');
  if (p.status !== 'ready') return;
  expect(p.forwarding).toBe(true);
  expect(lines.totalBaseUnits).toBe(p.approve.amount);                 // displayed == approved
  if (p.depositForBurnWithHook) {
    expect(lines.totalBaseUnits).toBe(p.depositForBurnWithHook.args[0]); // displayed == burned
  }
  // Merchant amount displayed is the intent amount M — never M + F, never M - F.
  expect(BigInt(fwdFees.merchant_amount_base_units!)).toBe(BigInt(M));
});

// ── P1-U4 (§14 D): a frontend-shaped object with injected values changes nothing ──
test('U4: client-injected fee fields are ignored — only the server model/decide lines', () => {
  // A hostile-looking intent carries client "fee" fields but NO server forwarding
  // model: the helper must refuse to render any fee (the server never authored one).
  const hostile = {
    cross_chain: true,
    forwarding_max_fee_base_units: '999999999',
    max_fee: '999999999',
    fees: { model: 'cctp_standard_1to1', gross_amount_base_units: M },
  };
  expect(describeCheckoutAmounts(hostile as never)).toBeNull();
  // Malformed server gross must fail closed, never reach a money label.
  expect(describeCheckoutAmounts({
    cross_chain: true, forwarding: true,
    fees: { model: 'cctp_forwarding_additive', merchant_amount_decimal: '5.000000', forwarding_fee_decimal: '0.02', gross_amount_decimal: 'x', gross_amount_base_units: 'not-a-number' },
  })).toBeNull();
});

// ── P1-U5 (§14 G): public copy carries no false Forwarding "1:1"/maxFee=0 ────
test('U5: README, docs and roadmap copy no longer claim 1:1 or maxFee = 0', async () => {
  const root = join(import.meta.dir, '..');
  const texts: Record<string, string> = {
    'README.md': await file(join(root, 'README.md')).text(),
    'DocsPage': await file(join(root, 'src', 'components', 'docs', 'DocsPage.tsx')).text(),
    'RoadmapPage': await file(join(root, 'src', 'components', 'landing', 'RoadmapPage.tsx')).text(),
  };
  for (const [name, text] of Object.entries(texts)) {
    expect(text.includes('1:1'), name).toBe(false);
    expect(text.includes('maxFee = 0'), name).toBe(false);
    expect(text.includes('maxFee=0'), name).toBe(false);
    expect(/zero[- ]fee/i.test(text), name).toBe(false);
  }
  // And the corrected Forwarding wording is actually present.
  expect(texts['README.md'].includes('forwarding fee'), 'README').toBe(true);
  expect(texts['DocsPage'].includes('Forwarding economics'), 'DocsPage').toBe(true);
  expect(texts['RoadmapPage'].includes('forwarding fee'), 'RoadmapPage').toBe(true);
});
