// Veil × Vesu — private lending of a permissioned asset.
//
// The STRK20 lending cycle, in ONE proven transaction each way:
//
//   spend private notes of the asset  ->  reserve an empty OPEN NOTE for the
//   vToken  ->  pay the lending helper  ->  call its `privacy_invoke`, which
//   deposits into Vesu and measures the shares that arrived  ->  apply what it
//   returns by PULLING the shares into the note, which becomes spendable
//   private balance.
//
// Redeeming is the mirror: shares in, underlying out.
//
// All of it is `Veil::invoke_derive` / `invoke_settle` — the same entrypoints
// VeilX uses for swaps, pointed at a different adapter. If the vault call
// reverts, or returns a deposit for the wrong note, the whole transaction
// reverts and no note was ever spent.
//
// What the chain shows: pool -> helper -> vToken -> pool. The lender never
// appears, and afterwards their position IS the note. Yield accrues in the
// ERC-4626 share price, so there is no position update to observe — the balance
// grows with nothing on-chain marking it.
//
// Amounts are public by design (STRK20 §10.7); it is the IDENTITY that is
// private. Because Veil registration is gated on the issuer's ERC-3643
// registry, every hidden lender in the anonymity set is a verified holder.
import { computeNoteId, deriveChannelKey, poseidon } from "./crypto.js";
import { assertU128, buildInvokeDeriveCalldata, hex, invokeCalldataHash, u256Felts, } from "./invoke.js";
import { VeilProver } from "./prover/veilProver.js";
/** Matches `veilvesu::interfaces::helper::LendingOperation`, and StarkWare's
 *  `vesu_lending_anonymizer::LendingOperation` before it — same two variants in
 *  the same order, so calldata built for the reference helper deserializes
 *  against ours unchanged. */
export var LendingOperation;
(function (LendingOperation) {
    /** Underlying in, vToken shares out. */
    LendingOperation[LendingOperation["Deposit"] = 0] = "Deposit";
    /** vToken shares in, underlying out. */
    LendingOperation[LendingOperation["Withdraw"] = 1] = "Withdraw";
})(LendingOperation || (LendingOperation = {}));
/** `privacy_invoke(operation, in_token, out_token, assets: u256, note_id)`.
 *
 *  The calldata layout of StarkWare's `vesu_lending_anonymizer::privacy_invoke`,
 *  unchanged — a helper written against the STRK20 privacy pool needs no
 *  modification to serve Veil. */
export function buildVesuInvokeCalldata(args) {
    const [low, high] = u256Felts(args.assets);
    return [
        hex(BigInt(args.operation)),
        hex(args.inToken),
        hex(args.outToken),
        low,
        high,
        hex(args.noteId),
    ];
}
/**
 * Drives private supply and redeem against a Vesu v2 vToken.
 *
 * The private viewing key goes into the proof witness and never onto the chain;
 * the transaction itself should be submitted by the prover service or a relayer,
 * since a wallet that signs it links itself to the note.
 */
