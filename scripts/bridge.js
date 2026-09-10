#!/usr/bin/env node
// Bridge one amount across for real, then watch the far side until it lands.
//
//   node bridge.js --asset gold --amount 1000000000000000000 --to 0x<starknet address>
//                  [--gas-limit 400000] [--watch 900]
//                  --note 0x<open note id> [--pool 0x<veil pool>]
//
// --note is REQUIRED. Every bridge-in lands in a Veil pool open note; there is
// no wallet delivery. The note must already be CLAIMED on the gateway by the
// recipient, or the far side quarantines the amount instead of filling it.
//
// --pool names WHICH Veil pool. A Veil pool is multi-asset -- one pool carries
// any number of tokens -- so the asset never implies the pool. Omit it for the
// main Veil pool, which is what the gateway defaults to.
//
// This is the script that proves the LayerZero pathway actually works. It:
//   1. checks the preconditions that otherwise fail deep inside a revert,
//   2. quotes the message fee from the real endpoint,
//   3. approves and escrows, sending the message,
//   4. polls the Starknet side until the twin supply changes -- or until the
//      amount shows up quarantined, which is a compliance answer, not a failure.
//
// A message takes minutes, not seconds: it must be verified by the pathway's
// DVNs and delivered by an executor. If it does not arrive, layerzeroscan.com
// is the place to look, and the GUID printed below is how to find it.

const { ethers } = require('ethers');
const { RpcProvider } = require('starknet');
const { compile } = require('../evm/test/harness');
const { network, veil } = require('./config');
const {
  parseArgs, loadDeployment, requireEnv, assetSlot, u256FromFelts, httpFetch, step, done,
} = require('./lib');

