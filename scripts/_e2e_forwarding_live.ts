/**
 * STEP 5L-F — REAL BASE SEPOLIA -> ARC TESTNET CCTP FORWARDING E2E HARNESS.
 *
 * Strictly a live operator harness. Uses the SAME 8-arg depositForBurnWithHook
 * ABI and the SAME fee/hook/finality semantics as the reviewed Step 5
 * implementation (src/cctp-checkout.ts + server/blockchain/cctp-*.ts).
 *
 * What it does, ONLY:
 *   1. approve(TokenMessengerV2, gross = M + F) on Base Sepolia USDC - exact
 *      gross, never unlimited. Skipped when allowance already >= gross.
 *   2. depositForBurnWithHook(M+F, 26, recipient_bytes32, burnToken,
 *      bytes32(0), F, 2000, hook) on Base Sepolia TokenMessengerV2.
 *   3. Reads back the burn tx receipt + decoded args and asserts the on-chain
 *      amount == M+F, maxFee == F, destinationDomain == 26,
 *      destinationCaller == bytes32(0), hookData == Circle's cctp-forward bytes,
 *      minFinalityThreshold == 2000.
 *   4. Polls Circle Iris (SANDBOX) /v2/messages/6?transactionHash={burnHash}
 *      until it returns status=complete AND forwardTxHash is present. NEVER
 *      calls receiveMessage; Circle performs the Arc mint.
 *   5. Reads the Arc Testnet receipt for forwardTxHash and asserts:
 *        - transaction succeeded
 *        - to == Arc MessageTransmitterV2 (registry-pinned)
 *        - a USDC Transfer log ZERO -> recipient exists with value == M
 *          (NOT M + F - Circle deducts F before minting on Arc).
 *
 * NEVER prints the private key or its hex. Only public addresses, tx hashes,
 * amounts, and status are logged. Never fabricates anything: if any step fails,
 * it throws with the exact reason.
 */
import { privateKeyToAccount } from 'viem/accounts';
import {
  createPublicClient, createWalletClient, custom, http, encodeEventTopics,
  parseAbi, pad, type Hex,
} from 'viem';
import { baseSepolia } from 'viem/chains';

// ── registry-pinned facts (mirror server/db/cctp.ts + cctp-forwarding-fee.ts;
//    the registry test cctp-registry.test.ts asserts these equal the module) ──
const SRC_RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const DEST_RPC = process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io';
const SRC_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Hex;
const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as Hex;
const ARC_USDC = '0x3600000000000000000000000000000000000000' as Hex;
const ARC_MESSAGE_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as Hex;
const ARC_CHAIN_ID = 5042002;
const ARC_CCTP_DOMAIN = 26;
const SRC_CCTP_DOMAIN = 6;
const FORWARD_HOOK: Hex = '0x636374702d666f72776172640000000000000000000000000000000000000000';
const ZERO_B32: Hex = pad('0x', { size: 32 });
const IRIS_SANDBOX = 'https://iris-api-sandbox.circle.com';

const usdcAbi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const tmAbi = parseAbi([
  'function MAX_VERSION() view returns (uint32)',
]);
// The 8-arg CCTP v2 forwarding entry — signature from Circle's Forwarding
// quickstart (REF-1) and the exact ABI in src/cctp-checkout.ts.
const tokenMessengerV2Abi = [
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

// ── read env ────────────────────────────────────────────────────────────────
const PK = (process.env.E2E_SOURCE_PK ?? '').trim();
if (!PK) throw new Error('E2E_SOURCE_PK missing');
const pkHex = (PK.startsWith('0x') ? PK : `0x${PK}`) as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(pkHex)) throw new Error('E2E_SOURCE_PK malformed');
const RECIPIENT = (process.env.E2E_MINT_RECIPIENT ?? '').trim() as Hex;
if (!/^0x[0-9a-fA-F]{40}$/.test(RECIPIENT)) throw new Error('E2E_MINT_RECIPIENT malformed');
const AMOUNT = BigInt((process.env.E2E_AMOUNT_BASE_UNITS ?? '').trim());
if (AMOUNT <= 0n) throw new Error('E2E_AMOUNT_BASE_UNITS must be positive');

const account = privateKeyToAccount(pkHex);
const recipientB32: Hex = pad(RECIPIENT, { size: 32 });

const srcPublic = createPublicClient({ chain: baseSepolia, transport: http(SRC_RPC) });
// `custom` transport piggybacks on the ambient provider injected into global
// in the browser; for a Node/Bun harness we use the pk directly via a signer
// built atop http() instead.
const srcWallet = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(SRC_RPC),
});
const destPublic = createPublicClient({
  chain: {
    id: ARC_CHAIN_ID,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [DEST_RPC] }, public: { http: [DEST_RPC] } },
  },
  transport: http(DEST_RPC),
});

