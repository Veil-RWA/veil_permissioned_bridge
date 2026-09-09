#!/usr/bin/env node
// Deploy the Starknet half: mirror, gateway, compliance and the bridged twin.
//
//   node deploy-starknet.js [--starknet starknet-sepolia] [--staleness 86400]
//                           [--name "Bridged AAPL"] [--symbol bAAPL]
//
// Declares each class if it is not already declared, then deploys. Resumable:
// every address is written to the deployment file as soon as it exists, so a
// failure at step 4 does not mean paying for steps 1-3 again.
//
// Run `scarb build` in ../cairo first -- this reads the Sierra and CASM from
// ../cairo/target/dev.

const fs = require('fs');
const path = require('path');
const { Account, RpcProvider, CallData, hash, byteArray } = require('starknet');
const { network } = require('./config');
const { parseArgs, loadDeployment, saveDeployment, requireEnv, step, done } = require('./lib');

const TARGET = path.join(__dirname, '..', 'cairo', 'target', 'dev');

function artifact(contract) {
  const sierraPath = path.join(TARGET, `veil_bridge_${contract}.contract_class.json`);
  const casmPath = path.join(TARGET, `veil_bridge_${contract}.compiled_contract_class.json`);
  if (!fs.existsSync(sierraPath)) {
    throw new Error(`missing ${path.basename(sierraPath)} -- run: (cd ../cairo && scarb build)`);
  }
  return {
    sierra: JSON.parse(fs.readFileSync(sierraPath, 'utf8')),
    casm: JSON.parse(fs.readFileSync(casmPath, 'utf8')),
  };
}

async function declareIfNeeded(account, contract, deployment) {
  deployment.starknet.classes = deployment.starknet.classes || {};
  if (deployment.starknet.classes[contract]) {
    return deployment.starknet.classes[contract];
  }
  const { sierra, casm } = artifact(contract);
  const classHash = hash.computeContractClassHash(sierra);
  try {
    await account.getClassByHash(classHash);
    console.log(`      class already declared  ${classHash}`);
  } catch (_) {
    console.log(`      declaring...`);
    const res = await account.declare({ contract: sierra, casm });
    await account.waitForTransaction(res.transaction_hash);
    console.log(`      declared                ${classHash}`);
  }
  deployment.starknet.classes[contract] = classHash;
  return classHash;
}

async function deployContract(account, classHash, calldata) {
  const res = await account.deployContract({ classHash, constructorCalldata: calldata });
  await account.waitForTransaction(res.transaction_hash);
  return res.contract_address;
}

async function main() {
  const args = parseArgs(process.argv);
  const net = network(args.starknet);
  if (net.kind !== 'starknet') throw new Error(`${args.starknet} is not a Starknet network`);

  const [rpc, accountAddress, key] = requireEnv(
    'STARKNET_RPC_URL', 'STARKNET_ACCOUNT_ADDRESS', 'STARKNET_PRIVATE_KEY'
  );
  const provider = new RpcProvider({ nodeUrl: rpc });
  const account = new Account(provider, accountAddress, key);

  const deployment = loadDeployment(args);
  // Expiry in seconds. A day is a starting point, not a recommendation: it is
  // the maximum time a revocation on the source chain can go unenforced here.
  const staleness = Number(args.staleness || 86400);
  const name = args.name || 'Bridged RWA';
  const symbol = args.symbol || 'bRWA';

  console.log(`network      ${args.starknet} (eid ${net.eid})`);
  console.log(`account      ${accountAddress}`);
  console.log(`endpoint     ${net.endpoint}`);
  console.log(`fee token    ${net.nativeToken}`);
  console.log(`staleness    ${staleness}s`);

  step(1, 4, 'VeilMirroredRegistry');
  if (deployment.starknet.registry) {
    done('already deployed', deployment.starknet.registry);
  } else {
    const classHash = await declareIfNeeded(account, 'VeilMirroredRegistry', deployment);
    saveDeployment(args, deployment);
    const address = await deployContract(account, classHash, [accountAddress, staleness]);
    deployment.starknet.registry = address;
    deployment.starknet.stalenessWindow = staleness;
    saveDeployment(args, deployment);
    done('deployed', address, `${net.explorer}/contract/${address}`);
  }

  step(2, 4, 'VeilBridgeGateway');
  if (deployment.starknet.gateway) {
    done('already deployed', deployment.starknet.gateway);
  } else {
    const classHash = await declareIfNeeded(account, 'VeilBridgeGateway', deployment);
    saveDeployment(args, deployment);
    // dst_eid is the EVM side: where the gateway sends its unlock messages.
    const address = await deployContract(account, classHash, [
      accountAddress,
      net.endpoint,
      net.nativeToken,
      deployment.starknet.registry,
      deployment.evmEid,
    ]);
    deployment.starknet.gateway = address;
    saveDeployment(args, deployment);
    done('deployed', address, `${net.explorer}/contract/${address}`);
  }

  step(3, 4, 'MirroredCompliance');
  if (deployment.starknet.compliance) {
    done('already deployed', deployment.starknet.compliance);
  } else {
    const classHash = await declareIfNeeded(account, 'MirroredCompliance', deployment);
    saveDeployment(args, deployment);
    const address = await deployContract(account, classHash, [
      accountAddress,
      deployment.starknet.registry,
    ]);
    deployment.starknet.compliance = address;
    saveDeployment(args, deployment);
    done('deployed', address, `${net.explorer}/contract/${address}`);
  }

  step(4, 4, 'VeilBridgedERC3643');
  if (deployment.starknet.token) {
    done('already deployed', deployment.starknet.token);
  } else {
    const classHash = await declareIfNeeded(account, 'VeilBridgedERC3643', deployment);
    saveDeployment(args, deployment);
    const calldata = CallData.compile([
      byteArray.byteArrayFromString(name),
      byteArray.byteArrayFromString(symbol),
      accountAddress,
      deployment.starknet.registry,
      deployment.starknet.compliance,
    ]);
    const address = await deployContract(account, classHash, calldata);
    deployment.starknet.token = address;
    deployment.starknet.name = name;
    deployment.starknet.symbol = symbol;
    saveDeployment(args, deployment);
    done('deployed', address, `${net.explorer}/contract/${address}`);
  }

  const file = saveDeployment(args, deployment);
  console.log(`\nwritten to ${path.relative(process.cwd(), file)}`);
  console.log('\nnext:');
  console.log('  node wire.js       # peers, gateway/token/compliance links, delegate');
}

main().catch((e) => {
  console.error('\n' + String(e.message || e));
  process.exit(1);
});
