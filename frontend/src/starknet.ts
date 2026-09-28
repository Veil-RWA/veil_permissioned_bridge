// The Starknet side, read-only: mirror and twin reads, note claims, and the
// gateway facts the app needs.
//
// There is no Starknet wallet here. The holder is their EVM wallet, on both
// chains: inside Veil it signs each action with personal_sign, and the prover's
// relayer submits it on Starknet (notes.ts). Nothing on this page sends a
// Starknet transaction.
//
// starknet.js v10 is required, not preferred. Live Sepolia serves RPC spec
// 0.10.x and v6 speaks 0.7 -- a v6 client cannot talk to the network at all.

import { RpcProvider, CallData, uint256 } from 'starknet';
import { STARKNET_RPC, RELEASE_GAS_LIMIT, IS_DEMO } from './config';
import type { Asset } from './assets';

export const snProvider = new RpcProvider({ nodeUrl: STARKNET_RPC });

async function callFelts(
  contractAddress: string, entrypoint: string, calldata: string[] = []
): Promise<string[]> {
  // v10 returns a flat felt array.
  return (await snProvider.callContract({ contractAddress, entrypoint, calldata })) as string[];
}

/// A read that may not have happened.
///
/// `undefined` means the contract did not answer -- no address configured, a
/// missing entrypoint, a revert, an RPC that is down -- which is NOT the same
/// as answering zero. Collapsing the two is how an eligibility panel ends up
/// telling a registered holder they are "not yet mirrored": nothing asked, and
/// the default got rendered as a fact about them.
async function maybeFelts(
  contractAddress: string | undefined, entrypoint: string, calldata: string[] = []
): Promise<string[] | undefined> {
  if (!contractAddress) return undefined;
  try { return await callFelts(contractAddress, entrypoint, calldata); }
  catch { return undefined; }
}

const u256 = (felts: string[] | undefined): bigint =>
  felts ? BigInt(felts[0] ?? 0) + (BigInt(felts[1] ?? 0) << 128n) : 0n;

export type MirrorStatus = {
  /// Did the mirrored registry answer the question that decides the gate? When
  /// false every eligibility field below is a default, not a finding, and the
  /// caller must render unknown rather than a refusal.
  readable: boolean;
  identity: bigint;      // the EVM identity this holder is bound to, 0 if unbound
  /// Whether `identity` is a fact. Eligibility is keyed on the EVM account, so
  /// a registry with no `identity_of` is not a mirrored registry at all and
  /// "unbound" would be the wrong thing to conclude from its silence.
  identityKnown: boolean;
  verified: boolean;     // what the twin will actually enforce
  balance: bigint;
  pending: bigint;       // quarantined, claimable once eligible
  fresh: boolean;
  freshnessKnown: boolean;
  syncedAt: number;
  stalenessWindow: number;
  /// The one mirror flag a bridge-in's snapshot does not overwrite. Undefined
  /// when the read did not come back.
  globalPaused: boolean | undefined;
};

/// What the mirror currently says about a holder. `verified` is the
/// number that matters: it already folds in the binding, the record, the freeze
/// flag, the global pause and the staleness window.
///
/// Every read is optional and reports whether it happened. A mirrored registry
/// is the only contract that can answer these, and pointing them at anything
/// else -- a demo stand-in, an ERC-3643 identity registry that happens to share
/// an entrypoint NAME -- produces a confident wrong answer about a real holder.
/// So on a demo deployment the registry is not asked at all.
export async function mirrorStatus(asset: Asset, address: string): Promise<MirrorStatus> {
  const sn = asset.addresses.starknet!;
  const registry = IS_DEMO ? undefined : sn.registry;
  const [identityF, verifiedF, balanceF, pendingF, windowF, pausedF] = await Promise.all([
    maybeFelts(registry, 'identity_of', [address]),
    maybeFelts(registry, 'is_verified', [address]),
    maybeFelts(sn.token, 'balance_of', [address]),
    maybeFelts(IS_DEMO ? undefined : sn.gateway, 'pending_of', [address]),
    maybeFelts(registry, 'staleness_window', []),
    maybeFelts(registry, 'global_paused', []),
  ]);

  // `is_verified` is the call that decides the gate, so it is the one that
  // decides whether there is an answer to show at all.
  const readable = verifiedF !== undefined;
  const identity = identityF ? BigInt(identityF[0] ?? 0) : 0n;
  let syncedAt = 0;
  let fresh = false;
  let freshnessKnown = false;
  if (identityF && identity !== 0n) {
    // IdentityRecord: seq, synced_at, verified, frozen, country
    const record = await maybeFelts(registry, 'record', [identityF[0]]);
    if (record) syncedAt = Number(BigInt(record[1] ?? 0));
    const isFresh = await maybeFelts(registry, 'is_fresh', [identityF[0]]);
    if (isFresh) { fresh = BigInt(isFresh[0] ?? 0) === 1n; freshnessKnown = true; }
  }

  return {
    readable,
    identity,
    identityKnown: identityF !== undefined,
    verified: readable && BigInt(verifiedF![0] ?? 0) === 1n,
    balance: u256(balanceF),
    pending: u256(pendingF),
    fresh,
    freshnessKnown,
    syncedAt,
    stalenessWindow: windowF ? Number(BigInt(windowF[0] ?? 0)) : 0,
    globalPaused: pausedF ? BigInt(pausedF[0] ?? 0) === 1n : undefined,
  };
}

/// Who, if anyone, has claimed a note for pool delivery. A transfer is only
/// filled into a note whose claimed owner is the recipient, because the fill is
/// one-shot and note ids are public.
export async function noteOwner(asset: Asset, noteId: string): Promise<string> {
  const felts = await callFelts(asset.addresses.starknet!.gateway!, 'note_owner', [
    BigInt(noteId).toString(),
  ]).catch(() => ['0']);
  return felts[0] ?? '0';
}