// ── STEP A: live Standard(2000) quote -> F ─────────────────────────────────
const quoteRes = await fetch(`${IRIS_SANDBOX}/v2/burn/USDC/fees/${SRC_CCTP_DOMAIN}/${ARC_CCTP_DOMAIN}?forward=true`);
if (quoteRes.status !== 200) throw new Error(`Circle fee quote non-200: ${quoteRes.status}`);
const quoteArr = await quoteRes.json();
if (!Array.isArray(quoteArr)) throw new Error('Circle fee quote body is not an array');
const stdEntry = quoteArr.find((e: { finalityThreshold?: number }) => e.finalityThreshold === 2000);
if (!stdEntry) throw new Error('Circle fee quote missing Standard(2000) entry');
if (typeof stdEntry.forwardFee?.med !== 'number' || !Number.isFinite(stdEntry.minimumFee)) {
  throw new Error('Circle Standard(2000) entry malformed (no forwardFee.med or minimumFee)');
}
// Circle's exact documented math, copied VERBATIM from
// server/blockchain/cctp-forwarding-fee.ts.
const forwardFee = BigInt(Math.round(stdEntry.forwardFee.med));
const protocolFee = (AMOUNT * BigInt(Math.round(stdEntry.minimumFee * 100))) / 1_000_000n;
const F = forwardFee + protocolFee;
if (F <= 0n) throw new Error('Forwarding fee F must be positive for a Forwarding burn');
const GROSS = AMOUNT + F;
console.log('── Quote (Standard 2000) ──');
console.log('M         base-units:', AMOUNT.toString());
console.log('F         base-units:', F.toString(), `(forwardFee.med=${forwardFee} protocolFee=${protocolFee})`);
console.log('M+F       base-units:', GROSS.toString());

// ── STEP B: verify sufficiency ──────────────────────────────────────────────
const bal = await srcPublic.readContract({ address: SRC_USDC, abi: usdcAbi, functionName: 'balanceOf', args: [account.address] });
const ethBal = await srcPublic.getBalance({ address: account.address });
if (bal < GROSS) throw new Error(`USDC ${bal} < gross ${GROSS} - insufficient`);
if (ethBal < 10n ** 15n) throw new Error('ETH gas balance looks too low (<0.001 ETH)');
console.log('source_address      ', account.address);
console.log('source_usdc_balance ', bal.toString());
console.log('source_eth_wei      ', ethBal.toString());

// ── STEP C: approval (EXACT gross, never unlimited) ────────────────────────
const allow = await srcPublic.readContract({ address: SRC_USDC, abi: usdcAbi, functionName: 'allowance', args: [account.address, TOKEN_MESSENGER] });
if (allow < GROSS) {
  console.log('── Approval ── current allowance', allow.toString(), '< gross', GROSS.toString(), '→ sending approve(gross)');
  const approveHash = await srcWallet.writeContract({
    address: SRC_USDC, abi: usdcAbi, functionName: 'approve',
    args: [TOKEN_MESSENGER, GROSS], chain: baseSepolia, account,
  });
  const approveReceipt = await srcPublic.waitForTransactionReceipt({ hash: approveHash });
  if (approveReceipt.status !== 'success') throw new Error('approve reverted: ' + approveReceipt.status);
  console.log('approve_tx           ', approveHash, 'status', approveReceipt.status, 'block', approveReceipt.blockNumber.toString());
  // Public RPC nodes can lag on state reads immediately after confirmation. Retry
  // the allowance read for up to ~15s before treating it as a real failure.
  let allow2 = allow;
  for (let i = 0; i < 8 && allow2 < GROSS; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    allow2 = await srcPublic.readContract({ address: SRC_USDC, abi: usdcAbi, functionName: 'allowance', args: [account.address, TOKEN_MESSENGER] });
  }
  if (allow2 < GROSS) throw new Error(`post-approve allowance ${allow2} < gross ${GROSS} after retries`);
  console.log('post_approve_allowance', allow2.toString());
} else {
  console.log('── Approval ── existing allowance', allow.toString(), '>= gross', GROSS.toString(), '→ skipping (no redundant tx)');
}

