import type { VeilEvent, VeilOperation, VeilPool, VeilProveAndSettleResult } from "./types.js";
export interface VeilProverConfig {
    /** Deployed Veil pool address (hex) every call targets. */
    veilAddress: string;
    /** Which pool this instance drives: "erc721" (default) or "erc3643". Selects
     *  the server's settle-assembly table. */
    pool?: VeilPool;
    /** SNIP-36 prover service base URL. Defaults to the hosted service. */
    endpoint?: string;
    /** "sse" (default) for a long-running prover, "job" for a pay-per-use
     *  deployment that runs one container per proof and exposes submit/poll. */
    transport?: "sse" | "job";
    /** Starknet RPC for read-only nonce lookups. Defaults to the hosted RPC. */
    rpcUrl?: string;
    /** Master account for the server-side fallback nonce. */
    masterAddress?: string;
    /** Default signer key (hex). Per-call `privateKey` overrides it. When set,
     *  `senderAddress` is required. */
    privateKey?: string;
    /** Default sender account (hex), used with `privateKey`. */
    senderAddress?: string;
}
/** Per-call options. `settleExtra` carries settle-only fields the derive does
 *  not produce (e.g. the NFT pool's withdraw recipient). */
export interface VeilCallOptions {
    settleExtra?: string[];
    blockNumber?: number;
    nonce?: string;
    privateKey?: string;
    senderAddress?: string;
    onEvent?: (event: VeilEvent) => void;
    signal?: AbortSignal;
}
export declare class VeilProver {
    private readonly config;
    constructor(config: VeilProverConfig);
    /** Run any operation by name + raw derive calldata. */
    proveAndSettle(operation: VeilOperation, deriveCalldata: string[], opts?: VeilCallOptions): Promise<VeilProveAndSettleResult>;
    /** Same, but yields each SSE event (phase / log / program_hash / complete). */
    proveAndSettleStream(operation: VeilOperation, deriveCalldata: string[], opts?: VeilCallOptions): AsyncGenerator<VeilEvent, void, void>;
    registerViewingKey(deriveCalldata: string[], opts?: VeilCallOptions): Promise<VeilProveAndSettleResult>;
    deposit(deriveCalldata: string[], opts?: VeilCallOptions): Promise<VeilProveAndSettleResult>;
    /** ERC-3643 pool: reserve an EMPTY open note that an owner-authorised adapter
     *  fills later, when the amount is finally known (STRK20 §10.3). The note
     *  records only its token — no filler address is stored, so no `note_id ->
     *  adapter` mapping is ever published. */
    createOpenNote(deriveCalldata: string[], opts?: VeilCallOptions): Promise<VeilProveAndSettleResult>;
    /** ERC-3643 pool: one atomic hop through an allowlisted adapter (STRK20
     *  §10.3.2). `settleExtra` carries the adapter calldata, which the proof binds
     *  by hash rather than by value. */
    invoke(deriveCalldata: string[], opts?: VeilCallOptions): Promise<VeilProveAndSettleResult>;
    privateTransfer(deriveCalldata: string[], opts?: VeilCallOptions): Promise<VeilProveAndSettleResult>;
    /** ERC-3643 pool: agent clawback / recovery (settle is agent-gated, so submit
     *  with the agent's privateKey + senderAddress). */
    forcedTransfer(deriveCalldata: string[], opts?: VeilCallOptions): Promise<VeilProveAndSettleResult>;
    approvePrivateTransfer(deriveCalldata: string[], opts?: VeilCallOptions): Promise<VeilProveAndSettleResult>;
    privateTransferAsApproved(deriveCalldata: string[], opts?: VeilCallOptions): Promise<VeilProveAndSettleResult>;
    revokePrivateApproval(deriveCalldata: string[], opts?: VeilCallOptions): Promise<VeilProveAndSettleResult>;
    /** Withdraw / unshield. Where the recipient lives differs by pool:
     *  - NFT pool: recipient is a settle-only field — pass it as `recipient` and
     *    it becomes `settleExtra: [recipient]`.
     *  - ERC-3643 pool: recipient is a `withdraw_derive` argument (bound by the
     *    proof), so put it inside `deriveCalldata`; the `recipient` arg here is
     *    ignored for this pool. */
    withdraw(deriveCalldata: string[], recipient?: string, opts?: VeilCallOptions): Promise<VeilProveAndSettleResult>;
    private input;
}
