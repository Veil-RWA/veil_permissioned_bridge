// Crypto primitives mirroring src/Veil.cairo byte-for-byte.
//
// Every function here is the off-chain twin of a Cairo helper. The whole point
// of this module is that it runs on the USER'S device: the private viewing key
// `k` is an input to these functions and is never serialized into an RPC call.
// (STRK20 §5.4 — discovery is a client-side scan; §4.3.1 / §6 — the viewing key
// must stay secret.)
import { poseidonHashMany } from "@scure/starknet";
import { ec, shortString } from "starknet";
// ── Field / curve handles ───────────────────────────────────────────────────
// `ec.starkCurve` is the same @scure/starknet curve the sequencer uses.
// `Fp` is the BASE field (felt252 modulus p = 2^251 + 17·2^192 + 1). All the
// "hash-and-add" encryption arithmetic in the contract is mod p, so we reuse Fp.
const CURVE = ec.starkCurve.CURVE;
const Fp = CURVE.Fp;
const ProjectivePoint = ec.starkCurve.ProjectivePoint;
export const TWO_POW_128 = 1n << 128n;
export const MAX_NOTE_SALT_EXCLUSIVE = 1n << 120n; // matches MAX_NOTE_SALT_EXCLUSIVE
const MASK_128 = TWO_POW_128 - 1n;
// ── Domain-separation tags (must equal the consts in Veil.cairo) ─────────────
const sstr = (s) => BigInt(shortString.encodeShortString(s));
export const DOMAIN = {
    NOTE_ID: sstr("VEIL_NOTE_ID"),
    CHANNEL_MARKER: sstr("VEIL_CH_MK"),
    SUBCHANNEL_MARKER: sstr("VEIL_SUB_MK"),
    NULLIFIER: 1n,
    DERIVE_CHANNEL_KEY: 2n,
    OUTGOING_CHANNEL_ID: 4n,
    OUTGOING_RECIPIENT_ENCRYPTION: 5n,
    SUBCHANNEL_ID: 6n,
    SUBCHANNEL_ENCRYPTION: 8n,
    NOTE_ENCRYPTION: 9n,
    CHANNEL_KEY_ENCRYPTION: 10n,
    CHANNEL_SENDER_ENCRYPTION: 11n,
    VIEW_KEY_ENCRYPTION: 12n,
};
// ── felt arithmetic (mod p) ──────────────────────────────────────────────────
export const poseidon = (values) => poseidonHashMany(values);
export const feltAdd = (a, b) => Fp.add(Fp.create(a), Fp.create(b));
export const feltSub = (a, b) => Fp.sub(Fp.create(a), Fp.create(b));
// `viewing_key_as_scalar`: u256 → felt252. Since the contract enforces
// 0 < k < curve_order/2 < p, the value is unchanged. We surface the same range
// guard so a bad key fails loudly here rather than producing junk derivations.
export const HALF_CURVE_ORDER = 0x4000000000000088000000000000000n << 128n;
export function viewingKeyAsScalar(k) {
    if (!(k > 0n && k < HALF_CURVE_ORDER)) {
        throw new Error("viewing key out of range (expected 0 < k < curve_order/2)");
    }
    return k;
}
// ── Elliptic curve helpers ───────────────────────────────────────────────────
// lift_x: recover a curve point from its x-coordinate. The contract uses
// `EcPointTrait::new_nz_from_x`. Either y-root works for ECDH because
// (k·R).x == (k·(−R)).x, exactly as the Cairo comment in §6.2.1 notes.
function liftX(x) {
    const xx = Fp.create(x);
    // y² = x³ + a·x + b
    const rhs = Fp.add(Fp.add(Fp.mul(Fp.mul(xx, xx), xx), Fp.mul(CURVE.a, xx)), CURVE.b);
    const y = Fp.sqrt(rhs); // throws if x is not a valid curve x-coordinate
    return ProjectivePoint.fromAffine({ x: xx, y });
}
// (k · G).x  — the public viewing key. Mirrors derive_public_viewing_key_internal.
export function derivePublicViewingKey(k) {
    const P = ProjectivePoint.BASE.multiply(viewingKeyAsScalar(k));
    return P.toAffine().x;
}
// ECDH shared secret x: (scalar · lift(pointX)).x
function ecdhSharedX(scalar, pointX) {
    const R = liftX(pointX);
    const S = R.multiply(scalar);
    return S.toAffine().x;
}
// ── Identifier derivations (public hashes; no secret beyond channel_key/k) ───
export const computeNoteId = (channelKey, collection, noteIndex) => poseidon([DOMAIN.NOTE_ID, channelKey, collection, BigInt(noteIndex)]);
export const computeSubchannelId = (channelKey, subchannelIndex) => poseidon([DOMAIN.SUBCHANNEL_ID, channelKey, BigInt(subchannelIndex)]);
export const computeOutgoingChannelId = (sender, k, index) => poseidon([DOMAIN.OUTGOING_CHANNEL_ID, sender, viewingKeyAsScalar(k), BigInt(index)]);
export const deriveNullifier = (channelKey, collection, noteIndex, k) => poseidon([DOMAIN.NULLIFIER, channelKey, collection, BigInt(noteIndex), viewingKeyAsScalar(k)]);
// Channel key for an OUTGOING channel (sender = the user). Needs the recipient's
// PUBLIC viewing key (fetched on-chain via get_viewing_key). Mirrors
// derive_channel_key_internal.
export const deriveChannelKey = (sender, k, recipient, recipientPubViewingKey) => poseidon([
    DOMAIN.DERIVE_CHANNEL_KEY,
    sender,
    viewingKeyAsScalar(k),
    recipient,
    recipientPubViewingKey,
]);
// decrypt_channel_internal → (channel_key, sender)
export function decryptChannel(k, cipher) {
    const sharedX = ecdhSharedX(viewingKeyAsScalar(k), cipher.ephemeralKeyX);
    const channelKey = feltSub(cipher.encryptedChannelKey, poseidon([DOMAIN.CHANNEL_KEY_ENCRYPTION, sharedX]));
    const sender = feltSub(cipher.encryptedSender, poseidon([DOMAIN.CHANNEL_SENDER_ENCRYPTION, sharedX]));
    return { channelKey, sender };
}
// decrypt_subchannel_collection_internal → collection
export function decryptSubchannelCollection(channelKey, subchannelIndex, salt, encryptedCollection) {
    const mask = poseidon([
        DOMAIN.SUBCHANNEL_ENCRYPTION,
        channelKey,
        BigInt(subchannelIndex),
        salt,
    ]);
    return feltSub(encryptedCollection, mask);
}
// decrypt_outgoing_recipient_internal → recipient
export function decryptOutgoingRecipient(sender, k, index, salt, encryptedRecipient) {
    const mask = poseidon([
        DOMAIN.OUTGOING_RECIPIENT_ENCRYPTION,
        sender,
        viewingKeyAsScalar(k),
        BigInt(index),
        salt,
    ]);
    return feltSub(encryptedRecipient, mask);
}
// decrypt_note_id_internal → NFT id (u128, returned as bigint)
export function decryptNftId(channelKey, collection, noteIndex, encryptedId) {
    const low = encryptedId & MASK_128;
    const salt = encryptedId >> 128n;
    if (salt >= MAX_NOTE_SALT_EXCLUSIVE)
        throw new Error("note salt too large");
    const mask = poseidon([
        DOMAIN.NOTE_ENCRYPTION,
        channelKey,
        collection,
        BigInt(noteIndex),
        salt,
    ]);
    const maskLow = mask & MASK_128;
    // wrapping_sub mod 2^128
    return (low - maskLow + TWO_POW_128) & MASK_128;
}
// ERC-3643 fungible pool: notes carry an `amount: u128`, encrypted with the
// identical hash-and-add packing as an NFT id (STRK20 §6.1.1) — only the
// semantics differ. The `token` address occupies the slot the NFT `collection`
// used. So this is `decryptNftId` under a name that reads correctly for the
// fungible pool.
export function decryptNoteAmount(channelKey, token, noteIndex, encryptedAmount) {
    return decryptNftId(channelKey, token, noteIndex, encryptedAmount);
}
