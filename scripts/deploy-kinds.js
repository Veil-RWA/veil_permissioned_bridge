#!/usr/bin/env node
// Deploy the EVM half of an allowlisted or rule-gated test asset: the faucet
// token, the issuer contract it answers to, and the matching lockbox.
//
//   node deploy-kinds.js --asset mmf     allowlisted money market fund
//   node deploy-kinds.js --asset pef     rule-gated private equity fund
//                        [--amount 1000] [--cooldown 3600] [--evm ethereum-sepolia]
//
// On a testnet there is no issuer, so this plays one, the way deploy-faucet.js
// does for the ERC-3643 assets:
//
//   allowlist  FaucetPermissionManager (the list, AccessControl-shaped)
//              FaucetAllowlistToken    both sides must be on the list
//              VeilAllowlistLockbox    reads the list: hasRole(WHITELISTED_ROLE, a)
//              ...then the issuer's consent: the lockbox is put on the list.
//
//   rules      FaucetRulesSource       the issuer's rules, and the adapter the
//                                      bridge reads (IVeilRulesSource)
//              FaucetRulesToken        its own check applies the same rules
//              VeilRulesLockbox        reads the adapter, sends the rules across
//              ...then the issuer's consent: the lockbox is a platform wallet.
//
// Resumable: every address is written to the deployment file as soon as it
// exists. Then `deploy-starknet.js --asset <id>` and `wire.js --asset <id>`.

const { ethers } = require('ethers');
const { compile } = require('../evm/test/harness');
const { network, ASSET_KINDS } = require('./config');
const {
  parseArgs, loadDeployment, saveDeployment, requireEnv, assetSlot, step, done,
} = require('./lib');

const NAMES = {
  mmf: ['Money Market Fund', 'MMF'],
  pef: ['Private Equity Fund', 'PEF'],
};

