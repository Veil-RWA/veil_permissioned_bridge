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
import { STARKNET_RPC, RELEASE_GAS_LIMIT, deployment, IS_DEMO } from './config';
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

/// Whether the mirror holds fresh issuer rules for `evmAccount` and for the
/// token. `required` is false for an asset whose mirror enforces no rules, and
/// then the other two do not matter. Undefined when the registry did not answer.
export async function rulesFreshness(
  asset: Asset, evmAccount: string
): Promise<{ required: boolean; account: boolean; token: boolean } | undefined> {
  // Only a rules lockbox (kinds `rules` and `securitize`) pushes rules. The
  // mirror of any other asset has none to hold.
  const kind = asset.addresses.evm?.kind;
  if (kind !== 'rules' && kind !== 'securitize') {
    return { required: false, account: true, token: true };
  }
  if (IS_DEMO) return undefined;
  const registry = asset.addresses.starknet!.registry;
  const [required, account, token] = await Promise.all([
    maybeFelts(registry, 'rules_required', []),
    maybeFelts(registry, 'account_rules_fresh', [BigInt(evmAccount).toString()]),
    maybeFelts(registry, 'token_rules_fresh', []),
  ]);
  if (!required || !account || !token) return undefined;
  const yes = (f: string[]) => BigInt(f[0] ?? 0) === 1n;
  return { required: yes(required), account: yes(account), token: yes(token) };
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

/// Does this asset's gateway take EVM wallets as holders? Only a gateway on the
/// current class does: it binds an EVM wallet to its own identity, lets a
/// wallet's own bridge-in claim its note, and carries the private way back
/// (`privacy_invoke`). One on an older class needs a Starknet account for all
/// three, so the app cannot use it. Undefined when the gateway did not answer.
const gatewayClass = new Map<string, Promise<string | undefined>>();

export async function supportsEvmHolders(asset: Asset): Promise<boolean | undefined> {
  const gateway = asset.addresses.starknet?.gateway;
  if (!gateway || IS_DEMO) return undefined;
  if (!gatewayClass.has(gateway)) {
    gatewayClass.set(gateway, snProvider.getClassHashAt(gateway).then((h) => String(h)).catch(() => undefined));
  }
  const hash = await gatewayClass.get(gateway)!;
  if (hash === undefined) return undefined;
  const current = deployment.classes?.VeilBridgeGateway;
  if (current) return BigInt(hash) === BigInt(current);
  // No class recorded: ask the class itself.
  try {
    const cls: any = await snProvider.getClass(hash);
    const abi = typeof cls.abi === 'string' ? JSON.parse(cls.abi) : cls.abi;
    return JSON.stringify(abi).includes('"privacy_invoke"');
  } catch {
    return undefined;
  }
}
