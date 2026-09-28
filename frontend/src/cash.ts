// The cash leg on chain: USDC over Circle's CCTP V2, into and out of the Veil
// pool, without naming the holder.
//
// IN (Ethereum -> Veil). The holder's wallet burns USDC through Circle's
// TokenMessengerV2 with Veil's cash vault as BOTH the mint recipient and the
// destination caller, and the holder's empty USDC note as the 32-byte hook
// data. Once Circle has attested the burn, Veil's relayer hands the message to
// the vault, which fills the note in the same transaction.
//
// OUT (Veil -> Ethereum). A proven pool `invoke`, submitted by the prover's
// relayer and signed by the holder's EVM wallet, pays Veil's cash exit, which
// burns through CCTP to the holder's Ethereum address. Once Circle has attested
// it, the same wallet calls Circle's MessageTransmitterV2 and the USDC is
// minted to it. The holder never sends a Starknet transaction either way.

import { Contract } from 'ethers';
import {
  VeilERC3643Discovery, VeilProver, makeVeilERC3643ContractReader, computeNoteId, TWO_POW_128,
} from 'veil-sdk';
import { Contract as SnContract } from 'starknet';
import { deployment, IRIS_API, PROVER_ENDPOINT, PROVER_MASTER_ADDRESS, STARKNET_RPC } from './config';
import { readProvider, type EvmSession, type EvmStatus } from './evm';
import { snProvider } from './starknet';
import type { NoteContext, NoteSlot } from './notes';
import poolReaderAbi from './poolReaderAbi.json';
import {
  fastMaxFee, irisTxHash, parseIrisMessages, planCashExit, word,
  ETHEREUM_DOMAIN, STARKNET_DOMAIN, STANDARD_FINALITY, FAST_FINALITY, type IrisMessage,
} from './cashCore';

export { STARKNET_DOMAIN, ETHEREUM_DOMAIN } from './cashCore';

const cash = () => {
  const c = deployment.cash;
  if (!c?.vault || !c.exit || !c.usdc || !c.pool || !c.source?.usdc || !c.source.tokenMessenger
      || !c.source.messageTransmitter) {
    throw new Error('The cash leg is not deployed on this route.');
  }
  return c as Required<typeof c> & { source: Required<NonNullable<typeof c.source>> };
};

const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function paused() view returns (bool)',
  'function isBlacklisted(address) view returns (bool)',
];

// Circle's evm-cctp-contracts, src/v2/TokenMessengerV2.sol and MessageTransmitterV2.sol.
const TOKEN_MESSENGER_ABI = [
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
];
const MESSAGE_TRANSMITTER_ABI = [
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
];

// ── Ethereum ───────────────────────────────────────────────────────────────

/// USDC's own rules on Ethereum, shaped like the lockbox assets' status so the
/// card reads it the same way: Circle's blocklist is the freeze, its pause the
/// pause, and there is no registry or lockbox to be admitted to.
export async function evmStatus(account: string): Promise<EvmStatus> {
  const c = cash();
  const usdc = new Contract(c.source.usdc, USDC_ABI, readProvider);
  const [balance, allowance, paused, blocklisted] = await Promise.all([
    usdc.balanceOf(account).then(BigInt),
    usdc.allowance(account, c.source.tokenMessenger).then(BigInt).catch(() => 0n),
    usdc.paused().catch(() => false),
    usdc.isBlacklisted(account).catch(() => false),
  ]);
  return {
    balance, allowance, paused, frozen: blocklisted, verified: !blocklisted,
    lockboxRegistered: true, country: 0,
  };
}

export async function approve(session: EvmSession, amount: bigint): Promise<void> {
  const c = cash();
  const usdc = new Contract(c.source.usdc, USDC_ABI, await session.provider.getSigner());
  const tx = await usdc.approve(c.source.tokenMessenger, amount);
  await tx.wait();
}

/// Circle's quoted minimum fee, in basis points, for a Fast Transfer on this
/// route; null when Circle offers none.
export async function fastFeeBps(sourceDomain: number, destinationDomain: number): Promise<number | null> {
  try {
    const res = await fetch(`${IRIS_API}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`);
    if (!res.ok) return null;
    const rows = (await res.json()) as { finalityThreshold: number; minimumFee: number }[];
    const row = rows.find((r) => r.finalityThreshold === FAST_FINALITY);
    return row ? row.minimumFee : null;
  } catch {
    return null;
  }
}

