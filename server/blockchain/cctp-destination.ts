/**
 * JafariPay — CCTP ARC DESTINATION SETTLEMENT (MASTER PHASE 8)
 *
 * Turns a VERIFIED, Circle-ATTESTED source burn (PHASE 5 + PHASE 7) into a real
 * JafariPay payment — but ONLY once a genuine USDC mint has landed on Arc in the
 * merchant's ONE pinned Arc wallet. This is the single phase in the whole CCTP
 * pipeline that may credit money, so it re-applies every same-chain safety rule
 * AND adds the cross-chain ones.
 *
 * ── What PHASE 8 does and does NOT do ─────────────────────────────────────
 *   DOES: (a) build the permissionless destination claim calldata (Circle
 *     receiveMessage), (b) verify a real destination tx on Arc via the registry
 *     Arc provider, (c) atomically credit exactly like the same-chain verifier
 *     (blockchain_transactions + payments + intent 'succeeded' + receipt +
 *     webhook) and (d) advance the cross_chain_transfers state machine.
 *   DOES NOT: trust an attestation alone. An attestation (PHASE 7) is only the
 *     PROOF that Circle will honour a mint; nothing is credited until the mint
 *     TRANSFER is observed ON ARC into the pinned wallet for the EXACT amount.
 *
 * ── Non-custodial guarantees (product rule) ──────────────────────────────
 *   • The mint recipient is NOT a calldata argument — it is baked into the
 *     message we attested in PHASE 7 and verified there against the merchant's
 *     pinned Arc wallet. receiveMessage(message, attestation) carries no
 *     recipient field, so NO relayer can redirect the mint. We re-verify the
 *     destination Transfer lands on that SAME wallet before crediting.
 *   • destinationCaller in our message is bytes32(0): execution is
 *     permissionless (our relayer or Circle Forwarding), and the executor pays
 *     only gas — it can NEVER change recipient, amount, or become the recipient.
 *   • JafariPay is never the recipient of customer funds; the mint goes straight
 *     to the merchant's Arc wallet and is credited only from a Transfer we read
 *     independently on Arc.
 *
 * ── Money-safety invariants (same rules as verifyPayment, plus cross-chain) ─
 *   1. Only an attested transfer may settle (attestation_status 'complete').
 *   2. The destination tx is read through the Arc provider, which proves
 *      eth_chainId before any receipt (no chain confusion) and the Arc USDC
 *      contract + finality_mode come from network_configs (registry, not caller).
 *   3. The tx must be a SUCCESSFUL call to the registry-pinned Arc
 *      MessageTransmitterV2 (so an unrelated ERC-20 transfer cannot settle).
 *   4. It must carry a Transfer of the EXACT amount to the merchant's pinned
 *      Arc wallet on the Arc USDC contract; recipient AND amount are re-checked
 *      against the intent as well as the transfer.
 *   5. Storage-layer replay: UNIQUE(destination_tx_hash, destination_network) on
 *      cross_chain_transfers + the blockchain_transactions tx-hash replay check
 *      + one transfer per intent mean a mint can settle exactly one journey.
 *   6. Credit is idempotent and atomic: a re-settle of a settled transfer is a
 *      no-op; the intent is never moved off 'succeeded'; a failure NEVER credits.
 */

import { encodeAbiParameters, toFunctionSelector, type Hex } from 'viem';
import { getDb } from '../db/schema.js';
import { generateId } from '../lib/ids.js';
import { ArcProvider, getNetworkConfig, USDCAdapter, type TransactionReceipt } from './arc-provider.js';
import { messageTransmitterFor } from './cctp-source.js';
import { formatBaseUnitsToDecimal } from '../lib/money.js';
import { issueReceiptForPayment } from '../receipts/service.js';
import { enqueueWebhookDeliveries } from '../webhooks/delivery.js';
import { ARC_CCTP_DOMAIN, CCTP_REGISTRY, isCctpDestination } from '../db/cctp.js';

// ── Destination claim calldata (Circle MessageTransmitterV2.receiveMessage) ──
// The relayer/forwarder executes this EXACT calldata we build from the attested
// message. There is no recipient argument anywhere: the mint recipient is inside
// `message`, which PHASE 7 already pinned to the merchant's Arc wallet. An
// operator therefore cannot redirect funds by altering the transaction.
export const RECEIVE_MESSAGE_SELECTOR = toFunctionSelector('receiveMessage(bytes message, bytes attestation)');

