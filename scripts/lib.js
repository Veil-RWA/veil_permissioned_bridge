// Shared helpers for the deployment scripts.

const fs = require('fs');
const path = require('path');
const { DEPLOYMENTS_DIR, deploymentPath, network, DEFAULT_EVM, DEFAULT_STARKNET } = require('./config');

function parseArgs(argv) {
  const out = { evm: DEFAULT_EVM, starknet: DEFAULT_STARKNET };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'yes' || key === 'y') {
      out.yes = true;
      continue;
    }
    out[key] = argv[++i];
  }
  return out;
}

function loadDeployment(args) {
  const file = deploymentPath(args.evm, args.starknet);
  if (!fs.existsSync(file)) {
    return {
      evmNetwork: args.evm,
      starknetNetwork: args.starknet,
      evmEid: network(args.evm).eid,
      starknetEid: network(args.starknet).eid,
      evm: {},
      starknet: {},
      wired: {},
    };
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveDeployment(args, data) {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const file = deploymentPath(args.evm, args.starknet);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(
      `missing environment: ${missing.join(', ')}\n` +
      `  copy .env.example to .env and fill it in, then: set -a && . ./.env && set +a`
    );
  }
  return names.map((n) => process.env[n]);
}

/// A Starknet address as LayerZero's 32-byte peer word.
const starknetPeer = (address) => '0x' + BigInt(address).toString(16).padStart(64, '0');

/// An EVM address as the same word: 20 bytes, left-padded.
const evmPeer = (address) => '0x' + BigInt(address).toString(16).padStart(64, '0');

/// Cairo takes a Bytes32 as a u256, i.e. two felts (low, high).
function peerCalldata(address) {
  const v = BigInt(address);
  return [(v % (1n << 128n)).toString(), (v >> 128n).toString()];
}

function step(n, total, text) {
  console.log(`\n[${n}/${total}] ${text}`);
}

function done(label, value, explorer) {
  console.log(`      ${label.padEnd(22)} ${value}`);
  if (explorer) console.log(`      ${''.padEnd(22)} ${explorer}`);
}

module.exports = {
  parseArgs,
  loadDeployment,
  saveDeployment,
  requireEnv,
  starknetPeer,
  evmPeer,
  peerCalldata,
  step,
  done,
};
