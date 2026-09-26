#!/usr/bin/env node
// Deploy the cash leg: USDC over Circle's CCTP, into and out of a Veil pool
// without naming the holder. See ../README.md, "The cash leg".
//
//   node deploy-cash.js [--pool 0x...] [--source ethereum-sepolia]
//
//   1. VeilCashRules  -- USDC's own rules (Circle's pause and blocklist) for the pool
//   2. VeilCashVault  -- CCTP in: fills the holder's USDC open note
//   3. VeilCashExit   -- CCTP out: a pool invoke adapter burning to an EVM address
//   4. The pool       -- USDC as a rules token, the vault and exit as adapters
//                        (owner calls; the account must own the pool)
//
// `--pool` defaults to the main Veil pool, the one every bridged asset lands in,
// so both legs of a DvP settle in the same pool. `--source` is the EVM chain the
// cash comes from and exits to (its CCTP domain is the exit's destination).
//
// Resumable like deploy-starknet.js: every address is written to the
// deployment file (`cash`) as soon as it exists. Run `scarb build` in ../cairo
// first.

const fs = require('fs');
const path = require('path');
const { hash } = require('starknet');
const { network, veil, cctp } = require('./config');
const {
  parseArgs, loadDeployment, saveDeployment, requireEnv, starknetAccount, asFelts, step, done,
} = require('./lib');

const TARGET = path.join(__dirname, '..', 'cairo', 'target', 'dev');
const TOKEN_KIND_RULES = 3n;

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
  deployment.classes = deployment.classes || {};
  const { sierra, casm } = artifact(contract);
  const classHash = hash.computeContractClassHash(sierra);
  if (deployment.classes[contract] === classHash) return classHash;
  const res = await account.declareIfNot({ contract: sierra, casm });
  if (res.transaction_hash) {
    console.log('      declaring...');
    await account.provider.waitForTransaction(res.transaction_hash);
    console.log(`      declared                ${classHash}`);
  } else {
    console.log(`      class already declared  ${classHash}`);
  }
  deployment.classes[contract] = classHash;
  return classHash;
}

async function deployContract(account, classHash, calldata) {
  const res = await account.deployContract({ classHash, constructorCalldata: calldata });
  await account.provider.waitForTransaction(res.transaction_hash);
  return res.contract_address;
}

