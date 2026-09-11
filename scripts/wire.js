#!/usr/bin/env node
// Wire both halves together. Idempotent: every step reads current on-chain
// state first and skips what is already correct, so re-running after a failure
// costs nothing but RPC calls.
//
//   node wire.js --asset gold [--evm ethereum-sepolia] [--starknet starknet-sepolia]
//
// Wires ONE asset's contract set. Each asset has its own lockbox, gateway and
// twin, so each needs its own wiring pass.
//
// Order matters in one place only: the peers must be set on BOTH sides before
// any message is sent, or the receiving side rejects it with ONLY_PEER. Setting
// one side and bridging immediately is the classic way to strand a message.

const { ethers } = require('ethers');

const { compile } = require('../evm/test/harness');
const { network, veil } = require('./config');
const {
  parseArgs, loadDeployment, saveDeployment, requireEnv, assetSlot, starknetPeer, evmPeer,
  peerCalldata, starknetAccount, feltToBigInt, step, done,
} = require('./lib');

const GATEWAY_ABI = [
  { type: 'function', name: 'set_local_identity', inputs: [{ name: 'sn_account', type: 'core::starknet::contract_address::ContractAddress' }, { name: 'allowed', type: 'core::bool' }, { name: 'country', type: 'core::integer::u16' }], outputs: [], state_mutability: 'external' },
  { type: 'function', name: 'set_peer', inputs: [{ name: 'eid', type: 'core::integer::u32' }, { name: 'peer', type: 'veil_bridge::lz::Bytes32' }], outputs: [], state_mutability: 'external' },
];