export class VeilVesuClient {
    prover;
    reader;
    helper;
    constructor(config) {
        this.prover = new VeilProver({ ...config, pool: "erc3643" });
        this.reader = config.reader;
        this.helper = config.helper;
    }
    /** The owner's SELF channel — where their own deposits, change and open notes
     *  live (sender == recipient == owner). */
    selfChannelKey(owner, k, ownerPublicViewingKey) {
        return deriveChannelKey(owner, k, owner, ownerPublicViewingKey);
    }
    /** The first unused note slot in a token's subchannel. Notes are contiguous
     *  (STRK20 Theorem 1), so the first empty slot is the next one the contract
     *  will assign — which is how the note id is known before the note exists. */
    async nextNoteIndex(channelKey, token, page = 64) {
        let i = 0;
        for (;;) {
            const ids = Array.from({ length: page }, (_, j) => computeNoteId(channelKey, token, i + j));
            const encs = await this.reader.getNotesBatch(ids);
            for (let j = 0; j < encs.length; j++) {
                if (encs[j] === 0n)
                    return i + j;
            }
            if (encs.length < page)
                return i + encs.length;
            i += page;
        }
    }
    async plan(operation, args) {
        assertU128("amount", args.amount);
        if (args.asset === args.vToken)
            throw new Error("asset and vToken are the same");
        const [inToken, outToken] = operation === LendingOperation.Deposit
            ? [args.asset, args.vToken]
            : [args.vToken, args.asset];
        const channelKey = this.selfChannelKey(args.owner, args.ownerPrivateViewingKey, args.ownerPublicViewingKey);
        const noteIndex = await this.nextNoteIndex(channelKey, outToken);
        const noteId = computeNoteId(channelKey, outToken, noteIndex);
        const invokeCalldata = buildVesuInvokeCalldata({
            operation,
            inToken,
            outToken,
            // Exactly what the pool pays in — the helper reverts otherwise, which is
            // what keeps a stateless adapter from stranding the remainder.
            assets: args.amount,
            noteId,
        });
        const calldataHash = invokeCalldataHash(invokeCalldata);
        return {
            noteId,
            noteIndex,
            channelKey,
            operation,
            inToken,
            outToken,
            invokeCalldata,
            calldataHash,
            deriveCalldata: buildInvokeDeriveCalldata({
                caller: args.owner,
                ownerPrivateViewingKey: args.ownerPrivateViewingKey,
                inToken,
                inAmount: args.amount,
                outToken,
                target: BigInt(this.helper),
                calldataHash,
                auditEphemeralSecret: args.auditEphemeralSecret,
                changeNoteSalt: args.changeNoteSalt,
                subchannelSalt: args.subchannelSalt,
            }),
            settleExtra: [hex(BigInt(invokeCalldata.length)), ...invokeCalldata],
        };
    }
    /** Resolve the note id and build every piece of calldata for a supply.
     *  Nothing is submitted. */
    planLend(args) {
        return this.plan(LendingOperation.Deposit, args);
    }
    /** Same, for a redeem. `amount` is a SHARE count. */
    planRedeem(args) {
        return this.plan(LendingOperation.Withdraw, args);
    }
    /** Supply the asset into Vesu; the shares land in a private note. */
    async lend(args, opts = {}) {
        const plan = await this.planLend(args);
        const result = await this.prover.proveAndSettle("invoke", plan.deriveCalldata, {
            ...opts,
            settleExtra: opts.settleExtra ?? plan.settleExtra,
        });
        return { plan, result };
    }
    /** Redeem shares back to the underlying, into a private note. */
    async redeem(args, opts = {}) {
        const plan = await this.planRedeem(args);
        const result = await this.prover.proveAndSettle("invoke", plan.deriveCalldata, {
            ...opts,
            settleExtra: opts.settleExtra ?? plan.settleExtra,
        });
        return { plan, result };
    }
    /** Streaming variant (phase / log / program_hash events). */
    async lendStream(args, opts = {}) {
        const plan = await this.planLend(args);
        return {
            plan,
            events: this.prover.proveAndSettleStream("invoke", plan.deriveCalldata, {
                ...opts,
                settleExtra: opts.settleExtra ?? plan.settleExtra,
            }),
        };
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Anonymous borrowing
// ─────────────────────────────────────────────────────────────────────────────
/** Matches `veilvesu::borrow_router::BorrowOperation`. */
export var BorrowOperation;
(function (BorrowOperation) {
    /** Collateral in, borrowed asset out. */
    BorrowOperation[BorrowOperation["Borrow"] = 0] = "Borrow";
    /** Repayment in, released collateral out. */
    BorrowOperation[BorrowOperation["Repay"] = 1] = "Repay";
})(BorrowOperation || (BorrowOperation = {}));
/**
 * `privacy_invoke(operation, salt, collateral_asset, debt_asset, in_amount,
 * out_amount, note_id)` on `VeilBorrowRouter`.
 */
export function buildBorrowInvokeCalldata(args) {
    const [inLow, inHigh] = u256Felts(args.inAmount);
    const [outLow, outHigh] = u256Felts(args.outAmount);
    return [
        hex(BigInt(args.operation)),
        hex(args.salt),
        hex(args.collateralAsset),
        hex(args.debtAsset),
        inLow,
        inHigh,
        outLow,
        outHigh,
        hex(args.noteId),
    ];
}
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
export function deriveBorrowSalt(ownerPrivateViewingKey, nonce) {
    return poseidon([ownerPrivateViewingKey, nonce]);
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
export class VeilVesuBorrowClient {
    prover;
    reader;
    router;
    constructor(config) {
        this.prover = new VeilProver({ ...config, pool: "erc3643" });
        this.reader = config.reader;
        this.router = config.router;
    }
    selfChannelKey(owner, k, ownerPublicViewingKey) {
        return deriveChannelKey(owner, k, owner, ownerPublicViewingKey);
    }
    async nextNoteIndex(channelKey, token, page = 64) {
        let i = 0;
        for (;;) {
            const ids = Array.from({ length: page }, (_, j) => computeNoteId(channelKey, token, i + j));
            const encs = await this.reader.getNotesBatch(ids);
            for (let j = 0; j < encs.length; j++) {
                if (encs[j] === 0n)
                    return i + j;
            }
            if (encs.length < page)
                return i + encs.length;
            i += page;
        }
    }
    async plan(operation, args) {
        assertU128("inAmount", args.inAmount);
        assertU128("outAmount", args.outAmount);
        if (args.collateralAsset === args.debtAsset) {
            throw new Error("collateralAsset and debtAsset are the same");
        }
        const [inToken, outToken] = operation === BorrowOperation.Borrow
            ? [args.collateralAsset, args.debtAsset]
            : [args.debtAsset, args.collateralAsset];
        const channelKey = this.selfChannelKey(args.owner, args.ownerPrivateViewingKey, args.ownerPublicViewingKey);
        const noteIndex = await this.nextNoteIndex(channelKey, outToken);
        const noteId = computeNoteId(channelKey, outToken, noteIndex);
        const invokeCalldata = buildBorrowInvokeCalldata({
            operation,
            salt: args.salt,
            collateralAsset: args.collateralAsset,
            debtAsset: args.debtAsset,
            inAmount: args.inAmount,
            outAmount: args.outAmount,
            noteId,
        });
        const calldataHash = invokeCalldataHash(invokeCalldata);
        return {
            noteId,
            noteIndex,
            channelKey,
            operation,
            inToken,
            outToken,
            invokeCalldata,
            calldataHash,
            deriveCalldata: buildInvokeDeriveCalldata({
                caller: args.owner,
                ownerPrivateViewingKey: args.ownerPrivateViewingKey,
                inToken,
                inAmount: args.inAmount,
                outToken,
                target: BigInt(this.router),
                calldataHash,
                auditEphemeralSecret: args.auditEphemeralSecret,
                changeNoteSalt: args.changeNoteSalt,
                subchannelSalt: args.subchannelSalt,
            }),
            settleExtra: [hex(BigInt(invokeCalldata.length)), ...invokeCalldata],
        };
    }
    planBorrow(args) {
        return this.plan(BorrowOperation.Borrow, args);
    }
    planRepay(args) {
        return this.plan(BorrowOperation.Repay, args);
    }
    /** Post collateral from private notes and receive the borrowed asset into a
     *  private note. */
    async borrow(args, opts = {}) {
        const plan = await this.planBorrow(args);
        const result = await this.prover.proveAndSettle("invoke", plan.deriveCalldata, {
            ...opts,
            settleExtra: opts.settleExtra ?? plan.settleExtra,
        });
        return { plan, result };
    }
    /** Repay from private notes and take the released collateral back into one. */
    async repay(args, opts = {}) {
        const plan = await this.planRepay(args);
        const result = await this.prover.proveAndSettle("invoke", plan.deriveCalldata, {
            ...opts,
            settleExtra: opts.settleExtra ?? plan.settleExtra,
        });
        return { plan, result };
    }
}
