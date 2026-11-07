#!/usr/bin/env node
// Offline only: print the direct u256 exit tail. Does not sign, send or read keys.
// node scripts/exit-calldata.mjs <evm|stellar> <recipient hex|G-address> <amount> <maxFee> <gasLimit>
import { bridgeExitTail, stellarExitRecipient } from '../frontend/vendor/veil-sdk/dist/index.js';
const [accountFormat, to, amount, maxFee, gasLimit] = process.argv.slice(2);
if (!gasLimit) throw new Error('usage: exit-calldata.mjs <evm|stellar> <recipient> <amount> <maxFee> <gasLimit>');
const recipient = to.startsWith('G') ? stellarExitRecipient(to) : BigInt(to);
console.log(JSON.stringify(bridgeExitTail({ accountFormat, recipient, amount: BigInt(amount), maxFee: BigInt(maxFee), gasLimit: BigInt(gasLimit) })));
