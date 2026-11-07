import type { BigNumberish, RpcProvider } from "starknet";
export declare const DOMAIN_POR: bigint;
export declare const DOMAIN_POR_X: bigint;
export declare const RESERVE_MAX_VALIDITY_SECS: bigint;
export declare const RESERVE_COOLDOWN_SECS = 86400n;
export declare enum ReserveMode {
    Snapshot = 0,
    Lock = 1
}
/** `get_reserve_status`: what a verifier sees. */
export declare enum ReserveStatus {
    Unknown = 0,
    Active = 1,
    Revoked = 2,
    Invalidated = 3,
    Expired = 4
}
/** The commitment published for threshold X. */
export declare function reserveCommitment(threshold: bigint, salt: bigint): bigint;
/** proof_id the settle stores, from the derive's auth_id (in the proven message). */
export declare function reserveProofId(authId: bigint): bigint;
/** A random 248-bit commitment salt. Keep it with X; it is what verifiers need. */
export declare function randomReserveSalt(): bigint;
/** `prove_reserve_derive(caller, k: u256, token, threshold: u128, commitment_salt,
 *  mode: u8, valid_for_secs: u64, reserve_note_salt: u128, change_note_salt: u128)`
 *  (auth_nonce + signature are appended by the prover's signer). */
export declare function buildProveReserveDeriveCalldata(args: {
    caller: bigint;
    ownerPrivateViewingKey: bigint;
    token: bigint;
    threshold: bigint;
    commitmentSalt: bigint;
    mode: ReserveMode;
    validForSecs: bigint;
    /** Lock mode: note salts (2 <= salt < 2^120). Ignored for a snapshot. */
    reserveNoteSalt: bigint;
    changeNoteSalt: bigint;
}): string[];
/** `revoke_reserve_derive(caller, proof_id)`. */
export declare function buildRevokeReserveDeriveCalldata(caller: bigint, proofId: bigint): string[];
export interface ReserveView {
    holder: bigint;
    token: bigint;
    mode: ReserveMode;
    baseBlock: bigint;
    createdAt: bigint;
    expiresAt: bigint;
}
/** Calls `verify_reserve`. Resolves to the proof, or rejects with the pool's
 *  reason: PROOF_UNKNOWN / PROOF_REVOKED / PROOF_INVALIDATED / PROOF_EXPIRED /
 *  BAD_COMMITMENT (in the RPC error message). */
export declare function verifyReserve(provider: RpcProvider, pool: BigNumberish, proofId: bigint, threshold: bigint, salt: bigint): Promise<ReserveView>;
/** Status without the opening (anyone can read it). */
export declare function getReserveStatus(provider: RpcProvider, pool: BigNumberish, proofId: bigint): Promise<ReserveStatus>;
