// Network constants and deployment paths.
//
// Endpoint ids and addresses are from LayerZero's metadata API
// (https://metadata.layerzero-api.com/v1/metadata/deployments), verified
// 2026-09. They are immutable per LayerZero's own docs, so they are pinned here
// rather than fetched at deploy time -- a bridge that silently repoints at a
// different endpoint because an API changed is worse than one that fails.

const path = require('path');

const NETWORKS = {
  'ethereum-sepolia': {
    kind: 'evm',
    eid: 40161,
    endpoint: '0x6edce65403992e310a62460808c4b910d972f10f',
    explorer: 'https://sepolia.etherscan.io',
  },
  'ethereum-mainnet': {
    kind: 'evm',
    eid: 30101,
    endpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    explorer: 'https://etherscan.io',
  },
  'starknet-sepolia': {
    kind: 'starknet',
    eid: 40500,
    endpoint: '0x0316d70a6e0445a58c486215fac8ead48d3db985acde27efca9130da4c675878',
    // STRK, the token the Starknet endpoint charges fees in.
    nativeToken: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    explorer: 'https://sepolia.voyager.online',
  },
  // Local starknet-devnet, for smoke-testing the deploy scripts before spending
  // testnet gas. There is no LayerZero endpoint on devnet, so `endpoint` is a
  // placeholder: contracts deploy and wire, but no message can cross.
  'starknet-devnet': {
    kind: 'starknet',
    eid: 40500,
    endpoint: '0x0316d70a6e0445a58c486215fac8ead48d3db985acde27efca9130da4c675878',
    nativeToken: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    explorer: 'http://127.0.0.1:5050',
    local: true,
  },
  'starknet-mainnet': {
    kind: 'starknet',
    eid: 30500,
    endpoint: '0x0524e065abff21d225fb7b28f26ec2f48314ace6094bc085f0a7cf1dc2660f68',
    nativeToken: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    explorer: 'https://voyager.online',
  },
};

/// Default pairing. Override with --evm / --starknet.
const DEFAULT_EVM = 'ethereum-sepolia';
const DEFAULT_STARKNET = 'starknet-sepolia';

/// Catalogue ids, kept in step with frontend/src/assets.ts. One lockbox and one
/// twin per asset -- the ESCROW is never shared, so each id gets its own set.
///
/// The Veil pool on the far side is the opposite and is NOT per asset: one pool
/// carries any number of them. See VEIL below.
const ASSET_IDS = ['gold', 'silver', 'tbill', 'credit', 'estate'];

/// Veil itself, per Starknet network. Not per asset: a Veil pool is
/// multi-asset, so every asset this bridge carries lands in the same pool
/// unless the sender names another.
///
/// `pool` is the MAIN pool -- already deployed and already carrying assets --
/// and is what a gateway defaults to. `factory` is the VeilERC3643Factory:
/// `create_pool` is the only way a pool exists and it records the deployer, so
/// this is what lets the gateway tell a real pool from an address someone
/// pasted, without an operator-maintained allowlist.
///
/// Public on-chain addresses, overridable with --pool / --factory.
const VEIL = {
  'starknet-sepolia': {
    pool: '0x12808521ab5f277d84eb430f2d59ff8753e91947b43fcf9aea341b38481a80a',
    factory: '0x244b26034b77cd3bbafe6a506ec177e7981bf0620021f3082813fc22a40cbe8',
  },
};

/// The main pool and factory for a Starknet network, or an empty object when
/// Veil is not deployed there yet.
function veil(starknetNetwork) {
  return VEIL[starknetNetwork] ?? {};
}

const DEPLOYMENTS_DIR = path.join(__dirname, '..', 'deployments');

/// Every script reads and writes this one file, so a half-finished deploy can
/// be resumed rather than restarted -- which matters when step 3 of 8 fails and
/// the first two cost real gas.
function deploymentPath(evmNetwork, starknetNetwork) {
  return path.join(DEPLOYMENTS_DIR, `${evmNetwork}__${starknetNetwork}.json`);
}

function network(name) {
  const n = NETWORKS[name];
  if (!n) {
    throw new Error(`unknown network "${name}". known: ${Object.keys(NETWORKS).join(', ')}`);
  }
  return n;
}

module.exports = {
  VEIL,
  veil,
  NETWORKS,
  ASSET_IDS,
  DEFAULT_EVM,
  DEFAULT_STARKNET,
  DEPLOYMENTS_DIR,
  deploymentPath,
  network,
};
