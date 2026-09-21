/**
 * JafariPay — Exact arithmetic for USDC amounts.
 * Never use floating point on money paths.
 *
 * USDC has 6 decimal places on all supported networks.
 */

export const USDC_DECIMALS = 6;
const USDC_FACTOR = BigInt(10 ** USDC_DECIMALS); // 1_000_000

/**
 * Parse a decimal string like "25.00" → BigInt base units (e.g. 25_000_000n).
 * Throws if the string is not valid.
 */
export function parseDecimalToBaseUnits(decimalStr: string): bigint {
  const trimmed = decimalStr.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid USDC amount: "${decimalStr}"`);
  }

  const [intPart, fracPart = ''] = trimmed.split('.');
  if (fracPart.length > USDC_DECIMALS) {
    throw new Error(`USDC amount "${decimalStr}" has more than ${USDC_DECIMALS} decimal places`);
  }

  const paddedFrac = fracPart.padEnd(USDC_DECIMALS, '0');
  return BigInt(intPart) * USDC_FACTOR + BigInt(paddedFrac);
}

/**
 * Format base units (as BigInt or string) back to a decimal string e.g. "25.000000".
 */
export function formatBaseUnitsToDecimal(baseUnits: bigint | string): string {
  const n = typeof baseUnits === 'string' ? BigInt(baseUnits) : baseUnits;
  const intPart = n / USDC_FACTOR;
  const fracPart = n % USDC_FACTOR;
  return `${intPart}.${fracPart.toString().padStart(USDC_DECIMALS, '0')}`;
}

/**
 * Validate that amount string is > 0.
 */
export function validatePositiveAmount(decimalStr: string): bigint {
  const base = parseDecimalToBaseUnits(decimalStr);
  if (base <= 0n) throw new Error('Amount must be greater than zero');
  return base;
}

/**
 * Parse and validate: must be a positive decimal string.
 */
export function parseAndValidate(decimalStr: string): bigint {
  const base = parseDecimalToBaseUnits(decimalStr);
  if (base <= 0n) throw new Error('Amount must be greater than zero');
  return base;
}
