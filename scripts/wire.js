#!/usr/bin/env node
// Wire both halves together. Idempotent: every step reads current on-chain
// state first and skips what is already correct, so re-running after a failure
// costs nothing but RPC calls.
//
//   node wire.js --asset gold [--adapter 0x<delivery adapter>]
//                [--evm ethereum-sepolia] [--starknet starknet-sepolia]
//
// --adapter points the gateway at the contract that fills open notes in a Veil
// pool, so pool-bound transfers arrive confidential. Optional: with none set,
// every transfer lands in the recipient's wallet.
//
// Wires ONE asset's contract set. Each asset has its own lockbox, gateway and
// twin, so each needs its own wiring pass.
//
// Order matters in one place only: the peers must be set on BOTH sides before
// any message is sent, or the receiving side rejects it with ONLY_PEER. Setting
// one side and bridging immediately is the classic way to strand a message.

const { ethers } = require('ethers');
const { Account, RpcProvider, Contract, CallData } = require('starknet');
const { compile } = require('../evm/test/harness');
const { network } = require('./config');
const {
  parseArgs, loadDeployment, saveDeployment, requireEnv, assetSlot, starknetPeer, evmPeer,
  peerCalldata, step, done,
} = require('./lib');

const GATEWAY_ABI = [
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

  const snProvider = new RpcProvider({ nodeUrl: snRpc });
  const account = new Account(snProvider, snAccount, snKey);

  slot.wired = slot.wired || {};

  async function invoke(label, contractAddress, entrypoint, calldata) {
    const res = await account.execute({ contractAddress, entrypoint, calldata });
    await account.waitForTransaction(res.transaction_hash);
    done(label, res.transaction_hash, `${snNet.explorer}/tx/${res.transaction_hash}`);
  }

  async function call(contractAddress, entrypoint, calldata = []) {
    return snProvider.callContract({ contractAddress, entrypoint, calldata });
  }

  const asFelt = (r) => BigInt(Array.isArray(r) ? r[0] : r.result ? r.result[0] : r);

  // ---- Starknet internal links -------------------------------------------
  step(1, 6, 'registry.set_gateway');
  if (asFelt(await call(slot.starknet.registry, 'gateway')) === BigInt(slot.starknet.gateway)) {
    done('already set', slot.starknet.gateway);
  } else {
    await invoke('tx', slot.starknet.registry, 'set_gateway', [slot.starknet.gateway]);
  }

  step(2, 6, 'token.set_gateway + token.set_compliance');
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

  step(3, 6, 'compliance.set_token');
  if (asFelt(await call(slot.starknet.compliance, 'token')) === BigInt(slot.starknet.token)) {
    done('already set', slot.starknet.token);
  } else {
    await invoke('tx', slot.starknet.compliance, 'set_token', [slot.starknet.token]);
  }

  step(4, 6, 'gateway.set_token');
  if (asFelt(await call(slot.starknet.gateway, 'token')) === BigInt(slot.starknet.token)) {
    done('already set', slot.starknet.token);
  } else {
    await invoke('tx', slot.starknet.gateway, 'set_token', [slot.starknet.token]);
  }

  // ---- Peers, both directions --------------------------------------------
  step(5, 6, `gateway.set_peer(${d.evmEid} -> lockbox)`);
  const wantEvmPeer = BigInt(slot.evm.lockbox);
  const havePeer = await call(slot.starknet.gateway, 'get_peer', [String(d.evmEid)]);
  const haveLow = BigInt(Array.isArray(havePeer) ? havePeer[0] : havePeer.result[0]);
  if (haveLow === wantEvmPeer) {
    done('already set', evmPeer(slot.evm.lockbox));
  } else {
    await invoke('tx', slot.starknet.gateway, 'set_peer',
      [String(d.evmEid), ...peerCalldata(slot.evm.lockbox)]);
  }

  if (args.adapter) {
    step(6, 7, 'gateway.set_delivery_adapter');
    if (asFelt(await call(slot.starknet.gateway, 'delivery_adapter')) === BigInt(args.adapter)) {
      done('already set', args.adapter);
    } else {
      await invoke('tx', slot.starknet.gateway, 'set_delivery_adapter', [args.adapter]);
      slot.starknet.deliveryAdapter = args.adapter;
    }
  }

  step(args.adapter ? 7 : 6, args.adapter ? 7 : 6, `lockbox.setPeer(${d.starknetEid} -> gateway)`);
  const want = starknetPeer(slot.starknet.gateway);
  const have = await lockbox.peers(d.starknetEid);
  if (have.toLowerCase() === want.toLowerCase()) {
    done('already set', want);
  } else {
    const tx = await lockbox.setPeer(d.starknetEid, want);
    await tx.wait();
    done('tx', tx.hash, `${evmNet.explorer}/tx/${tx.hash}`);
  }

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
