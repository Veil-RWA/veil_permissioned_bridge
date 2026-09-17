import { type CancelOrderArgs, type MakerOpening, type Order, type PostOrderArgs, type SenderBalanceRules } from "./dvp.js";
import { type VeilCallOptions, type VeilProverConfig } from "./prover/veilProver.js";
/** Same config as `VeilProver`, but `pool` is pinned to "erc3643" (the DvP lives
 *  only on the ERC-3643 pool). */
export type VeilDvpMakerConfig = Omit<VeilProverConfig, "pool">;
export declare class VeilDvpMaker {
    private readonly prover;
    private readonly veilAddress;
    constructor(config: VeilDvpMakerConfig);
    /** Lock `order.offerAmount` of `order.offerToken` and rest a limit order for
     *  `order.wantAmount` of `order.wantToken`. Proves `post_order_derive` and
     *  submits `post_order_settle`. */
    postOrder(args: PostOrderArgs, opts?: VeilCallOptions): Promise<import("./index.js").VeilProveAndSettleResult>;
    /** Streaming variant of {@link postOrder} (phase / log / program_hash). */
    postOrderStream(args: PostOrderArgs, opts?: VeilCallOptions): AsyncGenerator<import("./index.js").VeilEvent, void, void>;
    /** Cancel (if OPEN) and/or reclaim leftover escrow as a PRIVATE note. Works on
     *  an OPEN order (stops fills + returns remainder) or a FILLED order that still
     *  has price-improvement / rounding leftover. Proves `cancel_order_derive`. */
    cancelOrder(args: CancelOrderArgs, opts?: VeilCallOptions): Promise<import("./index.js").VeilProveAndSettleResult>;
    /** Streaming variant of {@link cancelOrder}. */
    cancelOrderStream(args: CancelOrderArgs, opts?: VeilCallOptions): AsyncGenerator<import("./index.js").VeilEvent, void, void>;
    /** What the maker gives the exchange for this order: its address, the salt
     *  behind the order's commitment, and the rules snapshot the post proof hashed
     *  (read with {@link rulesSnapshot} just before posting). */
    opening(order: Order, makerRules: SenderBalanceRules): MakerOpening;
    /** The pool's `get_sender_balance_rules(offer_token, maker)`: the rules a post
     *  proof reads now. If the issuer changes them before the proof's base block,
     *  the order's hash will not match this snapshot; re-read and re-post. */
    rulesSnapshot(reader: {
        getSenderBalanceRules(token: bigint, holder: bigint): Promise<SenderBalanceRules>;
    }, order: Order): Promise<SenderBalanceRules>;
    /** The deterministic order_id for an order (bound to this pool + chain). Use
     *  it to track the order on-chain (`get_order`) and to reference it at cancel.
     *  `pool` defaults to the configured veilAddress. */
    orderId(order: Order, chainId: bigint, pool?: bigint): bigint;
}
