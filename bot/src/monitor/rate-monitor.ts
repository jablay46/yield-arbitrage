import { createPublicClient, http, PublicClient, Address } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { TOKENS, TOKEN_DECIMALS, Protocol, PROTOCOLS } from '../config/constants';
import { RateMonitorConfig } from '../config';

/**
 * Rate data for a single market
 */
export interface MarketRate {
  protocol: Protocol;
  token: string;
  symbol: string;
  supplyApy: number;    // Annual percentage yield (in basis points)
  borrowApr: number;    // Annual percentage rate (in basis points)
  liquidity: bigint;    // Available liquidity
  utilization: number;  // Utilization rate (0-10000 bps)
  lastUpdated: number;   // Timestamp
}

/**
 * Arbitrage opportunity detected
 */
export interface ArbitrageOpportunity {
  id: string;
  timestamp: number;
  
  // Source (supply to)
  supplyProtocol: Protocol;
  supplyToken: string;
  supplyApy: number;
  
  // Destination (borrow from)
  borrowProtocol: Protocol;
  borrowToken: string;
  borrowApr: number;
  
  // Calculated values
  spread: number;          // supplyApy - borrowApr (in bps)
  estimatedProfit: number; // Estimated profit in USD
  flashloanAmount: bigint; // Recommended flashloan amount
  liquidity: bigint;       // Available liquidity
  
  // Confidence score
  confidence: number;      // 0-100
}

/**
 * Rate monitor service
 * Monitors lending rates from multiple protocols
 */
export class RateMonitor {
  private client: PublicClient;
  private config: RateMonitorConfig;
  private cache: Map<string, { data: MarketRate; timestamp: number }> = new Map();
  
