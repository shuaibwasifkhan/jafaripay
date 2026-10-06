/**
 * JAFARIPAY — PHASE 16 CROSS-CHAIN TESTNET E2E: Base Sepolia → Arc Testnet.
 *
 * The master plan's CRITICAL TESTNET RULE: PHASE 16 is only COMPLETE after a
 * REAL journey
 *   Base Sepolia ──(CCTP DepositForBurn)──▶ Circle attestation ──▶ Arc Testnet
 *   ──(USDC mint to the merchant's pinned Arc Testnet wallet)
 * verified against an actual source tx and an actual destination tx. No mocks.
 *
 * This file gives a human two things and NOTHING is faked:
 *
 *   --readonly   (DEFAULT, key-free, safe to run in CI right now)
 *                Strictly read-only infrastructure gate. Confirms every money-
 *                identity fact this route depends on is LIVE right now:
 *                  • Base Sepolia & Arc Testnet answer eth_chainId == registry.
 *                  • Source native USDC + CCTP TokenMessenger + MessageTransmitter
 *                    all have bytecode and USDC decimals == 6 on both chains.
 *                  • Circle Iris SANDBOX is reachable and the registry-derived
 *                    attestation URL is well-formed (a 404/"not observed" is a
 *                    VALID live answer — the endpoint is up).
 *                NO private keys. NO transactions. NO funds moved. Exit !=0 only
 *                on a hard money-identity MISMATCH.
 *
 *   --full       THE REAL E2E. Broadcasts a live depositForBurn on Base Sepolia,
 *                polls Circle for the attestation, then executes receiveMessage
 *                on Arc Testnet so USDC is minted to the merchant wallet, and
 *                verifies the destination tx. It reads EVERY secret from the
 *                environment and NEVER logs or hardcodes a key/seed phrase.
 *                It FAILS CLOSED with exact instructions if any required env is
 *                absent or if the funded wallets lack balance — it will not
 *                pretend to have run.
 *
 * Required env for --full (all human-supplied; see README / docs):
 *   BASE_SEPOLIA_RPC_URL       (defaults to the registry endpoint)
 *   ARC_TESTNET_RPC_URL        (defaults to the registry endpoint)
 *   E2E_SOURCE_PK              0x-prefixed private key of a Base Sepolia wallet
 *                              holding BOTH test USDC (Circle faucet) and ETH.
 *   E2E_MINT_RECIPIENT         0x… 20-byte address the CCTP mints to on Arc
 *                              Testnet (the merchant's pinned Arc Testnet wallet;
 *                              NON-CUSTODIAL: must be a merchant-controlled addr).
 *   E2E_RELAYER_PK             0x-prefixed private key that pays Arc Testnet gas
 *                              to execute receiveMessage. It is NEVER the mint
 *                              recipient and can NEVER alter mintRecipient.
 *   E2E_AMOUNT_BASE_UNITS      integer USDC base-units (6 decimals) to burn,
 *                              e.g. 1000000 == 1.00 USDC. Keep it tiny.
 * Optional:
 *   E2E_POLL_TIMEOUT_S         max seconds to wait for Circle attestation (def 900).
 *
 * Secrets policy: this script never prints a private key or seed phrase. It only
 * prints public addresses, tx hashes, chain ids, block numbers and amounts.
 *
 * NOTE ON DUPLICATED PROTOCOL CONSTANTS: this harness deliberately does NOT
 * import server/db/cctp.ts or server/blockchain/cctp-attestation.ts. The
 * project typechecks only `src` + `scripts` under an ES2020 lib with no
 * bun-types; those server modules transitively pull in db/schema.ts (bun:sqlite)
 * and ES2022-only APIs, which are outside this script's compile graph. So the
 * small set of CCTP facts below is mirrored VERBATIM from the registry — the
 * values are asserted equal to server/db/cctp.ts by cctp-registry.test.ts, so
 * they can never silently drift. Business logic MUST still read the registry;
 * only this standalone operator harness mirrors the constants.
 */

const TIMEOUT_MS = 20_000;