export function buildReceiveMessageCalldata(message: Hex, attestation: Hex): Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(message) || message.length % 2 !== 0) {
    throw new Error('buildReceiveMessageCalldata: message must be hex bytes');
  }
  if (!/^0x[0-9a-fA-F]*$/.test(attestation) || attestation.length % 2 !== 0) {
    throw new Error('buildReceiveMessageCalldata: attestation must be hex bytes');
  }
  return (RECEIVE_MESSAGE_SELECTOR + encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes' }],
    [message, attestation],
  ).slice(2)) as Hex;
}

/**
 * The full, permissionless destination claim the executor (our relayer or Circle
 * Forwarding) must submit ON Arc. `to` is the registry-pinned MessageTransmitterV2
 * for the route's environment class; nothing here names a recipient or an amount.
 */
export function destinationClaim(input: {
  destinationNetwork: string;
  message: Hex;
  attestation: Hex;
}): { to: string; data: Hex; chainId: number } {
  const cfg = CCTP_REGISTRY[input.destinationNetwork];
  if (!cfg || cfg.supportedAsDestination !== true) {
    throw new Error(`destinationClaim: "${input.destinationNetwork}" is not a CCTP destination`);
  }
  return {
    to: messageTransmitterFor(cfg.isTestnet),
    data: buildReceiveMessageCalldata(input.message, input.attestation),
    chainId: getNetworkConfig(input.destinationNetwork).chainId,
  };
}

// ── Provider seam (Arc receipt reader). ArcProvider satisfies this. ─────────
export interface DestinationProvider {
  getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null>;
}

export type DestinationFailureCode =
  | 'transfer_not_found'
  | 'not_attested'
  | 'not_cross_chain'
  | 'destination_not_registered'
  | 'invalid_tx_hash'
  | 'message_missing'
  | 'provider_error'
  | 'receipt_missing'
  | 'receipt_reverted'
  | 'not_message_transmitter_call'
  | 'mint_transfer_missing'
  | 'wrong_usdc_contract'
  | 'wrong_mint_recipient'
  | 'amount_mismatch'
  | 'intent_not_found'
  | 'intent_not_payable'
  | 'destination_replay_detected';

export interface DestinationFailure {
  ok: false;
  code: DestinationFailureCode;
  reason: string;
  retryable: boolean;
}

export interface DestinationSuccess {
  ok: true;
  outcome: 'settled' | 'already_settled';
  transferId: string;
  paymentIntentId: string;
  paymentId?: string;
  destinationTxHash: string;
  destinationNetwork: string;
  recipient: string;
  amountBaseUnits: string;
  blockNumber: number;
}

export type DestinationResult = DestinationSuccess | DestinationFailure;

const fail = (code: DestinationFailureCode, reason: string, retryable: boolean): DestinationFailure =>
  ({ ok: false, code, reason, retryable });

// cross_chain_transfers states past which a destination settle is meaningful.
const SETTLE_ELIGIBLE_STATES: ReadonlySet<string> = new Set(['attested', 'destination_pending', 'destination_submitted']);
// states already settled (or terminal) — a settle request is a no-op.
const SETTLED_STATES: ReadonlySet<string> = new Set(['destination_confirmed', 'settled']);

interface TransferRow {
  id: string;
  payment_intent_id: string;
  source_network: string;
  destination_network: string;
  destination_chain_id: number;
  cctp_message: string | null;
  attestation: string | null;
  attestation_status: string;
  mint_recipient: string;
  amount_base_units: string;
  state: string;
}

/**
 * Verify a destination mint receipt against the recorded, attested transfer —
 * the pure money-safety gate, NO credit. Returns the matching Transfer's fields
 * or a typed failure. Exposed so the settlement path and tests share ONE rule.
 */