/// The EVM identity a holder is bound to on the mirror (an EVM wallet is bound
/// to itself): 0n when unbound,
/// undefined when the registry did not answer -- silence is never "unbound".
export async function identityOf(asset: Asset, address: string): Promise<bigint | undefined> {
  if (IS_DEMO) return undefined;
  const felts = await maybeFelts(asset.addresses.starknet!.registry, 'identity_of', [address]);
  return felts ? BigInt(felts[0] ?? 0) : undefined;
}

/// Whether the mirror holds a fresh, verified eligibility record for
/// `evmAccount`. Undefined when the registry did not answer.
export async function identityFreshness(
  asset: Asset, evmAccount: string
): Promise<{ verified: boolean; fresh: boolean } | undefined> {
  if (IS_DEMO) return undefined;
  const registry = asset.addresses.starknet!.registry;
  const account = BigInt(evmAccount).toString();
  const [record, fresh] = await Promise.all([
    maybeFelts(registry, 'record', [account]),
    maybeFelts(registry, 'is_fresh', [account]),
  ]);
  if (!record || !fresh) return undefined;
  // IdentityRecord: seq, synced_at, verified, frozen, country
  const verified = BigInt(record[0] ?? 0) !== 0n
    && BigInt(record[2] ?? 0) === 1n && BigInt(record[3] ?? 0) === 0n;
  return { verified, fresh: BigInt(fresh[0] ?? 0) === 1n };
}

/// Whether the rules mirror holds fresh issuer rules for `evmAccount` and for
/// the token, for a rule-gated asset. `required` is false for any other kind,
/// and then the rest does not matter. `canHold` is what the issuer's fresh
/// rules say about the holder. Undefined when a contract did not answer.
export async function rulesFreshness(
  asset: Asset, evmAccount: string
): Promise<{ required: boolean; account: boolean; token: boolean; canHold: boolean } | undefined> {
  if (asset.addresses.evm?.kind !== 'rules') {
    return { required: false, account: true, token: true, canHold: true };
  }
  if (IS_DEMO) return undefined;
  const rules = asset.addresses.starknet?.rules;
  const registry = asset.addresses.starknet?.registry;
  if (!rules || !registry) return undefined;
  const [holder, token, window, block] = await Promise.all([
    // HolderRulesRecord: seq, synced_at, can_hold, frozen, is_investor, locked (u256)
    maybeFelts(rules, 'holder_rules', [BigInt(evmAccount).toString()]),
    // TokenRulesRecord: seq, synced_at, transfers_enabled, cap, full, strict, min (u256)
    maybeFelts(rules, 'token_rules', []),
    maybeFelts(registry, 'staleness_window', []),
    snProvider.getBlock('latest').catch(() => undefined),
  ]);
  if (!holder || !token || !window || !block) return undefined;
  const now = BigInt((block as { timestamp: number | string }).timestamp);
  const w = BigInt(window[0] ?? 0);
  const fresh = (seq: string | undefined, at: string | undefined) =>
    BigInt(seq ?? 0) !== 0n && (w === 0n || now <= BigInt(at ?? 0) + w);
  const account = fresh(holder[0], holder[1]);
  return {
    required: true,
    account,
    token: fresh(token[0], token[1]),
    canHold: account && BigInt(holder[2] ?? 0) === 1n && BigInt(holder[3] ?? 0) === 0n,
  };
}

export async function twinSupply(asset: Asset): Promise<bigint> {
  return u256(await callFelts(asset.addresses.starknet!.token!, 'total_supply', []).catch(() => ['0', '0']));
}

/// The LayerZero fee for a bridge back, in STRK. The gateway pays it from its
/// own balance; the holder signs a cap on it (`max_fee`) as part of the action.
export async function quoteBridgeBack(
  asset: Asset, amount: bigint, evmRecipient: string
): Promise<bigint> {
  const felts = await callFelts(asset.addresses.starknet!.gateway!, 'quote_bridge_back', [
    ...CallData.compile([uint256.bnToUint256(amount)]),
    BigInt(evmRecipient).toString(),
    RELEASE_GAS_LIMIT.toString(),
  ]);
  return u256(felts);
}

/// Does this asset's gateway take EVM wallets as holders? A gateway whose class
/// has the private way back (`privacy_invoke`) does: it binds an EVM wallet to
/// its own identity, lets a wallet's own bridge-in claim its note, and burns on
/// a proven pool invoke. One on an older class needs a Starknet account for all
/// three, so the app cannot use it. Asked of the class itself, once per class,
/// so any later gateway class that keeps the entrypoint keeps working.
/// Undefined when the gateway did not answer.
const classAnswers = new Map<string, Promise<boolean | undefined>>();

export async function supportsEvmHolders(asset: Asset): Promise<boolean | undefined> {
  const gateway = asset.addresses.starknet?.gateway;
  if (!gateway || IS_DEMO) return undefined;
  const hash = await snProvider.getClassHashAt(gateway).then((h) => String(h)).catch(() => undefined);
  if (hash === undefined) return undefined;
  const key = BigInt(hash).toString(16);
  if (!classAnswers.has(key)) {
    classAnswers.set(key, snProvider.getClass(hash).then((cls: any) => {
      const abi = typeof cls.abi === 'string' ? JSON.parse(cls.abi) : cls.abi;
      return JSON.stringify(abi).includes('"privacy_invoke"');
    }).catch(() => undefined));
  }
  return classAnswers.get(key)!;
}
