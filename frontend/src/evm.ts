// The EVM leg: wallet connection, reads, and the two writes (approve, bridgeOut).
//
// Discovery is EIP-6963, not `window.ethereum`. The legacy property is a single
// slot that every installed wallet overwrites, so with more than one installed
// the user gets whichever won that race rather than the one they meant. EIP-6963
// replaces it with a handshake: the page dispatches `eip6963:requestProvider`,
// each wallet answers with `eip6963:announceProvider` carrying its own provider
// and identity, and the user picks. `window.ethereum` stays as the fallback for
// wallets too old to announce.

import { BrowserProvider, Contract, JsonRpcProvider, zeroPadValue, type Eip1193Provider } from 'ethers';
import { evmChain, EVM_RPC, EXPLORER_EVM, DEFAULT_GAS_LIMIT } from './config';
import type { Asset } from './assets';

const LOCKBOX_ABI = [
  'function quoteBridgeOut(uint256 amount, bytes32 snRecipient, uint128 gasLimit) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
  'function bridgeOut(uint256 amount, bytes32 snRecipient, bytes32 noteId, bytes32 pool, uint128 gasLimit, address refundAddress) payable returns (bytes32)',
  'function totalEscrowed() view returns (uint256)',
  'function claimable(address) view returns (uint256)',
  'function claim(address recipient) returns (uint256)',
  'event BridgedOut(address indexed sender, uint256 amount, uint64 seq, bytes32 guid)',
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

const FAUCET_ABI = [
  'function claim() returns (uint256)',
  'function faucetAmount() view returns (uint256)',
  'function lastClaimed(address) view returns (uint256)',
  'function hasClaimed(address) view returns (bool)',
  'function faucetCooldown() view returns (uint256)',
];

const ROUTER_ABI = [
  'function claimAll(address[] tokens, address recipient) returns (uint256)',
];

const REGISTRY_ABI = [
  'function isVerified(address) view returns (bool)',
  'function investorCountry(address) view returns (uint16)',
];

declare global {
  interface Window { ethereum?: Eip1193Provider & { on?: Function; removeListener?: Function }; }
}

export const readProvider = new JsonRpcProvider(EVM_RPC);

export type EvmSession = {
  address: string;
  provider: BrowserProvider;
  /// Which wallet this is, so the UI can name it and a reload can find it again.
  wallet: EvmWallet;
};

/// One announced wallet. `rdns` is the stable identity (e.g. "io.metamask");
/// `uuid` changes per page load, so it is not what we remember.
export type EvmWallet = { rdns: string; name: string; icon: string };

type ProviderDetail = { info: EvmWallet & { uuid: string }; provider: Eip1193Provider };

const announced = new Map<string, ProviderDetail>();

// Start listening immediately: a wallet may announce before anything calls
// `discoverEvmWallets`, and the spec's whole point is that either order works.
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (event: Event) => {
    const detail = (event as CustomEvent<ProviderDetail>).detail;
    if (detail?.info?.rdns) announced.set(detail.info.rdns, detail);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/// Every wallet that has announced itself, plus the legacy injected one when
/// nothing announced at all.
export function discoverEvmWallets(): EvmWallet[] {
  // Ask again: wallets injected after the first request still answer.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  }
  const list = [...announced.values()].map((d) => d.info);
  if (!list.length && typeof window !== 'undefined' && window.ethereum) {
    return [{ rdns: LEGACY_RDNS, name: 'Injected wallet', icon: '' }];
  }
  return list;
}

const LEGACY_RDNS = 'legacy.injected';

function providerFor(rdns: string): Eip1193Provider | undefined {
  if (rdns === LEGACY_RDNS) return window.ethereum;
  return announced.get(rdns)?.provider;
}

/// Remember WHICH wallet, so a reload reconnects to the same one silently.
const LAST_WALLET = 'veil-bridge:evm-wallet';
const rememberWallet = (rdns: string | null): void => {
  try {
    if (rdns) localStorage.setItem(LAST_WALLET, rdns);
    else localStorage.removeItem(LAST_WALLET);
  } catch { /* storage unavailable */ }
};
const lastWallet = (): string | null => {
  try { return localStorage.getItem(LAST_WALLET); } catch { return null; }
};

/// Put the wallet on the chain this deployment lives on.
///
/// A wallet that has never heard of the chain answers 4902, which is a request
/// for the chain's details rather than a refusal -- so supply them and retry
/// instead of telling the user to go and do it by hand.
async function ensureChain(provider: BrowserProvider): Promise<void> {
  if (!evmChain) return;
  const net = await provider.getNetwork();
  if (Number(net.chainId) === evmChain.id) return;
  try {
    await provider.send('wallet_switchEthereumChain', [{ chainId: evmChain.hex }]);
  } catch (e: any) {
    const code = e?.code ?? e?.error?.code ?? e?.data?.originalError?.code;
    if (code === 4001) throw new Error(`Staying on the wrong network. Switch to ${evmChain.label} to bridge.`);
    if (code === -32002) {
      throw new Error('Your wallet already has a network request open. Check the wallet window.');
    }
    if (code !== 4902) {
      throw new Error(`Switch your wallet to ${evmChain.label} and try again.`);
    }
    await provider.send('wallet_addEthereumChain', [{
      chainId: evmChain.hex,
      chainName: evmChain.label,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: [EVM_RPC],
      blockExplorerUrls: [EXPLORER_EVM],
    }]);
  }
}

async function sessionFor(rdns: string, prompt: boolean): Promise<EvmSession | undefined> {
  const injected = providerFor(rdns);
  if (!injected) return undefined;
  const provider = new BrowserProvider(injected);

  // `eth_accounts` never prompts: it answers only for an already-authorised
  // wallet, which is what a silent restore needs.
  let accounts: string[];
  try {
    accounts = prompt
      ? await provider.send('eth_requestAccounts', [])
      : await provider.send('eth_accounts', []);
  } catch (e: any) {
    const code = e?.code ?? e?.error?.code ?? e?.data?.originalError?.code;
    // -32002: a request is ALREADY open. This is the usual reason a connect
    // button looks dead -- the wallet popup is behind the browser window, and
    // asking again does nothing but queue another one.
    if (code === -32002) {
      throw new Error('Your wallet already has a connection request open. Check the wallet window.');
    }
    // 4001: the user dismissed it. Not an error worth a red banner, but it must
    // not look like the button did nothing either.
    if (code === 4001) throw new Error('Connection request was rejected.');
    throw e;
  }
  if (!accounts?.length) return undefined;

  await ensureChain(provider);
  const signer = await provider.getSigner();
  const info = announced.get(rdns)?.info;
  return {
    address: await signer.getAddress(),
    provider,
    wallet: info ?? { rdns, name: 'Injected wallet', icon: '' },
  };
}

export async function connectEvm(rdns?: string): Promise<EvmSession> {
  const wallets = discoverEvmWallets();
  if (!wallets.length) {
    throw new Error('No EVM wallet found. Install MetaMask or another injected wallet.');
  }
  const chosen = rdns ?? (wallets.length === 1 ? wallets[0].rdns : undefined);
  if (!chosen) throw new PickEvmWalletError(wallets);

  const session = await sessionFor(chosen, true);
  if (!session) throw new Error('Wallet did not return an account.');
  rememberWallet(chosen);
  return session;
}

/// More than one wallet is installed, so the user has to say which. Thrown
/// rather than guessing -- picking one for them is how the wrong account signs.
export class PickEvmWalletError extends Error {
  constructor(public readonly wallets: EvmWallet[]) {
    super('Choose a wallet');
    this.name = 'PickEvmWalletError';
  }
}

/// Wait for a specific wallet to announce itself.
///
/// At page load the extension may not have injected yet, so the request this
/// module dispatched on import can go unanswered and `announced` is still empty
/// when a restore runs. Asking once and giving up is why a reload looked like a
/// disconnect. Re-ask, and give the wallet a moment to answer.
function waitForProvider(rdns: string, timeoutMs = 1500): Promise<boolean> {
  if (providerFor(rdns)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (found: boolean): void => {
      if (done) return;
      done = true;
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      clearInterval(retry);
      clearTimeout(giveUp);
      resolve(found);
    };
    const onAnnounce = (): void => { if (providerFor(rdns)) finish(true); };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    // Re-ask periodically: a wallet injected after our first request only
    // answers a new one.
    const retry = setInterval(() => {
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      if (providerFor(rdns)) finish(true);
    }, 150);
    const giveUp = setTimeout(() => finish(Boolean(providerFor(rdns))), timeoutMs);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  });
}

/// Reconnect on load without a prompt. Never throws.
export async function restoreEvm(): Promise<EvmSession | undefined> {
  const rdns = lastWallet();
  if (!rdns) return undefined;
  if (!(await waitForProvider(rdns))) return undefined;
  try { return await sessionFor(rdns, false); } catch { return undefined; }
}

export function disconnectEvm(): void {
  rememberWallet(null);
}

/// Tell the app when the wallet switches account or network underneath it.
/// Without this the page keeps showing the old address and signs with the new.
export function watchEvmWallet(
  session: EvmSession, onChange: () => void
): () => void {
  const injected = providerFor(session.wallet.rdns) as unknown as {
    on?: (e: string, h: (...a: unknown[]) => void) => void;
    removeListener?: (e: string, h: (...a: unknown[]) => void) => void;
  };
  if (!injected?.on) return () => {};
  const handler = () => onChange();
  injected.on('accountsChanged', handler);
  injected.on('chainChanged', handler);
  return () => {
    injected.removeListener?.('accountsChanged', handler);
    injected.removeListener?.('chainChanged', handler);
  };
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

/// Stock the connected wallet with every faucet asset, in ONE transaction.
///
/// An EOA cannot batch calls, so the router does it: `claimAll` calls
/// `claimFor(recipient)` on each token and SKIPS any that refuses, which is what
/// makes a second visit work when one asset is still on cooldown.
///
/// Falls back to a single `claim()` when no router is deployed -- one prompt for
/// the selected asset is better than no faucet at all.
export async function claimFaucets(
  session: EvmSession, tokens: string[], router?: string
): Promise<{ hash: string; batched: boolean }> {
  const signer = await session.provider.getSigner();
  if (router && tokens.length > 1) {
    const contract = new Contract(router, ROUTER_ABI, signer);
    const tx = await contract.claimAll(tokens, session.address);
    await tx.wait();
    return { hash: tx.hash, batched: true };
  }
  const contract = new Contract(tokens[0], FAUCET_ABI, signer);
  const tx = await contract.claim();
  await tx.wait();
  return { hash: tx.hash, batched: false };
}

/// Is a faucet configured on this token at all? `faucetAmount` of 0 disables it,
/// and a token that is not a faucet has no such function.
export async function faucetAmount(token: string): Promise<bigint> {
  const contract = new Contract(token, FAUCET_ABI, readProvider);
  return await contract.faucetAmount().catch(() => 0n);
}

/// A release that arrived while the recipient was ineligible is held here.
/// Nothing is lost; it stays claimable once the registry accepts them again.
export async function claimableOf(asset: Asset, account: string): Promise<bigint> {
  if (!asset.available) return 0n;
  const lockbox = new Contract(asset.addresses.evm!.lockbox!, LOCKBOX_ABI, readProvider);
  return await lockbox.claimable(account).catch(() => 0n);
}

/// Permissionless: the funds can only go to the recipient the message named,
/// so anyone may pay the gas to release them.
export async function claimHeld(
  session: EvmSession, asset: Asset, recipient: string
): Promise<string> {
  const signer = await session.provider.getSigner();
  const lockbox = new Contract(asset.addresses.evm!.lockbox!, LOCKBOX_ABI, signer);
  const tx = await lockbox.claim(recipient);
  await tx.wait();
  return tx.hash;
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

export async function bridgeOut(
  session: EvmSession,
  asset: Asset,
  amount: bigint,
  recipient: string,
  fee: bigint,
  noteId: string,
  /// Which Veil pool. Undefined means the gateway's default -- the main pool --
  /// which is what almost every transfer wants. A pool is multi-asset, so this
  /// is never implied by the asset.
  pool?: string
): Promise<BridgeResult> {
  const signer = await session.provider.getSigner();
  const lockbox = new Contract(asset.addresses.evm!.lockbox!, LOCKBOX_ABI, signer);
  const word = (v: string) => zeroPadValue('0x' + BigInt(v).toString(16).padStart(64, '0'), 32);
  const ZERO_WORD = zeroPadValue('0x00', 32);
  // Same message width either way, so the quote holds for both.
  // One entrypoint: a bridge-in always lands in a Veil pool note.
  const tx = await lockbox.bridgeOut(
    amount, snRecipientWord(recipient), word(noteId), pool ? word(pool) : ZERO_WORD,
    DEFAULT_GAS_LIMIT, session.address, { value: fee }
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