  constructor(rpcUrl: string, config: Partial<RateMonitorConfig> = {}) {
    this.client = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    });
    
    this.config = {
      dataSources: config.dataSources ?? 'all',
      defillamaApiUrl: config.defillamaApiUrl ?? 'https://api.llama.fi',
      subgraphUrls: config.subgraphUrls ?? {},
      cacheDurationMs: config.cacheDurationMs ?? 30000,
      includeIncentives: config.includeIncentives ?? true,
    };
  }
  
  /**
   * Get current rates from all protocols
   */
  async getAllRates(): Promise<MarketRate[]> {
    const rates: MarketRate[] = [];
    
    // Get rates from each protocol
    const [aaveRates, morphoRates, moonwellRates] = await Promise.all([
      this.getAaveRates(),
      this.getMorphoRates(),
      this.getMoonwellRates(),
    ]);
    
    rates.push(...aaveRates, ...morphoRates, ...moonwellRates);
    
    return rates;
  }
  
  /**
   * Get Aave V3 rates
   */
  async getAaveRates(): Promise<MarketRate[]> {
    const cacheKey = 'aave-rates';
    const cached = this.getCached(cacheKey);
    if (cached) return cached;
    
    // In production, query actual Aave pool
    // This is mock data for demonstration
    const rates: MarketRate[] = [
      {
        protocol: Protocol.AAVE,
        token: TOKENS.USDC,
        symbol: 'USDC',
        supplyApy: 520,    // 5.20% APY
        borrowApr: 380,    // 3.80% APR
        liquidity: 50_000_000n * 1_000_000n, // 50M USDC
        utilization: 6500, // 65%
        lastUpdated: Date.now(),
      },
      {
        protocol: Protocol.AAVE,
        token: TOKENS.DAI,
        symbol: 'DAI',
        supplyApy: 480,    // 4.80% APY
        borrowApr: 340,    // 3.40% APR
        liquidity: 30_000_000n * 1_000_000n, // 30M DAI
        utilization: 5500, // 55%
        lastUpdated: Date.now(),
      },
    ];
    
    this.setCache(cacheKey, rates);
    return rates;
  }
  
  /**
   * Get Morpho rates
   */
  async getMorphoRates(): Promise<MarketRate[]> {
    const cacheKey = 'morpho-rates';
    const cached = this.getCached(cacheKey);
    if (cached) return cached;
    
    // In production, query Morpho contracts
    const rates: MarketRate[] = [
      {
        protocol: Protocol.MORPHO,
        token: TOKENS.USDC,
        symbol: 'USDC',
        supplyApy: 510,    // 5.10% APY
        borrowApr: 360,    // 3.60% APR
        liquidity: 25_000_000n * 1_000_000n, // 25M USDC
        utilization: 6000, // 60%
        lastUpdated: Date.now(),
      },
      {
        protocol: Protocol.MORPHO,
        token: TOKENS.DAI,
        symbol: 'DAI',
        supplyApy: 470,    // 4.70% APY
        borrowApr: 320,    // 3.20% APR
        liquidity: 15_000_000n * 1_000_000n, // 15M DAI
        utilization: 5000, // 50%
        lastUpdated: Date.now(),
      },
    ];
    
    this.setCache(cacheKey, rates);
    return rates;
  }
  
  /**
   * Get Moonwell rates
   */
  async getMoonwellRates(): Promise<MarketRate[]> {
    const cacheKey = 'moonwell-rates';
    const cached = this.getCached(cacheKey);
    if (cached) return cached;
    
    // In production, query Moonwell contracts
    const rates: MarketRate[] = [
      {
        protocol: Protocol.MOONWELL,
        token: TOKENS.USDC,
        symbol: 'USDC',
        supplyApy: 550,    // 5.50% APY
        borrowApr: 400,    // 4.00% APR
        liquidity: 10_000_000n * 1_000_000n, // 10M USDC
        utilization: 7000, // 70%
        lastUpdated: Date.now(),
      },
    ];
    
    this.setCache(cacheKey, rates);
    return rates;
  }
  
  /**
   * Find arbitrage opportunities from rate data
   */
  findOpportunities(
    rates: MarketRate[],
    minSpreadBps: number = 50
  ): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];
    
    // Group rates by token
    const ratesByToken = new Map<string, MarketRate[]>();
    for (const rate of rates) {
      const existing = ratesByToken.get(rate.token) || [];
      existing.push(rate);
      ratesByToken.set(rate.token, existing);
    }
    
    // Find opportunities: supply at high APY, borrow at low APR
    for (const [token, tokenRates] of ratesByToken) {
      // Find highest supply APY
      const highestSupply = tokenRates.reduce((max, rate) => 
        rate.supplyApy > max.supplyApy ? rate : max
      );
      
      // Find lowest borrow APR
      const lowestBorrow = tokenRates.reduce((min, rate) => 
        rate.borrowApr < min.borrowApr ? rate : min
      );
      
      // Calculate spread
      const spread = highestSupply.supplyApy - lowestBorrow.borrowApr;
      
      if (spread >= minSpreadBps && highestSupply.protocol !== lowestBorrow.protocol) {
        // Estimate profit (simplified)
        const estimatedProfit = this.estimateProfit(
          highestSupply.supplyApy,
          lowestBorrow.borrowApr,
          highestSupply.liquidity
        );
        
        opportunities.push({
          id: `${highestSupply.protocol}-${lowestBorrow.protocol}-${token}-${Date.now()}`,
          timestamp: Date.now(),
          supplyProtocol: highestSupply.protocol,
          supplyToken: highestSupply.token,
          supplyApy: highestSupply.supplyApy,
          borrowProtocol: lowestBorrow.protocol,
          borrowToken: lowestBorrow.token,
          borrowApr: lowestBorrow.borrowApr,
          spread,
          estimatedProfit,
          flashloanAmount: this.calculateOptimalFlashloan(
            highestSupply.liquidity,
            lowestBorrow.liquidity
          ),
          liquidity: lowestBorrow.liquidity,
          confidence: this.calculateConfidence(spread, lowestBorrow.liquidity),
        });
      }
    }
    
    // Sort by profit
    return opportunities.sort((a, b) => b.estimatedProfit - a.estimatedProfit);
  }
  
  /**
   * Estimate profit for an arbitrage opportunity
   */
  private estimateProfit(
    supplyApy: number,
    borrowApr: number,
    liquidity: bigint
  ): number {
    // Simplified profit estimation
    // In production, calculate based on actual flashloan amount and time
    const spread = supplyApy - borrowApr;
    const effectiveAmount = Number(liquidity) / 1e6 * 0.1; // Assume 10% of liquidity
    return (effectiveAmount * spread) / 10000;
  }
  
  /**
   * Calculate optimal flashloan amount
   */
  private calculateOptimalFlashloan(
    supplyLiquidity: bigint,
    borrowLiquidity: bigint
  ): bigint {
    // Use minimum of available liquidity
    const minLiquidity = supplyLiquidity < borrowLiquidity 
      ? supplyLiquidity 
      : borrowLiquidity;
    
    // Use up to 10% of available liquidity
    return minLiquidity / 10n;
  }
  
  /**
   * Calculate confidence score
   */
  private calculateConfidence(spread: number, liquidity: bigint): number {
    let confidence = 50; // Base confidence
    
    // Higher spread = higher confidence
    confidence += Math.min(spread / 10, 30);
    
    // Higher liquidity = higher confidence
    const liquidityUsd = Number(liquidity) / 1e6;
    if (liquidityUsd > 50) confidence += 10;
    if (liquidityUsd > 100) confidence += 10;
    
    return Math.min(confidence, 100);
  }
  
  /**
   * Get cached data
   */
  private getCached(key: string): MarketRate[] | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    
    if (Date.now() - cached.timestamp > this.config.cacheDurationMs) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.data;
  }
  
  /**
   * Set cache
   */
  private setCache(key: string, data: MarketRate[]): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }
  
  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}

export default RateMonitor;
