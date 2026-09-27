#!/usr/bin/env node
// Replace one asset's gateway with the current VeilBridgeGateway class: EVM
// wallets as pool holders (self-binding, self-claimed notes,
// `register_note_evm`) and the `privacy_invoke` exit a Veil pool calls to
// bridge back to EVM.
//
//   (cd ../cairo && scarb build)
//   node --env-file=.env upgrade-gateway.js --asset gold [--float 20]
//   node --env-file=.env wire.js --asset gold
//
// This script:
//   1. deploys a new gateway with the old one's constructor inputs (owner,
//      endpoint, native token, registry, dst eid); the old address moves to
//      `starknet.previousGateways`;
//   2. registers the gateway as a local identity in the asset's registry: the
//      pool pays it the twin during an exit, and the twin only moves to
//      verified holders;
//   3. allows it as an adapter on the main pool (fills and exits);
//   4. sends it a native-token float (`--float`, STRK, default 20) for the
//      exit's LayerZero fee.
// wire.js then re-points registry, token, peers (both chains), pool and
// factory at it. Idempotent: every step reads first.

const fs = require('fs');
const path = require('path');
const { hash } = require('starknet');
const {
  parseArgs, loadDeployment, saveDeployment, requireEnv, starknetAccount, asFelts, assetSlot,
  step, done,
} = require('./lib');
const { network } = require('./config');

const h = (v) => '0x' + BigInt(v).toString(16);

async function main() {
  const args = parseArgs(process.argv);
  const net = network(args.starknet);
  const d = loadDeployment(args);
  const slot = assetSlot(d, args.asset);
  const sn = slot.starknet;
  const pool = d.veil?.pool;
  if (!sn?.gateway || !sn?.registry) throw new Error(`${args.asset}: no gateway/registry deployed`);
  if (!pool) throw new Error('no main pool in the deployment');
  const [rpc, address, key] = requireEnv('STARKNET_RPC_URL', 'STARKNET_ACCOUNT_ADDRESS', 'STARKNET_PRIVATE_KEY');
  const { provider, account } = starknetAccount(rpc, address, key);
  const call = async (to, entrypoint, calldata = []) =>
    asFelts(await provider.callContract({ contractAddress: to, entrypoint, calldata })).map(BigInt);
  const invoke = async (label, calls) => {
    const res = await account.execute(calls);
    await provider.waitForTransaction(res.transaction_hash);
    done(label, res.transaction_hash, `${net.explorer}/tx/${res.transaction_hash}`);
  };

  const dir = path.resolve(__dirname, '../cairo/target/dev');
  const sierra = JSON.parse(fs.readFileSync(path.join(dir, 'veil_bridge_VeilBridgeGateway.contract_class.json'), 'utf8'));
  const casm = JSON.parse(fs.readFileSync(path.join(dir, 'veil_bridge_VeilBridgeGateway.compiled_contract_class.json'), 'utf8'));
  const classHash = hash.computeContractClassHash(sierra);

  step(1, 4, `${args.asset}: a gateway on the current class`);
  const current = h((await provider.getClassHashAt(sn.gateway)));
  if (BigInt(current) === BigInt(classHash)) {
    done('already on it', sn.gateway);
  } else {
    const dec = await account.declareIfNot({ contract: sierra, casm });
    if (dec.transaction_hash) await provider.waitForTransaction(dec.transaction_hash);
    const old = sn.gateway;
    const calldata = [
      h((await call(old, 'owner'))[0]),
      h((await call(old, 'get_endpoint'))[0]),
      h((await call(old, 'native_token'))[0]),
      h(sn.registry),
      h((await call(old, 'dst_eid'))[0]),
    ];
    const res = await account.deployContract({ classHash, constructorCalldata: calldata });
    await provider.waitForTransaction(res.transaction_hash);
    sn.previousGateways = [...(sn.previousGateways ?? []), old];
    sn.gateway = res.contract_address;
    d.classes = { ...(d.classes ?? {}), VeilBridgeGateway: classHash };
    saveDeployment(args, d);
    done(`deployed (was ${old.slice(0, 12)}…)`, sn.gateway, `${net.explorer}/contract/${sn.gateway}`);
  }
  const gateway = sn.gateway;

  step(2, 4, 'registry: the gateway may hold the twin');
  if ((await call(sn.registry, 'local_identity', [gateway]))[0] === 1n) {
    done('already', gateway);
  } else {
    await invoke('set', [{ contractAddress: sn.registry, entrypoint: 'set_local_identity', calldata: [gateway, '1', '840'] }]);
  }

  step(3, 4, 'main pool: the gateway is an allowed adapter');
  if ((await call(pool, 'is_adapter_allowed', [gateway]))[0] === 1n) {
    done('already', pool);
  } else {
    await invoke('set', [{ contractAddress: pool, entrypoint: 'set_adapter_allowed', calldata: [gateway, '1'] }]);
  }

  step(4, 4, 'native float for exit fees');
  const native = h((await call(gateway, 'native_token'))[0]);
  const want = BigInt(Math.round(Number(args.float ?? 20) * 1e6)) * 10n ** 12n;
  const have = (await call(native, 'balance_of', [gateway]))[0];
  if (have >= want) {
    done('already', `${Number(have) / 1e18}`);
  } else {
    const top = want - have;
    await invoke(`sent ${Number(top) / 1e18}`, [
      { contractAddress: native, entrypoint: 'transfer', calldata: [gateway, h(top), '0x0'] },
    ]);
  }

  console.log(`\nnext: node --env-file=.env wire.js --asset ${args.asset}`);
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
