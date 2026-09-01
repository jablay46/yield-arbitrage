/**
 * PnL estimation helpers for closed leveraged loops.
 *
 * The margin in a same-asset unwind is returned intact, so realized PnL is
 * estimated from the net APY captured at open over the hold duration, minus
 * the gas spent opening and closing. This is an on-rate estimate, not a
 * balance-delta measurement.
 */

/** Seconds per year (365 days), matching the on-chain SECONDS_PER_YEAR. */
export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export interface PnLEstimateInput {
  /** USD value of the margin at open time. */
  marginUsd: number;
  /** Net APY at open, in basis points (10000 = 100%). */
  netApyBpsAtOpen: number;
  /** Hold duration in milliseconds. */
  holdMs: number;
  /** Gas spent on open + close, in gas units (receipt.gasUsed). */
  gasWei: bigint;
  /** Max fee per gas from the tx (wei). This is an upper bound on the
   *  effective gas price, so the gas cost is conservatively over-estimated. */
  maxFeePerGas: bigint;
  /** USD price of the gas-paying asset (ETH on Base). */
  gasAssetPriceUsd: number;
}

export interface PnLEstimate {
  grossYieldUsd: number;
  gasCostUsd: number;
  netPnlUsd: number;
  durationHours: number;
}

export function estimateRealizedPnL(input: PnLEstimateInput): PnLEstimate {
  const holdSeconds = Math.max(0, input.holdMs / 1000);
  const durationHours = holdSeconds / 3600;
  const yearFraction = holdSeconds / SECONDS_PER_YEAR;

  const grossYieldUsd =
    input.marginUsd * (input.netApyBpsAtOpen / 10000) * yearFraction;

  const ethCost = Number(input.gasWei * input.maxFeePerGas) / 1e18;
  const gasCostUsd = ethCost * input.gasAssetPriceUsd;

  return {
    grossYieldUsd,
    gasCostUsd,
    netPnlUsd: grossYieldUsd - gasCostUsd,
    durationHours,
  };
}
