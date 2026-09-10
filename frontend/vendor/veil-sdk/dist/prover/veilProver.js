// Instance-based front door for executing Veil pool functions through the
// SNIP-36 prover service. Construct one `VeilProver` bound to a deployed pool
// (and, optionally, your own signer / a custom service endpoint) and call the
// operation methods — each runs `<op>_derive` in the proven virtual OS and
// submits `<op>_settle` on-chain carrying the derive's proof + proof_facts.
//
// Both Veil pools are supported; set `pool` ("erc721" default, or "erc3643").
// The pools share function names but emit different message layouts, so the
// service keys its settle assembly by (pool, operation) — that's why the
// instance carries `pool`. The shared ops below (registerViewingKey / deposit /
// privateTransfer / withdraw) apply to either; `forcedTransfer` is the ERC-3643
// agent path; the approve/* methods are NFT-only. For any other operation a pool
// defines, use `proveAndSettle(operation, ...)` directly.
//
//   const veil = new VeilProver({ veilAddress: "0x..." });
//   await veil.deposit(deriveCalldata, { onEvent: (e) => console.log(e) });
//
// `deriveCalldata` is the ABI-serialized argument list for `<op>_derive` (hex
// felts; u256 = [low, high], ContractAddress/felt252/u128 = one felt each).
import { veilProveAndSettle, veilProveAndSettleStream } from "./veil.js";
import { proverEndpointFromEnv, proverTransportFromEnv } from "./constants.js";
export class VeilProver {
    config;
    constructor(config) {
        this.config = config;
        if (!config.veilAddress)
            throw new Error("VeilProver: veilAddress is required");
    }
    /** Run any operation by name + raw derive calldata. */
    proveAndSettle(operation, deriveCalldata, opts = {}) {
        return veilProveAndSettle(this.input(operation, deriveCalldata, opts));
    }
    /** Same, but yields each SSE event (phase / log / program_hash / complete). */
    proveAndSettleStream(operation, deriveCalldata, opts = {}) {
        return veilProveAndSettleStream(this.input(operation, deriveCalldata, opts));
    }
    // ── Typed per-operation shortcuts (operation name baked in) ───────────────
    registerViewingKey(deriveCalldata, opts) {
        return this.proveAndSettle("register_viewing_key", deriveCalldata, opts);
    }
    deposit(deriveCalldata, opts) {
        return this.proveAndSettle("deposit", deriveCalldata, opts);
    }
    /** ERC-3643 pool: reserve an EMPTY open note that an owner-authorised adapter
     *  fills later, when the amount is finally known (STRK20 §10.3). The note
     *  records only its token — no filler address is stored, so no `note_id ->
     *  adapter` mapping is ever published. */
    createOpenNote(deriveCalldata, opts) {
        return this.proveAndSettle("create_open_note", deriveCalldata, opts);
    }
    /** ERC-3643 pool: one atomic hop through an allowlisted adapter (STRK20
     *  §10.3.2). `settleExtra` carries the adapter calldata, which the proof binds
     *  by hash rather than by value. */
    invoke(deriveCalldata, opts) {
        return this.proveAndSettle("invoke", deriveCalldata, opts);
    }
    privateTransfer(deriveCalldata, opts) {
        return this.proveAndSettle("private_transfer", deriveCalldata, opts);
    }
    /** ERC-3643 pool: agent clawback / recovery (settle is agent-gated, so submit
     *  with the agent's privateKey + senderAddress). */
    forcedTransfer(deriveCalldata, opts) {
        return this.proveAndSettle("forced_transfer", deriveCalldata, opts);
    }
    approvePrivateTransfer(deriveCalldata, opts) {
        return this.proveAndSettle("approve_private_transfer", deriveCalldata, opts);
    }
    privateTransferAsApproved(deriveCalldata, opts) {
        return this.proveAndSettle("private_transfer_as_approved", deriveCalldata, opts);
    }
    revokePrivateApproval(deriveCalldata, opts) {
        return this.proveAndSettle("revoke_private_approval", deriveCalldata, opts);
    }
    /** Withdraw / unshield. Where the recipient lives differs by pool:
     *  - NFT pool: recipient is a settle-only field — pass it as `recipient` and
     *    it becomes `settleExtra: [recipient]`.
     *  - ERC-3643 pool: recipient is a `withdraw_derive` argument (bound by the
     *    proof), so put it inside `deriveCalldata`; the `recipient` arg here is
     *    ignored for this pool. */
    withdraw(deriveCalldata, recipient, opts = {}) {
        const isErc3643 = this.config.pool === "erc3643";
        const settleExtra = opts.settleExtra ?? (!isErc3643 && recipient !== undefined ? [recipient] : undefined);
        return this.proveAndSettle("withdraw", deriveCalldata, { ...opts, settleExtra });
    }
    input(operation, deriveCalldata, opts) {
        return {
            operation,
            pool: this.config.pool,
            veilAddress: this.config.veilAddress,
            deriveCalldata,
            // Explicit config wins; otherwise fall back to the environment, so a
            // deployment is configured by .env rather than by code.
            endpoint: this.config.endpoint ?? proverEndpointFromEnv(),
            transport: this.config.transport ?? proverTransportFromEnv(),
            rpcUrl: this.config.rpcUrl,
            masterAddress: this.config.masterAddress,
            settleExtra: opts.settleExtra,
            blockNumber: opts.blockNumber,
            nonce: opts.nonce,
            privateKey: opts.privateKey ?? this.config.privateKey,
            senderAddress: opts.senderAddress ?? this.config.senderAddress,
            onEvent: opts.onEvent,
            signal: opts.signal,
        };
    }
}