export async function verifyDestinationMint(input: {
  transfer: TransferRow;
  destinationTxHash: string;
  provider: DestinationProvider;
}): Promise<{ ok: true; txHash: string; recipient: string; amountBaseUnits: string; blockNumber: number } | DestinationFailure> {
  const { transfer } = input;
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.destinationTxHash)) {
    return fail('invalid_tx_hash', 'destination tx hash must be a full 0x-prefixed 32-byte hash', false);
  }
  const destCfg = CCTP_REGISTRY[transfer.destination_network];
  if (!destCfg || !isCctpDestination(transfer.destination_network)) {
    return fail('not_cross_chain', `destination "${transfer.destination_network}" is not a CCTP destination`, false);
  }

  let receipt: TransactionReceipt | null;
  try {
    receipt = await input.provider.getTransactionReceipt(input.destinationTxHash);
  } catch (err) {
    return fail('provider_error', `Arc destination read failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
  if (!receipt) return fail('receipt_missing', 'destination transaction not found on Arc yet', true);
  if (receipt.status !== 'success') return fail('receipt_reverted', 'destination transaction reverted on Arc', true);

  // The tx must be a call to the registry-pinned Arc MessageTransmitterV2 — this
  // binds the settlement to an actual CCTP claim, not an incidental transfer.
  const transmitter = messageTransmitterFor(destCfg.isTestnet);
  if (receipt.to.toLowerCase() !== transmitter) {
    return fail('not_message_transmitter_call', `destination tx did not call Arc MessageTransmitterV2 (${transmitter})`, true);
  }

  // Arc USDC address is registry-authoritative (never the caller's).
  const arcUsdc = getNetworkConfig(transfer.destination_network).usdcAddress.toLowerCase();
  const adapter = new USDCAdapter(arcUsdc);
  const transfers = adapter.decodeTransfers(receipt.logs);
  if (transfers.length === 0) {
    return fail('mint_transfer_missing', 'no USDC Transfer event in the destination receipt', true);
  }

  // The mint must land on the merchant's pinned Arc wallet for the EXACT amount.
  const expectedRecipient = transfer.mint_recipient.toLowerCase();
  const expectedAmount = BigInt(transfer.amount_base_units);
  const matching = transfers.find((t) => t.to === expectedRecipient && t.value === expectedAmount);
  if (!matching) {
    // Distinguish the two failure shapes for a clearer operator signal.
    const anyAtAmount = transfers.some((t) => t.value === expectedAmount);
    return anyAtAmount
      ? fail('wrong_mint_recipient', `mint of ${transfer.amount_base_units} did not go to the pinned Arc wallet ${expectedRecipient}`, false)
      : fail('amount_mismatch', `no mint of exactly ${transfer.amount_base_units} to ${expectedRecipient} on Arc`, false);
  }

  return {
    ok: true,
    txHash: receipt.txHash,
    recipient: matching.to,
    amountBaseUnits: matching.value.toString(),
    blockNumber: Number(receipt.blockNumber),
  };
}

/**
 * Advance ONE attested transfer to a credited settlement. Requires the real Arc
 * mint to be present (via verifyDestinationMint) before ANY credit. Idempotent:
 * a settled transfer returns 'already_settled' without touching the ledger.
 */
export async function settleDestination(input: {
  transferId: string;
  destinationTxHash: string;
  /** Injectable so tests avoid RPC and production uses the registry Arc provider. */
  providerFactory?: (destinationNetwork: string) => DestinationProvider;
  nowSeconds?: number;
}): Promise<DestinationResult> {
  const db = getDb();

  const transfer = db.prepare(
    `SELECT id,payment_intent_id,source_network,destination_network,destination_chain_id,cctp_message,attestation,
            attestation_status,mint_recipient,amount_base_units,state
     FROM cross_chain_transfers WHERE id=?`,
  ).get(input.transferId) as TransferRow | undefined;
  if (!transfer) return fail('transfer_not_found', `cross_chain_transfers "${input.transferId}" not found`, false);

  // Idempotent — already settled.
  if (transfer.attestation_status === 'complete' && SETTLED_STATES.has(transfer.state)) {
    const pay = db.prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(transfer.payment_intent_id) as { id: string } | undefined;
    return {
      ok: true, outcome: 'already_settled', transferId: transfer.id, paymentIntentId: transfer.payment_intent_id,
      paymentId: pay?.id, destinationTxHash: input.destinationTxHash, destinationNetwork: transfer.destination_network,
      recipient: transfer.mint_recipient, amountBaseUnits: transfer.amount_base_units, blockNumber: 0,
    };
  }

  // MONEY GATE 1: nothing settles before Circle attested the burn (PHASE 7).
  if (transfer.attestation_status !== 'complete' || !SETTLE_ELIGIBLE_STATES.has(transfer.state)) {
    return fail('not_attested', `transfer is not attested (attestation_status=${transfer.attestation_status}, state=${transfer.state})`, transfer.state !== 'settled');
  }
  if (!transfer.cctp_message || !transfer.attestation) {
    return fail('message_missing', 'attested transfer is missing its message/attestation payload', false);
  }
  if (!isCctpSourceSafe(transfer.source_network) || !isCctpDestination(transfer.destination_network)) {
    return fail('not_cross_chain', `route "${transfer.source_network}" → "${transfer.destination_network}" is not CCTP`, false);
  }

  // Load the intent; it must still be payable (mirrors same-chain guards).
  const pi = db.prepare(
    'SELECT id,status,settlement_address,amount_base_units,merchant_id,environment,chain_id,network,is_cross_chain FROM payment_intents WHERE id=?',
  ).get(transfer.payment_intent_id) as {
    id: string; status: string; settlement_address: string; amount_base_units: string;
    merchant_id: string; environment: string; chain_id: number; network: string; is_cross_chain: number;
  } | undefined;
  if (!pi) return fail('intent_not_found', `payment intent "${transfer.payment_intent_id}" not found`, false);
  if (pi.status === 'succeeded') {
    // The intent already carries a payment — treat as already settled.
    const pay = db.prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi.id) as { id: string } | undefined;
    return {
      ok: true, outcome: 'already_settled', transferId: transfer.id, paymentIntentId: pi.id, paymentId: pay?.id,
      destinationTxHash: input.destinationTxHash, destinationNetwork: transfer.destination_network,
      recipient: transfer.mint_recipient, amountBaseUnits: transfer.amount_base_units, blockNumber: 0,
    };
  }
  if (!['requires_payment', 'processing'].includes(pi.status)) {
    return fail('intent_not_payable', `payment intent is "${pi.status}", not payable`, false);
  }

  // Cross-check the recorded burn amount against the intent (defence in depth).
  if (BigInt(transfer.amount_base_units) !== BigInt(pi.amount_base_units)) {
    return fail('amount_mismatch', `transfer amount ${transfer.amount_base_units} != intent ${pi.amount_base_units}`, false);
  }
  if (transfer.mint_recipient.toLowerCase() !== pi.settlement_address.toLowerCase()) {
    return fail('wrong_mint_recipient', `transfer recipient ${transfer.mint_recipient} != intent settlement ${pi.settlement_address}`, false);
  }

  // MONEY GATE 2: the real Arc mint must exist, be a transmitter call, and pay
  // the exact amount to the pinned wallet. No provider → build the registry one.
  const provider = input.providerFactory
    ? input.providerFactory(transfer.destination_network)
    : new ArcProvider(transfer.destination_network);
  const verify = await verifyDestinationMint({ transfer, destinationTxHash: input.destinationTxHash, provider });
  if (!verify.ok) return verify;

  // MONEY GATE 3: storage replay — this destination tx may not already be booked.
  const existingBtx = db.prepare('SELECT id FROM blockchain_transactions WHERE tx_hash=? AND network=?')
    .get(verify.txHash, transfer.destination_network);
  if (existingBtx) return fail('destination_replay_detected', 'destination tx already recorded', false);

  const amountFmt = formatBaseUnitsToDecimal(BigInt(verify.amountBaseUnits));

  // ── ATOMIC credit (identical ledger shape to the same-chain verifier). ──
  const paymentId = generateId('pay');
  let credited = false;
  db.transaction(() => {
    // Re-guard under the transaction (a concurrent settle may have landed).
    const live = db.prepare('SELECT state FROM cross_chain_transfers WHERE id=?').get(transfer.id) as { state: string };
    const fresh = db.prepare('SELECT status FROM payment_intents WHERE id=?').get(pi.id) as { status: string };
    if (fresh.status === 'succeeded' || SETTLED_STATES.has(live.state)) { credited = false; return; }

    db.prepare(
      'INSERT OR IGNORE INTO blockchain_transactions(id,tx_hash,network,chain_id,block_number,block_timestamp,from_address,to_address,usdc_address,amount,log_index,raw_receipt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(generateId('btx'), verify.txHash, transfer.destination_network, transfer.destination_chain_id, verify.blockNumber,
      Math.floor((input.nowSeconds ?? Date.now() / 1000)), '0x0000000000000000000000000000000000000000', verify.recipient,
      getNetworkConfig(transfer.destination_network).usdcAddress, verify.amountBaseUnits, 0, '{}');

    db.prepare(
      'INSERT INTO payments(id,payment_intent_id,merchant_id,tx_hash,network,chain_id,sender_address,recipient_address,amount_base_units,amount_decimal,block_number,block_timestamp) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(paymentId, pi.id, pi.merchant_id, verify.txHash, transfer.destination_network, transfer.destination_chain_id,
      '0x0000000000000000000000000000000000000000', verify.recipient, verify.amountBaseUnits, amountFmt, verify.blockNumber,
      Math.floor((input.nowSeconds ?? Date.now() / 1000)));

    db.prepare('UPDATE blockchain_transactions SET payment_id=? WHERE tx_hash=? AND network=?').run(paymentId, verify.txHash, transfer.destination_network);
    db.prepare("UPDATE payment_intents SET status='succeeded',updated_at=unixepoch() WHERE id=?").run(pi.id);

    db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,from_status,to_status) VALUES(?,?,?,?,?)')
      .run(generateId('pe'), pi.id, 'payment.succeeded', 'processing', 'succeeded');
    db.prepare('INSERT INTO payment_events(id,payment_intent_id,event_type,to_status,data) VALUES(?,?,?,?,?)')
      .run(generateId('pe'), pi.id, 'payment.cross_chain.settled', 'succeeded',
        JSON.stringify({ transfer_id: transfer.id, destination_tx_hash: verify.txHash, destination_network: transfer.destination_network, source_network: transfer.source_network }));

    db.prepare(
      `UPDATE cross_chain_transfers SET destination_tx_hash=?, destination_block_number=?,
         claim_status='confirmed', state='settled', updated_at=? WHERE id=?`,
    ).run(verify.txHash, verify.blockNumber, Math.floor((input.nowSeconds ?? Date.now() / 1000)), transfer.id);

    credited = true;
  })();

  if (!credited) {
    const pay = db.prepare('SELECT id FROM payments WHERE payment_intent_id=?').get(pi.id) as { id: string } | undefined;
    return {
      ok: true, outcome: 'already_settled', transferId: transfer.id, paymentIntentId: pi.id, paymentId: pay?.id,
      destinationTxHash: verify.txHash, destinationNetwork: transfer.destination_network,
      recipient: verify.recipient, amountBaseUnits: verify.amountBaseUnits, blockNumber: verify.blockNumber,
    };
  }

  // Post-credit side effects — isolated, never able to move 'succeeded' back.
  const paymentRow = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId) as Record<string, unknown>;
  enqueueWebhookDeliveries(pi.id, 'payment.succeeded', {
    payment_intent_id: pi.id,
    payment: paymentRow,
    // PHASE 12: additive cross-chain settlement detail; the event type itself is
    // unchanged, so existing consumers keep reading payment_intent_id + payment.
    cross_chain: {
      transfer_id: transfer.id,
      source_network: transfer.source_network,
      destination_network: transfer.destination_network,
      destination_tx_hash: verify.txHash,
      mint_recipient: verify.recipient,
      amount_base_units: verify.amountBaseUnits,
    },
  }, pi.environment as 'test' | 'live');
  await issueReceiptForPayment(paymentId);

  return {
    ok: true, outcome: 'settled', transferId: transfer.id, paymentIntentId: pi.id, paymentId,
    destinationTxHash: verify.txHash, destinationNetwork: transfer.destination_network,
    recipient: verify.recipient, amountBaseUnits: verify.amountBaseUnits, blockNumber: verify.blockNumber,
  };
}

// Local import to avoid a circular registry surface (source-leg check only).
function isCctpSourceSafe(slug: string): boolean {
  return CCTP_REGISTRY[slug]?.supportedAsSource === true;
}

// Re-exported for tests that assert the Arc destination domain is honoured.
export const DESTINATION_DOMAIN = ARC_CCTP_DOMAIN;
