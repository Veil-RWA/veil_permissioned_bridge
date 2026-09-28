// Anonymous DvP (balance-escrow) client primitives for the ERC-3643 pool.
//
// Mirrors the on-chain `compute_maker_commitment` / `hash_rules` /
// `compute_order_id` / `compute_batch_id` and the `post_order_derive` /
// `cancel_order_derive` / `execute_batch_derive` calldata layouts byte-for-byte,
// so orders built here settle against VeilERC3643.cairo. Two roles:
//   * MAKER  — locks `offer_amount` of a token and wants `want_amount` of
//     another (a limit order; price = offer/want). Posted + cancelled through
//     the prover from the maker's own account (`VeilDvpMaker`, dvpMaker.ts).
//     The order stores only `poseidon('VEIL_MAKER', maker, maker_salt)`; the
//     maker hands its opening (address, salt, rules snapshot) to the exchange.
//   * EXCHANGE — the venue's matching engine: proves a conserved batch from its
//     own account, opening each maker's commitment so the issuer checks run in
//     the proof (`VeilDvpExchange`, dvpExchange.ts). No maker key is needed.
//
// Tier 1: order amounts are public by design. Maker identities are not on-chain
// (only the commitment, and the address encrypted to the auditor).
import { poseidon } from "./crypto.js";
import { shortString } from "starknet";
const sstr = (s) => BigInt(shortString.encodeShortString(s));
// Domain tags — must equal the consts in VeilERC3643.cairo.
export const DOMAIN_ORDER_ID = sstr("VEIL_ORDER");
export const DOMAIN_BATCH_ID = sstr("VEIL_BATCH");
export const DOMAIN_MAKER = sstr("VEIL_MAKER");
export const DOMAIN_RULES = sstr("VEIL_RULES");
const U128_MAX = (1n << 128n) - 1n;
const TWO_POW_128 = 1n << 128n;
function assertU128(name, v) {
    if (v < 0n || v > U128_MAX)
        throw new Error(`${name} out of u128 range: ${v}`);
}
export const NEUTRAL_RULES = {
    fullRequired: false,
    capped: false,
    locked: 0n,
    minResidual: 0n,
    residualStrict: false,
};
export const ORDER_OPEN = 0;
export const ORDER_FILLED = 1;
export const ORDER_CANCELLED = 2;
// ── Identifier derivations (mirror the Cairo helpers) ────────────────────────
/** compute_maker_commitment — what the order stores instead of the maker. */
export function computeMakerCommitment(maker, makerSalt) {
    return poseidon([DOMAIN_MAKER, maker, makerSalt]);
}
const U256_MAX = (1n << 256n) - 1n;
/** Serde(SenderBalanceRules): bools as 0/1, u256 as [low, high]. */
function rulesFelts(r) {
    for (const [name, v] of [["locked", r.locked], ["minResidual", r.minResidual]]) {
        if (v < 0n || v > U256_MAX)
            throw new Error(`${name} out of u256 range: ${v}`);
    }
    const b = (x) => (x ? 1n : 0n);
    return [
        b(r.fullRequired),
        b(r.capped),
        r.locked & U128_MAX,
        r.locked >> 128n,
        r.minResidual & U128_MAX,
        r.minResidual >> 128n,
        b(r.residualStrict),
    ];
}
/** hash_rules — the order's `maker_rules_hash`. */
export function hashRules(rules) {
    return poseidon([DOMAIN_RULES, ...rulesFelts(rules)]);
}
/** compute_order_id — binds the order to a pool + chain so it can't be replayed
 *  across deployments. */
