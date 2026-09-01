import { BPS_DENOMINATOR } from '../config/constants';

/**
 * Pure leverage / looping math. Kept dependency-free for unit testing.
 *
 * All rate inputs/outputs are in basis points unless suffixed otherwise.
 * Health factors are plain numbers where 1.0 = liquidation boundary.
 */

/** Flashloan needed to reach `leverage` on `margin`: F = margin * (L - 1). */
export function flashloanAmountFor(margin: bigint, leverage: number): bigint {
  return margin * BigInt(leverage - 1);
}

/** Total collateral after opening: margin * L. */
export function totalCollateralFor(margin: bigint, leverage: number): bigint {
  return margin * BigInt(leverage);
}

/**
 * Net leveraged APY on the margin, in bps:
 *   net = L * supplyApy - (L - 1) * borrowApr
 * Negative when the borrow cost exceeds the supply yield.
 */
export function netApyBps(
  supplyApyBps: number,
  borrowAprBps: number,
  leverage: number
): number {
  return leverage * supplyApyBps - (leverage - 1) * borrowAprBps;
}

/**
 * Health factor right after opening a same-asset-value loop:
 *   HF = (L * C * LT) / ((L - 1) * C) = L * LT / (L - 1)
 * with LT in basis points.
 */
export function projectedHealthFactor(
  leverage: number,
  liquidationThresholdBps: number
): number {
  const lt = liquidationThresholdBps / BPS_DENOMINATOR;
  return (leverage * lt) / (leverage - 1);
}

/**
 * Highest integer leverage whose debt stays within `ltvBps` borrowing power,
 * keeping `safetyMarginBps` of headroom below the LTV cap:
 *   (L - 1) / L <= ltv * (1 - safety)
 */
export function maxLeverageForLtv(
  ltvBps: number,
  safetyMarginBps = 200
): number {
  const effectiveLtv = (ltvBps - safetyMarginBps) / BPS_DENOMINATOR;
  if (effectiveLtv <= 0) return 1;
  return Math.floor(1 / (1 - effectiveLtv));
}

/** True when a leverage level keeps the projected HF at or above `minHF`. */
export function leverageAllowed(
  leverage: number,
  liquidationThresholdBps: number,
  ltvBps: number,
  minHF: number
): boolean {
  if (maxLeverageForLtv(ltvBps) < leverage) return false;
  return projectedHealthFactor(leverage, liquidationThresholdBps) >= minHF;
}

/**
 * Expected yearly net yield in margin terms (bps of margin):
 * same as netApyBps — provided for call-site readability.
 */
export function yearlyNetYieldOnMarginBps(
  supplyApyBps: number,
  borrowAprBps: number,
  leverage: number
): number {
  return netApyBps(supplyApyBps, borrowAprBps, leverage);
}

/**
 * How far the collateral/debt value ratio may move before HF hits 1.
 * Returns the fraction (e.g. 0.15 = a 15% adverse move liquidates).
 * Only meaningful for cross-asset loops; ~1 for same-asset stable loops.
 */
export function liquidationBuffer(
  leverage: number,
  liquidationThresholdBps: number
): number {
  const lt = liquidationThresholdBps / BPS_DENOMINATOR;
  // HF = C*LT / D. HF = 1 when C drops to D/LT.
  // drop fraction = 1 - (D / LT) / C = 1 - (L-1) / (L * LT)
  return 1 - (leverage - 1) / (leverage * lt);
}

/**
 * Minimum acceptable swap output for a cross-asset open, derived from the
 * oracle-implied fair value with a slippage tolerance. For same-asset loops
 * there is no swap and the caller passes 0.
 *
 *   fairOut = amountIn * priceIn / priceOut * 10^(decOut - decIn)
 *   minOut  = fairOut * (1 - slippageBps / 10000)
 *
 * Returns a bigint in `tokenOut` units. Uses integer math so it is safe to
 * unit-test deterministically.
 *
 * @param amountIn       Input amount (tokenIn units).
 * @param priceIn        Oracle price of tokenIn (1e8 scaled, like Aave oracle).
 * @param priceOut       Oracle price of tokenOut (1e8 scaled).
 * @param decimalsIn     ERC20 decimals of tokenIn.
 * @param decimalsOut    ERC20 decimals of tokenOut.
 * @param slippageBps    Tolerated slippage in basis points (e.g. 50 = 0.5%).
 */
export function minSwapOutFromOracle(
  amountIn: bigint,
  priceIn: bigint,
  priceOut: bigint,
  decimalsIn: number,
  decimalsOut: number,
  slippageBps: number,
): bigint {
  // fair = amountIn * priceIn / priceOut, then adjust for decimal difference.
  // Scale the numerator before dividing so a positive decimal adjustment
  // (decimalsOut > decimalsIn) does not truncate the fractional output to zero.
  let fairOut: bigint;
  if (decimalsOut > decimalsIn) {
    const scale = 10n ** BigInt(decimalsOut - decimalsIn);
    fairOut = (amountIn * priceIn * scale) / priceOut;
  } else if (decimalsIn > decimalsOut) {
    const scale = 10n ** BigInt(decimalsIn - decimalsOut);
    fairOut = (amountIn * priceIn) / (priceOut * scale);
  } else {
    fairOut = (amountIn * priceIn) / priceOut;
  }
  const factor = BigInt(BPS_DENOMINATOR - slippageBps);
  return (fairOut * factor) / BigInt(BPS_DENOMINATOR);
}
