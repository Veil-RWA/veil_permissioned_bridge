// VeilX — anonymous swaps of permissioned assets on Ekubo.
//
// The STRK20 anonymous-swap cycle, in ONE proven transaction:
//
//   spend private notes  ->  reserve an empty OPEN NOTE for the output token,
//   for the output token  ->  pay the swap anonymizer the
//   input  ->  call its `privacy_invoke`, which swaps on Ekubo and measures
//   what arrived  ->  apply what it returns by PULLING the output back into the
//   note, which becomes spendable private balance.
//
// All of it is `Veil::invoke_derive` / `invoke_settle`. If the swap reverts, or
// misses its slippage floor, or returns a deposit for the wrong note, the whole
// transaction reverts and no note was ever spent — there is no intermediate
// state in which the input is exposed and no second signature to collect.
//
// What the chain shows: pool -> anonymizer -> Ekubo -> pool. The swapper never
// appears. Amounts are public by design (STRK20 §10.7) — it is the IDENTITY
// that is private, and because Veil pool registration is gated on the issuer's
// ERC-3643 registry, every hidden swapper in the anonymity set is a verified
// holder.
import { computeNoteId, deriveChannelKey } from "./crypto.js";
import { assertU128, buildInvokeDeriveCalldata, hex, invokeCalldataHash, u256Felts, } from "./invoke.js";
import { VeilProver } from "./prover/veilProver.js";
/** `privacy_invoke(router_addr, token_amount, pool_key, minimum_received,
 *  skip_ahead, note_id)`.
 *
 *  Byte-for-byte the calldata layout of StarkWare's
 *  `ekubo_swap_anonymizer::privacy_invoke`, so a helper written against the
 *  STRK20 privacy pool needs no change to serve Veil. */
export function buildPrivacyInvokeCalldata(args) {
    assertU128("amountIn", args.amountIn);
    const [minLow, minHigh] = u256Felts(args.minimumReceived);
    return [
        hex(args.router),
        hex(args.tokenIn),
        hex(args.amountIn), // i129.mag
        "0x0", // i129.sign — a swap input is always positive (exact-in)
        hex(args.poolKey.token0),
        hex(args.poolKey.token1),
        hex(args.poolKey.fee),
        hex(args.poolKey.tickSpacing),
        hex(args.poolKey.extension),
        minLow,
        minHigh,
        hex(args.skipAhead ?? 0n),
        hex(args.noteId),
    ];
}
/**
 * Drives the anonymous swap.
 *
 * One proven operation, one transaction, atomic end to end. The private viewing
 * key goes into the proof witness and never onto the chain; the transaction
 * itself should be submitted by the prover service or a relayer, since a wallet
 * that signs it links itself to the note.
 */
export class VeilXSwapClient {
    config;
    prover;
    reader;
    anonymizer;
    router;
    constructor(config) {
        this.config = config;
        this.prover = new VeilProver({ ...config, pool: "erc3643" });
        this.reader = config.reader;
        this.anonymizer = config.anonymizer;
        this.router = config.router;
    }
    /** The owner's SELF channel — where their own deposits, change and open notes
     *  live (sender == recipient == owner). */
    selfChannelKey(owner, k, ownerPublicViewingKey) {
        return deriveChannelKey(owner, k, owner, ownerPublicViewingKey);
    }
    /** The first unused note slot in a token's subchannel. Notes are contiguous
     *  (STRK20 Theorem 1), so the first empty slot is the next one the contract
     *  will assign — which is how the note id can be known before the note
     *  exists, and why the client and `invoke_derive` agree on it. */
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
    /** Resolve the note id and build every piece of calldata. Nothing is
     *  submitted. */
    async planAnonymousSwap(args) {
        assertU128("amountIn", args.amountIn);
        if (args.tokenIn === args.tokenOut)
            throw new Error("tokenIn and tokenOut are the same");
        const inPool = (args.tokenIn === args.poolKey.token0 && args.tokenOut === args.poolKey.token1) ||
            (args.tokenIn === args.poolKey.token1 && args.tokenOut === args.poolKey.token0);
        if (!inPool)
            throw new Error("tokenIn/tokenOut are not the two tokens of poolKey");
        const channelKey = this.selfChannelKey(args.owner, args.ownerPrivateViewingKey, args.ownerPublicViewingKey);
        const noteIndex = await this.nextNoteIndex(channelKey, args.tokenOut);
        const noteId = computeNoteId(channelKey, args.tokenOut, noteIndex);
        const target = BigInt(this.anonymizer);
        const invokeCalldata = buildPrivacyInvokeCalldata({
            router: BigInt(this.router),
            tokenIn: args.tokenIn,
            amountIn: args.amountIn,
            poolKey: args.poolKey,
            minimumReceived: args.minimumReceived,
            skipAhead: args.skipAhead,
            noteId,
        });
        const calldataHash = invokeCalldataHash(invokeCalldata);
        return {
            noteId,
            noteIndex,
            channelKey,
            invokeCalldata,
            calldataHash,
            deriveCalldata: buildInvokeDeriveCalldata({
                caller: args.owner,
                ownerPrivateViewingKey: args.ownerPrivateViewingKey,
                inToken: args.tokenIn,
                inAmount: args.amountIn,
                outToken: args.tokenOut,
                target,
                calldataHash,
                auditEphemeralSecret: args.auditEphemeralSecret,
                changeNoteSalt: args.changeNoteSalt,
                subchannelSalt: args.subchannelSalt,
            }),
            // `invoke_settle(msg, nullifiers, calldata)` — the proven message is
            // `msg` + nullifiers, so the only tail the server has to append is the
            // adapter calldata, as a serialized array.
            settleExtra: [hex(BigInt(invokeCalldata.length)), ...invokeCalldata],
        };
    }
    /** Prove `invoke_derive` and submit `invoke_settle`. One transaction. */
    async anonymousSwap(args, opts = {}) {
        const plan = await this.planAnonymousSwap(args);
        const result = await this.prover.proveAndSettle("invoke", plan.deriveCalldata, {
            ...opts,
            settleExtra: opts.settleExtra ?? plan.settleExtra,
        });
        return { plan, result };
    }
    /** Streaming variant (phase / log / program_hash events). */
    async anonymousSwapStream(args, opts = {}) {
        const plan = await this.planAnonymousSwap(args);
        return {
            plan,
            events: this.prover.proveAndSettleStream("invoke", plan.deriveCalldata, {
                ...opts,
                settleExtra: opts.settleExtra ?? plan.settleExtra,
            }),
        };
    }
}
