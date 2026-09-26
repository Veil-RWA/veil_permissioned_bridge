// The cash leg's pure pieces: nothing here touches a wallet or an RPC, so the
// encodings can be tested in node (cashCore.test.mjs).
//
// USDC does not use a lockbox. It moves through Circle's CCTP V2: burned on
// Ethereum, minted on Starknet to Veil's cash vault, which fills the holder's
// empty USDC note; and back out through Veil's cash exit, a proven pool invoke
// that burns to an Ethereum address. See the bridge README, "The cash leg".

import {
  buildInvokeDeriveCalldata, computeNoteId, invokeCalldataHash, u256Felts, type OwnedNote,
} from 'veil-sdk';

/** Circle's CCTP domains. */
export const ETHEREUM_DOMAIN = 0;
export const STARKNET_DOMAIN = 25;
/** Standard Transfer: attested at finality, no CCTP fee. */
export const STANDARD_FINALITY = 2000;
/** Fast Transfer: attested before finality, for Circle's fee. */
export const FAST_FINALITY = 1000;
/** What the cash exit hands back into the invoke's open note. */
export const EXIT_CHANGE = 1n;

const hex = (v: bigint): string => '0x' + v.toString(16);

/** A felt, a Starknet address or an EVM address as CCTP's 32-byte word. */
export const word = (v: string | bigint): string =>
  '0x' + BigInt(v).toString(16).padStart(64, '0');

/**
 * A transaction hash in the form Circle's attestation service is keyed on.
 * A Starknet hash is a felt and loses its leading zeros; Circle's own Starknet
 * quickstart left-pads it to 64 hex characters before asking.
 */
export function irisTxHash(hash: string): string {
  const bare = hash.replace(/^0x/i, '').toLowerCase();
  return '0x' + (bare.length < 64 ? bare.padStart(64, '0') : bare);
}

