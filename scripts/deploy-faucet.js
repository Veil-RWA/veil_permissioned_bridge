#!/usr/bin/env node
// Deploy a permissioned ERC-3643 faucet asset on an EVM testnet.
//
//   node deploy-faucet.js --asset gold [--evm ethereum-sepolia]
//                         [--country 840] [--amount 1000] [--cooldown 3600]
//                         [--modules] [--max-balance 0] [--supply-limit 0]
//
// The bridge escrows an asset that already exists and belongs to an issuer, so
// `deploy-evm.js` deliberately does NOT create one. On a testnet there is no
// issuer, which is what this is for: a real ERC-3643 token with a public
// faucet, so a tester can hold a permissioned balance without anyone
// hand-registering them.
//
// What it deploys, per asset:
//   FaucetIdentityRegistry   isVerified / investorCountry, agent-gated
//   FaucetCompliance         modular, what ComplianceReader enumerates
//   FaucetERC3643            the token, with claim()
//   (--modules)              the five T-REX modules, bound and unconfigured
//
// Then it wires them: the token becomes an agent on the registry so `claim()`
// can register a caller, and the compliance binds the token so the per-identity
// ledger stays correct.
//
// The addresses land in the same deployment file `deploy-evm.js` writes, under
// `assets.<id>.evm.token`, so `wire.js` and the app pick the asset up with no
// further steps.

const { ethers } = require('ethers');
const { compile } = require('../evm/test/harness');
const { network } = require('./config');
const {
  parseArgs, loadDeployment, saveDeployment, requireEnv, assetSlot, step, done,
} = require('./lib');

/// Catalogue defaults, so `--asset silver` produces a silver-looking token
/// rather than five tokens all called "Faucet Asset".
const NAMES = {
  gold: ['Tokenized Gold', 'XAU'],
  silver: ['Tokenized Silver', 'XAG'],
  tbill: ['Short-dated Treasuries', 'TBILL'],
  credit: ['Private Credit Note', 'CREDIT'],
  estate: ['Real Estate Fund', 'ESTATE'],
};

