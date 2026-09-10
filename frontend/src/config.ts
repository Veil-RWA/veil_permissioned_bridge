// Deployment + network config for the app.
//
// Addresses come from ../deployments, copied in at build time by
// scripts/pull-deployment.mjs. Nothing is hardcoded here: the app renders a
// "not deployed" state rather than pointing at a stale address.

import raw from './deployment.json';

export type AssetDeployment = {
  evm?: { lockbox?: string; token?: string; complianceReader?: string };
  starknet?: {
    registry?: string;
    gateway?: string;
    compliance?: string;
    token?: string;
    name?: string;
    symbol?: string;
    stalenessWindow?: number;
  };
  wired?: { peers?: boolean; links?: boolean };
};

export type Deployment = {
  missing?: boolean;
  evmNetwork?: string;
  starknetNetwork?: string;
  evmEid?: number;
  starknetEid?: number;
  /// Per-asset contract sets, keyed by catalogue id. One lockbox and one twin
  /// each: assets are never pooled.
  assets?: Record<string, AssetDeployment>;
  /// Pre-catalogue single-asset deployments. Read by assets.ts as a fallback.
  evm?: AssetDeployment['evm'];
  starknet?: AssetDeployment['starknet'];
  wired?: { peers?: boolean; links?: boolean };
};

export const deployment = raw as Deployment;

/// True when at least one asset in the catalogue is fully deployed. The card
/// checks the SELECTED asset separately -- a deployment can carry gold and not
/// silver, and the UI has to say which.
export const isDeployed = Boolean(
  !deployment.missing &&
  ((deployment.assets && Object.keys(deployment.assets).length > 0) ||
    (deployment.evm?.lockbox && deployment.starknet?.gateway))
);

/// Chain ids the EVM wallet must be on for each supported deployment.
const EVM_CHAIN_IDS: Record<string, { id: number; hex: string; label: string }> = {
  'ethereum-sepolia': { id: 11155111, hex: '0xaa36a7', label: 'Ethereum Sepolia' },
  'ethereum-mainnet': { id: 1, hex: '0x1', label: 'Ethereum' },
};

const STARKNET_LABELS: Record<string, string> = {
  'starknet-sepolia': 'Starknet Sepolia',
  'starknet-mainnet': 'Starknet',
};

export const evmChain = EVM_CHAIN_IDS[deployment.evmNetwork ?? 'ethereum-sepolia'];
export const evmLabel = evmChain?.label ?? 'Ethereum';
export const starknetLabel = STARKNET_LABELS[deployment.starknetNetwork ?? 'starknet-sepolia'] ?? 'Starknet';

export const EVM_RPC = import.meta.env.VITE_EVM_RPC_URL
  ?? 'https://ethereum-sepolia-rpc.publicnode.com';
export const STARKNET_RPC = import.meta.env.VITE_STARKNET_RPC_URL
  ?? 'https://starknet-sepolia.drpc.org';

const testnet = (deployment.evmNetwork ?? '').includes('sepolia');
export const EXPLORER_EVM = testnet ? 'https://sepolia.etherscan.io' : 'https://etherscan.io';
export const EXPLORER_SN = testnet ? 'https://sepolia.voyager.online' : 'https://voyager.online';
export const LZ_SCAN = testnet ? 'https://testnet.layerzeroscan.com' : 'https://layerzeroscan.com';

/// Executor gas for lz_receive on Starknet. The mint path does a handful of
/// cross-contract calls (mirror write, binding, compliance check, mint), so it
/// needs materially more than a bare message.
export const DEFAULT_GAS_LIMIT = 400_000n;

/// STRK, the token the Starknet endpoint charges message fees in. Same address
/// on mainnet and Sepolia. `bridge_back` approves the GATEWAY for this, not the
/// endpoint: the gateway pays the endpoint on the caller's behalf.
export const STARKNET_FEE_TOKEN =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
