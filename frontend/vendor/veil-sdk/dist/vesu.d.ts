import type { VeilERC3643Reader } from "./erc3643.js";
import { type VeilCallOptions, type VeilProverConfig } from "./prover/veilProver.js";
import type { VeilProveAndSettleResult } from "./prover/types.js";
/** Matches `veilvesu::interfaces::helper::LendingOperation`, and StarkWare's
 *  `vesu_lending_anonymizer::LendingOperation` before it — same two variants in
 *  the same order, so calldata built for the reference helper deserializes
 *  against ours unchanged. */
export declare enum LendingOperation {
    /** Underlying in, vToken shares out. */
    Deposit = 0,
    /** vToken shares in, underlying out. */
    Withdraw = 1
}
export interface VeilVesuConfig extends VeilProverConfig {
    /** The `VeilVesuHelper`. Must be an ALLOWLISTED ADAPTER on the Veil pool and a
     *  registered identity under both tokens' registries — it custodies the
     *  permissioned asset for the length of the transaction. */
    helper: string;
    /** Key-free batch reader for the Veil ERC-3643 pool, used to find the next
     *  free note slot. Never sees a private viewing key. */
    reader: VeilERC3643Reader;
}
export interface PrivateLendArgs {
    owner: bigint;
    /** Stays on the device: it goes into the proof witness, never on-chain. */
    ownerPrivateViewingKey: bigint;
    /** The owner's PUBLIC viewing key, from `get_viewing_key` on the pool. */
    ownerPublicViewingKey: bigint;
    /** The permissioned asset being supplied. */
    asset: bigint;
    /** Its Vesu vToken. */
    vToken: bigint;
    /** How much to supply, u128. */
    amount: bigint;
    /** Salt for the private change note left behind by the spend, u128. */
    changeNoteSalt: bigint;
    /** Salt that opens the vToken's self-subchannel, if this is the owner's first
     *  note of it. */
    subchannelSalt: bigint;
    /** Fresh per-call ECDH secret encrypting the note owner to the auditor.
     *  Never reuse one. */
    auditEphemeralSecret: bigint;
}
/** Redeeming is the same shape with the tokens swapped, so it shares the type;
 *  `amount` is a share count rather than an asset amount. */
export type PrivateRedeemArgs = PrivateLendArgs;
export interface PrivateLendPlan {
    /** The open note the proceeds land in. */
    noteId: bigint;
    noteIndex: number;
    channelKey: bigint;
    operation: LendingOperation;
    inToken: bigint;
    outToken: bigint;
    /** The adapter calldata, bound to the proof by its Poseidon hash. */
    invokeCalldata: string[];
    calldataHash: bigint;
    deriveCalldata: string[];
    settleExtra: string[];
}
/** `privacy_invoke(operation, in_token, out_token, assets: u256, note_id)`.
 *
 *  The calldata layout of StarkWare's `vesu_lending_anonymizer::privacy_invoke`,
 *  unchanged — a helper written against the STRK20 privacy pool needs no
 *  modification to serve Veil. */
export declare function buildVesuInvokeCalldata(args: {
    operation: LendingOperation;
    inToken: bigint;
    outToken: bigint;
    /** MUST equal the `inAmount` the pool pays, or the helper's
     *  input-fully-consumed check reverts the transaction. */
    assets: bigint;
    noteId: bigint;
}): string[];
/**
 * Drives private supply and redeem against a Vesu v2 vToken.
 *
 * The private viewing key goes into the proof witness and never onto the chain;
 * the transaction itself should be submitted by the prover service or a relayer,
 * since a wallet that signs it links itself to the note.
 */
export declare class VeilVesuClient {
    private readonly prover;
    private readonly reader;
    readonly helper: string;
    constructor(config: VeilVesuConfig);
    /** The owner's SELF channel — where their own deposits, change and open notes
     *  live (sender == recipient == owner). */
    selfChannelKey(owner: bigint, k: bigint, ownerPublicViewingKey: bigint): bigint;
    /** The first unused note slot in a token's subchannel. Notes are contiguous
     *  (STRK20 Theorem 1), so the first empty slot is the next one the contract
     *  will assign — which is how the note id is known before the note exists. */
    nextNoteIndex(channelKey: bigint, token: bigint, page?: number): Promise<number>;
    private plan;
    /** Resolve the note id and build every piece of calldata for a supply.
     *  Nothing is submitted. */
    planLend(args: PrivateLendArgs): Promise<PrivateLendPlan>;
    /** Same, for a redeem. `amount` is a SHARE count. */
    planRedeem(args: PrivateRedeemArgs): Promise<PrivateLendPlan>;
    /** Supply the asset into Vesu; the shares land in a private note. */
    lend(args: PrivateLendArgs, opts?: VeilCallOptions): Promise<{
        plan: PrivateLendPlan;
        result: VeilProveAndSettleResult;
    }>;
    /** Redeem shares back to the underlying, into a private note. */
    redeem(args: PrivateRedeemArgs, opts?: VeilCallOptions): Promise<{
        plan: PrivateLendPlan;
        result: VeilProveAndSettleResult;
    }>;
    /** Streaming variant (phase / log / program_hash events). */
    lendStream(args: PrivateLendArgs, opts?: VeilCallOptions): Promise<{
        plan: PrivateLendPlan;
        events: AsyncGenerator<import("./index.js").VeilEvent, void, void>;
    }>;
}
/** Matches `veilvesu::borrow_router::BorrowOperation`. */
export declare enum BorrowOperation {
    /** Collateral in, borrowed asset out. */
    Borrow = 0,
    /** Repayment in, released collateral out. */
    Repay = 1
}
/**
 * `privacy_invoke(operation, salt, collateral_asset, debt_asset, in_amount,
 * out_amount, note_id)` on `VeilBorrowRouter`.
 */
