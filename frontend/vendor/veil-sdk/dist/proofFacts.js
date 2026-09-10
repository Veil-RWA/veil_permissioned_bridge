// Client-side SNIP-36 `proof_facts` construction for Veil settle transactions.
//
// The Veil prover service (see prover/veil.ts) proves `<op>_derive`, reads the
// derived L2->L1 message, assembles `<op>_settle` calldata, and submits it via
// the sequencer carrying the proof + proof_facts. Today the SDK trusts the
// `local_tx_hash` the SERVER returns. This module lets the CLIENT independently
// reconstruct the proof_facts the settle tx must carry, so a caller can verify
// the prover submitted exactly the actions it was asked to prove — closing the
// "trust the hosted prover" gap.
//
// The layout below is the SNIP-36 wire format shared by the blockifier (which
// validates the header) and the Cairo pool's `validate_proof` (Serde-decodes
// the same array). The version headers, virtual-OS program hash, config-hash
// scheme, and STRK fee-token address are Starknet-level constants — identical
// for every SNIP-36 app, Veil included. Reference: StarkWare's starknet-privacy
// SDK (`sdk/src/utils/proof-facts.ts`) and blockifier versioned constants.
//
// The ONE app-specific piece is the L2->L1 message payload the pool emits, over
// which the message hash is taken. This mirrors the reference layout
// `[pool_class_hash, ...server_actions]`; confirm it against Veil's Cairo
// `_compute_message_hash` before relying on the check for a given pool version.
import { ec, hash, num, shortString } from "starknet";
const toFelt = (s) => BigInt(shortString.encodeShortString(s));
const toHex = (v) => num.toHex(v);
const toBig = (v) => BigInt(num.toHex(v));
// ── SNIP-36 / virtual-OS constants (Starknet-level; same for all apps) ────────
export const PROOF_VERSION = toFelt("PROOF0");
export const VIRTUAL_SNOS = toFelt("VIRTUAL_SNOS");
export const VIRTUAL_SNOS0 = toFelt("VIRTUAL_SNOS0");
// Allowed virtual-OS program hash (blockifier versioned constants, 0.14.2).
// Pin/bump this per the sequencer version the target network runs.
export const VIRTUAL_PROGRAM_HASH = "0x3e98c2d7703b03a7edb73ed7f075f97f1dcbaa8f717cdf6e1a57bf058265473";
// STRK fee token — same address on mainnet/sepolia/devnet.
export const STRK_FEE_TOKEN_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
// shortString("StarknetOsConfig3").
export const STARKNET_OS_CONFIG_HASH_VERSION = "0x537461726b6e65744f73436f6e66696733";
/** Virtual-OS config hash: Pedersen(version, chain_id, strk_fee_token). */
export function computeVirtualOsConfigHash(chainId, strkFeeTokenAddress = STRK_FEE_TOKEN_ADDRESS) {
    return hash.computeHashOnElements([
        STARKNET_OS_CONFIG_HASH_VERSION,
        chainId,
        strkFeeTokenAddress,
    ]);
}
/** L2->L1 message payload the pool emits: `[pool_class_hash, ...server_actions]`. */
export function buildMessagePayload(poolClassHash, serverActionsCalldata) {
    return [toHex(poolClassHash), ...serverActionsCalldata.map(toHex)];
}
/** Message hash the contract binds the proof to:
 *  `poseidon([pool_address, 0, payload_len, ...payload])`. */
export function computeMessageHash(poolAddress, poolClassHash, serverActionsCalldata) {
    const payload = buildMessagePayload(poolClassHash, serverActionsCalldata);
    return ec.starkCurve.poseidonHashMany([
        toBig(poolAddress),
        0n,
        BigInt(payload.length),
        ...payload.map(toBig),
    ]);
}
/** Build the 9-felt `proof_facts` array the settle tx must carry. Layout:
 *  [0] proof_version 'PROOF0'  [1] program_variant 'VIRTUAL_SNOS'
 *  [2] virtual_program_hash    [3] os_output_version 'VIRTUAL_SNOS0'
 *  [4] base_block_number       [5] base_block_hash
 *  [6] os_config_hash          [7] message_hashes len (1)
 *  [8] message_hash            */
export function buildProofFacts(input) {
    const messageHash = computeMessageHash(input.poolAddress, input.poolClassHash, input.serverActionsCalldata);
    return [
        toHex(PROOF_VERSION),
        toHex(VIRTUAL_SNOS),
        VIRTUAL_PROGRAM_HASH,
        toHex(VIRTUAL_SNOS0),
        toHex(input.baseBlockNumber),
        toHex(toBig(input.baseBlockHash)),
        computeVirtualOsConfigHash(input.chainId),
        "0x1",
        toHex(messageHash),
    ];
}
/** True iff `actual` proof_facts equals the array we expect for `input`.
 *  Use to verify a settle tx (its `proof_facts`, fetched from the RPC) binds to
 *  exactly the actions/reference-block the caller intended. Length-safe and
 *  case-insensitive on hex. */
export function verifyProofFacts(input, actual) {
    const expected = buildProofFacts(input);
    if (actual.length !== expected.length)
        return false;
    return expected.every((e, i) => toBig(e) === toBig(actual[i]));
}
