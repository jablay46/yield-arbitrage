import { Address } from 'viem';
import { LEVERAGE_LEVELS } from '../config/constants';
import { MarketRate } from '../monitor/rate-monitor';
import {
  flashloanAmountFor,
  leverageAllowed,
  netApyBps,
  projectedHealthFactor,
} from './loop-calculator';

export interface LoopCandidate {
  asset: Address;
  symbol: string;
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
  minNetApyBps: number
): LoopCandidate[] {
  const candidates: LoopCandidate[] = [];

  for (const rate of rates) {
    if (!rate.isActive || rate.isFrozen || !rate.borrowingEnabled) continue;
    if (rate.availableLiquidity < flashloanAmountFor(marginAmount, 5)) continue;

    for (const leverage of LEVERAGE_LEVELS) {
      const net = netApyBps(rate.supplyApyBps, rate.borrowAprBps, leverage);
      if (net < minNetApyBps) continue;

      const allowedNormal = leverageAllowed(
        leverage,
        rate.liquidationThresholdBps,
        rate.ltvBps,
        minHealthFactor
      );

      // e-mode (ETH correlated, LT ~90%) can rescue higher leverage on ETH assets
      const isEthCorrelated = ['WETH', 'cbETH', 'wstETH', 'weETH'].includes(
        rate.symbol
      );
      const emodeLtBps = 9000;
      const emodeLtvBps = 8700;
      const allowedEmode =
        isEthCorrelated &&
        leverageAllowed(leverage, emodeLtBps, emodeLtvBps, minHealthFactor);

      if (!allowedNormal && !allowedEmode) continue;

      const needsEmode = !allowedNormal;
      const ltBps = needsEmode ? emodeLtBps : rate.liquidationThresholdBps;

      candidates.push({
        asset: rate.asset,
        symbol: rate.symbol,
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
