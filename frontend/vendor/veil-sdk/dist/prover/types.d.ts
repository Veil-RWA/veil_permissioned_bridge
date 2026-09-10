/** Service-targeting config. All optional; each falls back to the DEFAULT_*
 *  constants so the hosted service works with no setup. */
export interface ProverServiceConfig {
    /** Base URL of the SNIP-36 prover service. */
    endpoint?: string;
    /** Starknet RPC used for read-only nonce lookups. */
    rpcUrl?: string;
    /** Master account used for the server-side fallback nonce when no
     *  `privateKey` + `senderAddress` are supplied. */
    masterAddress?: string;
}
/** The Veil operation to run. The prover service runs `<op>_derive` against
 *  `veilAddress`, then assembles + submits `<op>_settle` with the proof. Both
 *  Veil pools are supported, but they share function names while emitting
 *  different message layouts, so the server keys its settle-calldata assembly by
 *  `(pool, operation)` — set `pool` accordingly. The literals below are hints
 *  across both pools; `string & {}` keeps the type open. */
export type VeilOperation = "register_viewing_key" | "deposit" | "create_open_note" | "invoke" | "private_transfer" | "withdraw" | "forced_transfer" | "post_order" | "cancel_order" | "approve_private_transfer" | "private_transfer_as_approved" | "revoke_private_approval" | (string & {});
/** Which pool the operation targets. The server selects its settle-assembly
 *  table from this. */
export type VeilPool = "erc721" | "erc3643" | (string & {});
export interface VeilProveAndSettleInput extends ProverServiceConfig {
    /** Prover transport. "sse" (default) streams from a long-running prover;
     *  "job" submits to a pay-per-use deployment and polls for the result. */
    transport?: "sse" | "job";
    /** Which Veil operation to run. */
    operation: VeilOperation;
    /** Which pool: "erc721" (default) or "erc3643". */
    pool?: VeilPool;
    /** The deployed Veil contract address (hex). */
    veilAddress: string;
    /** ABI-serialized calldata for `<operation>_derive` (hex felts). u256 args
     *  occupy two felts (low, high); ContractAddress/felt252/u128 are one each. */
    deriveCalldata: string[];
    /** Settle-only inputs not present in the derive call or the proven message.
     *  e.g. `withdraw` on the NFT pool: `[recipient]`. */
    settleExtra?: string[];
    /** Sender nonce (hex). When omitted, the client fetches the current on-chain
     *  nonce (for `senderAddress` if a `privateKey` is supplied, else the master
     *  account the server signs with). */
    nonce?: string;
    /** Reference block to prove against. Defaults to latest-1 if omitted. */
    blockNumber?: number;
    /** Optional signer key (hex). When omitted, the server uses its env master
     *  key + master sender. */
    privateKey?: string;
    /** Sender account hex address. Required when `privateKey` is supplied. */
    senderAddress?: string;
    /** Abort the request mid-stream. */
    signal?: AbortSignal;
}
/** Final result emitted by the Veil server's `complete` SSE event. */
export interface VeilProveAndSettleResult {
    operation: string;
    /** Tx hash returned by the gateway after submission. */
    txHash: string;
    /** Tx hash computed locally with proof_facts (sanity check). */
    localTxHash: string;
    /** Block the derive proof was generated against. */
    referenceBlock: number;
    proofDurationSecs: number;
    /** Number of felts in the assembled settle calldata. */
    settleCalldataLen: number;
}
/** A single SSE event from the Veil endpoint. The `program_hash` event carries
 *  the proven program hash (`proof_facts[2]`). */
export type VeilEvent = {
    type: "phase";
    phase: "proving" | "submitting" | string;
} | {
    type: "log";
    line: string;
} | {
    type: "program_hash";
    programHash: string;
} | {
    type: "complete";
    result: VeilProveAndSettleResult;
} | {
    type: "error";
    message: string;
};
