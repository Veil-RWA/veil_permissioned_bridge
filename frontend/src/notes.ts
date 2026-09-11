// Open notes, derived rather than typed.
//
// A note id is not an arbitrary handle. It is
//
//   note_id = H(DOMAIN.NOTE_ID, channel_key, token, index)
//   channel_key = H(DOMAIN.DERIVE_CHANNEL_KEY, owner, k, owner, pub(k))
//
// where `k` is the owner's private viewing key. So the id is bound to the owner
// by construction: nobody else can derive it, and only the key it came from can
// spend the note. Asking a user to paste one was wrong twice over -- it cannot
// be produced by hand, and a pasted id that is not yours sends your tokens into
// someone else's note.
//
// Everything here happens on the device. The viewing key is recovered from a
// wallet signature over fixed typed data (STRK20 §5.4) and never leaves.

import {
  deriveViewingKey, deriveChannelKey, computeNoteId, TWO_POW_128,
} from 'veil-sdk';
import { snProvider } from './starknet';
import type { SnSession } from './starknet';
import type { Asset } from './assets';

export type NoteContext = {
  owner: bigint;
  viewingKey: bigint;
  publicViewingKey: bigint;
  channelKey: bigint;
};

/// Recover the owner's viewing key and self-channel key.
///
/// Signing is idempotent: the typed data is fixed, so the same wallet always
/// produces the same key. Nothing is stored -- rederive it per session rather
/// than keeping a secret in browser storage.
/// Cached per (account, chain), the way VeilX does it.
///
/// The key is DERIVED from a signature, so it is always recoverable from the
/// wallet -- caching only avoids re-prompting on every reload. The trade-off is
/// the same one VeilX documents: anything that can run script in this origin
/// can read localStorage, and this key decrypts every note the account owns. It
/// is dropped on disconnect.
const keyCache = new Map<string, { privateKey: bigint; publicKey: bigint }>();

/// Cache keys must be CANONICAL, not whatever the wallet happened to return.
///
/// A Starknet address is a felt, and the same account comes back as
/// `0x07f69f…` from one wallet call and `0x7f69f…` from another -- same value,
/// different string. Keying storage on the raw string means a reload misses its
/// own entry and re-prompts for a signature the holder already gave, which
/// looks exactly like the cache not working at all. Chain ids vary the same way.
const canon = (v: string): string => {
  try { return '0x' + BigInt(v).toString(16); } catch { return v.trim().toLowerCase(); }
};

const cacheKey = (address: string, chainId: string) => `${canon(address)}:${canon(chainId)}`;

const storageKey = (address: string, chainId: string) =>
  `veil:vk:${canon(chainId)}:${canon(address)}`;

function loadCachedKey(address: string, chainId: string) {
  try {
    const raw = localStorage.getItem(storageKey(address, chainId));
    if (!raw) return null;
    const { privateKey, publicKey } = JSON.parse(raw) as Record<string, string>;
    if (!privateKey || !publicKey) return null;
    return { privateKey: BigInt(privateKey), publicKey: BigInt(publicKey) };
  } catch {
    return null;   // private mode, cleared storage, or a corrupt entry
  }
}

function storeKey(
  address: string, chainId: string, vk: { privateKey: bigint; publicKey: bigint }
) {
  try {
    localStorage.setItem(storageKey(address, chainId), JSON.stringify({
      privateKey: '0x' + vk.privateKey.toString(16),
      publicKey: '0x' + vk.publicKey.toString(16),
    }));
  } catch { /* storage unavailable -- the in-memory cache still serves */ }
}

/// Is a key already available without prompting? Lets the app derive the note
/// on connect without a second signature after a reload.
export function hasCachedViewingKey(address: string, chainId: string): boolean {
  return keyCache.has(cacheKey(address, chainId)) || loadCachedKey(address, chainId) !== null;
}

/// Drop the cached key. Called on disconnect, so switching accounts or walking
/// away from a shared machine does not leave it behind.
export function forgetViewingKey(address: string, chainId: string): void {
  keyCache.delete(cacheKey(address, chainId));
  try { localStorage.removeItem(storageKey(address, chainId)); } catch { /* ignore */ }
}