async function main() {
  const args = parseArgs(process.argv);
  const evmNet = network(args.evm);
  const snNet = network(args.starknet);
  const d = loadDeployment(args);
  const slot = assetSlot(d, args.asset);
  console.log(`asset        ${args.asset}`);

  for (const [k, v] of Object.entries({
    'evm.lockbox': slot.evm.lockbox,
    'starknet.registry': slot.starknet.registry,
    'starknet.gateway': slot.starknet.gateway,
    'starknet.compliance': slot.starknet.compliance,
    'starknet.token': slot.starknet.token,
  })) {
    if (!v) throw new Error(`${args.asset}: ${k} not deployed yet -- run deploy-evm.js and deploy-starknet.js with --asset ${args.asset} first`);
  }

  const [evmRpc, evmKey] = requireEnv('EVM_RPC_URL', 'EVM_PRIVATE_KEY');
  const [snRpc, snAccount, snKey] = requireEnv(
    'STARKNET_RPC_URL', 'STARKNET_ACCOUNT_ADDRESS', 'STARKNET_PRIVATE_KEY'
  );

  const provider = new ethers.JsonRpcProvider(evmRpc);
  const wallet = new ethers.Wallet(evmKey, provider);
  const lockbox = new ethers.Contract(slot.evm.lockbox, compile()['VeilERC3643Lockbox'].abi, wallet);

  const { provider: snProvider, account } = starknetAccount(snRpc, snAccount, snKey);

  slot.wired = slot.wired || {};

  async function invoke(label, contractAddress, entrypoint, calldata) {
    const res = await account.execute({ contractAddress, entrypoint, calldata });
    await account.provider.waitForTransaction(res.transaction_hash);
    done(label, res.transaction_hash, `${snNet.explorer}/tx/${res.transaction_hash}`);
  }

  async function call(contractAddress, entrypoint, calldata = []) {
    return snProvider.callContract({ contractAddress, entrypoint, calldata });
  }

  const asFelt = feltToBigInt;

  // ---- Starknet internal links -------------------------------------------
  step(1, 8, 'registry.set_gateway');
  if (asFelt(await call(slot.starknet.registry, 'gateway')) === BigInt(slot.starknet.gateway)) {
    done('already set', slot.starknet.gateway);
  } else {
    await invoke('tx', slot.starknet.registry, 'set_gateway', [slot.starknet.gateway]);
  }

  step(2, 8, 'token.set_gateway + token.set_compliance');
  if (asFelt(await call(slot.starknet.token, 'gateway')) === BigInt(slot.starknet.gateway)) {
    done('gateway already set', slot.starknet.gateway);
  } else {
    await invoke('tx', slot.starknet.token, 'set_gateway', [slot.starknet.gateway]);
  }
  if (asFelt(await call(slot.starknet.token, 'compliance')) === BigInt(slot.starknet.compliance)) {
    done('compliance already set', slot.starknet.compliance);
  } else {
    await invoke('tx', slot.starknet.token, 'set_compliance', [slot.starknet.compliance]);
  }

  step(3, 8, 'compliance.set_token');
  if (asFelt(await call(slot.starknet.compliance, 'token')) === BigInt(slot.starknet.token)) {
    done('already set', slot.starknet.token);
  } else {
    await invoke('tx', slot.starknet.compliance, 'set_token', [slot.starknet.token]);
  }

  step(4, 8, 'gateway.set_token');
  if (asFelt(await call(slot.starknet.gateway, 'token')) === BigInt(slot.starknet.token)) {
    done('already set', slot.starknet.token);
  } else {
    await invoke('tx', slot.starknet.gateway, 'set_token', [slot.starknet.token]);
  }

  // ---- Peers, both directions --------------------------------------------
  step(5, 8, `gateway.set_peer(${d.evmEid} -> lockbox)`);
  const wantEvmPeer = BigInt(slot.evm.lockbox);
  const havePeer = await call(slot.starknet.gateway, 'get_peer', [String(d.evmEid)]);
  const haveLow = BigInt(Array.isArray(havePeer) ? havePeer[0] : havePeer.result[0]);
  if (haveLow === wantEvmPeer) {
    done('already set', evmPeer(slot.evm.lockbox));
  } else {
    await invoke('tx', slot.starknet.gateway, 'set_peer',
      [String(d.evmEid), ...peerCalldata(slot.evm.lockbox)]);
  }

  step(6, 8, `lockbox.setPeer(${d.starknetEid} -> gateway)`);
  const want = starknetPeer(slot.starknet.gateway);
  const have = await lockbox.peers(d.starknetEid);
  if (have.toLowerCase() === want.toLowerCase()) {
    done('already set', want);
  } else {
    const tx = await lockbox.setPeer(d.starknetEid, want);
    await tx.wait();
    done('tx', tx.hash, `${evmNet.explorer}/tx/${tx.hash}`);
  }

  // ---- Veil: which pool this gateway delivers into -----------------------
  // A Veil pool is multi-asset, so this is NOT per-asset state in any real
  // sense: every asset points at the same main pool. It is set per gateway
  // because a gateway carries one asset.
  const veilNet = veil(args.starknet ?? d.starknetNetwork);
  const wantPool = args.pool ?? d.veil?.pool ?? veilNet.pool;
  const wantFactory = args.factory ?? d.veil?.factory ?? veilNet.factory;

  step(7, 8, 'gateway.set_pool (main Veil pool)');
  if (!wantPool) {
    done('skipped', 'no pool known for this network - wallet delivery only');
  } else if (asFelt(await call(slot.starknet.gateway, 'pool')) === BigInt(wantPool)) {
    done('already set', wantPool);
  } else {
    await invoke('tx', slot.starknet.gateway, 'set_pool', [wantPool]);
  }

  step(8, 8, 'gateway.set_factory (vouches for any other pool)');
  if (!wantFactory) {
    done('skipped', 'no factory known - only the default pool will be reachable');
  } else if (asFelt(await call(slot.starknet.gateway, 'factory')) === BigInt(wantFactory)) {
    done('already set', wantFactory);
  } else {
    await invoke('tx', slot.starknet.gateway, 'set_factory', [wantFactory]);
  }

  // A POOL IS A HOLDER, and the twin refuses to move to an address its mirror
  // has never heard of. `fill_open_note` pulls with `transfer_from(gateway ->
  // pool)`, so without this the pool reverts, the gateway burns back, and every
  // delivery quarantines with POOL_REVERTED -- the exact failure this flag was
  // documented to prevent while doing nothing at all.
  //
  // A pool has no EVM identity to mirror, so it is registered as a LOCAL
  // identity: infrastructure that may hold, not an investor. Defaults to the
  // pool being wired, since that is the one that has to work.
  const holders = [].concat(args.holder ?? [], wantPool ?? []).filter(Boolean);
  const seen = new Set();
  for (const holder of holders) {
    const key = BigInt(holder).toString();
    if (seen.has(key)) continue;
    seen.add(key);
    step(9, 9, `registry.set_local_identity(${holder.slice(0, 10)}… may hold the twin)`);
    const current = await call(slot.starknet.registry, 'local_identity', [holder]);
    if (asFelt(current) === 1n) {
      done('already a holder', holder);
    } else {
      await invoke('tx', slot.starknet.registry, 'set_local_identity', [holder, '1', '840']);
    }
  }

  // Recorded once at deployment level, not per asset, because one pool serves
  // every asset. The app reads it from here.
  if (wantPool || wantFactory) {
    d.veil = { ...(d.veil ?? {}) };
    if (wantPool) d.veil.pool = wantPool;
    if (wantFactory) d.veil.factory = wantFactory;
  }
  if (wantPool) slot.starknet.pool = wantPool;

  slot.wired.peers = true;
  slot.wired.links = true;
  saveDeployment(args, d);

  console.log('\nwired.');
  console.log('\nSTILL REQUIRED BEFORE ANY VALUE MOVES:');
  console.log(`  1. Issuer registers the lockbox as a verified identity:`);
  console.log(`       identityRegistry.registerIdentity(${slot.evm.lockbox}, ...)`);
  console.log(`     Without it bridgeOut reverts inside the token, not here.`);
  console.log(`  2. Replicate the token's compliance rules onto the twin:`);
  console.log(`       cd ../tools`);
  console.log(`       node export-compliance.js --rpc $EVM_RPC_URL --token ${slot.evm.token} \\`);
  console.log(`         ${slot.evm.complianceReader ? `--reader ${slot.evm.complianceReader} ` : ''}--out spec.json`);
  console.log(`       node apply-compliance.js --spec spec.json --compliance ${slot.starknet.compliance}`);
  console.log(`  3. Confirm the DVN/executor config for this pathway. Defaults apply if you`);
  console.log(`     set none; check them at https://layerzeroscan.com before mainnet.`);
  console.log(`\nthen:  node bridge.js --asset ${args.asset} --amount <n> --to <starknet address>`);
}

main().catch((e) => {
  console.error('\n' + String(e.message || e));
  process.exit(1);
});
