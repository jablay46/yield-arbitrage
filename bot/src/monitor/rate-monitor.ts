import { Address } from 'viem';
import { BasePublicClient } from '../client-types';
import { aavePoolAbi, aaveOracleAbi, dataProviderAbi, erc20Abi } from '../abis';
import {
  ADDRESSES,
  EMODE,
  TOKENS,
  TOKEN_DECIMALS,
  SECONDS_PER_YEAR,
} from '../config/constants';

/** Aave oracle prices are USD with 8 decimals. */
export const ORACLE_USD_DECIMALS = 8;

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

export interface EModeCategoryData {
  ltvBps: number;
  liquidationThresholdBps: number;
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
  private eModeCategory?: Promise<EModeCategoryData>;
  /** Cached oracle price (USD, 8 decimals) keyed by asset address (lowercase). */
  private priceCache = new Map<string, { price: number; ts: number }>();
  /** Cache TTL in ms; 0 disables caching. */
  private priceCacheTtlMs: number;

  constructor(client: BasePublicClient, watchlist?: Address[], priceCacheTtlMs = 0) {
    this.client = client;
    this.watchlist = watchlist ?? (Object.values(TOKENS) as Address[]);
    this.priceCacheTtlMs = priceCacheTtlMs;
  }

  /** Fetch and cache the ETH-correlated e-mode limits for this bot run. */
  async getEModeCategoryData(): Promise<EModeCategoryData> {
    if (!this.eModeCategory) {
      this.eModeCategory = this.client
        .readContract({
          address: ADDRESSES.aavePool as Address,
          abi: aavePoolAbi,
          functionName: 'getEModeCategoryData',
          args: [EMODE.ETH_CORRELATED],
        })
        .then((category) => {
          const data = {
            ltvBps: Number(category.ltv),
            liquidationThresholdBps: Number(category.liquidationThreshold),
          };
          if (
            data.ltvBps <= 0 ||
            data.liquidationThresholdBps < data.ltvBps ||
            data.liquidationThresholdBps > 10_000
          ) {
            throw new Error('invalid ETH-correlated e-mode category data');
          }
          return data;
        })
        .catch((error) => {
          this.eModeCategory = undefined;
          throw error;
        });
    }
    return this.eModeCategory;
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
        const rd = (r as Extract<typeof r, { status: 'success' }>).result;
        return {
          address: asset,
          abi: erc20Abi,
          functionName: 'balanceOf' as const,
          args: [rd.aTokenAddress] as const,
        };
      });

    // totalSupply of the variable debt token gives the total borrowed amount
    // for utilization. Keyed by the same reserve index as liquidity.
    const debtSupplyIndex: number[] = [];
    const debtSupplyCalls = reserveResults
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.status === 'success')
      .map(({ r, i }) => {
        debtSupplyIndex.push(i);
        const rd = (r as Extract<typeof r, { status: 'success' }>).result;
        return {
          address: rd.variableDebtTokenAddress,
          abi: erc20Abi,
          functionName: 'totalSupply' as const,
          args: [] as const,
        };
      });

    const [liquidityResults, debtSupplyResults] = await Promise.all([
      liquidityCalls.length
        ? this.client.multicall({ contracts: liquidityCalls, allowFailure: true })
        : Promise.resolve([]),
      debtSupplyCalls.length
        ? this.client.multicall({ contracts: debtSupplyCalls, allowFailure: true })
        : Promise.resolve([]),
    ]);

    // Fail-closed: a failed liquidity or debt read leaves the value unknown,
    // and the affected rate is omitted below (not treated as 0). This stops
    // autoTrade from selecting a market on a false zero-utilization signal.
    const liquidityByReserveIndex = new Map<number, bigint>();
    liquidityIndex.forEach((reserveIdx, pos) => {
      const liqResult = liquidityResults[pos];
      if (liqResult?.status === 'success') {
        liquidityByReserveIndex.set(reserveIdx, liqResult.result as bigint);
      }
    });

    const debtByReserveIndex = new Map<number, bigint>();
    debtSupplyIndex.forEach((reserveIdx, pos) => {
      const debtResult = debtSupplyResults[pos];
      if (debtResult?.status === 'success') {
        debtByReserveIndex.set(reserveIdx, debtResult.result as bigint);
      }
    });

    const rates: MarketRate[] = [];
    for (let i = 0; i < n; i++) {
      const reserve = reserveResults[i];
      const config = configResults[i];
      if (reserve.status !== 'success' || config.status !== 'success') continue;

      // Omit rates with incomplete market data (failed liquidity or debt
      // reads) rather than degrading to a 0-debt/0-liquidity signal.
      if (
        !liquidityByReserveIndex.has(i) ||
        !debtByReserveIndex.has(i)
      ) {
        continue;
      }

      const rd = reserve.result;
      const cfg = config.result;

      const availableLiquidity = liquidityByReserveIndex.get(i)!;
      const totalDebt = debtByReserveIndex.get(i)!;

      const symbol = this.symbolFor(this.watchlist[i]);

      // getReserveConfigurationData positional outputs
      const [, ltv, liquidationThreshold, , , , borrowingEnabled, , isActive, isFrozen] =
        cfg;

      // Utilization = totalDebt / (totalDebt + availableLiquidity).
      const totalDeployed = totalDebt + availableLiquidity;
      const utilizationBps =
        totalDeployed > 0n
          ? Number((totalDebt * 10_000n) / totalDeployed)
          : 0;

      rates.push({
        asset: this.watchlist[i],
        symbol,
        decimals: TOKEN_DECIMALS[symbol] ?? 18,
        supplyApyBps: rayRateToApyBps(rd.currentLiquidityRate),
        borrowAprBps: rayRateToAprBps(rd.currentVariableBorrowRate),
        availableLiquidity,
        utilizationBps,
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

  /**
   * USD price (8-decimal oracle units) of an asset from the Aave PriceOracle.
   * Returns a plain JS number. Results are cached for `priceCacheTtlMs` so
   * repeated valuation within one poll window doesn't add an RPC round-trip.
   */
  async getAssetPriceUsd(asset: Address): Promise<number> {
    const key = asset.toLowerCase();
    const now = Date.now();
    const hit = this.priceCache.get(key);
    if (hit && this.priceCacheTtlMs > 0 && now - hit.ts < this.priceCacheTtlMs) {
      return hit.price;
    }

    const price = await this.client.readContract({
      address: ADDRESSES.aaveOracle as Address,
      abi: aaveOracleAbi,
      functionName: 'getAssetPrice',
      args: [asset],
    });
    const priceUsd = Number(price) / 10 ** ORACLE_USD_DECIMALS;
    this.priceCache.set(key, { price: priceUsd, ts: now });
    return priceUsd;
  }

  /**
   * USD value of a token `amount` (smallest-unit bigint) at the oracle price.
   * decimals is the token's decimals (e.g. 18 for WETH, 6 for USDC).
   */
  async tokenAmountToUsd(
    asset: Address,
    amount: bigint,
    decimals: number,
  ): Promise<number> {
    const priceUsd = await this.getAssetPriceUsd(asset);
    return (Number(amount) / 10 ** decimals) * priceUsd;
  }
}
