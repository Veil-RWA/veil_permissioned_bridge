// The EVM leg: wallet connection, reads, and the two writes (approve, bridgeOut).

import { BrowserProvider, Contract, JsonRpcProvider, zeroPadValue, type Eip1193Provider } from 'ethers';
import { evmChain, EVM_RPC, DEFAULT_GAS_LIMIT } from './config';
import type { Asset } from './assets';

const LOCKBOX_ABI = [
  'function quoteBridgeOut(uint256 amount, bytes32 snRecipient, uint128 gasLimit) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
  'function bridgeOut(uint256 amount, bytes32 snRecipient, uint128 gasLimit, address refundAddress) payable returns (bytes32)',
  'function bridgeOutToPool(uint256 amount, bytes32 snRecipient, bytes32 noteId, uint128 gasLimit, address refundAddress) payable returns (bytes32)',
  'function totalEscrowed() view returns (uint256)',
  'function claimable(address) view returns (uint256)',
  'event BridgedOut(address indexed sender, bytes32 indexed snRecipient, uint256 amount, uint64 seq, bytes32 guid)',
];

const TOKEN_ABI = [
  'function identityRegistry() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function paused() view returns (bool)',
  'function isFrozen(address) view returns (bool)',
];

const REGISTRY_ABI = [
  'function isVerified(address) view returns (bool)',
  'function investorCountry(address) view returns (uint16)',
];

declare global {
  interface Window { ethereum?: Eip1193Provider & { on?: Function; removeListener?: Function }; }
}

export const readProvider = new JsonRpcProvider(EVM_RPC);

export type EvmSession = { address: string; provider: BrowserProvider };

export async function connectEvm(): Promise<EvmSession> {
  if (!window.ethereum) {
    throw new Error('No EVM wallet found. Install MetaMask or another injected wallet.');
  }
  const provider = new BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);

  // Prompt a switch rather than silently transacting on the wrong chain, which
  // would fail deep inside the contract with an unhelpful revert.
  const net = await provider.getNetwork();
  if (evmChain && Number(net.chainId) !== evmChain.id) {
    try {
      await provider.send('wallet_switchEthereumChain', [{ chainId: evmChain.hex }]);
    } catch {
      throw new Error(`Switch your wallet to ${evmChain.label} and try again.`);
    }
  }

  const signer = await provider.getSigner();
  return { address: await signer.getAddress(), provider };
}

export type TokenInfo = { symbol: string; decimals: number };

export async function tokenInfo(asset: Asset): Promise<TokenInfo> {
  if (!asset.available) return { symbol: asset.symbol, decimals: asset.decimals };
  const token = new Contract(asset.addresses.evm!.token!, TOKEN_ABI, readProvider);
  // Fall back to the catalogue rather than a placeholder: if the RPC is
  // unreachable, the asset's own ticker is still the right answer.
  const [symbol, decimals] = await Promise.all([
    token.symbol().catch(() => asset.symbol),
    token.decimals().catch(() => asset.decimals),
  ]);
  return { symbol: symbol || asset.symbol, decimals: Number(decimals) };
}

export type EvmStatus = {
  balance: bigint;
  allowance: bigint;
  verified: boolean;
  frozen: boolean;
  paused: boolean;
  lockboxRegistered: boolean;
  country: number;
};

/// Everything the UI needs to explain, before a user commits gas, whether this
/// transfer will actually work. The lockbox registration check is the one people
/// trip over: T-REX verifies the RECIPIENT of a transfer, and on a bridge-out
/// that is the lockbox.
export async function evmStatus(asset: Asset, account: string): Promise<EvmStatus> {
  const lockbox = asset.addresses.evm!.lockbox!;
  const token = new Contract(asset.addresses.evm!.token!, TOKEN_ABI, readProvider);
  const registryAddress: string = await token.identityRegistry();
  const registry = new Contract(registryAddress, REGISTRY_ABI, readProvider);

  const [balance, allowance, verified, lockboxRegistered, country, frozen, paused] =
    await Promise.all([
      token.balanceOf(account).catch(() => 0n),
      token.allowance(account, lockbox).catch(() => 0n),
      registry.isVerified(account).catch(() => false),
      registry.isVerified(lockbox).catch(() => false),
      registry.investorCountry(account).then(Number).catch(() => 0),
      token.isFrozen(account).catch(() => false),
      token.paused().catch(() => false),
    ]);

  return { balance, allowance, verified, frozen, paused, lockboxRegistered, country };
}

export const snRecipientWord = (starknetAddress: string): string =>
  zeroPadValue('0x' + BigInt(starknetAddress).toString(16).padStart(64, '0'), 32);

export async function quote(asset: Asset, amount: bigint, recipient: string): Promise<bigint> {
  const lockbox = new Contract(asset.addresses.evm!.lockbox!, LOCKBOX_ABI, readProvider);
  const fee = await lockbox.quoteBridgeOut(amount, snRecipientWord(recipient), DEFAULT_GAS_LIMIT);
  return fee.nativeFee ?? fee[0];
}

export async function approve(session: EvmSession, asset: Asset, amount: bigint): Promise<string> {
  const signer = await session.provider.getSigner();
  const token = new Contract(asset.addresses.evm!.token!, TOKEN_ABI, signer);
  const tx = await token.approve(asset.addresses.evm!.lockbox!, amount);
  await tx.wait();
  return tx.hash;
}

export type BridgeResult = { hash: string; guid?: string };
export type Delivery = 'wallet' | 'pool';

export async function bridgeOut(
  session: EvmSession,
  asset: Asset,
  amount: bigint,
  recipient: string,
  fee: bigint,
  delivery: Delivery = 'wallet',
  noteId = ''
): Promise<BridgeResult> {
  const signer = await session.provider.getSigner();
  const lockbox = new Contract(asset.addresses.evm!.lockbox!, LOCKBOX_ABI, signer);
  // Same message either way -- MINT is fixed width -- so the quote holds.
  const tx = delivery === 'pool'
    ? await lockbox.bridgeOutToPool(
        amount, snRecipientWord(recipient), zeroPadValue('0x' + BigInt(noteId).toString(16).padStart(64, '0'), 32),
        DEFAULT_GAS_LIMIT, session.address, { value: fee }
      )
    : await lockbox.bridgeOut(
        amount, snRecipientWord(recipient), DEFAULT_GAS_LIMIT, session.address, { value: fee }
      );
  const receipt = await tx.wait();

  let guid: string | undefined;
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = lockbox.interface.parseLog(log);
      if (parsed?.name === 'BridgedOut') guid = parsed.args.guid as string;
    } catch { /* not ours */ }
  }
  return { hash: tx.hash, guid };
}
