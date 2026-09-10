// The Starknet leg: wallet connection, mirror/twin reads, bridging back, and
// claiming a quarantined balance.
//
// starknet.js v10 is required, not preferred. Live Sepolia serves RPC spec
// 0.10.x and v6 speaks 0.7 -- a v6 client cannot talk to the network at all.
// v10 also ships its own `WalletAccount`, so wallet support needs no extra
// dependency; the only thing it does not do is discover the injected object,
// which is a dozen lines below.

import { RpcProvider, WalletAccount, CallData, uint256 } from 'starknet';
import { STARKNET_RPC, DEFAULT_GAS_LIMIT } from './config';
import type { Asset } from './assets';

export const snProvider = new RpcProvider({ nodeUrl: STARKNET_RPC });

export type SnSession = { address: string; account: WalletAccount };

type Injected = { id?: string; name?: string; icon?: string; version?: string };

/// Wallets inject themselves as `window.starknet_<id>`. This is what
/// get-starknet does internally; doing it here keeps the dependency count at
/// zero and avoids a library pinned to an older starknet.js.
export function availableWallets(): Array<{ key: string; label: string; provider: unknown }> {
  const found: Array<{ key: string; label: string; provider: unknown }> = [];
  const w = window as unknown as Record<string, Injected>;
  for (const key of Object.keys(w)) {
    if (!key.startsWith('starknet')) continue;
    const provider = w[key];
    if (!provider || typeof provider !== 'object') continue;
    // `window.starknet` is an alias for the last-used wallet; prefer the
    // explicit `starknet_x` entries so the user sees real names.
    if (key === 'starknet' && found.length) continue;
    found.push({ key, label: provider.name ?? key.replace('starknet_', ''), provider });
  }
  return found;
}

export async function connectStarknet(preferred?: string): Promise<SnSession> {
  const wallets = availableWallets();
  if (!wallets.length) {
    throw new Error('No Starknet wallet found. Install Argent X or Braavos.');
  }
  const chosen = preferred ? wallets.find((w) => w.key === preferred) ?? wallets[0] : wallets[0];
  const account = await WalletAccount.connect(
    { nodeUrl: STARKNET_RPC },
    chosen.provider as never
  );
  if (!account.address) throw new Error('Wallet did not return an address.');
  return { address: account.address, account };
}

async function callFelts(
  contractAddress: string, entrypoint: string, calldata: string[] = []
): Promise<string[]> {
  // v10 returns a flat felt array.
  return (await snProvider.callContract({ contractAddress, entrypoint, calldata })) as string[];
}

const u256 = (felts: string[]): bigint => BigInt(felts[0] ?? 0) + (BigInt(felts[1] ?? 0) << 128n);

export type MirrorStatus = {
  identity: bigint;      // the EVM account backing this wallet, 0 if unbound
  verified: boolean;     // what the twin will actually enforce
  balance: bigint;
  pending: bigint;       // quarantined, claimable once eligible
  fresh: boolean;
  syncedAt: number;
  stalenessWindow: number;
};

