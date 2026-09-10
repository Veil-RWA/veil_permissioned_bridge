// Anonymous DvP (balance-escrow) client primitives for the ERC-3643 pool.
//
// Mirrors the on-chain `compute_order_id` / `compute_batch_id` and the
// `post_order_derive` / `cancel_order_derive` calldata layouts byte-for-byte, so
// orders built here settle against VeilERC3643.cairo. Two roles:
//   * MAKER  — locks `offer_amount` of a token and wants `want_amount` of
//     another (a limit order; price = offer/want). Posted + cancelled through
//     the prover (`VeilDvpMaker`, dvpMaker.ts).
//   * EXCHANGE — Extended's matching engine: draws arbitrary amounts from open
//     orders and settles a conserved batch keylessly (`VeilDvpExchange`,
//     dvpExchange.ts).
//
// Tier 1: order amounts are public by design. Identity is hidden (post/cancel go
// through the prover + a relayer; the exchange is a known operator).
import { poseidon } from "./crypto.js";
import { shortString } from "starknet";
const sstr = (s) => BigInt(shortString.encodeShortString(s));
// Domain tags — must equal the consts in VeilERC3643.cairo.
export const DOMAIN_ORDER_ID = sstr("VEIL_ORDER");
export const DOMAIN_BATCH_ID = sstr("VEIL_BATCH");
const U128_MAX = (1n << 128n) - 1n;
const TWO_POW_128 = 1n << 128n;
function assertU128(name, v) {
    if (v < 0n || v > U128_MAX)
        throw new Error(`${name} out of u128 range: ${v}`);
}
export const ORDER_OPEN = 0;
export const ORDER_FILLED = 1;
export const ORDER_CANCELLED = 2;
// ── Identifier derivations (mirror the Cairo helpers) ────────────────────────
/** compute_order_id — binds the order to a pool + chain so it can't be replayed
 *  across deployments. */
export function computeOrderId(pool, chainId, order) {
    assertU128("offerAmount", order.offerAmount);
    assertU128("wantAmount", order.wantAmount);
    return poseidon([
        DOMAIN_ORDER_ID,
        pool,
        chainId,
        order.maker,
        order.offerToken,
        order.offerAmount,
        order.wantToken,
        order.wantAmount,
        order.expiry,
        order.nonce,
    ]);
}
/** compute_batch_id — binds the order set AND the per-order (deliver, draw)
 *  fills, so the exchange signature authorizes exactly the amounts that move.
 *  Inner hashes: poseidon(order_ids) and poseidon([deliver0, draw0, …]). */
export function computeBatchId(pool, chainId, batchNonce, orderIds, fills) {
    if (orderIds.length !== fills.length) {
        throw new Error("computeBatchId: orderIds and fills length mismatch");
    }
    const innerOrders = poseidon(orderIds);
    const flat = [];
    for (const f of fills) {
        assertU128("deliver", f.deliver);
        assertU128("draw", f.draw);
        flat.push(f.deliver, f.draw);
    }
    const innerFills = poseidon(flat);
    return poseidon([DOMAIN_BATCH_ID, pool, chainId, batchNonce, innerOrders, innerFills]);
}
// ── Derive-calldata builders (ABI order of the `*_derive` entrypoints) ───────
// Hex felts, matching the prover's `deriveCalldata` contract: u256 = [low, high];
// ContractAddress / felt252 / u128 / u64 = one felt each.
const hex = (v) => "0x" + v.toString(16);
function u256Pair(v) {
    return [hex(v & U128_MAX), hex(v >> 128n)];
}
/** Calldata for `post_order_derive(maker, k: u256, offer_token, offer_amount:
 *  u128, want_token, want_amount: u128, expiry: u64, nonce, change_note_salt:
 *  u128, receive_subchannel_salt)`. */
export function buildPostOrderDeriveCalldata(args) {
    const { order } = args;
    assertU128("offerAmount", order.offerAmount);
    assertU128("wantAmount", order.wantAmount);
    assertU128("changeNoteSalt", args.changeNoteSalt);
    return [
        hex(args.maker),
        ...u256Pair(args.makerPrivateViewingKey),
        hex(order.offerToken),
        hex(order.offerAmount),
        hex(order.wantToken),
        hex(order.wantAmount),
        hex(order.expiry),
        hex(order.nonce),
        hex(args.changeNoteSalt),
        hex(args.receiveSubchannelSalt),
    ];
}
/** Calldata for `cancel_order_derive(maker, k: u256, order_id, leftover_note_salt:
 *  u128)`. */
export function buildCancelOrderDeriveCalldata(args) {
    assertU128("leftoverNoteSalt", args.leftoverNoteSalt);
    return [
        hex(args.maker),
        ...u256Pair(args.makerPrivateViewingKey),
        hex(args.orderId),
        hex(args.leftoverNoteSalt),
    ];
}
// ── Note-amount classification (mirror read_note_amount_internal, §10.6) ─────
/** Classify a raw note `encrypted_amount` cell.
 *  - `open`: salt=1 reserved → the low 128 bits are the PLAINTEXT amount (a DvP
 *    receive note / open note). `amount === 0n` means an UNFILLED open note,
 *    which is NOT spendable (its nullifier must not be burned).
 *  - `regular`: a normally-encrypted note; decrypt with `decryptNoteAmount`. */
export function classifyNote(enc) {
    if (enc === 0n)
        return { kind: "empty" };
    if (enc >> 128n === 1n)
        return { kind: "open", amount: enc & U128_MAX };
    return { kind: "regular" };
}
/** The empty open-note encoding (salt=1, amount=0). */
export const EMPTY_OPEN_NOTE = TWO_POW_128;
