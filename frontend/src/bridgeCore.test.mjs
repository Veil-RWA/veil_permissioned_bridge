import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeExitTail, quoteBridgeBackCalldata, gatewayHasU256Exit, exitRecipientWord } from './bridgeCore.bundle.mjs';
const raw = '0xfcb2a5f4c3e1d2b0a9988776655443322110ffeeddccbbaa9988776655443322';
const mask = (1n << 128n) - 1n;
const pair = [BigInt(raw) & mask, BigInt(raw) >> 128n].map(x => '0x' + x.toString(16));
test('app quotes and exits pass the same raw Stellar key in low/high order', () => {
  const quote = quoteBridgeBackCalldata(600n, raw, 200000n);
  const tail = bridgeExitTail({ amount: 600n, recipient: BigInt(raw), accountFormat: 'stellar', maxFee: 5000n, gasLimit: 200000n });
  assert.deepEqual(quote.slice(2, 4), pair);
  assert.deepEqual(tail.slice(1, 3), pair);
});
test('app EVM exits serialize high bits and reject >= 2^160', () => {
  const a = { amount: 1n, recipient: (1n << 160n) - 1n, accountFormat: 'evm', maxFee: 1n, gasLimit: 1n };
  assert.equal(bridgeExitTail(a)[2], '0xffffffff');
  assert.throws(() => bridgeExitTail({ ...a, recipient: 1n << 160n }));
});
test('app G-address input becomes the raw key, not a lookup', () => {
  assert.equal(exitRecipientWord('GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57'),
    0xea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22cn);
});
test('old felt gateways are incompatible; new u256 gateways are recognized', () => {
  const f = type => [{ type: 'interface', items: [{ name: 'privacy_invoke', inputs: [{ name: 'recipient', type }] }] }];
  assert.equal(gatewayHasU256Exit(f('core::felt252')), false);
  assert.equal(gatewayHasU256Exit(f('core::integer::u256')), true);
});

import { spawnSync } from 'node:child_process';
const cli = new URL('../../scripts/exit-calldata.mjs', import.meta.url);
test('offline script encodes the same direct u256 Stellar exit', () => {
  const r = spawnSync(process.execPath, [cli.pathname, 'stellar', raw, '600', '5000', '200000'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).slice(1, 3), pair);
});
test('offline script rejects EVM overflow rather than truncating', () => {
  const r = spawnSync(process.execPath, [cli.pathname, 'evm', '0x10000000000000000000000000000000000000000', '1', '1', '1'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not an EVM address/);
});
