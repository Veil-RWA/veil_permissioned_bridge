export declare const DOMAIN_ORDER_ID: bigint;
export declare const DOMAIN_BATCH_ID: bigint;
export declare const DOMAIN_MAKER: bigint;
export declare const DOMAIN_RULES: bigint;
/** A maker order: lock `offerAmount` of `offerToken`, want `wantAmount` of
 *  `wantToken`. The limit price the exchange must honour is offer/want. */
export interface Order {
    maker: bigint;
    /** Secret, non-zero, fresh per order: hides the maker behind the commitment.
     *  Shared only with the exchange (in the maker's opening). */
    makerSalt: bigint;
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
/** On-chain order state (from `get_order`). No maker address: only its
 *  commitment, and the address encrypted to the auditor. */
export interface OrderRecord {
    makerCommitment: bigint;
    encMaker: {
        auditorPublicKey: bigint;
        ephemeralPubkey: bigint;
        encUserAddr: bigint;
    };
    offerToken: bigint;
    wantToken: bigint;
    offerAmount: bigint;
    wantAmount: bigint;
    escrowRemaining: bigint;
    received: bigint;
    receiveNoteId: bigint;
    expiry: bigint;
    status: number;
    makerRulesHash: bigint;
}
/** A rules token's balance rules for the maker as the post proof read them
 *  (`get_sender_balance_rules(offer_token, maker)`; all-neutral for other
 *  token kinds). */
export interface SenderBalanceRules {
    fullRequired: boolean;
    capped: boolean;
    locked: bigint;
    minResidual: bigint;
    residualStrict: boolean;
}
export declare const NEUTRAL_RULES: SenderBalanceRules;
/** What a maker gives the exchange so its batch proof can open the order's
 *  commitment and rules hash. */
export interface MakerOpening {
    maker: bigint;
    makerSalt: bigint;
    makerRules: SenderBalanceRules;
}
export declare const ORDER_OPEN = 0;
export declare const ORDER_FILLED = 1;
export declare const ORDER_CANCELLED = 2;
/** compute_maker_commitment — what the order stores instead of the maker. */
export declare function computeMakerCommitment(maker: bigint, makerSalt: bigint): bigint;
/** hash_rules — the order's `maker_rules_hash`. */
export declare function hashRules(rules: SenderBalanceRules): bigint;
/** compute_order_id — binds the order to a pool + chain so it can't be replayed
 *  across deployments. */
export declare function computeOrderId(pool: bigint, chainId: bigint, order: Order): bigint;
/** compute_batch_id — binds the order set AND the per-order (deliver, draw)
 *  fills: the replay guard (`is_batch_used`) for exactly the amounts proven.
 *  Inner hashes: poseidon(order_ids) and poseidon([deliver0, draw0, …]). */
export declare function computeBatchId(pool: bigint, chainId: bigint, batchNonce: bigint, orderIds: bigint[], fills: BatchFill[]): bigint;
export interface PostOrderArgs {
    maker: bigint;
    /** Private viewing key — goes into the proof witness, never on-chain. */
    makerPrivateViewingKey: bigint;
    order: Order;
    /** Fresh randomness encrypting the maker's address to the auditor. */
    auditEphemeralSecret: bigint;
    /** Fresh salt for the private change note (the remainder of the funding
     *  notes beyond `offerAmount`). 0 and 1 are reserved. */
    changeNoteSalt: bigint;
    /** Salt opening the offer-token self-subchannel if it doesn't exist yet. */
    offerSubchannelSalt: bigint;
    /** Salt opening the want-token self-subchannel if it doesn't exist yet. */
    receiveSubchannelSalt: bigint;
}
/** Calldata for `post_order_derive(maker, k: u256, offer_token, offer_amount:
 *  u128, want_token, want_amount: u128, expiry: u64, nonce, maker_salt,
 *  audit_ephemeral_secret_r, change_note_salt: u128, offer_subchannel_salt,
 *  receive_subchannel_salt)`. */
export declare function buildPostOrderDeriveCalldata(args: PostOrderArgs): string[];
export interface CancelOrderArgs {
    maker: bigint;
    makerPrivateViewingKey: bigint;
    orderId: bigint;
    /** The salt the order was posted with (opens its commitment). */
    makerSalt: bigint;
    /** Fresh salt for the private note the leftover escrow returns into. 0 and 1
     *  are reserved. */
    leftoverNoteSalt: bigint;
}
/** Calldata for `cancel_order_derive(maker, k: u256, order_id, maker_salt,
 *  leftover_note_salt: u128)`. */
export declare function buildCancelOrderDeriveCalldata(args: CancelOrderArgs): string[];
export interface ExecuteBatchArgs {
    orderIds: bigint[];
    fills: BatchFill[];
    /** Unique per batch — replay-guards the batch (batch_id includes it). */
    batchNonce: bigint;
    /** One opening per order, in order: the maker of `orderIds[i]`. */
    makers: MakerOpening[];
}
/** Calldata for `execute_batch_derive(order_ids: Array<felt252>, fills:
 *  Array<BatchFill>, batch_nonce, makers: Array<MakerOpening>)`. */
export declare function buildExecuteBatchDeriveCalldata(args: ExecuteBatchArgs): string[];
/** Args for the external-venue fill (HyperVeil): the exchange applies venue
 *  receipts (amounts are read from the venue at settle, never supplied here)
 *  to their makers' receive notes, opening each maker as for a batch. */
export interface VenueFillArgs {
    receiptIds: bigint[];
    makers: MakerOpening[];
}
/** Calldata for `venue_fill_derive(receipt_ids: Array<felt252>,
 *  makers: Array<MakerOpening>)`, before the authorization is appended. */
export declare function buildVenueFillDeriveCalldata(args: VenueFillArgs): string[];
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