async function main() {
  const args = parseArgs(process.argv);
  const net = network(args.evm);
  if (net.kind !== 'evm') throw new Error(`${args.evm} is not an EVM network`);

  const [name, symbol] = NAMES[args.asset] ?? ['Faucet Asset', 'FAUCET'];
  const country = Number(args.country ?? 840);
  const amount = ethers.parseUnits(String(args.amount ?? 1000), 18);
  const cooldown = BigInt(args.cooldown ?? 0);

  const [rpc, key] = requireEnv('EVM_RPC_URL', 'EVM_PRIVATE_KEY');
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);

  const chainNet = await provider.getNetwork();
  console.log(`network      ${args.evm} (chainId ${chainNet.chainId})`);
  console.log(`deployer     ${wallet.address}`);
  console.log(`balance      ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`);
  console.log(`asset        ${args.asset}  ${name} (${symbol})`);
  console.log(`faucet       ${ethers.formatUnits(amount, 18)} per claim, country ${country}, cooldown ${cooldown}s`);

  const deployment = loadDeployment(args);
  const slot = assetSlot(deployment, args.asset);
  const artifacts = compile();
  slot.faucet = slot.faucet ?? {};

  async function deploy(contract, ctorArgs) {
    const art = artifacts[contract];
    if (!art) throw new Error(`no artifact for ${contract}`);
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
    const c = await factory.deploy(...ctorArgs);
    await c.waitForDeployment();
    return await c.getAddress();
  }

  const at = (contract, address) =>
    new ethers.Contract(address, artifacts[contract].abi, wallet);

  const useModules = Boolean(args.modules);
  const total = useModules ? 5 : 4;

  // ── 1. registry ─────────────────────────────────────────────────────────
  step(1, total, 'FaucetIdentityRegistry');
  if (slot.faucet.registry) {
    done('already deployed', slot.faucet.registry);
  } else {
    slot.faucet.registry = await deploy('FaucetIdentityRegistry', [wallet.address]);
    done('deployed', slot.faucet.registry, `${net.explorer}/address/${slot.faucet.registry}`);
    saveDeployment(args, deployment);
  }

  // ── 2. compliance ───────────────────────────────────────────────────────
  step(2, total, 'FaucetCompliance');
  if (slot.faucet.compliance) {
    done('already deployed', slot.faucet.compliance);
  } else {
    slot.faucet.compliance = await deploy('FaucetCompliance', [wallet.address]);
    done('deployed', slot.faucet.compliance, `${net.explorer}/address/${slot.faucet.compliance}`);
    saveDeployment(args, deployment);
  }

  // ── 3. the token ────────────────────────────────────────────────────────
  step(3, total, `FaucetERC3643 (${symbol})`);
  if (slot.evm.token) {
    done('already deployed', slot.evm.token);
  } else {
    slot.evm.token = await deploy('FaucetERC3643', [
      name, symbol, wallet.address, slot.faucet.registry, slot.faucet.compliance,
    ]);
    done('deployed', slot.evm.token, `${net.explorer}/address/${slot.evm.token}`);
    saveDeployment(args, deployment);
  }

  // ── 4. wiring, without which claim() reverts inside the registry ────────
  step(4, total, 'wire registry + compliance + faucet');
  const registry = at('FaucetIdentityRegistry', slot.faucet.registry);
  const compliance = at('FaucetCompliance', slot.faucet.compliance);
  const token = at('FaucetERC3643', slot.evm.token);

  if (await registry.isAgent(slot.evm.token)) {
    done('token is already an agent', slot.evm.token);
  } else {
    const tx = await registry.addAgent(slot.evm.token);
    await tx.wait();
    done('registry.addAgent(token)', tx.hash, `${net.explorer}/tx/${tx.hash}`);
  }

  if ((await compliance.tokenBound()).toLowerCase() === slot.evm.token.toLowerCase()) {
    done('compliance already bound', slot.evm.token);
  } else {
    const tx = await compliance.bindToken(slot.evm.token);
    await tx.wait();
    done('compliance.bindToken(token)', tx.hash, `${net.explorer}/tx/${tx.hash}`);
  }

  const currentAmount = await token.faucetAmount();
  if (currentAmount === amount) {
    done('faucet already configured', ethers.formatUnits(amount, 18));
  } else {
    const tx = await token.configureFaucet(amount, country, cooldown);
    await tx.wait();
    done('token.configureFaucet', tx.hash, `${net.explorer}/tx/${tx.hash}`);
  }

  // ── 5. modules, bound but UNCONFIGURED ──────────────────────────────────
  // Bound-and-empty is deliberate: it gives the export tool something real to
  // enumerate without any of them blocking a transfer until you configure one.
  if (useModules) {
    step(5, total, 'compliance modules');
    slot.faucet.modules = slot.faucet.modules ?? {};
    for (const [key, contract] of [
      ['countryAllow', 'CountryAllowModule'],
      ['countryRestrict', 'CountryRestrictModule'],
      ['transferRestrict', 'TransferRestrictModule'],
      ['supplyLimit', 'SupplyLimitModule'],
      ['maxBalance', 'MaxBalanceModule'],
    ]) {
      if (slot.faucet.modules[key]) {
        done(`${contract} already deployed`, slot.faucet.modules[key]);
        continue;
      }
      const address = await deploy(contract, [wallet.address]);
      slot.faucet.modules[key] = address;
      const tx = await compliance.addModule(address);
      await tx.wait();
      done(`${contract} bound`, address, `${net.explorer}/address/${address}`);
      saveDeployment(args, deployment);
    }

    if (args.maxBalance) {
      const cap = ethers.parseUnits(String(args.maxBalance), 18);
      const m = at('MaxBalanceModule', slot.faucet.modules.maxBalance);
      const tx = await m.setMaxBalance(slot.faucet.compliance, cap);
      await tx.wait();
      done('maxBalance set', ethers.formatUnits(cap, 18));
    }
    if (args.supplyLimit) {
      const cap = ethers.parseUnits(String(args.supplyLimit), 18);
      const m = at('SupplyLimitModule', slot.faucet.modules.supplyLimit);
      const tx = await m.setSupplyLimit(slot.faucet.compliance, cap);
      await tx.wait();
      done('supplyLimit set', ethers.formatUnits(cap, 18));
    }
  }

  saveDeployment(args, deployment);

  console.log('\nfaucet asset ready.');
  console.log(`\n  token       ${slot.evm.token}`);
  console.log(`  registry    ${slot.faucet.registry}`);
  console.log(`  compliance  ${slot.faucet.compliance}`);
  console.log('\nAnyone can now get a balance:');
  console.log(`  cast send ${slot.evm.token} "claim()" --rpc-url $EVM_RPC_URL --private-key $KEY`);
  console.log('\nNEXT: deploy the lockbox against it, then register the lockbox as an identity:');
  console.log(`  node deploy-evm.js --asset ${args.asset} --token ${slot.evm.token}`);
  console.log(`  # then, with the lockbox address:`);
  console.log(`  cast send ${slot.faucet.registry} "registerIdentity(address,uint16)" <lockbox> ${country} ...`);
  console.log('  Without that registration every bridgeOut reverts inside the token.');
}

main().catch((e) => {
  console.error('\n' + (e.message ?? e));
  process.exit(1);
});
