// The Starknet leg: wallet connection, mirror/twin reads, and bridging back.

import { connect as starknetConnect } from 'get-starknet';
import { RpcProvider, Contract, CallData, uint256 } from 'starknet';
import { deployment, STARKNET_RPC, DEFAULT_GAS_LIMIT } from './config';

export const snProvider = new RpcProvider({ nodeUrl: STARKNET_RPC });

export type SnSession = { address: string; account: any };

export async function connectStarknet(): Promise<SnSession> {
  const wallet = await starknetConnect({ modalMode: 'alwaysAsk' });
  if (!wallet) throw new Error('No Starknet wallet selected.');
  if (!wallet.isConnected) await wallet.enable?.();
  const address = wallet.selectedAddress ?? wallet.account?.address;
  if (!address) throw new Error('Starknet wallet did not return an address.');
  return { address, account: wallet.account };
}

async function callFelts(contractAddress: string, entrypoint: string, calldata: string[] = []) {
  const res: any = await snProvider.callContract({ contractAddress, entrypoint, calldata });
  return (Array.isArray(res) ? res : res.result) as string[];
}

const u256 = (felts: string[]): bigint => BigInt(felts[0]) + (BigInt(felts[1] ?? 0) << 128n);

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
export async function mirrorStatus(address: string): Promise<MirrorStatus> {
  const sn = deployment.starknet!;
  const [identityF, verifiedF, balanceF, pendingF, windowF] = await Promise.all([
    callFelts(sn.registry!, 'identity_of', [address]).catch(() => ['0']),
    callFelts(sn.registry!, 'is_verified', [address]).catch(() => ['0']),
    callFelts(sn.token!, 'balance_of', [address]).catch(() => ['0', '0']),
    callFelts(sn.gateway!, 'pending_of', [address]).catch(() => ['0', '0']),
    callFelts(sn.registry!, 'staleness_window', []).catch(() => ['0']),
  ]);

  const identity = BigInt(identityF[0]);
  let syncedAt = 0;
  let fresh = false;
  if (identity !== 0n) {
    try {
      // IdentityRecord: seq, synced_at, verified, frozen, country
      const record = await callFelts(sn.registry!, 'record', [identityF[0]]);
      syncedAt = Number(BigInt(record[1] ?? 0));
      const freshF = await callFelts(sn.registry!, 'is_fresh', [identityF[0]]);
      fresh = BigInt(freshF[0]) === 1n;
    } catch { /* leave defaults */ }
  }

  return {
    identity,
    verified: BigInt(verifiedF[0]) === 1n,
    balance: u256(balanceF),
    pending: u256(pendingF),
    fresh,
    syncedAt,
    stalenessWindow: Number(BigInt(windowF[0])),
  };
}

export async function twinSupply(): Promise<bigint> {
  return u256(await callFelts(deployment.starknet!.token!, 'total_supply', []).catch(() => ['0', '0']));
}

/// Quote the return trip. The gateway asks the real endpoint, so this is the
/// actual STRK the wallet must approve.
export async function quoteBridgeBack(amount: bigint, evmRecipient: string): Promise<bigint> {
  const felts = await callFelts(deployment.starknet!.gateway!, 'quote_bridge_back', [
    ...CallData.compile([uint256.bnToUint256(amount)]),
    BigInt(evmRecipient).toString(),
    DEFAULT_GAS_LIMIT.toString(),
  ]);
  return u256(felts);
}

/// Burn on Starknet and instruct the lockbox to release. Two calls in one
/// multicall: approve the gateway for the message fee, then bridge back. The
/// gateway pays the endpoint, which is why the approval goes to the gateway.
export async function bridgeBack(
  session: SnSession,
  amount: bigint,
  evmRecipient: string,
  fee: bigint,
  feeToken: string
): Promise<string> {
  const sn = deployment.starknet!;
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
        { native_fee: uint256.bnToUint256(fee), lz_token_fee: uint256.bnToUint256(0n) },
        DEFAULT_GAS_LIMIT.toString(),
        session.address,
      ]),
    },
  ];
  const res = await session.account.execute(calls);
  await snProvider.waitForTransaction(res.transaction_hash);
  return res.transaction_hash;
}

export async function claimPending(session: SnSession, recipient: string): Promise<string> {
  const res = await session.account.execute({
    contractAddress: deployment.starknet!.gateway!,
    entrypoint: 'claim_pending',
    calldata: CallData.compile([recipient]),
  });
  await snProvider.waitForTransaction(res.transaction_hash);
  return res.transaction_hash;
}

export { Contract as StarknetContract };