export async function deriveNoteContext(session: SnSession): Promise<NoteContext> {
  const chainId = (await snProvider.getChainId()) as unknown as string;
  const id = cacheKey(session.address, chainId);
  const cached = keyCache.get(id) ?? loadCachedKey(session.address, chainId);
  const { privateKey, publicKey } = cached ?? await deriveViewingKey(
    session.account as never, chainId
  );
  if (!cached) {
    keyCache.set(id, { privateKey, publicKey });
    storeKey(session.address, chainId, { privateKey, publicKey });
  }
  const owner = BigInt(session.address);
  // The SELF channel: owner -> owner, which is where a holder's own notes live.
  const channelKey = deriveChannelKey(owner, privateKey, owner, publicKey);
  return { owner, viewingKey: privateKey, publicViewingKey: publicKey, channelKey };
}

export type NoteSlot = {
  noteId: string;
  index: number;
  /// The pool has this note recorded as an open note awaiting a fill.
  exists: boolean;
  /// Still empty, so it can still be filled. A filled note is one-shot.
  fillable: boolean;
};

const felt = (v: bigint): string => '0x' + v.toString(16);

async function readNote(pool: string, noteId: string): Promise<{ raw: bigint; token: bigint }> {
  const [notes, record] = await Promise.all([
    snProvider.callContract({
      contractAddress: pool, entrypoint: 'get_notes_batch', calldata: ['1', noteId],
    }).catch(() => ['0', '0'] as string[]),
    snProvider.callContract({
      contractAddress: pool, entrypoint: 'get_open_note', calldata: [noteId],
    }).catch(() => ['0'] as string[]),
  ]);
  const n = notes as string[];
  return { raw: BigInt(n[1] ?? n[0] ?? 0), token: BigInt((record as string[])[0] ?? 0) };
}

/// Walk this owner's note slots and report the first that can still be filled,
/// mirroring the pool's own `next_note_slot_internal`.
///
/// An open note is encoded as `2^128` while empty and `2^128 + amount` once
/// filled, so "exists and still empty" is exactly `raw == 2^128`.
export async function findFillableNote(
  asset: Asset, ctx: NoteContext, maxIndex = 12
): Promise<NoteSlot | undefined> {
  const pool = asset.addresses.starknet?.pool;
  const token = asset.addresses.starknet?.token;
  if (!pool || !token) return undefined;

  for (let index = 0; index < maxIndex; index++) {
    const noteId = felt(computeNoteId(ctx.channelKey, BigInt(token), index));
    const { raw, token: recorded } = await readNote(pool, noteId);
    if (recorded !== 0n && raw === TWO_POW_128) {
      return { noteId, index, exists: true, fillable: true };
    }
  }
  return undefined;
}

/// The next slot that holds nothing at all — where a new open note would be
/// created. Reported so the UI can say what to create rather than only that
/// nothing was found.
export async function nextEmptySlot(
  asset: Asset, ctx: NoteContext, maxIndex = 12
): Promise<NoteSlot | undefined> {
  const pool = asset.addresses.starknet?.pool;
  const token = asset.addresses.starknet?.token;
  if (!pool || !token) return undefined;

  for (let index = 0; index < maxIndex; index++) {
    const noteId = felt(computeNoteId(ctx.channelKey, BigInt(token), index));
    const { raw, token: recorded } = await readNote(pool, noteId);
    if (raw === 0n && recorded === 0n) {
      return { noteId, index, exists: false, fillable: false };
    }
  }
  return undefined;
}

// ── Creating the note ────────────────────────────────────────────────────────
//
// The bridge does not need the holder to go and make a note somewhere else. The
// SDK creates one here, at bridge time, through the same proven path the Veil
// app uses: `create_open_note_derive` runs in the proven virtual block and
// `create_open_note_settle` writes the empty note on-chain, carrying the
// derive's proof and proof_facts (SNIP-36).
//
// The browser cannot sign a settle, so -- exactly as veilx/app does it -- no
// privateKey or senderAddress is passed and the prover service submits from its
// own account. That is what `masterAddress` is for.
//
// The pool assigns the index itself (`next_note_slot_internal`), so nothing
// here picks one: after the settle, the scan finds the new note where the pool
// put it.

