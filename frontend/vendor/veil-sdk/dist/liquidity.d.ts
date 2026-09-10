/** Ekubo's tick base. A tick multiplies the price by this. */
export declare const TICK_BASE = 1.000001;
/** The widest tick Ekubo Core accepts, either side of zero. */
export declare const MAX_TICK_MAGNITUDE = 88722883n;
/** Core's price bounds as 128.128 sqrt ratios — sqrt(1.000001^±88722883). */
export declare const MAX_SQRT_RATIO = 6277100250585753475930931601400621808602321654880405518632n;
export declare const MIN_SQRT_RATIO = 18446748437148339061n;
/**
 * sqrt(1.000001^tick) as a 128.128 fixed-point number.
 *
 * Evaluated in double precision and then placed exactly, which keeps the full
 * 53-bit mantissa instead of losing it to an intermediate rounding. That is
 * ~1e-16 relative error on a value used only to size a deposit, and the caps
 * bound the consequences either way.
 */
export declare function tickToSqrtRatio(tick: bigint | number): bigint;
/** The inverse — the tick whose sqrt ratio is closest to `sqrtRatio`. */
export declare function sqrtRatioToTick(sqrtRatio: bigint): bigint;
/** Liquidity supportable by `amount` of token0 across [sa, sb]. */
export declare function liquidityForToken0(sa: bigint, sb: bigint, amount: bigint): bigint;
/** Liquidity supportable by `amount` of token1 across [sa, sb]. */
export declare function liquidityForToken1(sa: bigint, sb: bigint, amount: bigint): bigint;
/**
 * The largest liquidity both deposit amounts can support in this range.
 *
 * Below the range the position is all token0, above it all token1, and inside
 * it the binding constraint is whichever leg runs out first.
 */
export declare function maxLiquidity(sqrtRatioCurrent: bigint, sqrtRatioLower: bigint, sqrtRatioUpper: bigint, amount0: bigint, amount1: bigint): bigint;
/** What a given liquidity costs in each token at the current price. */
export declare function amountsForLiquidity(sqrtRatioCurrent: bigint, sqrtRatioLower: bigint, sqrtRatioUpper: bigint, liquidity: bigint): {
    amount0: bigint;
    amount1: bigint;
};
/**
 * The one call a caller needs before `add_liquidity`: given the pool's current
 * sqrt ratio, the tick bounds, the amounts on hand and a slippage tolerance,
 * produce the `liquidity` figure and the `max_amount*` caps to pass alongside
 * it.
 *
 * The caps are the requested amounts, so the position can never cost more than
 * what the caller already decided to commit.
 */
export declare function sizeLiquidity(args: {
    sqrtRatioCurrent: bigint;
    tickLower: bigint | number;
    tickUpper: bigint | number;
    amount0: bigint;
    amount1: bigint;
    /** Shave this many basis points off, to absorb price drift before inclusion. */
    slippageBps?: bigint;
}): {
    liquidity: bigint;
    maxAmount0: bigint;
    maxAmount1: bigint;
};
