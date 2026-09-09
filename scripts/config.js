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
  NETWORKS,
  DEFAULT_EVM,
  DEFAULT_STARKNET,
  DEPLOYMENTS_DIR,
  deploymentPath,
  network,
};