// Route class: DEFAULT is the PHASE 16 testnet pilot (Base Sepolia → Arc
// Testnet). Pass --mainnet to target the PHASE 18 production pilot
// (Base → Arc Mainnet). Both share the identical CCTP shape (Standard maxFee=0,
// destination domain 26, Base CCTP domain 6) and differ only in the
// registry-pinned chain ids / contract pair / Iris endpoint.
const TESTNET = !process.argv.includes('--mainnet');

// Source chain (Base): CCTP domain 6 on BOTH classes (verified server/db/cctp.ts).
const SRC_SLUG = TESTNET ? 'base_sepolia' : 'base_mainnet';
const SRC_CHAIN_ID = TESTNET ? 84532 : 8453;
const SRC_RPC = (TESTNET ? process.env.BASE_SEPOLIA_RPC_URL : process.env.BASE_RPC_URL)
  || (TESTNET ? 'https://sepolia.base.org' : 'https://mainnet.base.org'); // arc-studio-allow-onchain-literal — registry default
const SRC_NATIVE_USDC = TESTNET
  ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e' // arc-studio-allow-onchain-literal — Base Sepolia native USDC
  : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // arc-studio-allow-onchain-literal — Base mainnet native USDC
const SRC_DOMAIN = 6;

// Destination: Arc (domain 26); native USDC is the same address on both classes.
const DEST_SLUG = TESTNET ? 'arc_testnet' : 'arc_mainnet';
const DEST_CHAIN_ID = TESTNET ? 5042002 : 5042;
const DEST_RPC = (TESTNET ? process.env.ARC_TESTNET_RPC_URL : process.env.ARC_RPC_URL)
  || (TESTNET ? 'https://rpc.testnet.arc.io' : 'https://rpc.mainnet.arc.io'); // arc-studio-allow-onchain-literal — registry default
const DEST_NATIVE_USDC = '0x3600000000000000000000000000000000000000'; // arc-studio-allow-onchain-literal — Arc native USDC

// CCTP v2 contract pair (== server/db/cctp.ts CCTP_CONTRACTS_{TESTNET,MAINNET}).
const ARC_CCTP_DOMAIN = 26;
// arc-studio-allow-onchain-literal — CCTP v2 TokenMessenger (testnet | mainnet)
const TOKEN_MESSENGER = TESTNET ? '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' : '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
// arc-studio-allow-onchain-literal — CCTP v2 MessageTransmitter (testnet | mainnet)
const MESSAGE_TRANSMITTER = TESTNET ? '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' : '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';

// Circle Iris endpoints (== server/blockchain/cctp-attestation.ts).
const IRIS_PRODUCTION_BASE = 'https://iris-api.circle.com'; // arc-studio-allow-onchain-literal — Circle production Iris
const IRIS_SANDBOX_BASE = 'https://iris-api-sandbox.circle.com'; // arc-studio-allow-onchain-literal — Circle sandbox Iris (testnet)
function irisBaseUrl(isTestnet: boolean): string { return isTestnet ? IRIS_SANDBOX_BASE : IRIS_PRODUCTION_BASE; }
function attestationLookupUrl(opts: { isTestnet: boolean; sourceDomain: number; sourceTxHash: string }): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(opts.sourceTxHash)) {
    throw new Error(`attestationLookupUrl: source tx hash must be a full 0x-prefixed 32-byte hash: ${opts.sourceTxHash}`);
  }
  return `${irisBaseUrl(opts.isTestnet)}/v2/messages/${opts.sourceDomain}?transactionHash=${opts.sourceTxHash}`;
}

// Left-pad a 20-byte address to the 32-byte bytes32 form CCTP v2 expects
// (== server/db/cctp.ts addressToBytes32).
function addressToBytes32(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`addressToBytes32: not a 20-byte hex address: ${address}`);
  return '0x' + hex.padStart(64, '0');
}

