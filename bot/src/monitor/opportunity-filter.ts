import { PublicClient, WalletClient, getFunctionSelector } from 'viem';
import { ArbitrageOpportunity, MarketRate } from './rate-monitor';
import { GAS_ESTIMATES, BPS } from '../config/constants';

/**
 * Configuration for opportunity filter
 */
export interface OpportunityFilterConfig {
  // Minimum profit threshold (in USD)
  minProfitUsd: number;
  
  // Maximum slippage tolerance (in bps)
  maxSlippageBps: number;
  
  // Maximum gas price (in gwei)
  maxGasPriceGwei: number;
  
  // Gas buffer percentage
  gasBufferPercent: number;
  
  // Minimum confidence score (0-100)
  minConfidence: number;
  
  // Minimum liquidity (in USD)
  minLiquidityUsd: number;
  
  // Minimum spread (in bps)
  minSpreadBps: number;
}

/**
 * Filtered and validated opportunity
 */
export interface ValidatedOpportunity extends ArbitrageOpportunity {
  // Validated fields
  gasEstimate: bigint;
  estimatedGasCostUsd: number;
  netProfitUsd: number;
  isProfitable: boolean;
  
  // Execution details
  recommendedFlashloanProvider: 'aave' | 'morpho' | 'moonwell';
}

/**
 * Opportunity filter and validator
 * Filters out unprofitable or risky opportunities
 */
export class OpportunityFilter {
  private config: OpportunityFilterConfig;
  private client: PublicClient;
  
  constructor(
    config: Partial<OpportunityFilterConfig>,
    client: PublicClient
  ) {
    this.config = {
      minProfitUsd: config.minProfitUsd ?? 10,
      maxSlippageBps: config.maxSlippageBps ?? 300,
      maxGasPriceGwei: config.maxGasPriceGwei ?? 50,
      gasBufferPercent: config.gasBufferPercent ?? 20,
      minConfidence: config.minConfidence ?? 60,
      minLiquidityUsd: config.minLiquidityUsd ?? 1000, // $1k minimum
      minSpreadBps: config.minSpreadBps ?? 50,
    };
    
    this.client = client;
  }
  
  /**
   * Filter and validate opportunities
   */
  async filter(
    opportunities: ArbitrageOpportunity[]
  ): Promise<ValidatedOpportunity[]> {
    const validated: ValidatedOpportunity[] = [];
    
    for (const opp of opportunities) {
      // Basic filters
      if (!this.passesBasicFilters(opp)) continue;
      
      // Get gas estimates
      const gasEstimate = await this.estimateGas(opp);
      
      // Get current gas price
      const gasPrice = await this.getGasPrice();
      
      // Calculate costs
      const estimatedGasCostUsd = this.calculateGasCost(gasEstimate, gasPrice);
      
      // Calculate net profit
      const netProfitUsd = opp.estimatedProfit - estimatedGasCostUsd;
      
      // Check profitability
      const isProfitable = netProfitUsd >= this.config.minProfitUsd;
      
      // Determine best flashloan provider
      const provider = this.selectFlashloanProvider(opp);
      
      validated.push({
        ...opp,
        gasEstimate,
        estimatedGasCostUsd,
        netProfitUsd,
        isProfitable,
        recommendedFlashloanProvider: provider,
      });
    }
    
    // Sort by net profit
    return validated.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  }
  
  /**
   * Check basic filters
   */
  private passesBasicFilters(opp: ArbitrageOpportunity): boolean {
    // Check spread
    if (opp.spread < this.config.minSpreadBps) return false;
    
    // Check confidence
    if (opp.confidence < this.config.minConfidence) return false;
    
    // Check liquidity
    const liquidityUsd = Number(opp.liquidity) / 1e6;
    if (liquidityUsd < this.config.minLiquidityUsd) return false;
    
    return true;
  }
  
  /**
   * Estimate gas for the arbitrage
   */
  private async estimateGas(opp: ArbitrageOpportunity): Promise<bigint> {
    // Base gas estimate for arbitrage
    let gas = GAS_ESTIMATES.arbitrage;
    
    // Add gas for supply/borrow if different tokens
    if (opp.supplyToken !== opp.borrowToken) {
      gas += GAS_ESTIMATES.swap;
    }
    
    // Add buffer
    const buffer = BigInt(Math.floor(gas * this.config.gasBufferPercent / 100));
    
    return BigInt(gas) + buffer;
  }
  
  /**
   * Get current gas price
   */
  private async getGasPrice(): Promise<bigint> {
    try {
      const [gasPrice] = await this.client.getGasPrice();
      
      // Cap at max gas price
      const maxGasPrice = BigInt(this.config.maxGasPriceGwei * 1e9);
      
      return gasPrice > maxGasPrice ? maxGasPrice : gasPrice;
    } catch {
      // Default to 10 gwei if fetch fails
      return 10n * 1n ** 9n;
    }
  }
  
  /**
   * Calculate gas cost in USD
   */
  private calculateGasCost(gasEstimate: bigint, gasPrice: bigint): number {
    const gasCostWei = gasEstimate * gasPrice;
    const gasCostEth = Number(gasCostWei) / 1e18;
    
    // Assume ETH price of $3000 (in production, use oracle)
    const ethPrice = 3000;
    
    return gasCostEth * ethPrice;
  }
  
  /**
   * Select best flashloan provider
   */
  private selectFlashloanProvider(
    opp: ArbitrageOpportunity
  ): 'aave' | 'morpho' | 'moonwell' {
    // Aave is generally more reliable
    return 'aave';
  }
  
  /**
   * Update configuration
   */
  updateConfig(config: Partial<OpportunityFilterConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }
  
  /**
   * Get current configuration
   */
  getConfig(): OpportunityFilterConfig {
    return { ...this.config };
  }
}

export default OpportunityFilter;
