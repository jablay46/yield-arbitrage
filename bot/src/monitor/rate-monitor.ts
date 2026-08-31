import { Address } from 'viem';
import { BasePublicClient } from '../client-types';
import { aavePoolAbi, dataProviderAbi, erc20Abi } from '../abis';
import {
  ADDRESSES,
  TOKENS,
  TOKEN_DECIMALS,
  SECONDS_PER_YEAR,
} from '../config/constants';

/**
 * On-chain rate for a single Aave V3 reserve.
 * Rates are basis points (10000 = 100%).
 */
export interface MarketRate {
  asset: Address;
  symbol: string;
  decimals: number;
  supplyApyBps: number;
  borrowAprBps: number;
  availableLiquidity: bigint;
  utilizationBps: number;
  ltvBps: number;
  liquidationThresholdBps: number;
  borrowingEnabled: boolean;
  isActive: boolean;
  isFrozen: boolean;
  lastUpdated: number;
}

const RAY_NUMBER = 1e27;

/** Aave rates are ray-scaled per-second APR; convert to APY bps. */
export function rayRateToApyBps(rateRay: bigint): number {
  const apr = Number(rateRay) / RAY_NUMBER;
  const apy = Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1;
  return apy * 10000;
}

/** Aave variable borrow rate (ray per-second) to APR bps. */
export function rayRateToAprBps(rateRay: bigint): number {
  return (Number(rateRay) / RAY_NUMBER) * 10000;
}

/**
 * Fetches real on-chain rates from the Aave V3 pool for the configured
 * watchlist, using batched multicalls.
 */
export class RateMonitor {
  private client: BasePublicClient;
  private watchlist: Address[];

  constructor(client: BasePublicClient, watchlist?: Address[]) {
    this.client = client;
    this.watchlist = watchlist ?? (Object.values(TOKENS) as Address[]);
  }

  async getAllRates(): Promise<MarketRate[]> {
    const n = this.watchlist.length;

    const reserveCalls = this.watchlist.map((asset) => ({
      address: ADDRESSES.aavePool as Address,
      abi: aavePoolAbi,
      functionName: 'getReserveData' as const,
      args: [asset] as const,
    }));
    const configCalls = this.watchlist.map((asset) => ({
      address: ADDRESSES.aaveProtocolDataProvider as Address,
      abi: dataProviderAbi,
      functionName: 'getReserveConfigurationData' as const,
      args: [asset] as const,
    }));

    const [reserveResults, configResults] = await Promise.all([
      this.client.multicall({ contracts: reserveCalls, allowFailure: true }),
      this.client.multicall({ contracts: configCalls, allowFailure: true }),
    ]);

    // Liquidity needs the aToken address from reserveData first. Results
    // are keyed by reserve-result index (not a running counter) so a failed
    // reserve call doesn't shift later assets onto the wrong aToken balances.
    const liquidityIndex: number[] = [];
    const liquidityCalls = reserveResults
      .map((r, i) => ({ r, i, asset: this.watchlist[i] }))
      .filter(({ r }) => r.status === 'success')
      .map(({ r, i, asset }) => {
        liquidityIndex.push(i);
        return {
          address: asset,
          abi: erc20Abi,
          functionName: 'balanceOf' as const,
          args: [
            (r as Extract<typeof r, { status: 'success' }>).result.aTokenAddress,
          ] as const,
        };
      });

    const liquidityResults = liquidityCalls.length
      ? await this.client.multicall({ contracts: liquidityCalls, allowFailure: true })
      : [];

    const liquidityByReserveIndex = new Map<number, bigint>();
    liquidityIndex.forEach((reserveIdx, pos) => {
      const liqResult = liquidityResults[pos];
      liquidityByReserveIndex.set(
        reserveIdx,
        liqResult?.status === 'success' ? (liqResult.result as bigint) : 0n,
      );
    });

    const rates: MarketRate[] = [];
    for (let i = 0; i < n; i++) {
      const reserve = reserveResults[i];
      const config = configResults[i];
      if (reserve.status !== 'success' || config.status !== 'success') continue;

      const rd = reserve.result;
      const cfg = config.result;

      const availableLiquidity = liquidityByReserveIndex.get(i) ?? 0n;

      const symbol = this.symbolFor(this.watchlist[i]);

      // getReserveConfigurationData positional outputs
      const [, ltv, liquidationThreshold, , , , borrowingEnabled, , isActive, isFrozen] =
        cfg;

      rates.push({
        asset: this.watchlist[i],
        symbol,
        decimals: TOKEN_DECIMALS[symbol] ?? 18,
        supplyApyBps: rayRateToApyBps(rd.currentLiquidityRate),
        borrowAprBps: rayRateToAprBps(rd.currentVariableBorrowRate),
        availableLiquidity,
        utilizationBps: 0,
        ltvBps: Number(ltv),
        liquidationThresholdBps: Number(liquidationThreshold),
        borrowingEnabled,
        isActive,
        isFrozen,
        lastUpdated: Date.now(),
      });
    }

    return rates;
  }

  private symbolFor(asset: Address): string {
    const entry = Object.entries(TOKENS).find(([, a]) => a === asset);
    return entry ? entry[0] : asset.slice(0, 8);
  }
}