const ERC3643_ABI = [
  'function identityRegistry() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];
const REGISTRY_ABI = ['function isVerified(address) view returns (bool)'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv);
  if (!args.amount) throw new Error('--amount <wei> is required');
  if (!args.to) throw new Error('--to <starknet address> is required');

  const evmNet = network(args.evm);
  const snNet = network(args.starknet);
  const d = loadDeployment(args);
  const slot = assetSlot(d, args.asset);
  if (!slot.evm.lockbox || !slot.starknet.gateway) {
    throw new Error(`${args.asset} is not deployed -- run the deploy scripts with --asset ${args.asset}`);
  }
  if (!slot.wired || !slot.wired.peers) {
    throw new Error(`${args.asset} peers not set -- run: node wire.js --asset ${args.asset}`);
  }

  const [evmRpc, evmKey] = requireEnv('EVM_RPC_URL', 'EVM_PRIVATE_KEY');
  const [snRpc] = requireEnv('STARKNET_RPC_URL');

  const provider = new ethers.JsonRpcProvider(evmRpc);
  const wallet = new ethers.Wallet(evmKey, provider);
  const artifacts = compile();
  const lockbox = new ethers.Contract(slot.evm.lockbox, artifacts['VeilERC3643Lockbox'].abi, wallet);
  const token = new ethers.Contract(slot.evm.token, ERC3643_ABI, wallet);

  const amount = BigInt(args.amount);
  const gasLimit = BigInt(args.gasLimit || 400000);
  const recipient = ethers.zeroPadValue(
    '0x' + BigInt(args.to).toString(16).padStart(64, '0'), 32
  );

  let symbol = '';
  try { symbol = await token.symbol(); } catch (_) {}
  console.log(`asset        ${args.asset}`);
  console.log(`from         ${wallet.address}`);
  console.log(`to           ${args.to} (starknet)`);
  console.log(`amount       ${amount} ${symbol}`);
  console.log(`lockbox      ${slot.evm.lockbox}`);
  console.log(`gateway      ${slot.starknet.gateway}`);

  // ---- preconditions ------------------------------------------------------
  step(1, 5, 'preconditions');
  const registryAddr = await token.identityRegistry();
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, provider);

  const senderVerified = await registry.isVerified(wallet.address);
  const lockboxVerified = await registry.isVerified(slot.evm.lockbox);
  const balance = await token.balanceOf(wallet.address);
  done('sender verified', String(senderVerified));
  done('lockbox verified', String(lockboxVerified));
  done('balance', String(balance));

  if (!senderVerified) throw new Error(`${wallet.address} is not verified in ${registryAddr}`);
  if (!lockboxVerified) {
    throw new Error(
      `the lockbox is NOT a registered identity in ${registryAddr}.\n` +
      `  T-REX verifies the RECIPIENT of every transfer, and on a bridge-out that is\n` +
      `  the lockbox, so the escrow will revert inside the token. The issuer must call\n` +
      `  registerIdentity(${slot.evm.lockbox}, ...) first.`
    );
  }
  if (balance < amount) throw new Error(`balance ${balance} < amount ${amount}`);

  // ---- delivery -----------------------------------------------------------
  // Wallet unless a note is named. The pool is only meaningful alongside one.
  const noteId = args.note;
  if (!noteId) {
    throw new Error(
      '--note is required: every bridge-in lands in a Veil pool note.\n' +
      '  Derive it from the recipient\'s viewing key with the Veil SDK, and have\n' +
      '  them claim it on the gateway (register_note) before bridging.'
    );
  }
  const veilNet = veil(args.starknet ?? d.starknetNetwork);
  const mainPool = d.veil?.pool ?? veilNet.pool;
  const chosenPool = args.pool;
  {
    if (BigInt(noteId) === 0n) throw new Error('--note must be a non-zero felt');
    if (amount >= (1n << 128n)) {
      throw new Error(`amount ${amount} does not fit a note (max 2^128 - 1)`);
    }
    const target = chosenPool ?? mainPool;
    console.log(`delivery     open note ${noteId}`);
    console.log(`pool         ${target ?? '(gateway default)'}${chosenPool ? '' : '  [main Veil pool]'}`);
    if (chosenPool && mainPool && BigInt(chosenPool) !== BigInt(mainPool)) {
      console.log('             not the main pool - the gateway will check it against the factory');
    }
  }

  // ---- quote --------------------------------------------------------------
  step(2, 5, 'quote the message fee from the endpoint');
  const fee = await lockbox.quoteBridgeOut.staticCall(amount, recipient, gasLimit);
  const nativeFee = fee.nativeFee ?? fee[0];
  done('native fee', `${ethers.formatEther(nativeFee)} ETH`);
  const ethBalance = await provider.getBalance(wallet.address);
  if (ethBalance < nativeFee) {
    throw new Error(`need ${ethers.formatEther(nativeFee)} ETH for the message, have ${ethers.formatEther(ethBalance)}`);
  }

  // ---- approve ------------------------------------------------------------
  step(3, 5, 'approve the lockbox');
  const allowance = await token.allowance(wallet.address, slot.evm.lockbox);
  if (allowance >= amount) {
    done('already approved', String(allowance));
  } else {
    const tx = await token.approve(slot.evm.lockbox, amount);
    await tx.wait();
    done('tx', tx.hash, `${evmNet.explorer}/tx/${tx.hash}`);
  }

  // ---- send ---------------------------------------------------------------
  step(4, 5, 'escrow + send');
  const supplyBefore = await starknetSupply(snRpc, slot.starknet.token);
  // Zero means "the gateway's default", which is the main pool. Naming it
  // explicitly would work too, but zero is what the common case should send.
  const ZERO_WORD = '0x' + '0'.repeat(64);
  const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
  const poolWord = chosenPool ? word(chosenPool) : ZERO_WORD;
  const tx = await lockbox.bridgeOut(
    amount, recipient, word(noteId), poolWord, gasLimit, wallet.address, { value: nativeFee }
  );
  const receipt = await tx.wait();
  done('tx', tx.hash, `${evmNet.explorer}/tx/${tx.hash}`);

  const parsed = receipt.logs
    .map((l) => { try { return lockbox.interface.parseLog(l); } catch (_) { return null; } })
    .find((l) => l && l.name === 'BridgedOut');
  if (parsed) {
    done('guid', parsed.args.guid);
    done('seq', String(parsed.args.seq));
    console.log(`      ${''.padEnd(22)} https://testnet.layerzeroscan.com/tx/${tx.hash}`);
  }

  // ---- watch --------------------------------------------------------------
  const watchSeconds = Number(args.watch || 900);
  step(5, 5, `waiting for delivery on ${args.starknet} (up to ${watchSeconds}s)`);
  console.log('      a message must be DVN-verified then executor-delivered; minutes is normal');

  const deadline = Date.now() + watchSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(15000);
    const supply = await starknetSupply(snRpc, slot.starknet.token);
    const pending = await starknetPending(snRpc, slot.starknet.gateway, args.to);
    const elapsed = Math.round((watchSeconds * 1000 - (deadline - Date.now())) / 1000);

    if (supply > supplyBefore) {
      console.log(`\n      MINTED after ~${elapsed}s. twin supply ${supplyBefore} -> ${supply}`);
      console.log(`      ${snNet.explorer}/contract/${slot.starknet.token}`);
      return;
    }
    if (pending > 0n) {
      console.log(`\n      QUARANTINED after ~${elapsed}s: ${pending} held for ${args.to}`);
      console.log('      The message arrived; the recipient was not eligible. That is a');
      console.log('      compliance answer, not a failure -- push their eligibility and claim:');
      console.log(`        node ../tools/... syncCompliance, then gateway.claim_pending(${args.to})`);
      return;
    }
    process.stdout.write(`      ${elapsed}s: not yet\r`);
  }

  console.log(`\n      not delivered within ${watchSeconds}s.`);
  console.log('      Check the pathway at https://testnet.layerzeroscan.com/tx/' + tx.hash);
  console.log('      A message stuck in VERIFYING means the DVN config; stuck in INFLIGHT');
  console.log('      after verification usually means the executor ran out of gas -- retry');
  console.log('      with a larger --gas-limit.');
  process.exit(1);
}

function snProvider(rpc) {
  const options = { nodeUrl: rpc };
  if (process.env.STARKNET_HTTP_FETCH === '1') options.baseFetch = httpFetch;
  return new RpcProvider(options);
}

async function starknetSupply(rpc, token) {
  const provider = snProvider(rpc);
  try {
    const r = await provider.callContract({ contractAddress: token, entrypoint: 'total_supply', calldata: [] });
    return u256FromFelts(r);
  } catch (_) {
    return 0n;
  }
}

async function starknetPending(rpc, gateway, recipient) {
  const provider = snProvider(rpc);
  try {
    const r = await provider.callContract({
      contractAddress: gateway, entrypoint: 'pending_of', calldata: [recipient],
    });
    return u256FromFelts(r);
  } catch (_) {
    return 0n;
  }
}

main().catch((e) => {
  console.error('\n' + String(e.message || e));
  process.exit(1);
});
