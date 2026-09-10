#!/usr/bin/env node
// Record an already-deployed contract set, without running the deploy scripts.
//
//   node set-addresses.js --asset gold \
//     --lockbox 0x... --token 0x... \
//     --registry 0x... --gateway 0x... --compliance 0x... --twin 0x... \
//     [--reader 0x...] [--wired] [--pool 0x...] [--factory 0x...]
//     [--prover https://...] [--master 0x...]
//
// --pool and --factory are Veil's, not the asset's: a Veil pool is multi-asset,
// so one pool serves every asset here. They default to the main Veil pool and
// the VeilERC3643Factory for the target network, and are recorded once at
// deployment level rather than per asset.
//
// For when the contracts were deployed by hand, or by someone else, and all you
// have is the addresses. Writes the same deployment file `deploy-evm.js` and
// `deploy-starknet.js` produce, so `wire.js`, `bridge.js` and the app all pick
// it up with no further steps.
//
// Validates shape before writing: an EVM address must be 20 bytes and a
// Starknet address must be a felt, because a transposed pair here produces
// failures deep inside a contract call rather than here where it is obvious.

const path = require('path');
const { network, veil } = require('./config');
const { parseArgs, loadDeployment, saveDeployment, assetSlot } = require('./lib');

const EVM_FIELDS = { lockbox: 'evm', token: 'evm', reader: 'evm' };
const SN_FIELDS = {
  registry: 'starknet', gateway: 'starknet', compliance: 'starknet', twin: 'starknet',
  pool: 'starknet', factory: 'starknet',
};

function assertEvm(name, value) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`--${name} must be a 20-byte EVM address, got "${value}"`);
  }
}

function assertStarknet(name, value) {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Error(`--${name} must be a Starknet felt address, got "${value}"`);
  }
  // A 20-byte value here is almost always an EVM address pasted into the wrong
  // slot -- Starknet addresses are effectively always longer.
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`--${name} looks like an EVM address (20 bytes). Did you swap two arguments?`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const deployment = loadDeployment(args);
  const slot = assetSlot(deployment, args.asset);

  const given = Object.keys(args).filter((k) => k in EVM_FIELDS || k in SN_FIELDS);
  if (!given.length) {
    throw new Error(
      'nothing to set. Pass at least one of: ' +
      [...Object.keys(EVM_FIELDS), ...Object.keys(SN_FIELDS)].map((f) => `--${f}`).join(' ')
    );
  }

  for (const name of given) {
    const value = args[name];
    if (name in EVM_FIELDS) assertEvm(name, value);
    else assertStarknet(name, value);
  }

  if (args.lockbox) slot.evm.lockbox = args.lockbox;
  if (args.token) slot.evm.token = args.token;
  if (args.reader) slot.evm.complianceReader = args.reader;
  if (args.registry) slot.starknet.registry = args.registry;
  if (args.gateway) slot.starknet.gateway = args.gateway;
  if (args.compliance) slot.starknet.compliance = args.compliance;
  if (args.twin) slot.starknet.token = args.twin;
  if (args.symbol) slot.starknet.symbol = args.symbol;

  // Veil is deployment-level: one pool carries every asset.
  const veilNet = veil(args.starknet);
  deployment.veil = { ...(deployment.veil ?? {}) };
  const pool = args.pool ?? deployment.veil.pool ?? veilNet.pool;
  const factory = args.factory ?? deployment.veil.factory ?? veilNet.factory;
  if (pool) { deployment.veil.pool = pool; slot.starknet.pool = pool; }
  if (factory) deployment.veil.factory = factory;
  // The prove-and-settle service, used to CREATE an open note. Without it the
  // app can fill a note but not make one.
  if (args.prover) deployment.veil.proverEndpoint = args.prover;
  if (args.master) deployment.veil.masterAddress = args.master;
  if (args.wired) slot.wired = { peers: true, links: true };

  const file = saveDeployment(args, deployment);

  const complete = Boolean(
    slot.evm.lockbox && slot.evm.token &&
    slot.starknet.registry && slot.starknet.gateway && slot.starknet.token
  );

  console.log(`asset        ${args.asset}`);
  console.log(`route        ${args.evm} (eid ${network(args.evm).eid}) -> ${args.starknet} (eid ${network(args.starknet).eid})`);
  console.log('');
  console.log('  evm.lockbox        ' + (slot.evm.lockbox || '(missing)'));
  console.log('  evm.token          ' + (slot.evm.token || '(missing)'));
  console.log('  evm.reader         ' + (slot.evm.complianceReader || '(none)'));
  console.log('  starknet.registry  ' + (slot.starknet.registry || '(missing)'));
  console.log('  starknet.gateway   ' + (slot.starknet.gateway || '(missing)'));
  console.log('  starknet.compliance ' + (slot.starknet.compliance || '(missing)'));
  console.log('  starknet.twin      ' + (slot.starknet.token || '(missing)'));
  console.log('  veil.pool          ' + (deployment.veil?.pool || '(none - wallet delivery only)'));
  console.log('  veil.factory       ' + (deployment.veil?.factory || '(none - only the main pool reachable)'));
  console.log('  veil.prover        ' + (deployment.veil?.proverEndpoint || '(none - cannot create notes)'));
  console.log('  veil.master        ' + (deployment.veil?.masterAddress || '(none - cannot create notes)'));
  console.log('');
  console.log(`written to ${path.relative(process.cwd(), file)}`);

  if (!complete) {
    console.log('\nINCOMPLETE. The app needs lockbox, token, registry, gateway and twin');
    console.log('before it will treat this asset as available.');
    process.exit(1);
  }
  if (!slot.wired || !slot.wired.peers) {
    console.log('\nNext: peers must be set on BOTH sides before any message can cross.');
    console.log(`  node wire.js --asset ${args.asset}`);
    console.log('  (or pass --wired here if they are already set)');
  } else {
    console.log('\nReady. Start the app with:  (cd ../frontend && npm run dev)');
  }
}

try {
  main();
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
