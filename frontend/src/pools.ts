// Which Veil pool a bridged asset lands in, and whether that pool is real.
//
// A Veil pool is MULTI-ASSET: one pool carries any number of ERC-3643 tokens.
// So the asset never implies the pool. Almost everyone wants the main Veil pool
// -- already deployed, already carrying assets -- which is the gateway's
// default and what a transfer that names no pool gets. An entity running its
// own pool names that one instead, by pasting its address.
//
// Pasting an address is the dangerous part, and it is why this file exists. A
// typo, a stale address from a chat message, or a token address pasted by
// mistake would otherwise send a real position at a contract that cannot
// receive it. The gateway would refuse and sweep the amount to the wallet, so
// nothing is lost -- but the user paid for a message, waited for it to cross,
// and did not get what they asked for.
//
// So the address is checked HERE, before the source chain is touched, against
// the two things that actually have to be true:
//
//   1. the factory deployed it. `create_pool` is the only way a Veil pool comes
//      into existence and it records the deployer, so a non-zero owner is proof
//      of a genuine pool. This is the same question the gateway asks on
//      arrival, asked early enough to be free.
//   2. the pool accepts THIS asset. Multi-asset does not mean every-asset: a
//      pool holds the tokens its owner allow-listed, and `fill_open_note`
//      checks. A real pool that has never heard of this token would take the
//      message and revert.
//   3. the twin will transfer to it. The pool PULLS the tokens with
//      `transfer_from`, and the twin asserts `is_verified(to)` on the way out
//      -- a pool is a Starknet contract with no EVM identity, so it holds the
//      twin only once registered in this asset's mirror. Genuine and
//      asset-carrying is not enough.
//
// None of these reads needs a wallet, so the check runs as the user types.

import { snProvider } from './starknet';
import { deployment } from './config';
import type { Asset } from './assets';

/// The main Veil pool: what the gateway uses when a transfer names none.
export function mainPool(asset: Asset): string | undefined {
  return asset.addresses.starknet?.pool ?? deployment.veil?.pool;
}

/// The factory that vouches for any other pool. Without it the gateway can only
/// reach its default, so the UI must not offer a custom address either.
export function poolFactory(): string | undefined {
  return deployment.veil?.factory;
}

export type PoolCheck =
  | { ok: true; pool: string; owner: string; isMain: boolean }
  | { ok: false; reason: PoolProblem; detail?: string };

export type PoolProblem =
  | 'malformed'      // not a Starknet address
  | 'no-factory'     // nothing deployed that could vouch for it
  | 'not-a-pool'     // the factory never created it
  | 'wrong-asset'    // a real pool that does not carry this token
  | 'not-a-holder'   // this asset's mirror has not registered the pool
  | 'unreachable';   // the RPC could not answer

export const POOL_PROBLEMS: Record<PoolProblem, string> = {
  malformed: 'That is not a Starknet address.',
  'no-factory': 'This deployment has no Veil factory, so only the main pool can be used.',
  'not-a-pool': 'No Veil pool exists at that address.',
  'wrong-asset': 'That pool does not carry this asset.',
  'not-a-holder': 'That pool is not registered to hold this asset yet. The issuer has to register it.',
  unreachable: 'Could not reach Starknet to check that pool.',
};

/// Starknet addresses are felts: at most 63 hex digits, and never zero.
export function normalisePoolAddress(input: string): string | undefined {
  const trimmed = input.trim();
  if (!/^0x[0-9a-fA-F]{1,63}$/.test(trimmed)) return undefined;
  let value: bigint;
  try {
    value = BigInt(trimmed);
  } catch {
    return undefined;
  }
  if (value === 0n) return undefined;
  return '0x' + value.toString(16);
}

const same = (a?: string, b?: string): boolean =>
  Boolean(a && b && BigInt(a) === BigInt(b));

/// One contract read. Injectable so the decision logic can be tested against
/// every way a chain can answer, without a chain.
export type PoolReader = (
  contractAddress: string, entrypoint: string, calldata: string[]
) => Promise<string[]>;

const rpcReader: PoolReader = async (contractAddress, entrypoint, calldata) =>
  (await snProvider.callContract({ contractAddress, entrypoint, calldata })) as string[];

/// Does a pool exist at this address, and will it take this asset?
///
/// Reads only. Safe to call on every keystroke.
export type CheckOptions = {
  /// Defaults to the live RPC.
  read?: PoolReader;
  /// Defaults to the deployment's VeilERC3643Factory.
  factory?: string;
};

export async function checkPool(
  asset: Asset, input: string, options: CheckOptions = {}
): Promise<PoolCheck> {
  const read = options.read ?? rpcReader;
  const pool = normalisePoolAddress(input);
  if (!pool) return { ok: false, reason: 'malformed' };

  const twin = asset.addresses.starknet?.token;
  const factory = options.factory ?? poolFactory();
  const isMain = same(pool, mainPool(asset));

  // The main pool is the operator's own setting on the gateway, not something a
  // message chose, so it does not need the factory's word. Still checked for
  // the asset below -- a misconfigured default is worth catching too.
  if (!isMain) {
    if (!factory) return { ok: false, reason: 'no-factory' };
  }

  let owner = '0x0';
  try {
    if (factory) {
      const returned = await read(factory, 'get_pool_owner', [pool]);
      owner = returned[0] ?? '0x0';
    }
  } catch {
    // An unknown address reads back zero rather than reverting, so a thrown
    // error here means the RPC or the factory address is wrong -- not that the
    // pool is bad. Saying so beats accusing the user's address.
    return { ok: false, reason: 'unreachable' };
  }

  if (!isMain && BigInt(owner) === 0n) return { ok: false, reason: 'not-a-pool' };

  // Multi-asset is not every-asset. Ask the pool itself.
  if (twin) {
    try {
      const allowed = await read(pool, 'is_token_allowed', [twin]);
      if (BigInt(allowed[0] ?? 0) === 0n) return { ok: false, reason: 'wrong-asset' };
    } catch {
      // A contract with no `is_token_allowed` is not a Veil pool. For the main
      // pool that means the deployment is misconfigured; for a pasted address it
      // means the address is wrong. Either way the transfer must not go.
      return { ok: false, reason: isMain ? 'unreachable' : 'not-a-pool' };
    }
  }

  // The pool pulls the tokens, and the twin refuses to send to an address its
  // mirror does not know. Registration is the issuer's call, so a pool can be
  // perfectly genuine and still not be able to receive this asset yet.
  const registry = asset.addresses.starknet?.registry;
  if (registry) {
    try {
      const verified = await read(registry, 'is_verified', [pool]);
      if (BigInt(verified[0] ?? 0) === 0n) return { ok: false, reason: 'not-a-holder' };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }

  return { ok: true, pool, owner, isMain };
}
