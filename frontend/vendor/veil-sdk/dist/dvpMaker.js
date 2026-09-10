// Maker-side DvP client. Posts and cancels orders on the ERC-3643 pool through
// the SNIP-36 prover service (the proven `post_order_derive` / `cancel_order_derive`
// run in the virtual OS; the viewing key stays in the proof witness, never
// on-chain). Thin wrapper over `VeilProver` that builds the derive calldata.
//
//   const maker = new VeilDvpMaker({ veilAddress: "0x<pool>" });
//   const order = { maker, offerToken: USDC, offerAmount: 1000n,
//                   wantToken: GOLD, wantAmount: 100n, expiry, nonce };
//   await maker.postOrder({ maker, makerPrivateViewingKey: k, order,
//                           changeNoteSalt, receiveSubchannelSalt });
//   // later, to reclaim the unfilled remainder as a PRIVATE note:
//   await maker.cancelOrder({ maker, makerPrivateViewingKey: k, orderId,
//                             leftoverNoteSalt });
import { buildCancelOrderDeriveCalldata, buildPostOrderDeriveCalldata, computeOrderId, } from "./dvp.js";
import { VeilProver } from "./prover/veilProver.js";
export class VeilDvpMaker {
    prover;
    veilAddress;
    constructor(config) {
        this.prover = new VeilProver({ ...config, pool: "erc3643" });
        this.veilAddress = config.veilAddress;
    }
    /** Lock `order.offerAmount` of `order.offerToken` and rest a limit order for
     *  `order.wantAmount` of `order.wantToken`. Proves `post_order_derive` and
     *  submits `post_order_settle`. */
    postOrder(args, opts) {
        return this.prover.proveAndSettle("post_order", buildPostOrderDeriveCalldata(args), opts);
    }
    /** Streaming variant of {@link postOrder} (phase / log / program_hash). */
    postOrderStream(args, opts) {
        return this.prover.proveAndSettleStream("post_order", buildPostOrderDeriveCalldata(args), opts);
    }
    /** Cancel (if OPEN) and/or reclaim leftover escrow as a PRIVATE note. Works on
     *  an OPEN order (stops fills + returns remainder) or a FILLED order that still
     *  has price-improvement / rounding leftover. Proves `cancel_order_derive`. */
    cancelOrder(args, opts) {
        return this.prover.proveAndSettle("cancel_order", buildCancelOrderDeriveCalldata(args), opts);
    }
    /** Streaming variant of {@link cancelOrder}. */
    cancelOrderStream(args, opts) {
        return this.prover.proveAndSettleStream("cancel_order", buildCancelOrderDeriveCalldata(args), opts);
    }
    /** The deterministic order_id for an order (bound to this pool + chain). Use
     *  it to track the order on-chain (`get_order`) and to reference it at cancel.
     *  `pool` defaults to the configured veilAddress. */
    orderId(order, chainId, pool) {
        return computeOrderId(pool ?? BigInt(this.veilAddress), chainId, order);
    }
}
