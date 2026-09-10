// The note id, computed the way the pool computes it.
//
// The app derives a holder's note id on the device, from their viewing key, and
// hands it to the bridge. That derivation lives in TypeScript, in the SDK, while
// the pool computes the same value in Cairo. Nothing else checks that the two
// agree -- and if they drift, the app names a note the pool has never heard of,
// every pool delivery silently falls back to the wallet, and no test fails.
//
// So the formulas are pinned here against fixed inputs, and
// frontend/src/notes.test.mjs asserts the identical constants through the SDK.
// Either side changing alone breaks a test rather than a deployment.
//
// Formulas mirrored from the pool:
//   channel_key = poseidon(DERIVE_CHANNEL_KEY, sender, scalar(k), recipient, pub)
//   note_id     = poseidon(NOTE_ID, channel_key, token, index)

use core::poseidon::poseidon_hash_span;

const DOMAIN_NOTE_ID: felt252 = 'VEIL_NOTE_ID';
const DOMAIN_DERIVE_CHANNEL_KEY: felt252 = 2;

fn owner() -> felt252 { 0xA11CE }
fn token() -> felt252 { 0x777 }

/// The viewing key reduced to a curve scalar. Small keys pass through unchanged,
/// which is what the fixture uses.
fn scalar() -> felt252 { 0x1234567890ABCDEF }

/// `derivePublicViewingKey(k)` for the same key, taken from the SDK. It is the
/// x-coordinate of k*G, which Cairo cannot cheaply recompute here, so it is
/// pinned as an input rather than derived.
fn public_viewing_key() -> felt252 {
    0x2abbefdcbf731195ee2acd186441eb536e86f888327b3655cffbd07b57dbf26
}

fn channel_key() -> felt252 {
    poseidon_hash_span(
        array![DOMAIN_DERIVE_CHANNEL_KEY, owner(), scalar(), owner(), public_viewing_key()].span(),
    )
}

fn note_id(index: u32) -> felt252 {
    poseidon_hash_span(array![DOMAIN_NOTE_ID, channel_key(), token(), index.into()].span())
}

#[test]
fn the_channel_key_matches_the_sdk() {
    assert(
        channel_key() == 0x5304a364f07f09c4a3836a045e6082b3cf1fb25997b3975293e46c241ac94fb,
        'CHANNEL_KEY_DRIFTED',
    );
}

#[test]
fn the_note_id_matches_the_sdk() {
    // If this fails, the app is deriving a note the pool does not know, and
    // every pool delivery degrades to the wallet with no error anywhere.
    assert(
        note_id(0) == 0x6ddeb0ab2b45306345f9a16b2a92ebf89ca39be09484c88408d3b35cc1f27d3,
        'NOTE_ID_DRIFTED',
    );
}

#[test]
fn note_ids_are_distinct_per_slot() {
    // The app walks slots looking for a fillable one, so collisions would make
    // it fill the wrong note.
    assert(note_id(0) != note_id(1), 'SLOT_COLLISION');
    assert(note_id(1) != note_id(2), 'SLOT_COLLISION');
}

#[test]
fn a_different_owner_derives_a_different_note() {
    // The whole security property: the id is bound to the holder's key, so it
    // is not guessable and not reusable by anyone else.
    let other = poseidon_hash_span(
        array![DOMAIN_DERIVE_CHANNEL_KEY, 0xB0B, scalar(), 0xB0B, public_viewing_key()].span(),
    );
    let other_note = poseidon_hash_span(
        array![DOMAIN_NOTE_ID, other, token(), 0].span(),
    );
    assert(other_note != note_id(0), 'OWNER_NOT_BOUND');
}
