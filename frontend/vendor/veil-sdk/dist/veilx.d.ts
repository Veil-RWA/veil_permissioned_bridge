import type { VeilERC3643Reader } from "./erc3643.js";
import { type VeilCallOptions, type VeilProverConfig } from "./prover/veilProver.js";
import type { VeilProveAndSettleResult } from "./prover/types.js";
/** An Ekubo pool key. `extension` is the VeilX compliance extension, and being
 *  part of the key is what makes the compliance guarantee a property of the
 *  pool rather than of a frontend. */
export interface EkuboPoolKey {
    token0: bigint;
    token1: bigint;
    /** Fee as a 0.128 fraction: 2**128 * bps / 10000. */
    fee: bigint;
    tickSpacing: bigint;
    extension: bigint;
}
export interface VeilXConfig extends VeilProverConfig {
    /** The VeilX swap anonymizer. Must be an ALLOWLISTED ADAPTER on the pool and
     *  a registered identity under both tokens' registries — it custodies a
     *  permissioned asset for the length of the transaction. */
    anonymizer: string;
    /** The router the anonymizer is allowed to route through (VeilXRouter). */
    router: string;
    /** Key-free batch reader for the Veil ERC-3643 pool, used to find the next
     *  free note slot. Never sees a private viewing key. */
    reader: VeilERC3643Reader;
}
export interface AnonymousSwapArgs {
    owner: bigint;
    /** Stays on the device: it goes into the proof witness, never on-chain. */
    ownerPrivateViewingKey: bigint;
    /** The owner's PUBLIC viewing key, from `get_viewing_key` on the pool. */
    ownerPublicViewingKey: bigint;
    tokenIn: bigint;
    tokenOut: bigint;
    /** Input amount, u128. */
    amountIn: bigint;
    poolKey: EkuboPoolKey;
    /** Slippage floor, passed through to Ekubo's `clear_minimum`. A swap that
     *  cannot reach it reverts the whole transaction. */
    minimumReceived: bigint;
    /** Ekubo route optimisation; 0 is right for a single-hop pool. */
    skipAhead?: bigint;
    /** Salt for the private change note left behind by the spend, u128. */
    changeNoteSalt: bigint;
    /** Salt that opens the output token's self-subchannel, if this is the
     *  owner's first note of that token. */
    subchannelSalt: bigint;
    /** Fresh per-call ECDH secret encrypting the note owner to the auditor.
     *  Never reuse one — see `buildInvokeDeriveCalldata`. */
    auditEphemeralSecret: bigint;
}
export interface AnonymousSwapPlan {
    /** The open note the proceeds land in. Public — the pool creates it and the
     *  anonymizer credits it, both inside the settle transaction. */
    noteId: bigint;
    noteIndex: number;
    channelKey: bigint;
    /** The adapter calldata, bound to the proof by its Poseidon hash. */
    invokeCalldata: string[];
    calldataHash: bigint;
    /** Calldata for `invoke_derive`. */
    deriveCalldata: string[];
    /** The settle-only tail: everything after the proven message. */
    settleExtra: string[];
}
/** `privacy_invoke(router_addr, token_amount, pool_key, minimum_received,
 *  skip_ahead, note_id)`.
 *
 *  Byte-for-byte the calldata layout of StarkWare's
 *  `ekubo_swap_anonymizer::privacy_invoke`, so a helper written against the
 *  STRK20 privacy pool needs no change to serve Veil. */
export declare function buildPrivacyInvokeCalldata(args: {
    router: bigint;
    tokenIn: bigint;
    amountIn: bigint;
    poolKey: EkuboPoolKey;
    minimumReceived: bigint;
    skipAhead?: bigint;
    noteId: bigint;
}): string[];
/**
 * Drives the anonymous swap.
 *
 * One proven operation, one transaction, atomic end to end. The private viewing
 * key goes into the proof witness and never onto the chain; the transaction
 * itself should be submitted by the prover service or a relayer, since a wallet
 * that signs it links itself to the note.
 */
export declare class VeilXSwapClient {
    private readonly config;
    private readonly prover;
    private readonly reader;
    readonly anonymizer: string;
    readonly router: string;
    constructor(config: VeilXConfig);
    /** The owner's SELF channel — where their own deposits, change and open notes
     *  live (sender == recipient == owner). */
    selfChannelKey(owner: bigint, k: bigint, ownerPublicViewingKey: bigint): bigint;
    /** The first unused note slot in a token's subchannel. Notes are contiguous
     *  (STRK20 Theorem 1), so the first empty slot is the next one the contract
     *  will assign — which is how the note id can be known before the note
     *  exists, and why the client and `invoke_derive` agree on it. */
    nextNoteIndex(channelKey: bigint, token: bigint, page?: number): Promise<number>;
    /** Resolve the note id and build every piece of calldata. Nothing is
     *  submitted. */
    planAnonymousSwap(args: AnonymousSwapArgs): Promise<AnonymousSwapPlan>;
    /** Prove `invoke_derive` and submit `invoke_settle`. One transaction. */
    anonymousSwap(args: AnonymousSwapArgs, opts?: VeilCallOptions): Promise<{
        plan: AnonymousSwapPlan;
        result: VeilProveAndSettleResult;
    }>;
    /** Streaming variant (phase / log / program_hash events). */
    anonymousSwapStream(args: AnonymousSwapArgs, opts?: VeilCallOptions): Promise<{
        plan: AnonymousSwapPlan;
        events: AsyncGenerator<import("./index.js").VeilEvent, void, void>;
    }>;
}
