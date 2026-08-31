import { Address } from 'viem';
import { LEVERAGE_LEVELS } from '../config/constants';
import { EModeCategoryData, MarketRate } from '../monitor/rate-monitor';
import {
  flashloanAmountFor,
  leverageAllowed,
  netApyBps,
  projectedHealthFactor,
} from './loop-calculator';

export interface LoopCandidate {
  asset: Address;
  symbol: string;
  decimals: number;
  leverage: number;
  marginAmount: bigint;
  flashloanAmount: bigint;
  supplyApyBps: number;
  borrowAprBps: number;
  netApyBps: number;
  projectedHealthFactor: number;
  /** Whether the candidate needs an e-mode category (LTV too low otherwise) */
  needsEmode: boolean;
}

/**
 * Builds ranked loop candidates from live rates.
 * Same-asset loops only (supply WETH / borrow WETH); cross-asset looping
 * requires swap routing and is a future extension.
 */
export function findLoopCandidates(
  rates: MarketRate[],
  marginAmount: bigint,
  minHealthFactor: number,
  minNetApyBps: number,
  eModeCategory: EModeCategoryData
): LoopCandidate[] {
  const candidates: LoopCandidate[] = [];

  for (const rate of rates) {
    if (!rate.isActive || rate.isFrozen || !rate.borrowingEnabled) continue;

    for (const leverage of LEVERAGE_LEVELS) {
      // Evaluate liquidity per leverage level so a reserve that can fund a
      // 2x or 3x loop is not discarded merely because it cannot fund 5x.
      const flashloanAmount = flashloanAmountFor(marginAmount, leverage);
      if (rate.availableLiquidity < flashloanAmount) continue;

      const net = netApyBps(rate.supplyApyBps, rate.borrowAprBps, leverage);
      if (net < minNetApyBps) continue;

      const allowedNormal = leverageAllowed(
        leverage,
        rate.liquidationThresholdBps,
        rate.ltvBps,
        minHealthFactor
      );

      // ETH-correlated e-mode can rescue higher leverage on ETH assets.
      const isEthCorrelated = ['WETH', 'cbETH', 'wstETH', 'weETH'].includes(
        rate.symbol
      );
      const allowedEmode =
        isEthCorrelated &&
        leverageAllowed(
          leverage,
          eModeCategory.liquidationThresholdBps,
          eModeCategory.ltvBps,
          minHealthFactor
        );

      if (!allowedNormal && !allowedEmode) continue;

      const needsEmode = !allowedNormal;
      const ltBps = needsEmode
        ? eModeCategory.liquidationThresholdBps
        : rate.liquidationThresholdBps;

      candidates.push({
        asset: rate.asset,
        symbol: rate.symbol,
        decimals: rate.decimals,
        leverage,
        marginAmount,
        flashloanAmount: flashloanAmountFor(marginAmount, leverage),
        supplyApyBps: rate.supplyApyBps,
        borrowAprBps: rate.borrowAprBps,
        netApyBps: net,
        projectedHealthFactor: projectedHealthFactor(leverage, ltBps),
        needsEmode,
      });
    }
  }

  return candidates.sort((a, b) => b.netApyBps - a.netApyBps);
}