/// What the mirror currently says about a Starknet wallet. `verified` is the
/// number that matters: it already folds in the binding, the record, the freeze
/// flag, the global pause and the staleness window.
export async function mirrorStatus(asset: Asset, address: string): Promise<MirrorStatus> {
  const sn = asset.addresses.starknet!;
  const [identityF, verifiedF, balanceF, pendingF, windowF] = await Promise.all([
    callFelts(sn.registry!, 'identity_of', [address]).catch(() => ['0']),
    callFelts(sn.registry!, 'is_verified', [address]).catch(() => ['0']),
    callFelts(sn.token!, 'balance_of', [address]).catch(() => ['0', '0']),
    callFelts(sn.gateway!, 'pending_of', [address]).catch(() => ['0', '0']),
    callFelts(sn.registry!, 'staleness_window', []).catch(() => ['0']),
  ]);

  const identity = BigInt(identityF[0] ?? 0);
  let syncedAt = 0;
  let fresh = false;
  if (identity !== 0n) {
    try {
      // IdentityRecord: seq, synced_at, verified, frozen, country
      const record = await callFelts(sn.registry!, 'record', [identityF[0]]);
      syncedAt = Number(BigInt(record[1] ?? 0));
      fresh = BigInt((await callFelts(sn.registry!, 'is_fresh', [identityF[0]]))[0] ?? 0) === 1n;
    } catch { /* leave defaults */ }
  }

  return {
    identity,
    verified: BigInt(verifiedF[0] ?? 0) === 1n,
    balance: u256(balanceF),
    pending: u256(pendingF),
    fresh,
    syncedAt,
    stalenessWindow: Number(BigInt(windowF[0] ?? 0)),
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

/// Claim a note before bridging into it. Must be sent by the address the
/// transfer will name as recipient.
export async function registerNote(
  session: SnSession, asset: Asset, noteId: string
): Promise<string> {
  const res = await session.account.execute({
    contractAddress: asset.addresses.starknet!.gateway!,
    entrypoint: 'register_note',
    calldata: CallData.compile([BigInt(noteId).toString()]),
  });
  await snProvider.waitForTransaction(res.transaction_hash);
  return res.transaction_hash;
}

export async function twinSupply(asset: Asset): Promise<bigint> {
  return u256(await callFelts(asset.addresses.starknet!.token!, 'total_supply', []).catch(() => ['0', '0']));
}

/// The STRK the gateway must be approved for. Quoted from the real endpoint, so
/// this is the amount the wallet will actually be asked to approve.
export async function quoteBridgeBack(
  asset: Asset, amount: bigint, evmRecipient: string
): Promise<bigint> {
  const felts = await callFelts(asset.addresses.starknet!.gateway!, 'quote_bridge_back', [
    ...CallData.compile([uint256.bnToUint256(amount)]),
    BigInt(evmRecipient).toString(),
    DEFAULT_GAS_LIMIT.toString(),
  ]);
  return u256(felts);
}

/// Burn on Starknet and instruct the lockbox to release. Two calls in one
/// multicall: approve the gateway for the message fee, then bridge back. The
/// gateway pays the endpoint, which is why the approval goes to the gateway and
/// not to the endpoint itself.
export async function bridgeBack(
  session: SnSession,
  asset: Asset,
  amount: bigint,
  evmRecipient: string,
  fee: bigint,
  feeToken: string
): Promise<string> {
  const sn = asset.addresses.starknet!;
  const calls = [
    {
      contractAddress: feeToken,
      entrypoint: 'approve',
      calldata: CallData.compile([sn.gateway!, uint256.bnToUint256(fee)]),
    },
    {
      contractAddress: sn.gateway!,
      entrypoint: 'bridge_back',
      calldata: CallData.compile([
        uint256.bnToUint256(amount),
        BigInt(evmRecipient).toString(),
        {
          native_fee: uint256.bnToUint256(fee),
          lz_token_fee: uint256.bnToUint256(0n),
        },
        DEFAULT_GAS_LIMIT.toString(),
        session.address,
      ]),
    },
  ];
  const res = await session.account.execute(calls);
  await snProvider.waitForTransaction(res.transaction_hash);
  return res.transaction_hash;
}

/// Release a quarantined balance. Permissionless -- the funds can only go to
/// the recipient the original message named -- so anyone may pay the gas.
export async function claimPending(
  session: SnSession, asset: Asset, recipient: string
): Promise<string> {
  const res = await session.account.execute({
    contractAddress: asset.addresses.starknet!.gateway!,
    entrypoint: 'claim_pending',
    calldata: CallData.compile([recipient]),
  });
  await snProvider.waitForTransaction(res.transaction_hash);
  return res.transaction_hash;
}

/// The STRK balance the fee is paid from, so the UI can say "not enough STRK"
/// before the wallet does.
export async function feeTokenBalance(feeToken: string, address: string): Promise<bigint> {
  return u256(await callFelts(feeToken, 'balanceOf', [address]).catch(() => ['0', '0']));
}