function bytesOf(hexBytes: string): Uint8Array {
  const bare = hexBytes.replace(/^0x/i, '');
  if (bare.length % 2 !== 0 || /[^0-9a-f]/i.test(bare)) throw new Error('not a hex byte string');
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bare.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const bigOf = (bytes: Uint8Array): bigint => bytes.reduce((v, b) => (v << 8n) | BigInt(b), 0n);

/**
 * Raw bytes as a serialized Cairo `ByteArray`: `data` (31-byte words, the first
 * byte most significant), then `pending_word` and `pending_word_len`. This is
 * how the vault receives Circle's message and attestation, byte for byte.
 */
export function byteArrayCalldata(hexBytes: string): string[] {
  const bytes = bytesOf(hexBytes);
  const full = Math.floor(bytes.length / 31);
  const words: string[] = [];
  for (let i = 0; i < full; i++) words.push(hex(bigOf(bytes.subarray(31 * i, 31 * (i + 1)))));
  const rest = bytes.subarray(31 * full);
  return [hex(BigInt(full)), ...words, hex(bigOf(rest)), hex(BigInt(rest.length))];
}

// ── Circle's attestation service (Iris V2) ─────────────────────────────────

export type IrisMessage = {
  /** Circle has signed it: `message` and `attestation` can be relayed. */
  attested: boolean;
  message?: string;
  attestation?: string;
};

/** The first message of `GET /v2/messages/{domain}?transactionHash=`, or null
 *  when Circle has not indexed the burn yet (404, or no messages). */
export function parseIrisMessages(status: number, body: unknown): IrisMessage | null {
  if (status === 404) return null;
  const m = (body as { messages?: { status?: string; message?: string; attestation?: string }[] })
    ?.messages?.[0];
  if (!m) return null;
  const attested = Boolean(
    m.status === 'complete' && m.attestation && m.attestation !== 'PENDING' && m.message && m.message !== '0x',
  );
  return { attested, message: m.message, attestation: m.attestation };
}

/**
 * The most to let Circle take for a Fast Transfer of `amount`, from its quoted
 * minimum fee in basis points (`GET /v2/burn/USDC/fees/{src}/{dst}`). Circle's
 * own guide adds a 20% buffer, since the burn reverts, burning nothing, if the
 * fee at attestation exceeds the cap. Rounded up; always below `amount`.
 */
export function fastMaxFee(amount: bigint, minimumFeeBps: number): bigint {
  if (amount <= 1n) return 0n;
  const hundredths = BigInt(Math.ceil(minimumFeeBps * 100));      // bps x 100
  const fee = (amount * hundredths + 999_999n) / 1_000_000n;      // ceil
  const capped = (fee * 12n + 9n) / 10n;                          // +20%, ceil
  return capped >= amount ? amount - 1n : capped;
}

// ── The exit: one proven pool invoke through the cash exit ─────────────────

/** What the pool takes to cover `target` of `token`: it walks the owner's notes
 *  in discovery order and stops once it has enough (`select_input_notes`). */
export function selectInputTotal(notes: OwnedNote[], token: bigint, target: bigint): bigint | null {
  let total = 0n;
  for (const n of notes) {
    if (n.token !== token) continue;
    total += n.amount;
    if (total >= target) return total;
  }
  return null;
}

export type CashExitPlan = {
  inAmount: bigint;
  openNoteId: bigint;
  deriveCalldata: string[];
  settleExtra: string[];
};

/**
 * `invoke_derive` for an exit: the pool pays the cash exit `amount + 1` of the
 * owner's USDC and calls `privacy_invoke(open_note_id, amount, recipient,
 * max_fee, min_finality)`. The pool's slot rule for in token == out token: with
 * change left over, the change note takes the first free slot and the open note
 * the next.
 */
export function planCashExit(a: {
  owner: bigint;
  ownerPrivateViewingKey: bigint;
  selfChannelKey: bigint;
  notes: OwnedNote[];
  firstFreeSlot: number;
  usdc: bigint;
  exit: bigint;
  amount: bigint;
  recipient: bigint;
  maxFee: bigint;
  minFinality: number;
  auditEphemeralSecret: bigint;
  changeNoteSalt: bigint;
  subchannelSalt: bigint;
}): CashExitPlan {
  if (a.amount <= 0n) throw new Error('Enter an amount to move.');
  if (a.recipient <= 0n || a.recipient >= 1n << 160n) throw new Error('The recipient must be an EVM address.');
  const inAmount = a.amount + EXIT_CHANGE;
  const total = selectInputTotal(a.notes, a.usdc, inAmount);
  if (total === null) throw new Error('Not enough USDC in the pool (the exit keeps 1 unit back as change).');
  const openNoteIndex = a.firstFreeSlot + (total > inAmount ? 1 : 0);
  const openNoteId = computeNoteId(a.selfChannelKey, a.usdc, openNoteIndex);
  const [recipientLow, recipientHigh] = u256Felts(a.recipient);
  const [feeLow, feeHigh] = u256Felts(a.maxFee);
  const invokeCalldata = [
    hex(openNoteId), hex(a.amount), recipientLow, recipientHigh, feeLow, feeHigh, hex(BigInt(a.minFinality)),
  ];
  const calldataHash = invokeCalldataHash(invokeCalldata);
  return {
    inAmount,
    openNoteId,
    deriveCalldata: buildInvokeDeriveCalldata({
      caller: a.owner,
      ownerPrivateViewingKey: a.ownerPrivateViewingKey,
      inToken: a.usdc,
      inAmount,
      outToken: a.usdc,
      target: a.exit,
      calldataHash,
      auditEphemeralSecret: a.auditEphemeralSecret,
      changeNoteSalt: a.changeNoteSalt,
      subchannelSalt: a.subchannelSalt,
    }),
    settleExtra: [hex(BigInt(invokeCalldata.length)), ...invokeCalldata],
  };
}
