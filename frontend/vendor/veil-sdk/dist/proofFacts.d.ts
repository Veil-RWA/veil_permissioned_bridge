import type { BigNumberish } from "starknet";
export declare const PROOF_VERSION: bigint;
export declare const VIRTUAL_SNOS: bigint;
export declare const VIRTUAL_SNOS0: bigint;
export declare const VIRTUAL_PROGRAM_HASH = "0x3e98c2d7703b03a7edb73ed7f075f97f1dcbaa8f717cdf6e1a57bf058265473";
export declare const STRK_FEE_TOKEN_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
export declare const STARKNET_OS_CONFIG_HASH_VERSION = "0x537461726b6e65744f73436f6e66696733";
/** Virtual-OS config hash: Pedersen(version, chain_id, strk_fee_token). */
export declare function computeVirtualOsConfigHash(chainId: BigNumberish, strkFeeTokenAddress?: BigNumberish): string;
/** L2->L1 message payload the pool emits: `[pool_class_hash, ...server_actions]`. */
export declare function buildMessagePayload(poolClassHash: BigNumberish, serverActionsCalldata: BigNumberish[]): string[];
/** Message hash the contract binds the proof to:
 *  `poseidon([pool_address, 0, payload_len, ...payload])`. */
export declare function computeMessageHash(poolAddress: BigNumberish, poolClassHash: BigNumberish, serverActionsCalldata: BigNumberish[]): bigint;
export interface ProofFactsInput {
    poolAddress: BigNumberish;
    poolClassHash: BigNumberish;
    /** Serialized `<op>_settle` server actions (the proof's message payload tail). */
    serverActionsCalldata: BigNumberish[];
    baseBlockNumber: bigint;
    baseBlockHash: BigNumberish;
    chainId: BigNumberish;
}
/** Build the 9-felt `proof_facts` array the settle tx must carry. Layout:
 *  [0] proof_version 'PROOF0'  [1] program_variant 'VIRTUAL_SNOS'
 *  [2] virtual_program_hash    [3] os_output_version 'VIRTUAL_SNOS0'
 *  [4] base_block_number       [5] base_block_hash
 *  [6] os_config_hash          [7] message_hashes len (1)
 *  [8] message_hash            */
export declare function buildProofFacts(input: ProofFactsInput): string[];
/** True iff `actual` proof_facts equals the array we expect for `input`.
 *  Use to verify a settle tx (its `proof_facts`, fetched from the RPC) binds to
 *  exactly the actions/reference-block the caller intended. Length-safe and
 *  case-insensitive on hex. */
export declare function verifyProofFacts(input: ProofFactsInput, actual: BigNumberish[]): boolean;
