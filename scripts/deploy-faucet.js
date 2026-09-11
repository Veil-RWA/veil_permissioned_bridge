#!/usr/bin/env node
// Deploy a permissioned ERC-3643 faucet asset on an EVM testnet.
//
//   node deploy-faucet.js [--evm ethereum-sepolia]
//                         [--asset gold]        one asset; default is ALL FIVE
//                         [--country 840] [--amount 1000] [--cooldown 3600]
//                         [--modules] [--max-balance 0] [--supply-limit 0]
//
// The bridge escrows an asset that already exists and belongs to an issuer, so
// `deploy-evm.js` deliberately does NOT create one. On a testnet there is no
// issuer, which is what this is for: a real ERC-3643 token with a public
// faucet, so a tester can hold a permissioned balance without anyone
// hand-registering them.
//
// With no --asset it deploys the whole catalogue: gold, silver, tbill, credit
// and estate, plus a FaucetRouter so the app can stock a tester with all five
// in ONE transaction.
//
// What it deploys:
//   FaucetIdentityRegistry   ONCE, shared by every asset -- one issuer KYCing
//                            the same people across its products, which is also
//                            what the app's single "Get faucets" implies.
//   FaucetCompliance         PER ASSET: compliance binds to one token, and the
//                            per-identity ledger is only correct that way.
//   FaucetERC3643            per asset, with claim() / claimFor()
//   FaucetRouter             ONCE, batches claimFor across every token
//   (--modules)              the five T-REX modules per asset, bound+unconfigured
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
const { network, ASSET_IDS } = require('./config');
const {
  parseArgs, assetsRequested, loadDeployment, saveDeployment, requireEnv, assetSlot, step, done,
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

  const ids = assetsRequested(process.argv, ASSET_IDS);
  for (const id of ids) {
    if (!NAMES[id]) throw new Error(`unknown asset "${id}" (expected one of ${ASSET_IDS.join(', ')})`);
  }

  const country = Number(args.country ?? 840);
  const amount = ethers.parseUnits(String(args.amount ?? 1000), 18);
  const cooldown = BigInt(args.cooldown ?? 0);
  const useModules = Boolean(args.modules);

  const [rpc, key] = requireEnv('EVM_RPC_URL', 'EVM_PRIVATE_KEY');
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);

  const chainNet = await provider.getNetwork();
  console.log(`network      ${args.evm} (chainId ${chainNet.chainId})`);
  console.log(`deployer     ${wallet.address}`);
  console.log(`balance      ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`);
  console.log(`assets       ${ids.join(', ')}`);
  console.log(`faucet       ${ethers.formatUnits(amount, 18)} per claim, country ${country}, cooldown ${cooldown}s`);

  const deployment = loadDeployment(args);
  deployment.faucet = deployment.faucet ?? {};
  const artifacts = compile();

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

  // Every step is resumable: a run that dies at asset four costs nothing to
  // repeat, which on a testnet with a flaky RPC is the normal case.
  const perAsset = useModules ? 4 : 3;
  const total = 2 + ids.length * perAsset;
  let n = 0;

  // ── shared registry ─────────────────────────────────────────────────────
  step(++n, total, 'FaucetIdentityRegistry (shared by every asset)');
  if (deployment.faucet.registry) {
    done('already deployed', deployment.faucet.registry);
  } else {
    deployment.faucet.registry = await deploy('FaucetIdentityRegistry', [wallet.address]);
    done('deployed', deployment.faucet.registry,
      `${net.explorer}/address/${deployment.faucet.registry}`);
    saveDeployment(args, deployment);
  }
  const registry = at('FaucetIdentityRegistry', deployment.faucet.registry);

  // ── router ──────────────────────────────────────────────────────────────
  step(++n, total, 'FaucetRouter (one transaction for every asset)');
  if (deployment.faucet.router) {
    done('already deployed', deployment.faucet.router);
  } else {
    deployment.faucet.router = await deploy('FaucetRouter', []);
    done('deployed', deployment.faucet.router,
      `${net.explorer}/address/${deployment.faucet.router}`);
    saveDeployment(args, deployment);
  }

  // ── per asset ───────────────────────────────────────────────────────────
  for (const id of ids) {
    const [name, symbol] = NAMES[id];
    const slot = assetSlot(deployment, id);
    slot.faucet = slot.faucet ?? {};

    step(++n, total, `${symbol}: FaucetCompliance`);
    if (slot.faucet.compliance) {
      done('already deployed', slot.faucet.compliance);
    } else {
      slot.faucet.compliance = await deploy('FaucetCompliance', [wallet.address]);
      done('deployed', slot.faucet.compliance);
      saveDeployment(args, deployment);
    }

    step(++n, total, `${symbol}: FaucetERC3643 (${name})`);
    if (slot.evm.token) {
      done('already deployed', slot.evm.token);
    } else {
      slot.evm.token = await deploy('FaucetERC3643', [
        name, symbol, wallet.address, deployment.faucet.registry, slot.faucet.compliance,
      ]);
      done('deployed', slot.evm.token, `${net.explorer}/address/${slot.evm.token}`);
      saveDeployment(args, deployment);
    }

    step(++n, total, `${symbol}: wire + configure the faucet`);
    const compliance = at('FaucetCompliance', slot.faucet.compliance);
    const token = at('FaucetERC3643', slot.evm.token);

    // Without this, claim() reverts inside the registry rather than here.
    if (await registry.isAgent(slot.evm.token)) {
      done('token is already an agent');
    } else {
      const tx = await registry.addAgent(slot.evm.token);
      await tx.wait();
      done('registry.addAgent(token)', tx.hash);
    }

    if ((await compliance.tokenBound()).toLowerCase() === slot.evm.token.toLowerCase()) {
      done('compliance already bound');
    } else {
      const tx = await compliance.bindToken(slot.evm.token);
      await tx.wait();
      done('compliance.bindToken(token)', tx.hash);
    }

    if ((await token.faucetAmount()) === amount) {
      done('faucet already configured', ethers.formatUnits(amount, 18));
    } else {
      const tx = await token.configureFaucet(amount, country, cooldown);
      await tx.wait();
      done('token.configureFaucet', tx.hash);
    }

    // Bound-and-EMPTY on purpose: the export tool gets something real to
    // enumerate, and nothing blocks a transfer until you configure one.
    if (useModules) {
      step(++n, total, `${symbol}: compliance modules`);
      slot.faucet.modules = slot.faucet.modules ?? {};
      for (const [modKey, contract] of [
        ['countryAllow', 'CountryAllowModule'],
        ['countryRestrict', 'CountryRestrictModule'],
        ['transferRestrict', 'TransferRestrictModule'],
        ['supplyLimit', 'SupplyLimitModule'],
        ['maxBalance', 'MaxBalanceModule'],
      ]) {
        if (slot.faucet.modules[modKey]) {
          done(`${contract} already deployed`, slot.faucet.modules[modKey]);
          continue;
        }
        const address = await deploy(contract, [wallet.address]);
        slot.faucet.modules[modKey] = address;
        const tx = await compliance.addModule(address);
        await tx.wait();
        done(`${contract} bound`, address);
        saveDeployment(args, deployment);
      }
      if (args.maxBalance) {
        const cap = ethers.parseUnits(String(args.maxBalance), 18);
        const tx = await at('MaxBalanceModule', slot.faucet.modules.maxBalance)
          .setMaxBalance(slot.faucet.compliance, cap);
        await tx.wait();
        done('maxBalance set', ethers.formatUnits(cap, 18));
      }
      if (args.supplyLimit) {
        const cap = ethers.parseUnits(String(args.supplyLimit), 18);
        const tx = await at('SupplyLimitModule', slot.faucet.modules.supplyLimit)
          .setSupplyLimit(slot.faucet.compliance, cap);
        await tx.wait();
        done('supplyLimit set', ethers.formatUnits(cap, 18));
      }
    }
  }

  saveDeployment(args, deployment);

  console.log('\nfaucet assets ready.\n');
  console.log(`  registry    ${deployment.faucet.registry}   (shared)`);
  console.log(`  router      ${deployment.faucet.router}   (Get faucets)`);
  for (const id of ids) {
    const slot = assetSlot(deployment, id);
    console.log(`  ${id.padEnd(8)}    ${slot.evm.token}`);
  }
  console.log('\nThe app\'s "Get faucets" button calls the router, stocking every asset at once.');
  console.log('\nNEXT, per asset: deploy the lockbox and register it as an identity.');
  console.log(`  node deploy-evm.js --asset <id> --token <token>`);
  console.log(`  cast send ${deployment.faucet.registry} "registerIdentity(address,uint16)" <lockbox> ${country} ...`);
  console.log('  T-REX verifies the RECIPIENT of a transfer, and on a bridge-out that is the');
  console.log('  lockbox -- without the registration every escrow reverts inside the token.');
}

main().catch((e) => {
  console.error('\n' + (e.message ?? e));
  process.exit(1);
});
