export declare const DOMAIN_ORDER_ID: bigint;
export declare const DOMAIN_BATCH_ID: bigint;
/** A maker order: lock `offerAmount` of `offerToken`, want `wantAmount` of
 *  `wantToken`. The limit price the exchange must honour is offer/want. */
export interface Order {
    maker: bigint;
    offerToken: bigint;
    offerAmount: bigint;
    wantToken: bigint;
    wantAmount: bigint;
    expiry: bigint;
    nonce: bigint;
}
/** One per-order fill in a batch: deliver `deliver` of the order's want token to
 *  the maker, drawing `draw` of its offer token from the escrow. Arbitrary
 *  amounts — the contract enforces draw·want ≤ deliver·offer (limit price),
 *  draw ≤ escrow, received+deliver ≤ want_amount, and batch conservation. */
export interface BatchFill {
    deliver: bigint;
    draw: bigint;
}
/** On-chain order state (from `get_order`). */
export interface OrderRecord {
    maker: bigint;
    offerToken: bigint;
    wantToken: bigint;
    offerAmount: bigint;
    wantAmount: bigint;
    escrowRemaining: bigint;
    received: bigint;
    receiveNoteId: bigint;
    expiry: bigint;
    status: number;
}
export declare const ORDER_OPEN = 0;
export declare const ORDER_FILLED = 1;
export declare const ORDER_CANCELLED = 2;
/** compute_order_id — binds the order to a pool + chain so it can't be replayed
 *  across deployments. */
export declare function computeOrderId(pool: bigint, chainId: bigint, order: Order): bigint;
/** compute_batch_id — binds the order set AND the per-order (deliver, draw)
 *  fills, so the exchange signature authorizes exactly the amounts that move.
 *  Inner hashes: poseidon(order_ids) and poseidon([deliver0, draw0, …]). */
export declare function computeBatchId(pool: bigint, chainId: bigint, batchNonce: bigint, orderIds: bigint[], fills: BatchFill[]): bigint;
export interface PostOrderArgs {
    maker: bigint;
    /** Private viewing key — goes into the proof witness, never on-chain. */
    makerPrivateViewingKey: bigint;
    order: Order;
    /** Fresh salt for the private change note (the remainder of the funding
     *  notes beyond `offerAmount`). */
    changeNoteSalt: bigint;
    /** Salt opening the want-token self-subchannel if it's the maker's first. */
    receiveSubchannelSalt: bigint;
}
/** Calldata for `post_order_derive(maker, k: u256, offer_token, offer_amount:
 *  u128, want_token, want_amount: u128, expiry: u64, nonce, change_note_salt:
 *  u128, receive_subchannel_salt)`. */
export declare function buildPostOrderDeriveCalldata(args: PostOrderArgs): string[];
export interface CancelOrderArgs {
    maker: bigint;
    makerPrivateViewingKey: bigint;
    orderId: bigint;
    /** Fresh salt for the private note the leftover escrow returns into. */
    leftoverNoteSalt: bigint;
}
/** Calldata for `cancel_order_derive(maker, k: u256, order_id, leftover_note_salt:
 *  u128)`. */
export declare function buildCancelOrderDeriveCalldata(args: CancelOrderArgs): string[];
/** Classify a raw note `encrypted_amount` cell.
 *  - `open`: salt=1 reserved → the low 128 bits are the PLAINTEXT amount (a DvP
 *    receive note / open note). `amount === 0n` means an UNFILLED open note,
 *    which is NOT spendable (its nullifier must not be burned).
 *  - `regular`: a normally-encrypted note; decrypt with `decryptNoteAmount`. */
export declare function classifyNote(enc: bigint): {
    kind: "empty";
} | {
    kind: "open";
    amount: bigint;
} | {
    kind: "regular";
};
/** The empty open-note encoding (salt=1, amount=0). */
export declare const EMPTY_OPEN_NOTE: bigint;
