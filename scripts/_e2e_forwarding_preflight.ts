/**
 * STEP 5L-F FORWARDING PREFLIGHT (READ-ONLY)
 *
 * Loads the repo .env via Bun, verifies source wallet + balances + recipient +
 * amount + live Circle Forwarding quote, and reports ONLY public information.
 *
 * Never prints the private key or its hex value. Never broadcasts a tx. Never
 * calls receiveMessage. Never changes any code, registry, or schema.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, erc20Abi } from 'viem';
import { baseSepolia } from 'viem/chains';

const PK = (process.env.E2E_SOURCE_PK ?? '').trim();
const RECIPIENT = (process.env.E2E_MINT_RECIPIENT ?? '').trim();
const AMOUNT_RAW = (process.env.E2E_AMOUNT_BASE_UNITS ?? '').trim();

if (!PK) throw new Error('E2E_SOURCE_PK missing');
if (!RECIPIENT) throw new Error('E2E_MINT_RECIPIENT missing');
if (!AMOUNT_RAW) throw new Error('E2E_AMOUNT_BASE_UNITS missing');

// Normalize PK to 0x-prefixed hex WITHOUT ever printing it.
const pkHex = PK.startsWith('0x') ? PK : `0x${PK}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(pkHex)) throw new Error('E2E_SOURCE_PK is not a 32-byte hex key');

const account = privateKeyToAccount(pkHex as `0x${string}`);

if (!/^0x[0-9a-fA-F]{40}$/.test(RECIPIENT)) throw new Error('E2E_MINT_RECIPIENT is not a 20-byte address');
const amount = BigInt(AMOUNT_RAW);
if (amount <= 0n) throw new Error('E2E_AMOUNT_BASE_UNITS must be positive');

const SRC_RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // registry-pinned Base Sepolia native USDC

const client = createPublicClient({ chain: baseSepolia, transport: http(SRC_RPC) });

const [chainId, ethBal, usdcBal, allowBal] = await Promise.all([
  client.getChainId(),
  client.getBalance({ address: account.address }),
  client.readContract({ address: SRC_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
  client.readContract({ address: SRC_USDC, abi: erc20Abi, functionName: 'allowance', args: [account.address, '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'] }),
]);

// Live Circle Forwarding Standard(2000) quote for Base Sepolia domain 6 -> Arc domain 26.
const quoteUrl = 'https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/6/26?forward=true';
const quoteRes = await fetch(quoteUrl);
const quoteJson = quoteRes.ok ? await quoteRes.json() : null;

// Select ONLY the Standard(2000) entry (matches the implementation's rule).
let selected: { finalityThreshold: number; minimumFee: number; forwardFee?: { med?: number } } | null = null;
if (Array.isArray(quoteJson)) {
  selected = quoteJson.find((e: { finalityThreshold?: number }) => e.finalityThreshold === 2000) ?? null;
}

// Circle's exact fee math (mirrored from server/blockchain/cctp-forwarding-fee.ts).
let fee = 0n;
let protocolFee = 0n;
if (selected && typeof selected.forwardFee?.med === 'number' && Number.isFinite(selected.minimumFee)) {
  const forwardFee = BigInt(Math.round(selected.forwardFee.med));
  protocolFee = (amount * BigInt(Math.round(selected.minimumFee * 100))) / 1_000_000n;
  fee = forwardFee + protocolFee;
}
const gross = amount + fee;

// Report ONLY public, non-secret facts.
console.log('source_address      ', account.address);
console.log('source_chain_id     ', chainId, '(expected 84532)', chainId === 84532 ? 'OK' : 'MISMATCH');
console.log('source_eth_balance  ', ethBal.toString(), 'wei');
console.log('source_usdc_balance ', usdcBal.toString(), 'base-units');
console.log('source_tm_allowance ', allowBal.toString(), 'base-units (already approved to TokenMessengerV2)');
console.log('recipient           ', RECIPIENT);
console.log('amount_base_units   ', amount.toString());
console.log('quote_status        ', quoteRes.status);
console.log('standard_2000_found ', selected !== null);
if (selected) {
  console.log('quote_entry         ', JSON.stringify(selected));
  console.log('fee_F_base_units    ', fee.toString(), `(forwardFee.med + protocolFee=${protocolFee.toString()})`);
  console.log('gross_M_plus_F      ', gross.toString());
  console.log('usdc_covers_gross   ', usdcBal >= gross ? 'YES' : 'NO (short by ' + (gross - usdcBal).toString() + ')');
}
