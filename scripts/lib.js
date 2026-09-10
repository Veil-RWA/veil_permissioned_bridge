// Shared helpers for the deployment scripts.

const fs = require('fs');
const path = require('path');
const {
  DEPLOYMENTS_DIR, deploymentPath, network, DEFAULT_EVM, DEFAULT_STARKNET, ASSET_IDS,
} = require('./config');

function parseArgs(argv) {
  const out = { evm: DEFAULT_EVM, starknet: DEFAULT_STARKNET, asset: 'gold' };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'yes' || key === 'y') {
      out.yes = true;
      continue;
    }
    const value = argv[++i];
    // Repeating a flag collects it, so --holder can be given several times.
    if (key in out && key !== 'evm' && key !== 'starknet' && key !== 'asset') {
      out[key] = [].concat(out[key], value);
    } else {
      out[key] = value;
    }
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
      assets: {},
    };
  }
  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  loaded.assets = loaded.assets || {};
  return loaded;
}

function saveDeployment(args, data) {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const file = deploymentPath(args.evm, args.starknet);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

/// The contract set for one asset, created on first use. Every script writes
/// here rather than at the top level, so a deployment can carry gold without
/// silver and the app can say which.
function assetSlot(deployment, id) {
  if (!ASSET_IDS.includes(id)) {
    throw new Error(`unknown --asset "${id}". known: ${ASSET_IDS.join(', ')}`);
  }
  deployment.assets = deployment.assets || {};
  const slot = deployment.assets[id] || (deployment.assets[id] = {});
  slot.evm = slot.evm || {};
  slot.starknet = slot.starknet || {};
  slot.wired = slot.wired || {};
  return slot;
}

/// A `fetch` built on Node's http/https modules.
///
/// starknet.js calls global `fetch`. Some sandboxes and CI images have it
/// disabled or unroutable while the http module still works (ethers uses http,
/// which is why it keeps working where starknet.js does not). Set
/// STARKNET_HTTP_FETCH=1 to route RPC through http instead. Harmless anywhere
/// global fetch already works, so it is opt-in rather than automatic.
function httpFetch(url, init = {}) {
  const { request } = require(String(url).startsWith('https') ? 'https' : 'http');
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: init.method || 'GET', headers: init.headers || {} },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers: { get: (k) => res.headers[String(k).toLowerCase()] },
            text: async () => body,
            json: async () => JSON.parse(body),
          })
        );
      }
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/// Build a Starknet provider + account.
///
/// starknet.js v10 takes an options OBJECT here; v6 took positional arguments.
/// Passing the old positional form silently reads the provider as the options
/// bag, so `nodeUrl` comes back undefined ("Using default public node url") and
/// the address is undefined a moment later. One helper so that mistake cannot
/// be made three times.
///
/// v10 is required, not preferred: live Sepolia serves RPC spec 0.10.x and
/// starknet.js v6 speaks 0.7. A v6 client cannot talk to the network at all.
function starknetAccount(rpcUrl, address, privateKey) {
  const { Account, RpcProvider } = require('starknet');
  const options = { nodeUrl: rpcUrl };
  if (process.env.STARKNET_HTTP_FETCH === '1') options.baseFetch = httpFetch;
  const provider = new RpcProvider(options);
  const account = new Account({ provider, address, signer: privateKey });
  return { provider, account };
}

/// `provider.callContract` returns a flat felt array in v10.
function asFelts(result) {
  return Array.isArray(result) ? result : result.result ?? [];
}

const feltToBigInt = (result) => BigInt(asFelts(result)[0] ?? 0);

/// Starknet u256 is two felts, low first.
const u256FromFelts = (result) => {
  const f = asFelts(result);
  return BigInt(f[0] ?? 0) + (BigInt(f[1] ?? 0) << 128n);
};

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
  assetSlot,
  starknetAccount,
  httpFetch,
  asFelts,
  feltToBigInt,
  u256FromFelts,
  loadDeployment,
  saveDeployment,
  requireEnv,
  starknetPeer,
  evmPeer,
  peerCalldata,
  step,
  done,
};
