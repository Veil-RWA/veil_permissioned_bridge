// HyperVeil client helpers: private Hyperliquid spot trading through Veil.
//
// Everything here is pure: calldata, note ids, order terms and STRK20 wallet
// actions, built from values the caller reads from the chain. Nothing signs or
// submits — the app hands the derive calldata to `VeilProver` and the STRK20
// actions to the wallet (`wallet_strk20InvokeTransaction`).
//
// The user's USDC and STRK live inside the HyperVeil Veil pool. They enter by
// a plain pool deposit or from STRK20 (`strk20ToVeilActions`); every fee,
// deposit to Hyperliquid and exit is a proven pool invoke planned here.
//
// See hyperveil/README.md for the flows these serve.
import { computeNoteId } from "./crypto.js";
import { buildInvokeDeriveCalldata, hex, invokeCalldataHash, u256Felts } from "./invoke.js";
/** What every HyperVeil invoke adapter (fee adapter, entry helper, gateway)
 *  hands back into the invoke's open note: a pool invoke must return
 *  something. */
export const INVOKE_CHANGE = 1n;
/** Fee adapter targets. */
export const FUND_ORDER = 0;
export const FUND_NOTE = 1;
/** HyperCore USDC has 8 decimals, CCTP USDC 6. */
export const USDC_CORE_PER_CCTP_UNIT = 100n;
// ── Note selection (mirror of `select_input_notes_internal`) ────────────────
/** What the pool takes to cover `target` of `token`: it walks the owner's
 *  notes in the order discovery lists them (channel by channel, slot by slot)
 *  and stops once it has enough. Returns that total, or null if the balance
 *  cannot cover `target`. */
export function selectInputTotal(notes, token, target) {
    let total = 0n;
    for (const n of notes) {
        if (n.token !== token)
            continue;
        total += n.amount;
        if (total >= target)
            return total;
    }
    return null;
}
/** A pool invoke that pays `target` `amount + 1` of `token` and calls its
 *  `privacy_invoke(open_note_id, ...tail)`. */
export function planSameTokenInvoke(a) {
    if (a.amount <= 0n)
        throw new Error(`${a.what}: amount must be positive`);
    const inAmount = a.amount + INVOKE_CHANGE;
    const total = selectInputTotal(a.notes, a.token, inAmount);
    if (total === null)
        throw new Error(`${a.what}: insufficient balance`);
    const hasChange = total > inAmount;
    const openNoteIndex = a.firstFreeSlot + (hasChange ? 1 : 0);
    const openNoteId = computeNoteId(a.selfChannelKey, a.token, openNoteIndex);
    const invokeCalldata = [hex(openNoteId), ...a.tail];
    const calldataHash = invokeCalldataHash(invokeCalldata);
    return {
        inAmount,
        openNoteId,
        openNoteIndex,
        invokeCalldata,
        calldataHash,
        deriveCalldata: buildInvokeDeriveCalldata({
            caller: a.owner,
            ownerPrivateViewingKey: a.ownerPrivateViewingKey,
            inToken: a.token,
            inAmount,
            outToken: a.token,
            target: a.target,
            calldataHash,
            auditEphemeralSecret: a.auditEphemeralSecret,
            changeNoteSalt: a.changeNoteSalt,
            subchannelSalt: a.subchannelSalt,
        }),
        settleExtra: [hex(BigInt(invokeCalldata.length)), ...invokeCalldata],
    };
}
/** Prepay a LayerZero fee from STRK held in the pool, through the fee adapter:
 *  `FUND_ORDER` for an order's routing and cancel (key = order id),
 *  `FUND_NOTE` for the deposit that credits a USDC-twin note or the exit that
 *  fills a USDC note (key = that note id). */
export function planFee(a) {
    return planSameTokenInvoke({
        ...a,
        token: a.strk,
        target: a.feeAdapter,
        tail: [hex(BigInt(a.target)), hex(a.key), hex(a.amount)],
        what: "fee",
    });
}
/** USDC from the pool to Hyperliquid: the entry helper burns `amountUsdc6`
 *  through CCTP to the omnibus and registers the deposit; the USDC twin is
 *  credited into `twinNoteId` (an empty USDC-twin open note whose DEPOSIT fee
 *  was prepaid with `planFee(FUND_NOTE)`) once the omnibus confirms. */