// Standard (maxFee=0, 1:1) source-leg route plan (== cctpSourceRoutePlan).
function sourceRoutePlan(opts: { mintRecipientAddress: string; burnTokenAddress: string }): {
  token_messenger: string; destination_domain: number; mint_recipient_bytes32: string; destination_caller_bytes32: `0x${string}`; burn_token: string; max_fee: string; min_finality_threshold: number;
} {
  return {
    token_messenger: TOKEN_MESSENGER,
    destination_domain: ARC_CCTP_DOMAIN,
    mint_recipient_bytes32: addressToBytes32(opts.mintRecipientAddress),
    // bytes32(0): anyone (our relayer / Circle Forwarding) may execute receiveMessage.
    destination_caller_bytes32: ('0x' + '0'.repeat(64)) as `0x${string}`,
    burn_token: opts.burnTokenAddress,
    max_fee: '0',
    min_finality_threshold: 0,
  };
}

const DECIMALS_SELECTOR = '0x313ce567';

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

async function hasCode(url: string, addr: string): Promise<boolean> {
  try {
    const code = (await rpc(url, 'eth_getCode', [addr, 'latest'])) as string;
    return !!code && code !== '0x';
  } catch {
    return false;
  }
}

async function decimalsOf(url: string, addr: string): Promise<number | null> {
  try {
    const d = (await rpc(url, 'eth_call', [{ to: addr, data: DECIMALS_SELECTOR }, 'latest'])) as string;
    return parseInt(d, 16);
  } catch {
    return null;
  }
}

async function chainIdOf(url: string): Promise<number | null> {
  try {
    const cid = (await rpc(url, 'eth_chainId')) as string;
    return parseInt(cid, 16);
  } catch {
    return null;
  }
}

interface Check { name: string; ok: boolean; detail: string; hard: boolean }

/**
 * Read-only infra gate. `hard` checks are money-identity invariants — a false
 * hard check is a genuine blocker (exit != 0). A network-egress UNREACHABLE is
 * surfaced loudly but is NOT a security defect.
 */
