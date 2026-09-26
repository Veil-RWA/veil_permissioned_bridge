#!/usr/bin/env node
// Veil's cash relayer: delivers USDC deposits into the cash vault.
//
//   node --env-file=.env relay-cash.js [--from-block N] [--once]
//
// A USDC deposit is a CCTP burn on Ethereum that names Veil's cash vault as
// BOTH the mint recipient and the destination caller, with the holder's empty
// USDC note as hook data. Only the vault can take such a message, and the vault
// is called by whoever relays it. If holders relayed their own deposits, their
// Starknet accounts would appear next to the notes being filled. So Veil relays
// them, the way HyperVeil's keeper does for its exits: this watches Circle's
// TokenMessengerV2 for burns addressed to the vault, waits for Circle's
// attestation, and calls `receive_deposit` from the relayer account.
//
// The relayer is trusted with nothing. It can only hand the vault a message
// Circle attested; the vault checks it is addressed to itself and fills the
// note the burn named, or holds the deposit for retry or refund to the wallet
// that burned it.
//
// Uses STARKNET_RPC_URL, STARKNET_ACCOUNT_ADDRESS and STARKNET_PRIVATE_KEY
// (the relayer account pays Starknet fees), and EVM_RPC_URL when set. The
// progress (last block scanned, deposits seen) is kept in .relay-cash/, so a
// restart resumes where it stopped.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { network } = require('./config');
const { parseArgs, loadDeployment, requireEnv, starknetAccount, asFelts } = require('./lib');

const STARKNET_DOMAIN = 25;
const POLL_MS = 15_000;
const CHUNK = 2_000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const IRIS = {
  testnet: 'https://iris-api-sandbox.circle.com',
  mainnet: 'https://iris-api.circle.com',
};

// Circle's evm-cctp-contracts, src/v2/TokenMessengerV2.sol.
const MESSENGER = new ethers.Interface([
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
]);

const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const hex = (v) => '0x' + v.toString(16);

/// Raw bytes as a serialized Cairo ByteArray (31-byte words, then the pending
/// word and its length) -- the same encoding as the app's cashCore.ts.
function byteArrayCalldata(hexBytes) {
  const bytes = Buffer.from(hexBytes.replace(/^0x/i, ''), 'hex');
  const full = Math.floor(bytes.length / 31);
  const out = [hex(BigInt(full))];
  for (let i = 0; i < full; i++) out.push('0x' + (bytes.subarray(31 * i, 31 * (i + 1)).toString('hex') || '0'));
  const rest = bytes.subarray(31 * full);
  out.push(rest.length ? '0x' + rest.toString('hex') : '0x0', hex(BigInt(rest.length)));
  return out;
}

/// The fields of a CCTP V2 message the relayer checks before paying to relay it.
function readMessage(hexMessage) {
  const b = Buffer.from(hexMessage.replace(/^0x/i, ''), 'hex');
  const u = (at, len) => BigInt('0x' + (b.subarray(at, at + len).toString('hex') || '0'));
  return {
    sourceDomain: Number(u(4, 4)),
    destinationDomain: Number(u(8, 4)),
    nonce: u(12, 32),
    destinationCaller: u(108, 32),
    mintRecipient: b.length >= 148 + 68 ? u(148 + 36, 32) : 0n,
  };
}