export declare function buildBorrowInvokeCalldata(args: {
    operation: BorrowOperation;
    /** Identifies the borrower's position vault. See `deriveBorrowSalt`. */
    salt: bigint;
    collateralAsset: bigint;
    debtAsset: bigint;
    /** MUST equal what the pool pays in, or the router reverts. */
    inAmount: bigint;
    /** How much to draw (Borrow) or how much collateral to release (Repay). */
    outAmount: bigint;
    noteId: bigint;
}): string[];
/**
 * The salt that addresses a borrower's position vault.
 *
 * `poseidon(viewing_key, nonce)`. The salt travels in the settle calldata and is
 * therefore PUBLIC, but it is a hash of a secret, so it does not invert to an
 * identity. Two consequences worth stating plainly to a user:
 *
 *   * every operation on the same position touches the same vault address, so
 *     those operations are linkable TO EACH OTHER — a debt position has to
 *     persist, so this cannot be designed away;
 *   * a borrower who wants two unlinkable exposures needs two nonces, and each
 *     position is separately collateralised.
 */
export declare function deriveBorrowSalt(ownerPrivateViewingKey: bigint, nonce: bigint): bigint;
export interface AnonymousBorrowArgs {
    owner: bigint;
    ownerPrivateViewingKey: bigint;
    ownerPublicViewingKey: bigint;
    /** From `deriveBorrowSalt`. Reuse it to add to or repay the same position. */
    salt: bigint;
    collateralAsset: bigint;
    debtAsset: bigint;
    /** Collateral to post (Borrow) or repayment to make (Repay), u128. */
    inAmount: bigint;
    /** Amount to draw (Borrow) or collateral to release (Repay), u128. */
    outAmount: bigint;
    changeNoteSalt: bigint;
    subchannelSalt: bigint;
    auditEphemeralSecret: bigint;
}
export interface AnonymousBorrowPlan {
    noteId: bigint;
    noteIndex: number;
    channelKey: bigint;
    operation: BorrowOperation;
    inToken: bigint;
    outToken: bigint;
    invokeCalldata: string[];
    calldataHash: bigint;
    deriveCalldata: string[];
    settleExtra: string[];
}
export interface VeilVesuBorrowConfig extends VeilProverConfig {
    /** The `VeilBorrowRouter` — one allowlisted adapter serving every borrower. */
    router: string;
    reader: VeilERC3643Reader;
}
/**
 * Drives anonymous borrowing against Vesu.
 *
 * The borrower's Vesu position lives in a `VeilBorrowVault` at a salt-derived
 * address, isolated from every other borrower's — which is the whole reason this
 * needs a router and per-position contracts rather than the single stateless
 * helper that serves lending. Collateral is spent from private notes and the
 * borrowed asset is credited to a private note, in one proven transaction. The
 * borrower signs nothing.
 */
export declare class VeilVesuBorrowClient {
    private readonly prover;
    private readonly reader;
    readonly router: string;
    constructor(config: VeilVesuBorrowConfig);
    selfChannelKey(owner: bigint, k: bigint, ownerPublicViewingKey: bigint): bigint;
    nextNoteIndex(channelKey: bigint, token: bigint, page?: number): Promise<number>;
    private plan;
    planBorrow(args: AnonymousBorrowArgs): Promise<AnonymousBorrowPlan>;
    planRepay(args: AnonymousBorrowArgs): Promise<AnonymousBorrowPlan>;
    /** Post collateral from private notes and receive the borrowed asset into a
     *  private note. */
    borrow(args: AnonymousBorrowArgs, opts?: VeilCallOptions): Promise<{
        plan: AnonymousBorrowPlan;
        result: VeilProveAndSettleResult;
    }>;
    /** Repay from private notes and take the released collateral back into one. */
    repay(args: AnonymousBorrowArgs, opts?: VeilCallOptions): Promise<{
        plan: AnonymousBorrowPlan;
        result: VeilProveAndSettleResult;
    }>;
}
