// What History says about a LayerZero message, from LayerZero Scan's own
// response shapes (the INFLIGHT case is the one seen on 2026-09-28, verified
// and waiting for the executor).
//
//   npx esbuild src/lzStatus.ts --bundle --format=esm --platform=node \
//     --outfile=src/lzStatus.bundle.mjs --define:import.meta.env='{}' && node src/lzStatus.test.mjs
import assert from 'node:assert/strict';
import { describe, elapsed } from './lzStatus.bundle.mjs';

let pass = 0;
const test = (name, fn) => { fn(); console.log(`  ok    ${name}`); pass++; };

test('verified but not delivered: waiting for the executor', () => {
  const s = describe({
    created: '2026-09-28T14:16:42.000Z',
    status: { name: 'INFLIGHT', message: 'Ready for committer to commit verification' },
    verification: { dvn: { status: 'SUCCEEDED' } },
  });
  assert.equal(s.stage, 'delivering');
  assert.match(s.text, /executor/);
  assert.equal(s.raw, 'Ready for committer to commit verification');
  assert.equal(s.since, Date.parse('2026-09-28T14:16:42.000Z'));
});

test('in flight before the verifiers sign', () => {
  const s = describe({ status: { name: 'INFLIGHT' }, verification: { dvn: { status: 'WAITING' } } });
  assert.equal(s.stage, 'verifying');
});

test('delivered, with the destination transaction', () => {
  const s = describe({ status: { name: 'DELIVERED' }, destination: { tx: { txHash: '0xabc' } } });
  assert.equal(s.stage, 'delivered');
  assert.equal(s.dstTx, '0xabc');
});

test('confirming on the source chain', () => {
  assert.equal(describe({ status: { name: 'CONFIRMING' } }).stage, 'confirming');
});

test('failed, blocked and stored payloads all read as failed', () => {
  for (const name of ['FAILED', 'BLOCKED', 'PAYLOAD_STORED']) {
    assert.equal(describe({ status: { name } }).stage, 'failed', name);
  }
});

test('an unknown status is passed through, never read as delivered', () => {
  const s = describe({ status: { name: 'SOMETHING_NEW', message: 'odd' } });
  assert.equal(s.stage, 'unknown');
  assert.equal(s.text, 'odd');
});

test('elapsed reads in minutes, then hours', () => {
  const t = Date.parse('2026-09-28T14:00:00Z');
  assert.equal(elapsed(t, t + 20_000), 'just now');
  assert.equal(elapsed(t, t + 12 * 60_000), 'for 12 min');
  assert.equal(elapsed(t, t + 75 * 60_000), 'for 1 h 15 min');
  assert.equal(elapsed(undefined), '');
});

console.log(`\n${pass} passed`);