export function planDeposit(a) {
    const [maxLow, maxHigh] = u256Felts(a.cctpMaxFee);
    return planSameTokenInvoke({
        ...a,
        token: a.usdc,
        target: a.entryHelper,
        amount: a.amountUsdc6,
        tail: [hex(a.amountUsdc6), hex(a.twinNoteId), maxLow, maxHigh, hex(BigInt(a.minFinality)), hex(a.returnValue)],
        what: "deposit",
    });
}
/** The USDC twin back to real USDC in the pool: the gateway burns `amount`
 *  (twin units, 8 dp, a whole number of CCTP units) and the exit vault later
 *  fills `usdcNoteId` (an empty real-USDC open note whose WITHDRAW fee was
 *  prepaid with `planFee(FUND_NOTE)`). */
export function planExit(a) {
    if (a.amount <= 0n || a.amount % USDC_CORE_PER_CCTP_UNIT !== 0n) {
        throw new Error("exit amount must be a positive whole number of CCTP units (multiple of 100)");
    }
    return planSameTokenInvoke({
        ...a,
        token: a.usdcTwin,
        target: a.gateway,
        tail: [hex(a.amount), hex(a.usdcNoteId), hex(a.returnValue)],
        what: "exit",
    });
}
/** A human decimal ("24.9") as an integer with `decimals` places (exact). */
export function toUnits(value, decimals) {
    const s = value.trim();
    if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".")
        throw new Error(`not a number: ${value}`);
    const [int = "0", frac = ""] = s.split(".");
    const trimmed = frac.replace(/0+$/, "");
    if (trimmed.length > decimals)
        throw new Error(`${value} has more than ${decimals} decimals`);
    return BigInt(int || "0") * 10n ** BigInt(decimals) + BigInt((trimmed.padEnd(decimals, "0")) || "0");
}
/** A Veil DvP order for "buy/sell `size` base at `price` (quote per base)".
 *  The order's limit leaves room for Hyperliquid's worst fee (`maxFeeBps`,
 *  the omnibus's), so a route to Hyperliquid can still be placed at `price`:
 *  a buy escrows `size * price / (1 - fee)` of quote; a sell asks for
 *  `size * price * (1 - fee)`. */
export function orderTerms(args) {
    const { base, quote } = args;
    const sizeWei = toUnits(args.size, base.decimals);
    const px = toUnits(args.price, 8); // 1e8 fixed point
    if (sizeWei === 0n || px === 0n)
        throw new Error("size and price must be positive");
    const keep = 10000n - BigInt(args.maxFeeBps);
    // quote wei = size_wei * px * 10^wdq / (10^wdb * 1e8)
    const num = sizeWei * px * 10n ** BigInt(quote.decimals);
    const den = 10n ** BigInt(base.decimals) * 10n ** 8n;
    if (args.side === "buy") {
        const offer = (num * 10000n + den * keep - 1n) / (den * keep); // round up
        return { offerToken: quote.address, offerAmount: offer, wantToken: base.address, wantAmount: sizeWei };
    }
    const want = (num * keep) / (den * 10000n); // round down
    if (want === 0n)
        throw new Error("order too small");
    return { offerToken: base.address, offerAmount: sizeWei, wantToken: quote.address, wantAmount: want };
}
/** A private STRK20 balance of `token` into the user's Veil pool balance, in
 *  one STRK20 transaction: withdraw `amount` to the HyperVeil STRK20 entry,
 *  then invoke it; it fills `veilNoteId`, the user's empty open note of
 *  `token` in the Veil pool. */
export function strk20ToVeilActions(a) {
    if (a.amount <= 0n)
        throw new Error("amount must be positive");
    return [
        { type: "withdraw", token: hex(a.token), amount: hex(a.amount), recipient: hex(a.strk20Entry) },
        { type: "invoke", contract: hex(a.strk20Entry), calldata: [hex(a.token), hex(a.veilNoteId), hex(a.amount)] },
    ];
}