import { VeilProver } from 'veil-sdk';
import { PROVER_ENDPOINT, PROVER_MASTER_ADDRESS, STARKNET_RPC } from './config';

const U128_MAX = (1n << 128n) - 1n;
const hexOf = (v: bigint): string => '0x' + v.toString(16);
const u256Pair = (v: bigint): [string, string] => [hexOf(v & U128_MAX), hexOf(v >> 128n)];

/// A fresh felt, for the audit ephemeral secret and the subchannel salt. Both
/// must be unpredictable: the first blinds the auditor encryption, the second
/// opens the subchannel.
function randomFelt(): bigint {
  const bytes = new Uint8Array(31);          // < 2^248, safely inside the field
  crypto.getRandomValues(bytes);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v === 0n ? 1n : v;
}

/// Calldata for `create_open_note_derive(owner, k: u256, token,
/// audit_ephemeral_secret_r, subchannel_salt)`.
export function buildCreateOpenNoteCalldata(
  owner: bigint, viewingKey: bigint, token: bigint,
  auditEphemeralSecretR: bigint, subchannelSalt: bigint,
): string[] {
  return [
    hexOf(owner),
    ...u256Pair(viewingKey),
    hexOf(token),
    hexOf(auditEphemeralSecretR),
    hexOf(subchannelSalt),
  ];
}

export type CreateNoteResult = { ok: true; slot: NoteSlot } | { ok: false; reason: string };

/// Create an empty open note for this asset, then find it.
/// How long to wait for a freshly settled note to become readable. Starknet
/// Sepolia blocks land in a few seconds, but an RPC can trail a block or two,
/// so this covers roughly a minute rather than giving up on the first read.
const NOTE_VISIBLE_ATTEMPTS = 20;
const NOTE_VISIBLE_DELAY_MS = 3000;

export async function createOpenNote(
  asset: Asset, ctx: NoteContext, onProgress?: (line: string) => void
): Promise<CreateNoteResult> {
  const pool = asset.addresses.starknet?.pool;
  const token = asset.addresses.starknet?.token;
  if (!pool || !token) return { ok: false, reason: 'This asset has no Veil pool configured.' };
  if (!PROVER_ENDPOINT) {
    return { ok: false, reason: 'No Veil prover endpoint is configured for this deployment.' };
  }
  if (!PROVER_MASTER_ADDRESS) {
    return { ok: false, reason: 'No prover master account is configured for this deployment.' };
  }

  const prover = new VeilProver({
    veilAddress: pool,
    pool: 'erc3643',
    endpoint: PROVER_ENDPOINT,
    transport: 'job',
    rpcUrl: STARKNET_RPC,
    // The browser cannot sign a settle; the prover submits from its own account.
    masterAddress: PROVER_MASTER_ADDRESS,
  });

  const calldata = buildCreateOpenNoteCalldata(
    ctx.owner, ctx.viewingKey, BigInt(token), randomFelt(), randomFelt(),
  );

  try {
    onProgress?.('proving');
    await prover.createOpenNote(calldata);
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) };
  }

  // The settle succeeded, so the note EXISTS. It is simply not readable yet:
  // the prover's transaction has to be included and this RPC has to have seen
  // that block. Handing that back as a failure told the holder their note was
  // lost and sent them to press a button for a state the app could just wait
  // for -- so wait for it, and only give up after the block time it actually
  // takes. A read that lags is not an error.
  onProgress?.('finding the note');
  for (let attempt = 0; ; attempt++) {
    const slot = await findFillableNote(asset, ctx);
    if (slot) return { ok: true, slot };
    if (attempt >= NOTE_VISIBLE_ATTEMPTS) break;
    onProgress?.(`waiting for the note to confirm (${attempt + 1}/${NOTE_VISIBLE_ATTEMPTS})`);
    await new Promise((r) => setTimeout(r, NOTE_VISIBLE_DELAY_MS));
  }
  return {
    ok: false,
    reason: 'Your note was created, but this RPC still cannot see it. It is not lost — press Bridge again in a moment and it will be used.',
  };
}