async function readonlyProbe(): Promise<number> {
  console.log(`PHASE ${TESTNET ? '16' : '18'} — READ-ONLY ${TESTNET ? 'testnet' : 'PRODUCTION'} infrastructure gate (NO keys, NO writes).\n`);
  console.log(`Route: ${SRC_SLUG} (chain ${SRC_CHAIN_ID}, domain ${SRC_DOMAIN}) ──CCTP──▶ ${DEST_SLUG} (chain ${DEST_CHAIN_ID}, domain ${ARC_CCTP_DOMAIN})`);
  console.log(`CCTP pair (${TESTNET ? 'testnet' : 'mainnet'}): TokenMessenger=${TOKEN_MESSENGER} MessageTransmitter=${MESSAGE_TRANSMITTER}\n`);

  const checks: Check[] = [];

  // --- Source chain identity ---
  const srcChain = await chainIdOf(SRC_RPC);
  checks.push({
    name: `${SRC_SLUG} eth_chainId`,
    ok: srcChain === SRC_CHAIN_ID,
    detail: srcChain == null ? 'UNREACHABLE' : `${srcChain} (expected ${SRC_CHAIN_ID})`,
    hard: true,
  });
  const srcUsdcCode = await hasCode(SRC_RPC, SRC_NATIVE_USDC);
  checks.push({ name: `${SRC_SLUG} native USDC bytecode`, ok: srcUsdcCode, detail: SRC_NATIVE_USDC, hard: true });
  const srcDecimals = await decimalsOf(SRC_RPC, SRC_NATIVE_USDC);
  checks.push({ name: `${SRC_SLUG} USDC decimals`, ok: srcDecimals === 6, detail: `${srcDecimals ?? '-'}`, hard: true });
  const srcTmCode = await hasCode(SRC_RPC, TOKEN_MESSENGER);
  checks.push({ name: `${SRC_SLUG} TokenMessenger bytecode`, ok: srcTmCode, detail: TOKEN_MESSENGER, hard: true });
  const srcMtCode = await hasCode(SRC_RPC, MESSAGE_TRANSMITTER);
  checks.push({ name: `${SRC_SLUG} MessageTransmitter bytecode`, ok: srcMtCode, detail: MESSAGE_TRANSMITTER, hard: true });

  // --- Destination chain identity ---
  const destChain = await chainIdOf(DEST_RPC);
  checks.push({
    name: `${DEST_SLUG} eth_chainId`,
    ok: destChain === DEST_CHAIN_ID,
    detail: destChain == null ? 'UNREACHABLE' : `${destChain} (expected ${DEST_CHAIN_ID})`,
    hard: true,
  });
  const destUsdcCode = await hasCode(DEST_RPC, DEST_NATIVE_USDC);
  checks.push({ name: `${DEST_SLUG} native USDC bytecode`, ok: destUsdcCode, detail: DEST_NATIVE_USDC, hard: true });
  const destDecimals = await decimalsOf(DEST_RPC, DEST_NATIVE_USDC);
  checks.push({ name: `${DEST_SLUG} USDC decimals`, ok: destDecimals === 6, detail: `${destDecimals ?? '-'}`, hard: true });
  const destMtCode = await hasCode(DEST_RPC, MESSAGE_TRANSMITTER);
  checks.push({ name: `${DEST_SLUG} MessageTransmitter bytecode`, ok: destMtCode, detail: MESSAGE_TRANSMITTER, hard: true });

  // --- Circle Iris reachability (permissionless, no key) ---
  // A syntactically-valid 32-byte hash that is not a real burn. Any well-formed
  // HTTP answer (404 "not observed", 200 {messages:[]}, or even a pending) means
  // the endpoint is LIVE and our registry-derived URL is correctly shaped.
  const probeHash = '0x' + '11'.repeat(32);
  const irisUrl = attestationLookupUrl({ isTestnet: TESTNET, sourceDomain: SRC_DOMAIN, sourceTxHash: probeHash });
  let irisOk = false;
  let irisDetail = '';
  try {
    const res = await fetch(irisUrl, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
    irisOk = true; // reached the service (any status is a live answer)
    let body = '';
    try { body = JSON.stringify(await res.json()).slice(0, 160); } catch { body = '(non-json body)'; }
    irisDetail = `HTTP ${res.status} @ ${irisBaseUrl(TESTNET)} — ${body}`;
  } catch (e) {
    irisOk = false;
    irisDetail = `UNREACHABLE (${(e as Error).message})`;
  }
  checks.push({ name: `Circle Iris (${TESTNET ? 'SANDBOX' : 'PRODUCTION'}) reachable + URL well-formed`, ok: irisOk, detail: irisDetail, hard: false });

  for (const c of checks) {
    const mark = c.ok ? 'PASS' : c.hard ? 'FAIL' : 'WARN';
    console.log(`  [${mark}] ${c.name}: ${c.detail}`);
  }

  const hardFails = checks.filter((c) => c.hard && !c.ok);
  const unreachable = checks.filter((c) => !c.ok && /UNREACHABLE/.test(c.detail));
  console.log(`\nSUMMARY: ${checks.filter((c) => c.ok).length}/${checks.length} checks ok  hard-fails=${hardFails.length}  unreachable=${unreachable.length}`);
  if (unreachable.length) {
    console.log('NOTE: some endpoints did not answer (transient public-RPC / egress outage). This is surfaced, not treated as a protocol defect.');
  }
  if (hardFails.length) {
    console.error('\nHARD money-identity mismatch on the testnet route — resolve before running --full.');
    return 1;
  }
  console.log('\nInfra gate OK. To perform the REAL E2E you must supply funded wallets + keys via env and run with --full.');
  return 0;
}

/**
 * THE REAL E2E. Fails closed unless every required env var is present; never
 * logs a secret. Delegates the actual signing/broadcast to viem against the
 * registry-pinned contracts, so what runs here is exactly the route the product
 * uses: mintRecipient is the merchant's pinned Arc wallet, maxFee=0 (Standard).
 */
async function fullE2E(): Promise<number> {
  const sourcePk = process.env.E2E_SOURCE_PK;
  const mintRecipient = process.env.E2E_MINT_RECIPIENT;
  const relayerPk = process.env.E2E_RELAYER_PK;
  const amountRaw = process.env.E2E_AMOUNT_BASE_UNITS;
  const pollTimeoutS = parseInt(process.env.E2E_POLL_TIMEOUT_S || '900', 10);

  const missing: string[] = [];
  if (!sourcePk) missing.push('E2E_SOURCE_PK');
  if (!mintRecipient) missing.push('E2E_MINT_RECIPIENT');
  if (!relayerPk) missing.push('E2E_RELAYER_PK');
  if (!amountRaw) missing.push('E2E_AMOUNT_BASE_UNITS');
  if (missing.length) {
    console.error('PHASE 16 --full requires funded testnet wallets + keys (human action).\nMissing env var(s): ' + missing.join(', '));
    console.error('Never commit these; supply them only in the local environment. See header docs in this file.');
    return 2;
  }

  let amountBaseUnits: bigint;
  try {
    amountBaseUnits = BigInt(amountRaw as string);
  } catch {
    console.error('E2E_AMOUNT_BASE_UNITS must be an integer (USDC base units, 6 decimals).');
    return 2;
  }
  if (amountBaseUnits <= 0n) { console.error('E2E_AMOUNT_BASE_UNITS must be > 0.'); return 2; }

  // Route plan identical to production checkout PHASE 4 (Standard, maxFee=0):
  // pins TokenMessenger, destination domain, mintRecipient bytes32, maxFee=0.
  let plan: ReturnType<typeof sourceRoutePlan>;
  try {
    plan = sourceRoutePlan({
      mintRecipientAddress: mintRecipient as string,
      burnTokenAddress: SRC_NATIVE_USDC,
    });
  } catch (e) {
    console.error('Refusing to build route plan: ' + (e as Error).message);
    return 1;
  }

  console.log(`PHASE ${TESTNET ? '16' : '18'} — FULL ${TESTNET ? 'testnet' : 'PRODUCTION'} E2E (real ${TESTNET ? 'testnet' : 'MAINNET'} funds moved).`);
  console.log(`  burn ${amountBaseUnits.toString()} base units on ${SRC_SLUG} → mint to ${plan.mint_recipient_bytes32} on ${DEST_SLUG}`);
  console.log(`  maxFee=${plan.max_fee} minFinalityThreshold=${plan.min_finality_threshold} destinationDomain=${plan.destination_domain}`);

  // ─── Real broadcaster ────────────────────────────────────────────────────
  // This DOES move value; it only runs with operator-supplied funded keys and
  // it NEVER self-reports success — success is proven by the two real tx hashes
  // it prints plus the on-chain USDC balance delta it reads back.
  const {
    createPublicClient, createWalletClient, http, parseAbi,
  } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const chains = await import('viem/chains');
  // Base source chain object: Base Sepolia (testnet pilot) or Base mainnet.
  const srcChainDef = TESTNET ? chains.baseSepolia : chains.base;

  // Derive public accounts from the private keys (keys themselves are never
  // printed). Sanity: source and relayer are distinct accounts.
  const srcAccount = privateKeyToAccount(sourcePk as `0x${string}`);
  const relayerAccount = privateKeyToAccount(relayerPk as `0x${string}`);
  if (srcAccount.address.toLowerCase() === relayerAccount.address.toLowerCase()) {
    console.error('E2E_SOURCE_PK and E2E_RELAYER_PK must be different wallets.');
    return 2;
  }
  console.log(`  source wallet (pays ${SRC_SLUG} USDC+gas): ${srcAccount.address}`);
  console.log(`  relayer wallet (pays ${DEST_SLUG} gas only, NOT the recipient): ${relayerAccount.address}`);

  const erc20Abi = parseAbi(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
  const tmAbi = parseAbi(['function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)']);
  const mtAbi = parseAbi(['function receiveMessage(bytes message,bytes attestation)']);

  // Arc destination chain definition (testnet 5042002 / mainnet 5042; native USDC 0x3600…).
  const arcChainDef = {
    id: DEST_CHAIN_ID,
    name: DEST_SLUG,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [DEST_RPC] }, public: { http: [DEST_RPC] } },
  } as const;

  const srcPublic = createPublicClient({ chain: srcChainDef, transport: http(SRC_RPC) });
  const destPublic = createPublicClient({ chain: arcChainDef, transport: http(DEST_RPC) });
  const srcWallet = createWalletClient({ account: srcAccount, chain: srcChainDef, transport: http(SRC_RPC) });
  const destWallet = createWalletClient({ account: relayerAccount, chain: arcChainDef, transport: http(DEST_RPC) });

  const bal = await srcPublic.readContract({ address: SRC_NATIVE_USDC as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [srcAccount.address] });
  if (bal < amountBaseUnits) {
    console.error(`Source wallet has ${bal.toString()} base-unit USDC on ${SRC_SLUG}, needs ${amountBaseUnits.toString()}. Fund it${TESTNET ? ' from the Circle testnet faucet' : ' with real USDC'}.`);
    return 2;
  }

  console.log('  [1/5] approve TokenMessenger…');
  const approveHash = await srcWallet.writeContract({ account: srcAccount, address: SRC_NATIVE_USDC as `0x${string}`, abi: erc20Abi, functionName: 'approve', args: [TOKEN_MESSENGER as `0x${string}`, amountBaseUnits] });
  await srcPublic.waitForTransactionReceipt({ hash: approveHash });

  console.log('  [2/5] depositForBurn on Base Sepolia (CCTP V2, 7-arg)…');
  const burnHash = await srcWallet.writeContract({ account: srcAccount, address: TOKEN_MESSENGER as `0x${string}`, abi: tmAbi, functionName: 'depositForBurn', args: [amountBaseUnits, plan.destination_domain, plan.mint_recipient_bytes32 as `0x${string}`, SRC_NATIVE_USDC as `0x${string}`, plan.destination_caller_bytes32, 0n, plan.min_finality_threshold] });
  const burnReceipt = await srcPublic.waitForTransactionReceipt({ hash: burnHash });
  console.log(`  SOURCE TX (Base Sepolia): ${burnHash} status=${burnReceipt.status}`);

  console.log('  [3/5] poll Circle SANDBOX for attestation…');
  const lookup = attestationLookupUrl({ isTestnet: TESTNET, sourceDomain: SRC_DOMAIN, sourceTxHash: burnHash });
  const deadline = Date.now() + pollTimeoutS * 1000;
  let message: string | null = null;
  let attestation: string | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(lookup, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = (await res.json()) as { messages?: Array<{ status: string; message?: string; attestation?: string }> };
      const m = body.messages?.find((x) => x.status === 'complete' && x.message && x.attestation);
      if (m?.message && m.attestation) { message = m.message; attestation = m.attestation; break; }
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (!message || !attestation) { console.error('Attestation not received within window — re-run once Circle completes.'); return 1; }
  console.log('  attestation received.');

  console.log('  [4/5] receiveMessage on Arc Testnet (relayer pays gas only)…');
  const recipientBalBefore = await destPublic.readContract({ address: DEST_NATIVE_USDC as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [mintRecipient as `0x${string}`] });
  const recvHash = await destWallet.writeContract({ account: relayerAccount, address: MESSAGE_TRANSMITTER as `0x${string}`, abi: mtAbi, functionName: 'receiveMessage', args: [message as `0x${string}`, attestation as `0x${string}`] });
  const recvReceipt = await destPublic.waitForTransactionReceipt({ hash: recvHash });

  console.log('  [5/5] verify USDC minted to merchant Arc Testnet wallet…');
  const recipientBalAfter = await destPublic.readContract({ address: DEST_NATIVE_USDC as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [mintRecipient as `0x${string}`] });
  const minted = recipientBalAfter - recipientBalBefore;

  console.log('\n  ===== PHASE 16 E2E EVIDENCE =====');
  console.log(`  source tx         : ${burnHash} (status ${burnReceipt.status})`);
  console.log(`  destination tx    : ${recvHash} (status ${recvReceipt.status})`);
  console.log(`  mint recipient    : ${mintRecipient}`);
  console.log(`  USDC before/after : ${recipientBalBefore.toString()} / ${recipientBalAfter.toString()} (minted ${minted.toString()} base units)`);

  if (burnReceipt.status !== 'success' || recvReceipt.status !== 'success' || minted !== amountBaseUnits) {
    console.error('\nE2E DID NOT COMPLETE CLEANLY — inspect the evidence above before trusting this route.');
    return 1;
  }
  console.log('\nE2E VERIFIED: source burn + Circle attestation + Arc mint to the merchant wallet, 1:1.');
  return 0;
}

/**
 * RESUME: continue from an existing source burn tx hash (steps [3/5]→[5/5]).
 * Usage: bun run scripts/cctp-e2e-base-sepolia.ts --resume <0x…txHash>
 * Requires: E2E_RELAYER_PK, E2E_MINT_RECIPIENT.
 * Does NOT create another depositForBurn.
 */
async function resumeE2E(burnHash: string): Promise<number> {
  const mintRecipient = process.env.E2E_MINT_RECIPIENT;
  const relayerPk = process.env.E2E_RELAYER_PK;
  const pollTimeoutS = parseInt(process.env.E2E_POLL_TIMEOUT_S || '900', 10);

  const missing: string[] = [];
  if (!mintRecipient) missing.push('E2E_MINT_RECIPIENT');
  if (!relayerPk) missing.push('E2E_RELAYER_PK');
  if (missing.length) {
    console.error('PHASE 16 --resume requires: ' + missing.join(', '));
    return 2;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(burnHash)) {
    console.error(`--resume: invalid tx hash (must be 0x + 64 hex chars): ${burnHash}`);
    return 2;
  }

  console.log(`PHASE 16 — RESUME from existing burn tx: ${burnHash}`);
  console.log(`  NO new depositForBurn will be created.`);

  const { createPublicClient, createWalletClient, http, parseAbi } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const chains = await import('viem/chains');
  const srcChainDef = TESTNET ? chains.baseSepolia : chains.base;
  const arcChainDef = {
    id: DEST_CHAIN_ID, name: DEST_SLUG,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [DEST_RPC] }, public: { http: [DEST_RPC] } },
  } as const;

  const srcPublic = createPublicClient({ chain: srcChainDef, transport: http(SRC_RPC) });
  const destPublic = createPublicClient({ chain: arcChainDef, transport: http(DEST_RPC) });
  const relayerAccount = privateKeyToAccount(relayerPk as `0x${string}`);
  const destWallet = createWalletClient({ account: relayerAccount, chain: arcChainDef, transport: http(DEST_RPC) });

  // Verify the source tx exists and succeeded.
  console.log('  [verify] checking source tx status on Base Sepolia…');
  let srcReceipt: { status: string } | null = null;
  try {
    srcReceipt = await srcPublic.getTransactionReceipt({ hash: burnHash as `0x${string}` });
  } catch { /* not found */ }
  if (!srcReceipt) { console.error('  Source tx not found on Base Sepolia.'); return 1; }
  if (srcReceipt.status !== 'success') { console.error('  Source tx status is NOT success: ' + srcReceipt.status); return 1; }
  console.log(`  Source tx confirmed: status=${srcReceipt.status}`);

  // [3/5] Poll Circle for attestation (already available in most cases after resume).
  console.log('  [3/5] poll Circle SANDBOX for attestation…');
  const lookup = attestationLookupUrl({ isTestnet: TESTNET, sourceDomain: SRC_DOMAIN, sourceTxHash: burnHash });
  const deadline = Date.now() + pollTimeoutS * 1000;
  let message: string | null = null;
  let attestation: string | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(lookup, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = (await res.json()) as { messages?: Array<{ status: string; message?: string; attestation?: string }> };
      const m = body.messages?.find((x) => x.status === 'complete' && x.message && x.attestation);
      if (m?.message && m.attestation) { message = m.message; attestation = m.attestation; break; }
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  if (!message || !attestation) {
    console.error('Attestation not received within window.'); return 1;
  }
  console.log('  Attestation received. Validating message contents…');

  // Validate the attested message: decode CCTP V2 header fields.
  const msgBytes = message as `0x${string}`;
  // CCTP V2 message layout (bytes):
  //   [0..4)   uint32 version
  //   [4..8)   uint32 sourceDomain
  //   [8..12)  uint32 destinationDomain
  //   [12..44) bytes32 nonce
  //   [44..76) bytes32 sender
  //   [76..108) bytes32 recipient (MessageTransmitter)
  //   [108..140) bytes32 destinationCaller
  //   [140..144) uint32 minFinalityThreshold
  //   [144..148) uint32 finalityThresholdExecuted
  //   [148..)    bytes messageBody (BurnMessageV2)
  const hex = msgBytes.replace(/^0x/, '');
  function sliceField(hexStr: string, byteOffset: number, byteLen: number): string {
    return hexStr.slice(byteOffset * 2, (byteOffset + byteLen) * 2);
  }
  const destDomainHex = sliceField(hex, 8, 4);
  const destDomain = parseInt(destDomainHex, 16);
  // BurnMessageV2 body starts at byte 148:
  //   [148..152) uint32 version (body)
  //   [152..184) bytes32 burnToken
  //   [184..216) bytes32 mintRecipient
  //   [216..248) uint256 amount
  //   [248..280) bytes32 messageSender
  //   [280..312) uint256 maxFee
  //   [312..344) uint256 feeExecuted
  //   [344..376) uint256 expirationBlock
  const mintRecipHex = sliceField(hex, 184, 32);
  const expectedMintRecip = mintRecipient!.toLowerCase().replace(/^0x/, '').padStart(64, '0');

  console.log(`    destinationDomain: ${destDomain} (expected ${ARC_CCTP_DOMAIN})`);
  console.log(`    mintRecipient (from msg): 0x${mintRecipHex.slice(24)}`);
  console.log(`    mintRecipient (expected): 0x${expectedMintRecip.slice(24)}`);

  if (destDomain !== ARC_CCTP_DOMAIN) {
    console.error(`  VALIDATION FAILED: destination domain ${destDomain} != ${ARC_CCTP_DOMAIN}`);
    return 1;
  }
  if (mintRecipHex.toLowerCase() !== expectedMintRecip) {
    console.error('  VALIDATION FAILED: mint recipient in attestation does not match E2E_MINT_RECIPIENT');
    return 1;
  }
  console.log('  Message validation PASSED.');

  // [4/5] receiveMessage on Arc Testnet.
  console.log('  [4/5] receiveMessage on Arc Testnet (relayer pays gas only)…');
  const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);
  const mtAbi = parseAbi(['function receiveMessage(bytes message,bytes attestation)']);
  const recipientBalBefore = await destPublic.readContract({ address: DEST_NATIVE_USDC as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [mintRecipient as `0x${string}`] });
  const recvHash = await destWallet.writeContract({ account: relayerAccount, address: MESSAGE_TRANSMITTER as `0x${string}`, abi: mtAbi, functionName: 'receiveMessage', args: [msgBytes, attestation as `0x${string}`] });
  const recvReceipt = await destPublic.waitForTransactionReceipt({ hash: recvHash });

  // [5/5] Verify USDC minted.
  console.log('  [5/5] verify USDC minted to merchant Arc Testnet wallet…');
  const recipientBalAfter = await destPublic.readContract({ address: DEST_NATIVE_USDC as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [mintRecipient as `0x${string}`] });
  const minted = recipientBalAfter - recipientBalBefore;

  console.log('\n  ===== PHASE 16 E2E EVIDENCE (RESUMED) =====');
  console.log(`  source tx         : ${burnHash} (status ${srcReceipt.status})`);
  console.log(`  destination tx    : ${recvHash} (status ${recvReceipt.status})`);
  console.log(`  mint recipient    : ${mintRecipient}`);
  console.log(`  USDC before/after : ${recipientBalBefore.toString()} / ${recipientBalAfter.toString()} (minted ${minted.toString()} base units)`);

  if (recvReceipt.status !== 'success' || minted <= 0n) {
    console.error('\nE2E DID NOT COMPLETE CLEANLY — inspect the evidence above.');
    return 1;
  }
  console.log('\nE2E VERIFIED (resumed): Circle attestation + Arc mint to the merchant wallet.');
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv;
  const resumeIdx = argv.indexOf('--resume');
  if (resumeIdx !== -1) {
    const txHash = argv[resumeIdx + 1];
    if (!txHash || txHash.startsWith('--')) {
      console.error('Usage: --resume <0x…transactionHash>');
      process.exit(2);
    }
    process.exit(await resumeE2E(txHash));
  }
  const mode = argv.includes('--full') ? 'full' : 'readonly';
  if (mode === 'full') process.exit(await fullE2E());
  process.exit(await readonlyProbe());
}

main().catch((e) => {
  console.error('PHASE 16 E2E harness crashed:', e);
  process.exit(1);
});