/// The CCTP parameters for a transfer: Standard is free and waits for finality;
/// Fast pays Circle's fee (capped with a buffer) to be attested before it.
export async function transferParams(
  amount: bigint, fast: boolean, sourceDomain: number, destinationDomain: number,
): Promise<{ maxFee: bigint; minFinality: number }> {
  if (!fast) return { maxFee: 0n, minFinality: STANDARD_FINALITY };
  const bps = await fastFeeBps(sourceDomain, destinationDomain);
  if (bps === null) throw new Error('Circle is not offering a Fast Transfer on this route right now. Use Standard.');
  return { maxFee: fastMaxFee(amount, bps), minFinality: FAST_FINALITY };
}

/// Burn `amount` USDC into `noteId`, through the cash vault. Returns the tx hash.
export async function burnToVeil(
  session: EvmSession, amount: bigint, noteId: string, fast: boolean,
): Promise<string> {
  const c = cash();
  const { maxFee, minFinality } = await transferParams(amount, fast, ETHEREUM_DOMAIN, STARKNET_DOMAIN);
  const messenger = new Contract(c.source.tokenMessenger, TOKEN_MESSENGER_ABI, await session.provider.getSigner());
  const vault = word(c.vault);
  const tx = await messenger.depositForBurnWithHook(
    amount, STARKNET_DOMAIN, vault, c.source.usdc, vault, maxFee, minFinality, word(noteId),
  );
  await tx.wait();
  return tx.hash as string;
}

/// Mint an exit's USDC on Ethereum. Anyone may relay it (the burn names no
/// destination caller); the USDC can only go to the recipient it names.
export async function mintOnEvm(session: EvmSession, message: string, attestation: string): Promise<string> {
  const c = cash();
  const transmitter = new Contract(
    c.source.messageTransmitter, MESSAGE_TRANSMITTER_ABI, await session.provider.getSigner(),
  );
  const tx = await transmitter.receiveMessage(message, attestation);
  await tx.wait();
  return tx.hash as string;
}

// ── Circle ─────────────────────────────────────────────────────────────────

/// Circle's view of the burn in `txHash`, or null while it has not seen it.
export async function irisMessage(sourceDomain: number, txHash: string): Promise<IrisMessage | null> {
  const res = await fetch(`${IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${irisTxHash(txHash)}`);
  const body = res.ok ? await res.json() : undefined;
  return parseIrisMessages(res.status, body);
}

// ── Starknet ───────────────────────────────────────────────────────────────

/// A note's raw value: 0 when it does not exist, 2^128 when it is an empty open
/// note, 2^128 + amount once filled.
export async function noteValue(noteId: string): Promise<bigint> {
  const res = await snProvider.callContract({
    contractAddress: cash().pool, entrypoint: 'get_notes_batch', calldata: ['1', noteId],
  });
  const felts = res as string[];
  return BigInt(felts[1] ?? 0);
}

export const isFilled = (raw: bigint): boolean => raw > TWO_POW_128;

// ── Notes with a deposit on its way ────────────────────────────────────────
//
// A note stays empty until Circle has attested the burn and the vault has
// filled it, which is minutes (or hours). A second deposit into the same note
// would arrive to a filled note and be refunded, so notes with a burn in
// flight are remembered here, per browser, and skipped.

const INFLIGHT_KEY = `veil-bridge:cash-inflight:${deployment.evmNetwork ?? '?'}:${deployment.starknetNetwork ?? '?'}`;
const INFLIGHT_TTL_MS = 24 * 60 * 60 * 1000;

function loadInFlight(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(INFLIGHT_KEY) ?? '{}') as Record<string, number>;
    const now = Date.now();
    return Object.fromEntries(Object.entries(raw).filter(([, at]) => now - at < INFLIGHT_TTL_MS));
  } catch {
    return {};
  }
}

