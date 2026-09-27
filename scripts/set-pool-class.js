#!/usr/bin/env node
// Declare the current VeilERC3643 class (built in the veil_contracts checkout
// this repo sits in) and point the pool factory at it, so the next
// `create_pool` (migrate-pool.js) deploys it. Also declares VeilEvmVerifier,
// the class a pool library-calls to check an EVM wallet's signature, and
// records it as `veil.evmVerifierClass` (migrate-pool.js sets it on the pool).
//
//   (cd ../.. && scarb build)
//   node --env-file=.env set-pool-class.js --factory 0x... [--artifacts ../../target/dev]
//
// Idempotent: declaring an existing class and re-setting the same hash are
// both skipped.

const fs = require('fs');
const path = require('path');
const { hash } = require('starknet');
const {
  parseArgs, loadDeployment, saveDeployment, requireEnv, starknetAccount, asFelts, step, done,
} = require('./lib');
const { network } = require('./config');

async function main() {
  const args = parseArgs(process.argv);
  if (!args.factory) throw new Error('--factory is required');
  const net = network(args.starknet);
  const dir = path.resolve(__dirname, args.artifacts ?? '../../target/dev');
  const [rpc, address, key] = requireEnv('STARKNET_RPC_URL', 'STARKNET_ACCOUNT_ADDRESS', 'STARKNET_PRIVATE_KEY');
  const { provider, account } = starknetAccount(rpc, address, key);

  const declare = async (name) => {
    const sierra = JSON.parse(fs.readFileSync(path.join(dir, `veil_${name}.contract_class.json`), 'utf8'));
    const casm = JSON.parse(fs.readFileSync(path.join(dir, `veil_${name}.compiled_contract_class.json`), 'utf8'));
    const classHash = hash.computeContractClassHash(sierra);
    const res = await account.declareIfNot({ contract: sierra, casm });
    if (res.transaction_hash) {
      await provider.waitForTransaction(res.transaction_hash);
      done('declared', classHash, `${net.explorer}/tx/${res.transaction_hash}`);
    } else {
      done('already declared', classHash);
    }
    return classHash;
  };

  step(1, 3, 'declare VeilEvmVerifier');
  const verifier = await declare('VeilEvmVerifier');
  const d = loadDeployment(args);
  d.veil = { ...(d.veil ?? {}), evmVerifierClass: verifier };
  saveDeployment(args, d);

  step(2, 3, 'declare VeilERC3643');
  const classHash = await declare('VeilERC3643');

  step(3, 3, 'factory.set_veil_class_hash');
  const current = asFelts(await provider.callContract({ contractAddress: args.factory, entrypoint: 'veil_class_hash' }))[0];
  if (BigInt(current) === BigInt(classHash)) {
    done('already set', classHash);
    return;
  }
  const tx = await account.execute({ contractAddress: args.factory, entrypoint: 'set_veil_class_hash', calldata: [classHash] });
  await provider.waitForTransaction(tx.transaction_hash);
  done(`set (was ${current})`, classHash, `${net.explorer}/tx/${tx.transaction_hash}`);
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