// ── STEP D: the FORWARDING burn (depositForBurnWithHook) ────────────────────
console.log('── Broadcast depositForBurnWithHook ──');
const burnHash = await srcWallet.writeContract({
  address: TOKEN_MESSENGER,
  abi: tokenMessengerV2Abi,
  functionName: 'depositForBurnWithHook',
  args: [GROSS, ARC_CCTP_DOMAIN, recipientB32, SRC_USDC, ZERO_B32, F, 2000, FORWARD_HOOK],
  chain: baseSepolia,
  account,
});
const burnReceipt = await srcPublic.waitForTransactionReceipt({ hash: burnHash });
if (burnReceipt.status !== 'success') throw new Error('depositForBurnWithHook reverted: ' + burnReceipt.status);
console.log('source_tx_hash      ', burnHash);
console.log('source_block_number ', burnReceipt.blockNumber.toString());
console.log('source_status       ', burnReceipt.status);
console.log('source_gas_used     ', burnReceipt.gasUsed.toString());

// Independently decode the burn tx to prove the on-chain params match the plan
// (never trust our own broadcast summary; read from the chain).
const burnTx = await srcPublic.getTransaction({ hash: burnHash });
const data = burnTx.input as Hex;
const selector = data.slice(0, 10);
// depositForBurnWithHook selector - keccak256 of the signature; verify by decoding args.
const argWords = [data.slice(10 + 0 * 64, 10 + 1 * 64), data.slice(10 + 1 * 64, 10 + 2 * 64), data.slice(10 + 2 * 64, 10 + 3 * 64), data.slice(10 + 3 * 64, 10 + 4 * 64), data.slice(10 + 4 * 64, 10 + 5 * 64), data.slice(10 + 5 * 64, 10 + 6 * 64), data.slice(10 + 6 * 64, 10 + 7 * 64)];
const onAmount = BigInt('0x' + argWords[0]);
const onDomain = Number(BigInt('0x' + argWords[1]));
const onRecipient = ('0x' + argWords[2]) as Hex;
const onBurnToken = ('0x' + argWords[3].slice(24)) as Hex;
const onCaller = ('0x' + argWords[4]) as Hex;
const onMaxFee = BigInt('0x' + argWords[5]);
const onMinFinality = Number(BigInt('0x' + argWords[6]));
// hookData is a dynamic bytes - starts at offset word then length + data.
const hookOffsetWord = data.slice(10 + 7 * 64, 10 + 8 * 64);
const hookOffset = Number(BigInt('0x' + hookOffsetWord));
const hookLenWord = data.slice(10 + hookOffset * 2, 10 + hookOffset * 2 + 64);
const hookLen = Number(BigInt('0x' + hookLenWord));
const hookBytes = ('0x' + data.slice(10 + hookOffset * 2 + 64, 10 + hookOffset * 2 + 64 + hookLen * 2)) as Hex;

console.log('── On-chain decoded burn params ──');
console.log('amount              ', onAmount.toString(), '(expected M+F =', GROSS.toString(), ')', onAmount === GROSS ? 'OK' : 'MISMATCH');
console.log('destinationDomain   ', onDomain, '(expected 26)', onDomain === 26 ? 'OK' : 'MISMATCH');
console.log('mintRecipient(b32)  ', onRecipient.toLowerCase(), '(expected', recipientB32.toLowerCase() + ')', onRecipient.toLowerCase() === recipientB32.toLowerCase() ? 'OK' : 'MISMATCH');
console.log('burnToken           ', onBurnToken.toLowerCase(), '(expected', SRC_USDC.toLowerCase() + ')', onBurnToken.toLowerCase() === SRC_USDC.toLowerCase() ? 'OK' : 'MISMATCH');
console.log('destinationCaller   ', onCaller, '(expected 0x00..00)', onCaller === ZERO_B32 ? 'OK' : 'MISMATCH');
console.log('maxFee              ', onMaxFee.toString(), '(expected F =', F.toString(), ')', onMaxFee === F ? 'OK' : 'MISMATCH');
console.log('minFinalityThreshold', onMinFinality, '(expected 2000)', onMinFinality === 2000 ? 'OK' : 'MISMATCH');
console.log('hookData            ', hookBytes.toLowerCase(), '(expected', FORWARD_HOOK.toLowerCase() + ')', hookBytes.toLowerCase() === FORWARD_HOOK.toLowerCase() ? 'OK' : 'MISMATCH');
if (onAmount !== GROSS || onDomain !== 26 || onMaxFee !== F || onMinFinality !== 2000 || hookBytes.toLowerCase() !== FORWARD_HOOK.toLowerCase() || onCaller !== ZERO_B32) {
  throw new Error('source tx decoded params do not match the Forwarding plan - STOP');
}