async function main() {
  const args = parseArgs(process.argv);
  const kind = ASSET_KINDS[args.asset];
  if (!kind) throw new Error(`--asset must be one of: ${Object.keys(ASSET_KINDS).join(', ')}`);
  const net = network(args.evm);
  if (net.kind !== 'evm') throw new Error(`${args.evm} is not an EVM network`);

  const [rpc, key] = requireEnv('EVM_RPC_URL', 'EVM_PRIVATE_KEY');
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  const amount = ethers.parseUnits(String(args.amount ?? 1000), 18);
  const cooldown = BigInt(args.cooldown ?? 3600);
  const [name, symbol] = NAMES[args.asset];

  const d = loadDeployment(args);
  const slot = assetSlot(d, args.asset);
  const artifacts = compile();
  console.log(`network      ${args.evm} (eid ${net.eid})`);
  console.log(`deployer     ${wallet.address}`);
  console.log(`asset        ${args.asset} (${kind}) ${name} / ${symbol}`);

  async function deploy(contract, ctorArgs) {
    const art = artifacts[contract];
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
    const c = await factory.deploy(...ctorArgs);
    await c.waitForDeployment();
    return c.getAddress();
  }
  const at = (contract, address) => new ethers.Contract(address, artifacts[contract].abi, wallet);
  async function send(label, promise) {
    const tx = await promise;
    await tx.wait();
    done(label, tx.hash, `${net.explorer}/tx/${tx.hash}`);
  }

  slot.evm.kind = kind;
  slot.evm.owner = wallet.address;

  if (kind === 'allowlist') {
    step(1, 5, 'FaucetPermissionManager (the issuer\'s allowlist)');
    if (!slot.evm.allowlist) {
      slot.evm.allowlist = await deploy('FaucetPermissionManager', [wallet.address]);
      saveDeployment(args, d);
    }
    done('at', slot.evm.allowlist, `${net.explorer}/address/${slot.evm.allowlist}`);
    const manager = at('FaucetPermissionManager', slot.evm.allowlist);
    slot.evm.role = await manager.WHITELISTED_ROLE();

    step(2, 5, `FaucetAllowlistToken (${symbol})`);
    if (!slot.evm.token) {
      slot.evm.token = await deploy('FaucetAllowlistToken', [name, symbol, wallet.address, slot.evm.allowlist]);
      slot.evm.faucet = slot.evm.token;
      saveDeployment(args, d);
    }
    done('at', slot.evm.token, `${net.explorer}/address/${slot.evm.token}`);
    const token = at('FaucetAllowlistToken', slot.evm.token);

    step(3, 5, 'the token may add faucet claimers to the list; faucet amount');
    if (!(await manager.isAgent(slot.evm.token))) await send('addAgent', manager.addAgent(slot.evm.token));
    else done('already an agent', slot.evm.token);
    if ((await token.faucetAmount()) !== amount) await send('configureFaucet', token.configureFaucet(amount, cooldown));
    else done('faucet already configured', ethers.formatUnits(amount, 18));

    step(4, 5, 'VeilAllowlistLockbox');
    if (!slot.evm.lockbox) {
      slot.evm.lockbox = await deploy('VeilAllowlistLockbox', [
        net.endpoint, wallet.address, slot.evm.token, d.starknetEid, slot.evm.allowlist, slot.evm.role,
      ]);
      saveDeployment(args, d);
    }
    done('at', slot.evm.lockbox, `${net.explorer}/address/${slot.evm.lockbox}`);

    step(5, 5, 'issuer consent: the lockbox is on the list');
    if (!(await manager.hasRole(slot.evm.role, slot.evm.lockbox))) {
      await send('grantRole', manager.grantRole(slot.evm.role, slot.evm.lockbox));
    } else {
      done('already allowed', slot.evm.lockbox);
    }
  } else {
    step(1, 5, 'FaucetRulesSource (the issuer\'s rules, and the adapter the bridge reads)');
    if (!slot.evm.rules) {
      slot.evm.rules = await deploy('FaucetRulesSource', [wallet.address]);
      saveDeployment(args, d);
    }
    done('at', slot.evm.rules, `${net.explorer}/address/${slot.evm.rules}`);
    const source = at('FaucetRulesSource', slot.evm.rules);

    step(2, 5, `FaucetRulesToken (${symbol})`);
    if (!slot.evm.token) {
      slot.evm.token = await deploy('FaucetRulesToken', [name, symbol, wallet.address, slot.evm.rules]);
      slot.evm.faucet = slot.evm.token;
      saveDeployment(args, d);
    }
    done('at', slot.evm.token, `${net.explorer}/address/${slot.evm.token}`);
    const token = at('FaucetRulesToken', slot.evm.token);

    step(3, 5, 'the token may approve faucet claimers; faucet amount');
    if (!(await source.isAgent(slot.evm.token))) await send('addAgent', source.addAgent(slot.evm.token));
    else done('already an agent', slot.evm.token);
    if ((await source.token()).toLowerCase() !== slot.evm.token.toLowerCase()) {
      await send('setToken', source.setToken(slot.evm.token));
    } else {
      done('source already reads the token', slot.evm.token);
    }
    if ((await token.faucetAmount()) !== amount) await send('configureFaucet', token.configureFaucet(amount, cooldown));
    else done('faucet already configured', ethers.formatUnits(amount, 18));

    step(4, 5, 'VeilRulesLockbox');
    if (!slot.evm.lockbox) {
      slot.evm.lockbox = await deploy('VeilRulesLockbox', [
        net.endpoint, wallet.address, slot.evm.token, d.starknetEid, slot.evm.rules,
      ]);
      saveDeployment(args, d);
    }
    done('at', slot.evm.lockbox, `${net.explorer}/address/${slot.evm.lockbox}`);

    step(5, 5, 'issuer consent: the lockbox is a platform wallet');
    if (!(await source.isPlatform(slot.evm.lockbox))) {
      await send('setPlatform', source.setPlatform(slot.evm.lockbox, true));
    } else {
      done('already a platform wallet', slot.evm.lockbox);
    }
  }

  saveDeployment(args, d);
  console.log('\nnext:');
  console.log(`  node deploy-starknet.js --asset ${args.asset} --name "Bridged ${name}" --symbol b${symbol}`);
  console.log(`  node wire.js --asset ${args.asset}`);
}

main().catch((e) => {
  console.error('\n' + String(e.message || e));
  process.exit(1);
});
