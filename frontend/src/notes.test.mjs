// The SDK half of the cross-language note-derivation check.
//
// cairo/tests/test_note_derivation.cairo asserts the same constants using the
// pool's formulas. Neither side alone would catch a drift: if they diverge the
// app names a note the pool has never seen, every pool delivery falls back to
// the wallet, and nothing errors.

import assert from 'node:assert';
import {
  deriveChannelKey, computeNoteId, viewingKeyAsScalar, derivePublicViewingKey,
} from 'veil-sdk';

const OWNER = 0xa11cen;
const KEY = 0x1234567890abcdefn;
const TOKEN = 0x777n;

const EXPECTED_PUBKEY = 0x2abbefdcbf731195ee2acd186441eb536e86f888327b3655cffbd07b57dbf26n;
const EXPECTED_CHANNEL_KEY = 0x5304a364f07f09c4a3836a045e6082b3cf1fb25997b3975293e46c241ac94fbn;
const EXPECTED_NOTE_0 = 0x6ddeb0ab2b45306345f9a16b2a92ebf89ca39be09484c88408d3b35cc1f27d3n;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

test('the viewing key reduces to the scalar Cairo uses', () => {
  assert.strictEqual(viewingKeyAsScalar(KEY), KEY, 'small keys pass through unchanged');
});

test('the public viewing key is pinned', () => {
  assert.strictEqual(derivePublicViewingKey(KEY), EXPECTED_PUBKEY);
});

test('the channel key matches the pool formula', () => {
  const ck = deriveChannelKey(OWNER, KEY, OWNER, EXPECTED_PUBKEY);
  assert.strictEqual(ck, EXPECTED_CHANNEL_KEY);
});

test('the note id matches the pool formula', () => {
  const ck = deriveChannelKey(OWNER, KEY, OWNER, EXPECTED_PUBKEY);
  assert.strictEqual(computeNoteId(ck, TOKEN, 0), EXPECTED_NOTE_0);
});

test('derivation is deterministic', () => {
  const a = computeNoteId(deriveChannelKey(OWNER, KEY, OWNER, EXPECTED_PUBKEY), TOKEN, 0);
  const b = computeNoteId(deriveChannelKey(OWNER, KEY, OWNER, EXPECTED_PUBKEY), TOKEN, 0);
  assert.strictEqual(a, b);
});

test('a different owner derives a different note', () => {
  const mine = computeNoteId(deriveChannelKey(OWNER, KEY, OWNER, EXPECTED_PUBKEY), TOKEN, 0);
  const theirs = computeNoteId(deriveChannelKey(0xb0bn, KEY, 0xb0bn, EXPECTED_PUBKEY), TOKEN, 0);
  assert.notStrictEqual(mine, theirs);
});

console.log(`\n${passed} passed`);
