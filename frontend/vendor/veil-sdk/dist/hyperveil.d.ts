import type { OwnedNote } from "./erc3643.js";
/** What every HyperVeil invoke adapter (fee adapter, entry helper, gateway)
 *  hands back into the invoke's open note: a pool invoke must return
 *  something. */
export declare const INVOKE_CHANGE = 1n;
/** Fee adapter targets. */
export declare const FUND_ORDER = 0;
export declare const FUND_NOTE = 1;
/** HyperCore USDC has 8 decimals, CCTP USDC 6. */
export declare const USDC_CORE_PER_CCTP_UNIT = 100n;
/** What the pool takes to cover `target` of `token`: it walks the owner's
 *  notes in the order discovery lists them (channel by channel, slot by slot)
 *  and stops once it has enough. Returns that total, or null if the balance
 *  cannot cover `target`. */
export declare function selectInputTotal(notes: OwnedNote[], token: bigint, target: bigint): bigint | null;
export interface SameTokenInvokeBase {
    owner: bigint;
    ownerPrivateViewingKey: bigint;
    /** The owner's self-channel key. */
    selfChannelKey: bigint;
    /** The owner's spendable notes, in discovery order. */
    notes: OwnedNote[];
    /** First empty slot of the invoked token in the self-channel (`nextNoteIndex`). */
    firstFreeSlot: number;
    auditEphemeralSecret: bigint;
    changeNoteSalt: bigint;
    subchannelSalt: bigint;
}
export interface InvokePlan {
    /** What the pool spends: the adapter's amount + INVOKE_CHANGE. */
    inAmount: bigint;
    openNoteId: bigint;
    openNoteIndex: number;
    invokeCalldata: string[];
    calldataHash: bigint;
    deriveCalldata: string[];
    /** `invoke_settle`'s tail: the adapter calldata as a serialized array. */
    settleExtra: string[];
}
/** A pool invoke that pays `target` `amount + 1` of `token` and calls its
 *  `privacy_invoke(open_note_id, ...tail)`. */
export declare function planSameTokenInvoke(a: SameTokenInvokeBase & {
    token: bigint;
    target: bigint;
    amount: bigint;
    tail: string[];
    what: string;
}): InvokePlan;
/** Prepay a LayerZero fee from STRK held in the pool, through the fee adapter:
 *  `FUND_ORDER` for an order's routing and cancel (key = order id),
 *  `FUND_NOTE` for the deposit that credits a USDC-twin note or the exit that
 *  fills a USDC note (key = that note id). */
export declare function planFee(a: SameTokenInvokeBase & {
    strk: bigint;
    feeAdapter: bigint;
    target: 0 | 1;
    key: bigint;
    amount: bigint;
}): InvokePlan;
/** USDC from the pool to Hyperliquid: the entry helper burns `amountUsdc6`
 *  through CCTP to the omnibus and registers the deposit; the USDC twin is
 *  credited into `twinNoteId` (an empty USDC-twin open note whose DEPOSIT fee
 *  was prepaid with `planFee(FUND_NOTE)`) once the omnibus confirms. */
export declare function planDeposit(a: SameTokenInvokeBase & {
    usdc: bigint;
    entryHelper: bigint;
    amountUsdc6: bigint;
    twinNoteId: bigint;
    cctpMaxFee: bigint;
    minFinality: number;
    /** HYPE (wei) for the omnibus's CREDIT; must equal the keeper's. */
    returnValue: bigint;
}): InvokePlan;
/** The USDC twin back to real USDC in the pool: the gateway burns `amount`
 *  (twin units, 8 dp, a whole number of CCTP units) and the exit vault later
 *  fills `usdcNoteId` (an empty real-USDC open note whose WITHDRAW fee was
 *  prepaid with `planFee(FUND_NOTE)`). */
export declare function planExit(a: SameTokenInvokeBase & {
    usdcTwin: bigint;
    gateway: bigint;
    amount: bigint;
    usdcNoteId: bigint;
    /** HYPE (wei) for the omnibus's reply; 0 — an exit has none. */
    returnValue: bigint;
}): InvokePlan;
export interface TwinToken {
    address: bigint;
    /** = the HyperCore token's weiDecimals. */
    decimals: number;
}
/** A human decimal ("24.9") as an integer with `decimals` places (exact). */
export declare function toUnits(value: string, decimals: number): bigint;
export interface OrderTerms {
    offerToken: bigint;
    offerAmount: bigint;
    wantToken: bigint;
    wantAmount: bigint;
}
/** A Veil DvP order for "buy/sell `size` base at `price` (quote per base)".
 *  The order's limit leaves room for Hyperliquid's worst fee (`maxFeeBps`,
 *  the omnibus's), so a route to Hyperliquid can still be placed at `price`:
 *  a buy escrows `size * price / (1 - fee)` of quote; a sell asks for
 *  `size * price * (1 - fee)`. */
export declare function orderTerms(args: {
    side: "buy" | "sell";
    size: string;
    price: string;
    base: TwinToken;
    quote: TwinToken;
    maxFeeBps: number;
}): OrderTerms;
export type Strk20Action = {
    type: "withdraw";
    token: string;
    amount: string;
    recipient: string;
} | {
    type: "transfer";
    token: string;
    amount: string | "OPEN";
    recipient: string;
} | {
    type: "invoke";
    contract: string;
    calldata: string[];
};
/** A private STRK20 balance of `token` into the user's Veil pool balance, in
 *  one STRK20 transaction: withdraw `amount` to the HyperVeil STRK20 entry,
 *  then invoke it; it fills `veilNoteId`, the user's empty open note of
 *  `token` in the Veil pool. */
export declare function strk20ToVeilActions(a: {
    token: bigint;
    strk20Entry: bigint;
    veilNoteId: bigint;
    amount: bigint;
}): Strk20Action[];
