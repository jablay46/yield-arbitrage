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
