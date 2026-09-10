// Exchange-side DvP client — for Extended's matching engine. KEYLESS and
// PROOFLESS: settling a batch needs no maker viewing keys and no STARK proof.
// The engine, after matching off-chain, draws ARBITRARY amounts from open orders
// and submits one conserved batch. The contract enforces every maker's limit
// price, escrow cap, delivery cap, and per-token conservation, so a compromised
// engine can grief (refuse to fill) but cannot mint or steal.
//
// Two responsibilities:
//   1. Authorize the batch — sign `batch_id` with the exchange account's key so
//      `execute_batch_settle` accepts it (SNIP-6 `is_valid_signature`).
//   2. Submit the tx — via a starknet.js Account (the exchange itself, or a
//      relayer it funds; the signature is independent of the submitter).
//
//   const exch = new VeilDvpExchange({
//     poolAddress, chainId, exchangePrivateKey, submitter /* starknet.js Account */,
//   });
//   await exch.executeBatch({
//     orderIds: [idA, idB],
//     fills:   [{ deliver: 37n, draw: 370n }, { deliver: 370n, draw: 37n }],
//     batchNonce,
//   });
import { CallData, ec } from "starknet";
import { computeBatchId } from "./dvp.js";
const toBig = (v) => (typeof v === "bigint" ? v : BigInt(v));
const hex = (v) => "0x" + v.toString(16);
const U128_MAX = (1n << 128n) - 1n;
export class VeilDvpExchange {
    pool;
    chainId;
    exchangeKey;
    submitter;
    constructor(config) {
        this.pool = toBig(config.poolAddress);
        this.chainId = config.chainId;
        this.exchangeKey = toBig(config.exchangePrivateKey);
        this.submitter = config.submitter;
    }
    /** The batch_id the exchange signature authorizes. */
    batchId(args) {
        return computeBatchId(this.pool, this.chainId, args.batchNonce, args.orderIds, args.fills);
    }
    /** STARK signature `[r, s]` over batch_id, as the contract's
     *  `is_valid_account_sig` expects from the exchange account. */
    signBatch(args) {
        const sig = ec.starkCurve.sign(hex(this.batchId(args)), hex(this.exchangeKey));
        return [hex(sig.r), hex(sig.s)];
    }
    /** Build the `execute_batch_settle` invocation (calldata-serialized) without
     *  submitting — for callers that manage their own tx submission. */
    buildBatchCall(args) {
        validateFills(args.fills);
        const signature = this.signBatch(args);
        const calldata = CallData.compile({
            order_ids: args.orderIds.map(hex),
            // Array<BatchFill{ deliver: u128, draw: u128 }>
            fills: args.fills.map((f) => ({ deliver: hex(f.deliver), draw: hex(f.draw) })),
            batch_nonce: hex(args.batchNonce),
            exchange_signature: signature,
        });
        return { contractAddress: hex(this.pool), entrypoint: "execute_batch_settle", calldata };
    }
    /** Sign + submit the batch via the configured `submitter`. Returns the
     *  transaction hash. Requires `submitter` in the config. */
    async executeBatch(args) {
        if (!this.submitter) {
            throw new Error("VeilDvpExchange.executeBatch: no `submitter` Account configured — use buildBatchCall() and submit yourself");
        }
        if (args.orderIds.length !== args.fills.length) {
            throw new Error("executeBatch: orderIds and fills length mismatch");
        }
        const call = this.buildBatchCall(args);
        const { transaction_hash } = await this.submitter.execute(call);
        return transaction_hash;
    }
}
function validateFills(fills) {
    for (const f of fills) {
        if (f.deliver <= 0n)
            throw new Error("fill.deliver must be > 0");
        if (f.deliver > U128_MAX || f.draw < 0n || f.draw > U128_MAX) {
            throw new Error("fill amounts out of u128 range");
        }
    }
}
