// The cash leg's pure encodings (cashCore.ts), checked against starknet.js and
// against the relayer's own encoder (scripts/relay-cash.js).
//
//   npx esbuild src/cashCore.ts --bundle --format=esm --platform=node \
//     --outfile=src/cashCore.bundle.mjs --log-level=error && node src/cashCore.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CallData, byteArray } from 'starknet';
import {
  byteArrayCalldata, word, irisTxHash, parseIrisMessages, fastMaxFee, planCashExit, selectInputTotal,
  EXIT_CHANGE,
} from './cashCore.bundle.mjs';
import { computeNoteId } from 'veil-sdk';

const require = createRequire(import.meta.url);
const relayer = require('../../scripts/relay-cash.js');

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log(`  ok  ${name}`); };
const felts = (xs) => xs.map((x) => BigInt(x));

test('ByteArray: same felts as starknet.js, and as the relayer, at every word boundary', () => {
  for (const len of [0, 1, 30, 31, 32, 61, 62, 63, 148, 376, 408]) {
    const text = Array.from({ length: len }, (_, i) => String.fromCharCode(33 + (i % 90))).join('');
    const hexBytes = '0x' + Buffer.from(text, 'latin1').toString('hex');
    const reference = felts(CallData.compile([byteArray.byteArrayFromString(text)]));
    assert.deepEqual(felts(byteArrayCalldata(hexBytes)), reference, `app, len ${len}`);
    assert.deepEqual(felts(relayer.byteArrayCalldata(hexBytes)), reference, `relayer, len ${len}`);
  }
});

test('ByteArray: bytes above 0x7f and leading zero bytes survive', () => {
  const hexBytes = '0x00ff' + '80'.repeat(40) + '0001';
  const cd = byteArrayCalldata(hexBytes);
  assert.deepEqual(felts(cd), felts(relayer.byteArrayCalldata(hexBytes)));
  assert.equal(cd[0], '0x1');                       // one full 31-byte word
  assert.equal(BigInt(cd[cd.length - 1]), 13n);     // 44 - 31 bytes pending
});

test('word and Circle hash forms', () => {
  assert.equal(word('0xabc'), '0x' + '0'.repeat(61) + 'abc');
  assert.equal(irisTxHash('0x7f'), '0x' + '0'.repeat(62) + '7f');
  const h = '0x' + 'a'.repeat(64);
  assert.equal(irisTxHash(h), h);
});

test("Circle's attestation response", () => {
  assert.equal(parseIrisMessages(404, undefined), null);
  assert.equal(parseIrisMessages(200, { messages: [] }), null);
  assert.equal(parseIrisMessages(200, { messages: [{ status: 'pending_confirmations', attestation: 'PENDING', message: '0x' }] }).attested, false);
  const done = parseIrisMessages(200, { messages: [{ status: 'complete', attestation: '0xab', message: '0xcd' }] });
  assert.equal(done.attested, true);
  assert.equal(done.message, '0xcd');
});

test('Fast fee cap: quoted bps, rounded up, +20%, always below the amount', () => {
  assert.equal(fastMaxFee(1_000_000n, 1), 120n);    // 100 + 20%
  assert.equal(fastMaxFee(1_000_000n, 14), 1680n);  // 1400 + 20%
  assert.equal(fastMaxFee(1_000_000n, 1.3), 156n);  // 130 + 20%
  assert.equal(fastMaxFee(1n, 14), 0n);
  assert.ok(fastMaxFee(10n, 10_000) < 10n);
});

const USDC = 0x512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343n;
const note = (amount, i) => ({ noteId: BigInt(i + 1), channelKey: 7n, token: USDC, amount, noteIndex: i, sender: 1n });
const base = {
  owner: 0xc0n, ownerPrivateViewingKey: 0x51f3n, selfChannelKey: 0x1234n, usdc: USDC,
  exit: 0x3c0fn, recipient: 0x1111111111111111111111111111111111111111n, maxFee: 0n, minFinality: 2000,
  auditEphemeralSecret: 5n, changeNoteSalt: 6n, subchannelSalt: 7n,
};

test('Exit: with change, the open note takes the slot after the change note', () => {
  const plan = planCashExit({ ...base, notes: [note(100_000_000n, 0)], firstFreeSlot: 1, amount: 40_000_000n });
  assert.equal(plan.inAmount, 40_000_000n + EXIT_CHANGE);
  assert.equal(plan.openNoteId, computeNoteId(base.selfChannelKey, USDC, 2));
});

test('Exit: an exact spend leaves no change, so the open note takes the first free slot', () => {
  const plan = planCashExit({ ...base, notes: [note(40_000_001n, 0)], firstFreeSlot: 1, amount: 40_000_000n });
  assert.equal(plan.openNoteId, computeNoteId(base.selfChannelKey, USDC, 1));
});

test("Exit: the adapter calldata is VeilCashExit.privacy_invoke's, and settle carries it", () => {
  const plan = planCashExit({ ...base, notes: [note(100n, 0)], firstFreeSlot: 1, amount: 40n, maxFee: 3n, minFinality: 1000 });
  // [len, open_note_id, amount, recipient.low, recipient.high, max_fee.low, max_fee.high, min_finality]
  assert.equal(plan.settleExtra.length, 8);
  assert.equal(BigInt(plan.settleExtra[0]), 7n);
  const low = base.recipient & ((1n << 128n) - 1n), high = base.recipient >> 128n;   // u256 (low, high)
  assert.deepEqual(felts(plan.settleExtra.slice(2)), [40n, low, high, 3n, 0n, 1000n]);
});

test('Exit: refuses a balance that cannot also cover the change unit, and a non-EVM recipient', () => {
  assert.throws(() => planCashExit({ ...base, notes: [note(40n, 0)], firstFreeSlot: 1, amount: 40n }), /Not enough USDC/);
  assert.throws(() => planCashExit({ ...base, notes: [note(100n, 0)], firstFreeSlot: 1, amount: 4n, recipient: 1n << 160n }), /EVM address/);
  assert.equal(selectInputTotal([note(5n, 0), note(7n, 1)], USDC, 6n), 12n);
});

test('Relayer reads the CCTP header fields it checks', () => {
  const m = Buffer.alloc(148 + 228 + 32);
  m.writeUInt32BE(0, 4);            // source: Ethereum
  m.writeUInt32BE(25, 8);           // destination: Starknet
  m[12 + 31] = 9;                   // nonce 9
  m[108 + 31] = 0x42;               // destination caller
  m[148 + 36 + 31] = 0x42;          // mint recipient
  const f = relayer.readMessage('0x' + m.toString('hex'));
  assert.deepEqual([f.sourceDomain, f.destinationDomain, f.nonce, f.destinationCaller, f.mintRecipient], [0, 25, 9n, 0x42n, 0x42n]);
});

console.log(`\n${pass} passed`);