export function computeOrderId(pool, chainId, order) {
    assertU128("offerAmount", order.offerAmount);
    assertU128("wantAmount", order.wantAmount);
    return poseidon([
        DOMAIN_ORDER_ID,
        pool,
        chainId,
        computeMakerCommitment(order.maker, order.makerSalt),
        order.offerToken,
        order.offerAmount,
        order.wantToken,
        order.wantAmount,
        order.expiry,
        order.nonce,
    ]);
}
/** compute_batch_id — binds the order set AND the per-order (deliver, draw)
 *  fills: the replay guard (`is_batch_used`) for exactly the amounts proven.
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
/** Note salts 0 (empty) and 1 (open note) are reserved. */
function assertNoteSalt(name, v) {
    assertU128(name, v);
    if (v < 2n)
        throw new Error(`${name} must be >= 2 (0 and 1 are reserved): ${v}`);
}
/** Calldata for `post_order_derive(maker, k: u256, offer_token, offer_amount:
 *  u128, want_token, want_amount: u128, expiry: u64, nonce, maker_salt,
 *  audit_ephemeral_secret_r, change_note_salt: u128, offer_subchannel_salt,
 *  receive_subchannel_salt)`. */
export function buildPostOrderDeriveCalldata(args) {
    const { order } = args;
    if (order.maker !== args.maker)
        throw new Error("order.maker must equal maker");
    if (order.makerSalt === 0n)
        throw new Error("makerSalt must be non-zero");
    assertU128("offerAmount", order.offerAmount);
    assertU128("wantAmount", order.wantAmount);
    assertNoteSalt("changeNoteSalt", args.changeNoteSalt);
    return [
        hex(args.maker),
        ...u256Pair(args.makerPrivateViewingKey),
        hex(order.offerToken),
        hex(order.offerAmount),
        hex(order.wantToken),
        hex(order.wantAmount),
        hex(order.expiry),
        hex(order.nonce),
        hex(order.makerSalt),
        hex(args.auditEphemeralSecret),
        hex(args.changeNoteSalt),
        hex(args.offerSubchannelSalt),
        hex(args.receiveSubchannelSalt),
    ];
}
/** Calldata for `cancel_order_derive(maker, k: u256, order_id, maker_salt,
 *  leftover_note_salt: u128)`. */
export function buildCancelOrderDeriveCalldata(args) {
    assertNoteSalt("leftoverNoteSalt", args.leftoverNoteSalt);
    return [
        hex(args.maker),
        ...u256Pair(args.makerPrivateViewingKey),
        hex(args.orderId),
        hex(args.makerSalt),
        hex(args.leftoverNoteSalt),
    ];
}
/** Calldata for `execute_batch_derive(order_ids: Array<felt252>, fills:
 *  Array<BatchFill>, batch_nonce, makers: Array<MakerOpening>)`. */
export function buildExecuteBatchDeriveCalldata(args) {
    const { orderIds, fills, makers } = args;
    if (orderIds.length !== fills.length || orderIds.length !== makers.length) {
        throw new Error("executeBatch: orderIds, fills and makers length mismatch");
    }
    const out = [BigInt(orderIds.length), ...orderIds, BigInt(fills.length)];
    for (const f of fills) {
        if (f.deliver <= 0n)
            throw new Error("fill.deliver must be > 0");
        assertU128("deliver", f.deliver);
        assertU128("draw", f.draw);
        out.push(f.deliver, f.draw);
    }
    out.push(args.batchNonce, BigInt(makers.length));
    for (const m of makers) {
        if (m.makerSalt === 0n)
            throw new Error("makerSalt must be non-zero");
        out.push(m.maker, m.makerSalt, ...rulesFelts(m.makerRules));
    }
    return out.map(hex);
}
/** Calldata for `venue_fill_derive(receipt_ids: Array<felt252>,
 *  makers: Array<MakerOpening>)`, before the authorization is appended. */
export function buildVenueFillDeriveCalldata(args) {
    const { receiptIds, makers } = args;
    if (receiptIds.length === 0)
        throw new Error("venueFill: no receipts");
    if (receiptIds.length !== makers.length) {
        throw new Error("venueFill: receiptIds and makers length mismatch");
    }
    const out = [BigInt(receiptIds.length), ...receiptIds, BigInt(makers.length)];
    for (const m of makers) {
        if (m.makerSalt === 0n)
            throw new Error("makerSalt must be non-zero");
        out.push(m.maker, m.makerSalt, ...rulesFelts(m.makerRules));
    }
    return out.map(hex);
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
