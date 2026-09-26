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
    pool: '0x3d1e717b761ea66b915669b4990568c3d77ed3179cab997d2b77ccccc5182b3',
    factory: '0x462126c275889892df53f5902c4db2a9c90333414ab3f1660b3bb2b3b154541',
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

/// Circle's CCTP V2 and USDC per network, for the cash leg (deploy-cash.js).
/// From Circle's developer docs, read 2026-09-26: "CCTP Starknet contracts and
/// interfaces", "EVM Contract addresses" and "USDC contract addresses". Pinned
/// like the endpoints: a script that followed whatever a page said at run time
/// would route real USDC through it.
const CCTP = {
  'starknet-sepolia': {
    domain: 25,
    usdc: '0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343',
    tokenMessenger: '0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370',
    messageTransmitter: '0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8',
  },
  'starknet-mainnet': {
    domain: 25,
    usdc: '0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb',
    tokenMessenger: '0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a',
    messageTransmitter: '0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183',
  },
  'ethereum-sepolia': {
    domain: 0,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  },
  'ethereum-mainnet': {
    domain: 0,
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  },
};

function cctp(networkName) {
  const c = CCTP[networkName];
  if (!c) throw new Error(`no CCTP addresses pinned for "${networkName}"`);
  return c;
}

module.exports = {
  CCTP,
  cctp,
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
