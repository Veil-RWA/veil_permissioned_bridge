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
    /// The Veil pool THIS asset's gateway defaults to -- what a transfer that
    /// names no pool gets. In practice the main Veil pool, the same one for
    /// every asset, because a pool is multi-asset. Absent means pool delivery
    /// is not configured and every transfer lands in a wallet.
    pool?: string;
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
  /// each -- the ESCROW is never shared, so one issuer's pause or compromise
  /// cannot reach another's holders. The Veil pool below is shared, which is a
  /// different thing: a pool holds many assets without mixing their books.
  assets?: Record<string, AssetDeployment>;
  /// Testnet faucet infrastructure, when the assets were deployed by
  /// `deploy-faucet.js` rather than by an issuer.
  faucet?: {
    /// Shared identity registry.
    registry?: string;
    /// Batches claimFor across every token, so "Get faucets" is one
    /// transaction rather than one per asset.
    router?: string;
  };
  /// Veil itself, which is not per-asset.
  veil?: {
    /// The main Veil pool. Where bridged assets land unless the user names
    /// another.
    pool?: string;
    /// VeilERC3643Factory. `create_pool` is the only way a pool exists and it
    /// records the deployer, so this is what tells a real pool from a typo.
    /// Without it the app offers only the main pool.
    factory?: string;
    /// SNIP-36 prove-and-settle service, used to CREATE an open note.
    proverEndpoint?: string;
    /// Account the prover submits settles from.
    masterAddress?: string;
  };
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

/// The SNIP-36 prove-and-settle service. Creating an open note runs
/// `create_open_note_derive` in the proven virtual block and submits
/// `create_open_note_settle` with its proof, and neither can happen in a
/// browser -- the prover does both.
///
/// No default: a hardcoded endpoint here would send a holder's proof to a host
/// nobody chose. Absent, the app says note creation is unavailable instead of
/// silently failing at the prover.
export const PROVER_ENDPOINT: string | undefined =
  import.meta.env.VITE_VEIL_PROVER_ENDPOINT ?? deployment.veil?.proverEndpoint;

/// Account the prover submits the settle from. The browser cannot sign a
/// settle, so there is no per-user key here -- same arrangement as veilx/app.
export const PROVER_MASTER_ADDRESS: string | undefined =
  import.meta.env.VITE_VEIL_MASTER_ADDRESS ?? deployment.veil?.masterAddress;

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