function saveInFlight(v: Record<string, number>): void {
  try { localStorage.setItem(INFLIGHT_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ }
}

const canonNote = (noteId: string): string => '0x' + BigInt(noteId).toString(16);

export function inFlightNotes(): Set<bigint> {
  return new Set(Object.keys(loadInFlight()).map((k) => BigInt(k)));
}

export function markInFlight(noteId: string): void {
  saveInFlight({ ...loadInFlight(), [canonNote(noteId)]: Date.now() });
}

export function forgetInFlight(noteId: string): void {
  const v = loadInFlight();
  delete v[canonNote(noteId)];
  saveInFlight(v);
}

/// The first empty USDC note of this holder that no deposit is on its way to.
export async function findFreeNote(
  ctx: NoteContext, exclude: Set<bigint>, maxIndex = 16,
): Promise<NoteSlot | undefined> {
  const c = cash();
  const usdc = BigInt(c.usdc);
  for (let index = 0; index < maxIndex; index++) {
    const id = computeNoteId(ctx.channelKey, usdc, index);
    if (exclude.has(id)) continue;
    const noteId = '0x' + id.toString(16);
    const [notes, record] = await Promise.all([
      snProvider.callContract({ contractAddress: c.pool, entrypoint: 'get_notes_batch', calldata: ['1', noteId] }),
      snProvider.callContract({ contractAddress: c.pool, entrypoint: 'get_open_note', calldata: [noteId] }),
    ]);
    const raw = BigInt((notes as string[])[1] ?? 0);
    const token = BigInt((record as string[])[0] ?? 0);
    if (token === usdc && raw === TWO_POW_128) return { noteId, index, exists: true, fillable: true };
  }
  return undefined;
}

function random(bytes: number): bigint {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b.reduce((v, x) => (v << 8n) | BigInt(x), 0n);
}
const randomFelt = (): bigint => random(31) || 1n;
/** A note salt: 2 <= salt < 2^120 (0 and 1 are reserved). */
const randomNoteSalt = (): bigint => (random(15) % ((1n << 120n) - 2n)) + 2n;

/// The first empty USDC slot in the holder's self-channel.
async function firstFreeSlot(ctx: NoteContext, usdc: bigint): Promise<number> {
  for (let start = 0; start < 512; start += 32) {
    const ids = Array.from({ length: 32 }, (_, j) => '0x' + computeNoteId(ctx.channelKey, usdc, start + j).toString(16));
    const res = (await snProvider.callContract({
      contractAddress: cash().pool, entrypoint: 'get_notes_batch', calldata: [String(ids.length), ...ids],
    })) as string[];
    const free = res.slice(1).findIndex((v) => BigInt(v) === 0n);
    if (free >= 0) return start + free;
  }
  throw new Error('Could not find a free note slot.');
}

/// Leave the pool: one proven invoke through the cash exit, burning `amount`
/// to `recipient` on Ethereum. The prover's relayer submits it, so the holder's
/// account does not appear. Returns the Starknet tx hash of the burn.
export async function exitToEvm(
  ctx: NoteContext, amount: bigint, recipient: string, fast: boolean, onProgress?: (line: string) => void,
): Promise<string> {
  const c = cash();
  if (!PROVER_ENDPOINT || !PROVER_MASTER_ADDRESS) {
    throw new Error('No Veil prover is configured for this deployment.');
  }
  const usdc = BigInt(c.usdc);
  onProgress?.('reading your notes');
  const pool = new SnContract({ abi: poolReaderAbi as never, address: c.pool, providerOrAccount: snProvider });
  const discovery = new VeilERC3643Discovery(makeVeilERC3643ContractReader(pool as never));
  const [notes, slot] = await Promise.all([
    discovery.listOwnedNotes(ctx.owner, ctx.viewingKey),
    firstFreeSlot(ctx, usdc),
  ]);
  const { maxFee, minFinality } = await transferParams(amount, fast, STARKNET_DOMAIN, ETHEREUM_DOMAIN);
  const plan = planCashExit({
    owner: ctx.owner,
    ownerPrivateViewingKey: ctx.viewingKey,
    selfChannelKey: ctx.channelKey,
    notes,
    firstFreeSlot: slot,
    usdc,
    exit: BigInt(c.exit),
    amount,
    recipient: BigInt(recipient),
    maxFee,
    minFinality,
    auditEphemeralSecret: randomFelt(),
    changeNoteSalt: randomNoteSalt(),
    subchannelSalt: randomFelt(),
  });
  const prover = new VeilProver({
    veilAddress: c.pool,
    pool: 'erc3643',
    endpoint: PROVER_ENDPOINT,
    transport: 'job',
    rpcUrl: STARKNET_RPC,
    masterAddress: PROVER_MASTER_ADDRESS,
    signer: ctx.signer,
    chainId: ctx.chainId,
  });
  onProgress?.('proving');
  const { txHash } = await prover.invoke(plan.deriveCalldata, { settleExtra: plan.settleExtra });
  onProgress?.('waiting for inclusion');
  await snProvider.waitForTransaction(txHash, { retryInterval: 3000 });
  return txHash;
}
