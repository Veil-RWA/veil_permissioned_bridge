// Pool-level pieces of `Veil::invoke_derive` / `invoke_settle`.
//
// These describe the POOL's side of an adapter hop, so they are identical
// whatever the adapter does — an Ekubo swap, a Vesu supply, anything else that
// implements `privacy_invoke`. They live here rather than in either adapter
// client so the two cannot drift apart.
import { poseidon } from "./crypto.js";
export const U128_MAX = (1n << 128n) - 1n;
export function assertU128(name, v) {
    if (v < 0n || v > U128_MAX)
        throw new Error(`${name} out of u128 range: ${v}`);
}
export const hex = (v) => "0x" + v.toString(16);
/** Split a u256 into the (low, high) felt pair Cairo expects. */
export function u256Felts(v) {
    return [hex(v & U128_MAX), hex(v >> 128n)];
}
/** `invoke_derive(caller, owner_private_viewing_key: u256, in_token,
 *  in_amount: u128, out_token, target, calldata_hash, audit_ephemeral_secret_r,
 *  change_note_salt: u128, subchannel_salt)`. */
export function buildInvokeDeriveCalldata(args) {
    assertU128("inAmount", args.inAmount);
    assertU128("changeNoteSalt", args.changeNoteSalt);
    const [low, high] = u256Felts(args.ownerPrivateViewingKey);
    return [
        hex(args.caller),
        low,
        high,
        hex(args.inToken),
        hex(args.inAmount),
        hex(args.outToken),
        hex(args.target),
        hex(args.calldataHash),
        hex(args.auditEphemeralSecret),
        hex(args.changeNoteSalt),
        hex(args.subchannelSalt),
    ];
}
/** The Poseidon hash `invoke_settle` recomputes over the adapter calldata. It
 *  binds the arguments to the proof without carrying them in the message, so
 *  neither the route nor the amounts nor the note can be swapped after
 *  proving. */
export function invokeCalldataHash(calldata) {
    return poseidon(calldata.map((f) => BigInt(f)));
}
