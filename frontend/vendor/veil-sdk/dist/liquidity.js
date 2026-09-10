// Concentrated-liquidity sizing for VeilX pools.
//
// `VeilXRouter::add_liquidity` takes a liquidity figure rather than deriving it
// from the deposit amounts, so the derivation lives here. That is a deliberate
// split: the maths is a pure function of the price and the range, it costs
// nothing to do off-chain, and keeping it out of the contract keeps VeilX's
// on-chain dependency on Ekubo down to interfaces and type definitions.
//
// Getting it wrong is not dangerous — it is a revert. The caller passes
// `max_amount0` / `max_amount1` alongside, and the router refuses any position
// that would cost more than those caps.
//
// The formulas are the standard concentrated-liquidity ones (Uniswap V3
// whitepaper §6.29–6.30), with Ekubo's parameters: sqrt ratios are 128.128
// fixed point rather than Q96, and a tick is a factor of 1.000001 rather than
// 1.0001.
const Q128 = 1n << 128n;
/** Ekubo's tick base. A tick multiplies the price by this. */
export const TICK_BASE = 1.000001;
/** The widest tick Ekubo Core accepts, either side of zero. */
export const MAX_TICK_MAGNITUDE = 88722883n;
/** Core's price bounds as 128.128 sqrt ratios — sqrt(1.000001^±88722883). */
export const MAX_SQRT_RATIO = 6277100250585753475930931601400621808602321654880405518632n;
export const MIN_SQRT_RATIO = 18446748437148339061n;
/**
 * sqrt(1.000001^tick) as a 128.128 fixed-point number.
 *
 * Evaluated in double precision and then placed exactly, which keeps the full
 * 53-bit mantissa instead of losing it to an intermediate rounding. That is
 * ~1e-16 relative error on a value used only to size a deposit, and the caps
 * bound the consequences either way.
 */
export function tickToSqrtRatio(tick) {
    const t = Number(tick);
    if (Math.abs(t) > Number(MAX_TICK_MAGNITUDE)) {
        throw new Error(`tick ${t} is outside Ekubo's ±${MAX_TICK_MAGNITUDE} range`);
    }
    // The endpoints are exact protocol constants, not approximations: Core
    // rejects anything outside them, so a tick at the boundary must return the
    // boundary itself rather than a double-precision neighbour of it.
    if (t === Number(MAX_TICK_MAGNITUDE))
        return MAX_SQRT_RATIO;
    if (t === -Number(MAX_TICK_MAGNITUDE))
        return MIN_SQRT_RATIO;
    const sqrtPrice = Math.pow(TICK_BASE, t / 2);
    const exponent = Math.floor(Math.log2(sqrtPrice));
    const mantissa = sqrtPrice / Math.pow(2, exponent); // in [1, 2)
    const m53 = BigInt(Math.round(mantissa * 2 ** 52));
    const shift = BigInt(128 + exponent - 52);
    const ratio = shift >= 0n ? m53 << shift : m53 >> -shift;
    // Clamp: rounding at the extremes must never produce a limit Core rejects.
    if (ratio > MAX_SQRT_RATIO)
        return MAX_SQRT_RATIO;
    if (ratio < MIN_SQRT_RATIO)
        return MIN_SQRT_RATIO;
    return ratio;
}
/** The inverse — the tick whose sqrt ratio is closest to `sqrtRatio`. */
export function sqrtRatioToTick(sqrtRatio) {
    const asFloat = Number((sqrtRatio * 10n ** 9n) / Q128) / 1e9;
    return BigInt(Math.round((2 * Math.log(asFloat)) / Math.log(TICK_BASE)));
}
/** Liquidity supportable by `amount` of token0 across [sa, sb]. */
export function liquidityForToken0(sa, sb, amount) {
    if (amount === 0n)
        return 0n;
    if (sb <= sa)
        throw new Error("sqrt ratio bounds out of order");
    return ((amount * sa * sb) / Q128) / (sb - sa);
}
/** Liquidity supportable by `amount` of token1 across [sa, sb]. */
export function liquidityForToken1(sa, sb, amount) {
    if (amount === 0n)
        return 0n;
    if (sb <= sa)
        throw new Error("sqrt ratio bounds out of order");
    return (amount * Q128) / (sb - sa);
}
/**
 * The largest liquidity both deposit amounts can support in this range.
 *
 * Below the range the position is all token0, above it all token1, and inside
 * it the binding constraint is whichever leg runs out first.
 */
export function maxLiquidity(sqrtRatioCurrent, sqrtRatioLower, sqrtRatioUpper, amount0, amount1) {
    if (sqrtRatioLower >= sqrtRatioUpper)
        throw new Error("sqrt ratio bounds out of order");
    if (sqrtRatioCurrent <= sqrtRatioLower) {
        return liquidityForToken0(sqrtRatioLower, sqrtRatioUpper, amount0);
    }
    if (sqrtRatioCurrent < sqrtRatioUpper) {
        const l0 = liquidityForToken0(sqrtRatioCurrent, sqrtRatioUpper, amount0);
        const l1 = liquidityForToken1(sqrtRatioLower, sqrtRatioCurrent, amount1);
        return l0 < l1 ? l0 : l1;
    }
    return liquidityForToken1(sqrtRatioLower, sqrtRatioUpper, amount1);
}
/** What a given liquidity costs in each token at the current price. */
export function amountsForLiquidity(sqrtRatioCurrent, sqrtRatioLower, sqrtRatioUpper, liquidity) {
    const lo = sqrtRatioLower;
    const hi = sqrtRatioUpper;
    if (lo >= hi)
        throw new Error("sqrt ratio bounds out of order");
    const amount0Between = (a, b) => (liquidity * Q128 * (b - a)) / (a * b);
    const amount1Between = (a, b) => (liquidity * (b - a)) / Q128;
    if (sqrtRatioCurrent <= lo) {
        return { amount0: amount0Between(lo, hi), amount1: 0n };
    }
    if (sqrtRatioCurrent < hi) {
        return {
            amount0: amount0Between(sqrtRatioCurrent, hi),
            amount1: amount1Between(lo, sqrtRatioCurrent),
        };
    }
    return { amount0: 0n, amount1: amount1Between(lo, hi) };
}
/**
 * The one call a caller needs before `add_liquidity`: given the pool's current
 * sqrt ratio, the tick bounds, the amounts on hand and a slippage tolerance,
 * produce the `liquidity` figure and the `max_amount*` caps to pass alongside
 * it.
 *
 * The caps are the requested amounts, so the position can never cost more than
 * what the caller already decided to commit.
 */
export function sizeLiquidity(args) {
    const lower = tickToSqrtRatio(args.tickLower);
    const upper = tickToSqrtRatio(args.tickUpper);
    const raw = maxLiquidity(args.sqrtRatioCurrent, lower, upper, args.amount0, args.amount1);
    const bps = args.slippageBps ?? 50n; // 0.5%
    const liquidity = (raw * (10000n - bps)) / 10000n;
    return { liquidity, maxAmount0: args.amount0, maxAmount1: args.amount1 };
}
