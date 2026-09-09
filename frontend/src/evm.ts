// The EVM leg: wallet connection, reads, and the two writes (approve, bridgeOut).

import { BrowserProvider, Contract, JsonRpcProvider, zeroPadValue, type Eip1193Provider } from 'ethers';
import { deployment, evmChain, EVM_RPC, DEFAULT_GAS_LIMIT } from './config';

const LOCKBOX_ABI = [
  'function quoteBridgeOut(uint256 amount, bytes32 snRecipient, uint128 gasLimit) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
  'function bridgeOut(uint256 amount, bytes32 snRecipient, uint128 gasLimit, address refundAddress) payable returns (bytes32)',
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

export async function tokenInfo(): Promise<TokenInfo> {
  const token = new Contract(deployment.evm!.token!, TOKEN_ABI, readProvider);
  // Fall back to the deployment's own symbol rather than a placeholder: if the
  // RPC is unreachable the twin's configured name is still the right answer.
  const fallbackSymbol = deployment.starknet?.symbol ?? 'RWA';
  const [symbol, decimals] = await Promise.all([
    token.symbol().catch(() => fallbackSymbol),
    token.decimals().catch(() => 18),
  ]);
  return { symbol: symbol || fallbackSymbol, decimals: Number(decimals) };
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
export async function evmStatus(account: string): Promise<EvmStatus> {
  const lockbox = deployment.evm!.lockbox!;
  const token = new Contract(deployment.evm!.token!, TOKEN_ABI, readProvider);
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

export async function quote(amount: bigint, recipient: string): Promise<bigint> {
  const lockbox = new Contract(deployment.evm!.lockbox!, LOCKBOX_ABI, readProvider);
  const fee = await lockbox.quoteBridgeOut(amount, snRecipientWord(recipient), DEFAULT_GAS_LIMIT);
  return fee.nativeFee ?? fee[0];
}

export async function approve(session: EvmSession, amount: bigint): Promise<string> {
  const signer = await session.provider.getSigner();
  const token = new Contract(deployment.evm!.token!, TOKEN_ABI, signer);
  const tx = await token.approve(deployment.evm!.lockbox!, amount);
  await tx.wait();
  return tx.hash;
}

export type BridgeResult = { hash: string; guid?: string };

export async function bridgeOut(
  session: EvmSession,
  amount: bigint,
  recipient: string,
  fee: bigint
): Promise<BridgeResult> {
  const signer = await session.provider.getSigner();
  const lockbox = new Contract(deployment.evm!.lockbox!, LOCKBOX_ABI, signer);
  const tx = await lockbox.bridgeOut(
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
