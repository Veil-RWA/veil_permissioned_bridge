// Private proof of reserve (ERC-3643 pool).
//
// The holder proves, inside a SNIP-36 proof, that their address holds at least
// X of a token in the pool. Only `commitment = poseidon('VEIL_POR_X', X, salt)`
// goes on-chain; the holder hands (X, salt) to the verifiers they choose, who
// call `verify_reserve(proof_id, X, salt)`.
//
//  * SNAPSHOT (mode 0): "held >= X at the proof's base block". Funds stay free.
//  * LOCK (mode 1): X moves into a reserve note nobody but an agent seizure can
//    spend until the proof expires or the holder revokes it. A seizure
//    invalidates the proof.
// Validity is at most 7 days; one proof per (holder, token) per day.
//
// Derives run through `VeilProver` ("prove_reserve" / "revoke_reserve"); the
// signer must be the holder (the pool checks the signature in the proof).
import { poseidon } from "./crypto.js";
import { assertU128, hex, u256Felts } from "./invoke.js";
const toHexBytes = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const shortString = (s) => BigInt("0x" + toHexBytes(new TextEncoder().encode(s)));
export const DOMAIN_POR = shortString("VEIL_POR");
export const DOMAIN_POR_X = shortString("VEIL_POR_X");
export const RESERVE_MAX_VALIDITY_SECS = 7n * 86400n;
export const RESERVE_COOLDOWN_SECS = 86400n;
export var ReserveMode;
(function (ReserveMode) {
    ReserveMode[ReserveMode["Snapshot"] = 0] = "Snapshot";
    ReserveMode[ReserveMode["Lock"] = 1] = "Lock";
})(ReserveMode || (ReserveMode = {}));
/** `get_reserve_status`: what a verifier sees. */
export var ReserveStatus;
(function (ReserveStatus) {
    ReserveStatus[ReserveStatus["Unknown"] = 0] = "Unknown";
    ReserveStatus[ReserveStatus["Active"] = 1] = "Active";
    ReserveStatus[ReserveStatus["Revoked"] = 2] = "Revoked";
    ReserveStatus[ReserveStatus["Invalidated"] = 3] = "Invalidated";
    ReserveStatus[ReserveStatus["Expired"] = 4] = "Expired";
})(ReserveStatus || (ReserveStatus = {}));
/** The commitment published for threshold X. */
export function reserveCommitment(threshold, salt) {
    assertU128("threshold", threshold);
    return poseidon([DOMAIN_POR_X, threshold, salt]);
}
/** proof_id the settle stores, from the derive's auth_id (in the proven message). */
export function reserveProofId(authId) {
    return poseidon([DOMAIN_POR, authId]);
}
/** A random 248-bit commitment salt. Keep it with X; it is what verifiers need. */
export function randomReserveSalt() {
    const b = crypto.getRandomValues(new Uint8Array(31));
    return BigInt("0x" + toHexBytes(b));
}
/** `prove_reserve_derive(caller, k: u256, token, threshold: u128, commitment_salt,
 *  mode: u8, valid_for_secs: u64, reserve_note_salt: u128, change_note_salt: u128)`
 *  (auth_nonce + signature are appended by the prover's signer). */
export function buildProveReserveDeriveCalldata(args) {
    assertU128("threshold", args.threshold);
    if (args.threshold === 0n)
        throw new Error("threshold must be > 0");
    if (args.validForSecs <= 0n || args.validForSecs > RESERVE_MAX_VALIDITY_SECS)
        throw new Error(`validForSecs must be in (0, ${RESERVE_MAX_VALIDITY_SECS}]`);
    const [low, high] = u256Felts(args.ownerPrivateViewingKey);
    return [
        hex(args.caller),
        low,
        high,
        hex(args.token),
        hex(args.threshold),
        hex(args.commitmentSalt),
        hex(BigInt(args.mode)),
        hex(args.validForSecs),
        hex(args.reserveNoteSalt),
        hex(args.changeNoteSalt),
    ];
}
/** `revoke_reserve_derive(caller, proof_id)`. */
export function buildRevokeReserveDeriveCalldata(caller, proofId) {
    return [hex(caller), hex(proofId)];
}
/** Calls `verify_reserve`. Resolves to the proof, or rejects with the pool's
 *  reason: PROOF_UNKNOWN / PROOF_REVOKED / PROOF_INVALIDATED / PROOF_EXPIRED /
 *  BAD_COMMITMENT (in the RPC error message). */
export async function verifyReserve(provider, pool, proofId, threshold, salt) {
    assertU128("threshold", threshold);
    const r = await provider.callContract({
        contractAddress: hex(BigInt(pool)),
        entrypoint: "verify_reserve",
        calldata: [hex(proofId), hex(threshold), hex(salt)],
    }, "latest");
    const v = r.map((x) => BigInt(x));
    return {
        holder: v[0],
        token: v[1],
        mode: Number(v[2]),
        baseBlock: v[3],
        createdAt: v[4],
        expiresAt: v[5],
    };
}
/** Status without the opening (anyone can read it). */
export async function getReserveStatus(provider, pool, proofId) {
    const r = await provider.callContract({ contractAddress: hex(BigInt(pool)), entrypoint: "get_reserve_status", calldata: [hex(proofId)] }, "latest");
    return Number(BigInt(r[0]));
}
