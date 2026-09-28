import { type ExecuteBatchArgs, type VenueFillArgs } from "./dvp.js";
import { type VeilCallOptions, type VeilProverConfig } from "./prover/veilProver.js";
/** Same config as `VeilProver`, pinned to the ERC-3643 pool. `signer` is the
 *  exchange account registered with `set_exchange`. */
export type VeilDvpExchangeConfig = Omit<VeilProverConfig, "pool">;
export declare class VeilDvpExchange {
    private readonly prover;
    private readonly veilAddress;
    constructor(config: VeilDvpExchangeConfig);
    /** The batch's replay-guard id (`is_batch_used`). */
    batchId(args: ExecuteBatchArgs, chainId: bigint): bigint;
    /** Prove `execute_batch_derive` and submit `execute_batch_settle`. */
    executeBatch(args: ExecuteBatchArgs, opts?: VeilCallOptions): Promise<import("./index.js").VeilProveAndSettleResult>;
    /** Prove `venue_fill_derive` and submit `venue_fill_settle`: apply an
     *  external venue's receipts (HyperVeil) to their makers' receive notes. */
    venueFill(args: VenueFillArgs, opts?: VeilCallOptions): Promise<import("./index.js").VeilProveAndSettleResult>;
    /** Streaming variant of {@link executeBatch}. */
    executeBatchStream(args: ExecuteBatchArgs, opts?: VeilCallOptions): AsyncGenerator<import("./index.js").VeilEvent, void, void>;
}