function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { lastBlock: null, pending: {}, done: {} }; }
}
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const deployment = loadDeployment(args);
  const c = deployment.cash;
  if (!c?.vault || !c.source?.tokenMessenger) throw new Error('no cash leg in this deployment: run deploy-cash.js');
  const [rpc, address, key] = requireEnv('STARKNET_RPC_URL', 'STARKNET_ACCOUNT_ADDRESS', 'STARKNET_PRIVATE_KEY');
  const { provider: sn, account } = starknetAccount(rpc, address, key);
  const evmUrl = process.env.EVM_RPC_URL && !process.env.EVM_RPC_URL.includes('<')
    ? process.env.EVM_RPC_URL
    : (args.evm.includes('sepolia') ? 'https://ethereum-sepolia-rpc.publicnode.com' : 'https://ethereum-rpc.publicnode.com');
  const evm = new ethers.JsonRpcProvider(evmUrl);
  const iris = network(args.starknet).eid >= 40000 ? IRIS.testnet : IRIS.mainnet;
  const vault = BigInt(c.vault);
  const vaultWord = word(c.vault).toLowerCase();
  const stateFile = path.join(__dirname, '.relay-cash', `${args.evm}__${args.starknet}.json`);
  const st = loadState(stateFile);

  console.log(`relayer   ${address}`);
  console.log(`vault     ${c.vault}`);
  console.log(`watching  TokenMessengerV2 ${c.source.tokenMessenger} on ${args.evm}`);

  const depositStatus = async (nonce) => {
    const id = asFelts(await sn.callContract({
      contractAddress: c.vault, entrypoint: 'deposit_id_of',
      calldata: [String(c.source.domain ?? 0), hex(nonce & ((1n << 128n) - 1n)), hex(nonce >> 128n)],
    }))[0];
    const rec = asFelts(await sn.callContract({ contractAddress: c.vault, entrypoint: 'deposit_of', calldata: [id] }));
    // CashDeposit { note_id, amount, source_domain, sender: u256, status }
    return Number(BigInt(rec[rec.length - 1] ?? 0));
  };

  for (;;) {
    // 1. New burns addressed to the vault.
    try {
      const latest = await evm.getBlockNumber();
      let from = args['from-block'] ? Number(args['from-block']) : (st.lastBlock ?? latest - 5_000) + 1;
      if (args['from-block']) delete args['from-block'];
      while (from <= latest) {
        const to = Math.min(from + CHUNK - 1, latest);
        const logs = await evm.getLogs({
          address: c.source.tokenMessenger,
          topics: [MESSENGER.getEvent('DepositForBurn').topicHash],
          fromBlock: from, toBlock: to,
        });
        for (const log of logs) {
          const ev = MESSENGER.parseLog(log);
          if (Number(ev.args.destinationDomain) !== STARKNET_DOMAIN) continue;
          if (ev.args.mintRecipient.toLowerCase() !== vaultWord) continue;
          if (ev.args.destinationCaller.toLowerCase() !== vaultWord) continue;
          if (!st.done[log.transactionHash] && !st.pending[log.transactionHash]) {
            st.pending[log.transactionHash] = Date.now();
            console.log(`seen      ${log.transactionHash} (${ev.args.amount} units)`);
          }
        }
        st.lastBlock = to;
        from = to + 1;
      }
      saveState(stateFile, st);
    } catch (e) {
      console.error(`scan: ${e.shortMessage ?? e.message}`);
    }

    // 2. Relay what Circle has attested.
    for (const [tx, seenAt] of Object.entries(st.pending)) {
      try {
        const res = await fetch(`${iris}/v2/messages/${c.source.domain ?? 0}?transactionHash=${tx}`);
        if (res.status === 404) continue;
        const body = await res.json();
        const messages = (body.messages ?? []).filter((m) => m.status === 'complete'
          && m.attestation && m.attestation !== 'PENDING' && m.message && m.message !== '0x');
        if (!messages.length) {
          if (Date.now() - seenAt > PENDING_TTL_MS) { delete st.pending[tx]; console.log(`gave up   ${tx} (never attested)`); }
          continue;
        }
        let allDone = true;
        for (const m of messages) {
          const f = readMessage(m.message);
          if (f.destinationDomain !== STARKNET_DOMAIN || f.destinationCaller !== vault || f.mintRecipient !== vault) continue;
          if ((await depositStatus(f.nonce)) !== 0) continue; // already delivered or held
          try {
            const r = await account.execute({
              contractAddress: c.vault,
              entrypoint: 'receive_deposit',
              calldata: [...byteArrayCalldata(m.message), ...byteArrayCalldata(m.attestation)],
            });
            await sn.waitForTransaction(r.transaction_hash);
            console.log(`relayed   ${tx} -> ${r.transaction_hash}`);
          } catch (e) {
            allDone = false;
            console.error(`relay ${tx}: ${String(e.message ?? e).split('\n')[0]}`);
          }
        }
        if (allDone) { delete st.pending[tx]; st.done[tx] = Date.now(); }
      } catch (e) {
        console.error(`iris ${tx}: ${e.message}`);
      }
    }
    saveState(stateFile, st);
    if (args.once) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { byteArrayCalldata, readMessage };
