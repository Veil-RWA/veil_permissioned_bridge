export declare const U128_MAX: bigint;
export declare function assertU128(name: string, v: bigint): void;
export declare const hex: (v: bigint) => string;
/** Split a u256 into the (low, high) felt pair Cairo expects. */
export declare function u256Felts(v: bigint): [string, string];
/** `invoke_derive(caller, owner_private_viewing_key: u256, in_token,
 *  in_amount: u128, out_token, target, calldata_hash, audit_ephemeral_secret_r,
 *  change_note_salt: u128, subchannel_salt)`. */
export declare function buildInvokeDeriveCalldata(args: {
    caller: bigint;
    ownerPrivateViewingKey: bigint;
    inToken: bigint;
    inAmount: bigint;
    outToken: bigint;
    /** The adapter. Must be owner-allowlisted on the pool and a verified identity
     *  under BOTH tokens' registries. */
    target: bigint;
    calldataHash: bigint;
    /** Per-call ECDH secret used to encrypt the note owner to the auditor. MUST
     *  be freshly random for every call: reusing it against the same auditor key
     *  reproduces the mask and makes the ciphertext linkable (OZ audit of the
     *  STRK20 pool, L-05). The contract can only check it is non-zero. */
    auditEphemeralSecret: bigint;
    changeNoteSalt: bigint;
    subchannelSalt: bigint;
}): string[];
/** The Poseidon hash `invoke_settle` recomputes over the adapter calldata. It
 *  binds the arguments to the proof without carrying them in the message, so
 *  neither the route nor the amounts nor the note can be swapped after
 *  proving. */
export declare function invokeCalldataHash(calldata: string[]): bigint;
