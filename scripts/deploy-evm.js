#!/usr/bin/env node
// Deploy the EVM half: the lockbox in front of an existing ERC-3643 token.
//
//   node deploy-evm.js --asset gold --token 0x<erc3643> [--evm ethereum-sepolia]
//
// --asset is a catalogue id (gold, silver, tbill, credit, estate). Each gets
// its own lockbox: assets are never pooled.
//
// Also deploys ComplianceReader unless --skip-reader, since the export tool
// wants it and it is a cheap, stateless view contract.
//
// This does NOT deploy an ERC-3643 token. The whole point of the bridge is that
// the asset already exists and belongs to an issuer; if you need one to test
// against, deploy a T-REX yourself or use `--token` with a testnet deployment.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { compile } = require('../evm/test/harness');
const { network } = require('./config');
const {
  parseArgs, loadDeployment, saveDeployment, requireEnv, assetSlot, step, done,
} = require('./lib');

async function main() {
  const args = parseArgs(process.argv);
  if (!args.token) throw new Error('--token <erc3643 address> is required');

  const net = network(args.evm);
  if (net.kind !== 'evm') throw new Error(`${args.evm} is not an EVM network`);

  const [rpc, key] = requireEnv('EVM_RPC_URL', 'EVM_PRIVATE_KEY');
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);

  const chainNet = await provider.getNetwork();
  console.log(`network      ${args.evm} (chainId ${chainNet.chainId}, eid ${net.eid})`);
  console.log(`deployer     ${wallet.address}`);
  console.log(`balance      ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`);
  console.log(`endpoint     ${net.endpoint}`);
  console.log(`asset        ${args.asset}`);
  console.log(`token        ${args.token}`);

  const deployment = loadDeployment(args);
  const slot = assetSlot(deployment, args.asset);
  const artifacts = compile();
  const total = args.skipReader ? 1 : 2;

  async function deploy(name, ctorArgs) {
    const art = artifacts[name];
    if (!art) throw new Error(`no artifact for ${name}`);
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
    const c = await factory.deploy(...ctorArgs);
    await c.waitForDeployment();
    return await c.getAddress();
  }

  step(1, total, `VeilERC3643Lockbox (${args.asset})`);
  if (slot.evm.lockbox) {
    done('already deployed', slot.evm.lockbox);
  } else {
    // dstEid is the STARKNET side: where this lockbox sends its messages.
    const address = await deploy('VeilERC3643Lockbox', [
      net.endpoint,
      wallet.address,
      args.token,
      deployment.starknetEid,
    ]);
    slot.evm.lockbox = address;
    slot.evm.token = args.token;
    slot.evm.owner = wallet.address;
    saveDeployment(args, deployment);
    done('deployed', address, `${net.explorer}/address/${address}`);
  }

  if (!args.skipReader) {
    step(2, total, 'ComplianceReader');
    // Stateless and asset-agnostic: reuse one across every asset.
    const existing = Object.values(deployment.assets)
      .map((a) => a.evm && a.evm.complianceReader).find(Boolean);
    if (existing) {
      slot.evm.complianceReader = existing;
      done('reusing', existing);
    } else {
      const address = await deploy('ComplianceReader', []);
      slot.evm.complianceReader = address;
      saveDeployment(args, deployment);
      done('deployed', address, `${net.explorer}/address/${address}`);
    }
  }

  const file = saveDeployment(args, deployment);
  console.log(`\nwritten to ${path.relative(process.cwd(), file)}`);
  console.log('\nnext:');
  console.log(`  node deploy-starknet.js --asset ${args.asset}`);
  console.log('\nREMINDER: the issuer must register the lockbox as a verified identity in');
  console.log(`the token's registry, or bridgeOut reverts inside the token:`);
  console.log(`  identityRegistry.registerIdentity(${slot.evm.lockbox}, ...)`);
}

main().catch((e) => {
  console.error('\n' + String(e.message || e));
  process.exit(1);
});
