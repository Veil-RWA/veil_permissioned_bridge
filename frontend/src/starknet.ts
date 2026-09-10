// The Starknet leg: wallet connection, mirror/twin reads, bridging back, and
// claiming a quarantined balance.
//
// starknet.js v10 is required, not preferred. Live Sepolia serves RPC spec
// 0.10.x and v6 speaks 0.7 -- a v6 client cannot talk to the network at all.
//
// Wallet DISCOVERY is get-starknet's job, not ours. Enumerating
// `window.starknet_*` by hand picks whichever wallet happens to enumerate
// first, which is the wrong wallet as soon as someone has both Argent and
// Braavos; get-starknet shows the picker, remembers the choice, and knows about
// wallets that are installed but not yet injected. It is independent of the
// starknet.js version -- it hands back a `StarknetWindowObject`, which v10's
// own `WalletAccount` takes -- so the two compose exactly as they should.
// (`@starknet-io/get-starknet` is the maintained package; plain `get-starknet`
// is deprecated.)
//
// This mirrors veilx/app/src/main.ts, which is the reference for the flow.

import { connect as pickWallet, disconnect as dropWallet } from '@starknet-io/get-starknet';
import type { StarknetWindowObject } from '@starknet-io/get-starknet';
import { RpcProvider, WalletAccount, CallData, uint256 } from 'starknet';
import { STARKNET_RPC, DEFAULT_GAS_LIMIT, deployment } from './config';
import type { Asset } from './assets';

export const snProvider = new RpcProvider({ nodeUrl: STARKNET_RPC });

export type SnSession = { address: string; account: WalletAccount };

/// Chain ids as felts, so a wallet's answer can be compared whatever form it
/// comes back in.
const CHAIN_IDS: Record<string, string> = {
  'starknet-sepolia': '0x534e5f5345504f4c4941', // SN_SEPOLIA
  'starknet-mainnet': '0x534e5f4d41494e',       // SN_MAIN
};

const expectedChainId = (): string | undefined =>
  CHAIN_IDS[deployment.starknetNetwork ?? 'starknet-sepolia'];

/// Ask the wallet which chain it is on. Wallets differ: newer ones answer
/// `wallet_requestChainId`, older expose `chainId`, and the account can answer
/// from its own provider. Try in that order.
async function walletChainId(
  wallet: StarknetWindowObject, account: WalletAccount | null
): Promise<string | null> {
  const w = wallet as unknown as {
    request?: (a: { type: string }) => Promise<string>;
    chainId?: string;
  };
  try { if (w?.request) return await w.request({ type: 'wallet_requestChainId' }); }
  catch { /* fall through */ }
  if (w?.chainId) return w.chainId;
  // v10's WalletAccount has no getChainId of its own; the shared provider
  // answers for the node this app is pointed at, which is the same question.
  try { if (account) return (await snProvider.getChainId()) as unknown as string; }
  catch { /* fall through */ }
  return null;
}

const sameChain = (a: string, b: string): boolean => {
  try { return BigInt(a) === BigInt(b); } catch { return a === b; }
};

/// Did the user explicitly connect in this browser before?
///
/// get-starknet keeps its own "last wallet" memory that is shared across sites
/// and predates this app, so `neverAsk` alone will happily attach a wallet the
/// user never approved HERE. Gate it on our own flag instead.
const AUTOCONNECT = 'veil-bridge:autoconnect';
const mayAutoConnect = (): boolean => {
  try { return localStorage.getItem(AUTOCONNECT) === '1'; } catch { return false; }
};
const rememberConnect = (on: boolean): void => {
  try {
    if (on) localStorage.setItem(AUTOCONNECT, '1');
    else localStorage.removeItem(AUTOCONNECT);
  } catch { /* storage unavailable */ }
};

export class WrongChainError extends Error {
  constructor(public readonly got: string, public readonly want: string) {
    super(`Your wallet is on ${got}, but this deployment is on ${want}. Switch network and reconnect.`);
    this.name = 'WrongChainError';
  }
}

async function sessionFrom(wallet: StarknetWindowObject): Promise<SnSession> {
  const account = await WalletAccount.connect({ nodeUrl: STARKNET_RPC }, wallet as never);
  if (!account.address) throw new Error('Wallet did not return an address.');

  // A wallet on the wrong network is NOT connected. Showing it as connected
  // invites signing for a chain where none of these contracts exist -- and on
  // this bridge it would derive a viewing key against the wrong chain id, so
  // the note ids would be silently wrong too.
  const want = expectedChainId();
  const got = await walletChainId(wallet, account);
  if (want && got && !sameChain(got, want)) {
    throw new WrongChainError(got, deployment.starknetNetwork ?? 'starknet-sepolia');
  }

  return { address: account.address, account };
}

/// Open the picker and connect. `alwaysAsk` so the user chooses their wallet
/// rather than getting whichever one enumerated first.
export async function connectStarknet(): Promise<SnSession> {
  const wallet = await pickWallet({ modalMode: 'alwaysAsk', modalTheme: 'dark' });
  if (!wallet) throw new Error('No wallet selected.');
  const session = await sessionFrom(wallet);
  rememberConnect(true);
  return session;
}

/// Re-attach to an already-authorised wallet on load, without a prompt, so a
/// reload keeps the session instead of appearing to disconnect. Returns
/// undefined when there is nothing to restore -- never throws.
export async function restoreStarknet(): Promise<SnSession | undefined> {
  if (!mayAutoConnect()) return undefined;

  // The extension may not have injected yet when this runs, and `neverAsk`
  // simply answers "nothing" in that case. Asking once and giving up is why a
  // reload looked like a disconnect, so try again briefly before concluding
  // there is no wallet.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const wallet = await pickWallet({ modalMode: 'neverAsk' });
      if (wallet) return await sessionFrom(wallet);
    } catch {
      return undefined;   // authorised but locked, or on the wrong chain
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
}

export async function disconnectStarknet(): Promise<void> {
  rememberConnect(false);
  try { await dropWallet({ clearLastWallet: true }); } catch { /* already gone */ }
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