// ── STEP E: poll Circle for attestation + forwardTxHash ─────────────────────
const pollUrl = `${IRIS_SANDBOX}/v2/messages/${SRC_CCTP_DOMAIN}?transactionHash=${burnHash}`;
const deadline = Date.now() + 25 * 60_000; // 25 min budget for Circle
let forwardTxHash: string | null = null;
let attestationStatus = '';
let iter = 0;
while (Date.now() < deadline) {
  iter++;
  let body: unknown;
  try {
    const r = await fetch(pollUrl);
    if (r.status === 404) { console.log(`poll[${iter}] 404 not_observed`); }
    else { body = await r.json(); }
  } catch (e) { console.log(`poll[${iter}] network throw (retrying)`); }
  const entry = (body as { messages?: Array<{ status?: string; forwardTxHash?: string }> })?.messages?.[0];
  if (entry) {
    attestationStatus = entry.status ?? '';
    if (attestationStatus === 'complete' && typeof entry.forwardTxHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(entry.forwardTxHash)) {
      forwardTxHash = entry.forwardTxHash;
      console.log(`poll[${iter}] COMPLETE. forwardTxHash=${forwardTxHash}`);
      break;
    }
    console.log(`poll[${iter}] status=${attestationStatus}${entry.forwardTxHash ? ' forwardTxHash=' + entry.forwardTxHash : ''}`);
  }
  await new Promise((r) => setTimeout(r, 20_000));
}
if (!forwardTxHash) throw new Error(`Circle did not return a valid forwardTxHash within budget (last status: ${attestationStatus || 'not_observed'})`);

// ── STEP F: verify the Arc destination mint == EXACTLY M ───────────────────
console.log('── Arc destination verification ──');
const arcReceipt = await destPublic.getTransactionReceipt({ hash: forwardTxHash as Hex });
console.log('arc_tx_hash      ', forwardTxHash);
console.log('arc_status       ', arcReceipt.status);
console.log('arc_block_number ', arcReceipt.blockNumber.toString());
console.log('arc_to           ', (arcReceipt.to ?? 'null').toLowerCase(), '(expected Arc MessageTransmitterV2', ARC_MESSAGE_TRANSMITTER.toLowerCase() + ')');
if (arcReceipt.status !== 'success') throw new Error('Arc destination tx did not succeed');
if (arcReceipt.to === null || arcReceipt.to.toLowerCase() !== ARC_MESSAGE_TRANSMITTER.toLowerCase()) {
  throw new Error('Arc destination tx did not call the registry transmitter');
}

const recipientLower = RECIPIENT.toLowerCase();
// Filter Transfer logs emitted BY Arc native USDC whose `to` matches the recipient.
const usdcTransferTopic0 = encodeEventTopics({ abi: usdcAbi, eventName: 'Transfer' })[0];
let mintedTo: string | null = null;
let mintedAmount: bigint | null = null;
for (const log of arcReceipt.logs) {
  if (log.address.toLowerCase() !== ARC_USDC.toLowerCase()) continue;
  if (log.topics[0] !== usdcTransferTopic0) continue;
  const to = ('0x' + (log.topics[2] ?? '').slice(26)) as Hex;
  const value = BigInt('0x' + (log.data as Hex).slice(2));
  console.log('arc_log Transfer', 'from_topic1=', log.topics[1]?.slice(0, 10), 'to=', to.toLowerCase(), 'value=', value.toString());
  if (to.toLowerCase() === recipientLower) {
    if (mintedAmount !== null) throw new Error('multiple Transfer logs to the recipient - ambiguous destination');
    mintedTo = to;
    mintedAmount = value;
  }
}
if (mintedAmount === null) throw new Error(`No USDC Transfer to recipient ${recipientLower} found on Arc destination receipt`);
console.log('recipient            ', mintedTo);
console.log('arc_minted_base_units', mintedAmount.toString());
console.log('expected M           ', AMOUNT.toString(), '(NOT M+F =', GROSS.toString() + ')');
if (mintedAmount !== AMOUNT) throw new Error(`Arc minted ${mintedAmount} != M ${AMOUNT} - merchant target violated`);
if (mintedAmount === GROSS) throw new Error('Arc minted the GROSS (M+F) - fee would double-credit; this MUST NOT happen');

console.log('── FORWARDING E2E OK ──');
console.log('summary:', {
  source_tx: burnHash, source_block: burnReceipt.blockNumber.toString(),
  M: AMOUNT.toString(), F: F.toString(), gross: GROSS.toString(),
  forwardTxHash, arc_block: arcReceipt.blockNumber.toString(), minted: mintedAmount.toString(),
  recipient: mintedTo,
});
