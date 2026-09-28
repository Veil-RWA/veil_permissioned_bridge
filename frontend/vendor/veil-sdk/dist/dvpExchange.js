// Exchange-side DvP client — for the venue's matching engine. No maker viewing
// keys: after matching off-chain, the engine proves one conserved batch with
// ARBITRARY draws from open orders. `execute_batch_derive` runs in the proven
// virtual OS, authorized by the exchange account's signature; it opens each
// maker's commitment (address, salt and rules snapshot, handed over by the
// maker) and runs the issuer's per-maker checks there, so no maker is named
// on-chain. The settle re-checks every maker's limit price, escrow cap,
// delivery cap and per-token conservation, so a compromised engine can grief
// (refuse to fill) but cannot mint or steal.
//
//   const exch = new VeilDvpExchange({
//     veilAddress, signer: exchangeAccount /* starknet.js Account */,
//   });
//   await exch.executeBatch({
//     orderIds: [idA, idB],
//     fills:   [{ deliver: 37n, draw: 370n }, { deliver: 370n, draw: 37n }],
//     batchNonce,
//     makers:  [openingA, openingB],
//   });
import { buildExecuteBatchDeriveCalldata, buildVenueFillDeriveCalldata, computeBatchId, } from "./dvp.js";
import { VeilProver } from "./prover/veilProver.js";
export class VeilDvpExchange {
    prover;
    veilAddress;
    constructor(config) {
        this.prover = new VeilProver({ ...config, pool: "erc3643" });
        this.veilAddress = config.veilAddress;
    }
    /** The batch's replay-guard id (`is_batch_used`). */
    batchId(args, chainId) {
        return computeBatchId(BigInt(this.veilAddress), chainId, args.batchNonce, args.orderIds, args.fills);
    }
    /** Prove `execute_batch_derive` and submit `execute_batch_settle`. */
    executeBatch(args, opts) {
        return this.prover.proveAndSettle("execute_batch", buildExecuteBatchDeriveCalldata(args), opts);
    }
    /** Prove `venue_fill_derive` and submit `venue_fill_settle`: apply an
     *  external venue's receipts (HyperVeil) to their makers' receive notes. */
    venueFill(args, opts) {
        return this.prover.proveAndSettle("venue_fill", buildVenueFillDeriveCalldata(args), opts);
    }
    /** Streaming variant of {@link executeBatch}. */
    executeBatchStream(args, opts) {
        return this.prover.proveAndSettleStream("execute_batch", buildExecuteBatchDeriveCalldata(args), opts);
    }
}
