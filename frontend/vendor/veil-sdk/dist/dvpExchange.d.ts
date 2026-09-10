import { Account } from "starknet";
import { type BatchFill } from "./dvp.js";
export interface VeilDvpExchangeConfig {
    /** The deployed ERC-3643 pool address (hex or bigint). */
    poolAddress: string | bigint;
    /** Chain id (felt) the pool was deployed on — bound into batch_id. */
    chainId: bigint;
    /** The exchange account's STARK private key (hex or bigint). Signs `batch_id`;
     *  the matching `is_valid_signature` must be registered via `set_exchange`. */
    exchangePrivateKey: string | bigint;
    /** starknet.js Account that SUBMITS the tx and pays gas. May be the exchange
     *  account or a separate relayer — the signature does not depend on it. When
     *  omitted, use {@link buildBatchCall} and submit yourself. */
    submitter?: Account;
}
export interface ExecuteBatchArgs {
    orderIds: bigint[];
    fills: BatchFill[];
    /** Unique per batch — replay-guards the batch (batch_id includes it). */
    batchNonce: bigint;
}
export declare class VeilDvpExchange {
    private readonly pool;
    private readonly chainId;
    private readonly exchangeKey;
    private readonly submitter?;
    constructor(config: VeilDvpExchangeConfig);
    /** The batch_id the exchange signature authorizes. */
    batchId(args: ExecuteBatchArgs): bigint;
    /** STARK signature `[r, s]` over batch_id, as the contract's
     *  `is_valid_account_sig` expects from the exchange account. */
    signBatch(args: ExecuteBatchArgs): string[];
    /** Build the `execute_batch_settle` invocation (calldata-serialized) without
     *  submitting — for callers that manage their own tx submission. */
    buildBatchCall(args: ExecuteBatchArgs): {
        contractAddress: string;
        entrypoint: string;
        calldata: string[];
    };
    /** Sign + submit the batch via the configured `submitter`. Returns the
     *  transaction hash. Requires `submitter` in the config. */
    executeBatch(args: ExecuteBatchArgs): Promise<string>;
}