async function main() {
  const args = parseArgs(process.argv);
  const net = network(args.starknet);
  if (net.kind !== 'starknet') throw new Error(`${args.starknet} is not a Starknet network`);
  const source = args.source || args.evm;
  const here = cctp(args.starknet);
  const there = cctp(source);

  const [rpc, accountAddress, key] = requireEnv(
    'STARKNET_RPC_URL', 'STARKNET_ACCOUNT_ADDRESS', 'STARKNET_PRIVATE_KEY'
  );
  const { provider, account } = starknetAccount(rpc, accountAddress, key);
  const deployment = loadDeployment(args);
  const pool = args.pool || deployment.veil?.pool || veil(args.starknet).pool;
  if (!pool) throw new Error('no Veil pool: pass --pool');
  const cash = (deployment.cash = deployment.cash || {});
  if (cash.pool && BigInt(cash.pool) !== BigInt(pool)) {
    throw new Error(`deployment already has a cash leg for pool ${cash.pool}; this run names ${pool}`);
  }
  Object.assign(cash, {
    pool,
    usdc: here.usdc,
    tokenMessenger: here.tokenMessenger,
    messageTransmitter: here.messageTransmitter,
    source: { network: source, domain: there.domain, usdc: there.usdc, tokenMessenger: there.tokenMessenger },
  });
  saveDeployment(args, deployment);

  const read = async (contractAddress, entrypoint, calldata = []) =>
    asFelts(await provider.callContract({ contractAddress, entrypoint, calldata }));
  const owner = BigInt((await read(pool, 'get_owner'))[0]);
  if (owner !== BigInt(accountAddress)) {
    throw new Error(`account ${accountAddress} does not own pool ${pool} (owner ${'0x' + owner.toString(16)})`);
  }

  console.log(`network      ${args.starknet}`);
  console.log(`account      ${accountAddress}`);
  console.log(`pool         ${pool}`);
  console.log(`usdc         ${here.usdc}`);
  console.log(`cctp         messenger ${here.tokenMessenger}`);
  console.log(`             transmitter ${here.messageTransmitter}`);
  console.log(`source       ${source} (CCTP domain ${there.domain})`);

  step(1, 4, 'VeilCashRules');
  if (cash.rules) {
    done('already deployed', cash.rules);
  } else {
    const classHash = await declareIfNeeded(account, 'VeilCashRules', deployment);
    saveDeployment(args, deployment);
    cash.rules = await deployContract(account, classHash, [here.usdc]);
    saveDeployment(args, deployment);
    done('deployed', cash.rules, `${net.explorer}/contract/${cash.rules}`);
  }

  step(2, 4, 'VeilCashVault');
  if (cash.vault) {
    done('already deployed', cash.vault);
  } else {
    const classHash = await declareIfNeeded(account, 'VeilCashVault', deployment);
    saveDeployment(args, deployment);
    cash.vault = await deployContract(account, classHash, [
      pool, here.usdc, here.messageTransmitter, here.tokenMessenger,
    ]);
    saveDeployment(args, deployment);
    done('deployed', cash.vault, `${net.explorer}/contract/${cash.vault}`);
  }

  step(3, 4, 'VeilCashExit');
  if (cash.exit) {
    done('already deployed', cash.exit);
  } else {
    const classHash = await declareIfNeeded(account, 'VeilCashExit', deployment);
    saveDeployment(args, deployment);
    cash.exit = await deployContract(account, classHash, [
      pool, here.usdc, here.tokenMessenger, there.domain,
    ]);
    saveDeployment(args, deployment);
    done('deployed', cash.exit, `${net.explorer}/contract/${cash.exit}`);
  }

  step(4, 4, 'pool: USDC as a rules token, vault and exit as adapters');
  const calls = [];
  const kind = BigInt((await read(pool, 'get_token_kind', [here.usdc]))[0]);
  if (kind !== TOKEN_KIND_RULES) {
    calls.push({ contractAddress: pool, entrypoint: 'add_rules_token', calldata: [here.usdc, cash.rules] });
  } else {
    console.log('      USDC is already a rules token (rules unchanged)');
  }
  for (const adapter of [cash.vault, cash.exit]) {
    if (BigInt((await read(pool, 'is_adapter_allowed', [adapter]))[0]) !== 1n) {
      calls.push({ contractAddress: pool, entrypoint: 'set_adapter_allowed', calldata: [adapter, 1] });
    }
  }
  if (calls.length) {
    const res = await account.execute(calls);
    await provider.waitForTransaction(res.transaction_hash);
    done('configured', res.transaction_hash, `${net.explorer}/tx/${res.transaction_hash}`);
  } else {
    done('already configured', pool);
  }

  // Read back what the pool and the contracts now say.
  const checks = [
    ['USDC kind is rules', BigInt((await read(pool, 'get_token_kind', [here.usdc]))[0]) === TOKEN_KIND_RULES],
    ['vault is an adapter', BigInt((await read(pool, 'is_adapter_allowed', [cash.vault]))[0]) === 1n],
    ['exit is an adapter', BigInt((await read(pool, 'is_adapter_allowed', [cash.exit]))[0]) === 1n],
    ['vault serves the pool', BigInt((await read(cash.vault, 'pool'))[0]) === BigInt(pool)],
    ['exit serves the pool', BigInt((await read(cash.exit, 'pool'))[0]) === BigInt(pool)],
    ['exit burns to the source domain', BigInt((await read(cash.exit, 'destination_domain'))[0]) === BigInt(there.domain)],
    ['rules read Circle USDC', BigInt((await read(cash.rules, 'token'))[0]) === BigInt(here.usdc)],
  ];
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`      ${pass ? 'ok  ' : 'FAIL'} ${label}`);
    ok = ok && pass;
  }
  saveDeployment(args, deployment);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
