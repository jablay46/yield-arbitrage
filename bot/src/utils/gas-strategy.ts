import { PublicClient } from 'viem';

/**
 * Gas strategy configuration
 */
export interface GasStrategyConfig {
  // Max gas price willing to pay (in gwei)
  maxGasPriceGwei: number;
  
  // Priority fee for miners (in gwei)
  priorityFeeGwei: number;
  
  // Gas estimation buffer (percentage)
  gasBufferPercent: number;
  
  // Use EIP-1559
  useEip1559: boolean;
  
  // Target block time (for Base ~2s)
  targetBlockTime: number;
}

/**
 * Calculated gas fees
 */
export interface GasFees {
  gasPrice: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  estimatedGas: bigint;
  totalCostWei: bigint;
  totalCostUsd: number;
}

/**
 * Gas strategy
 * Dynamic gas pricing for optimal transaction inclusion
 */
export class GasStrategy {
  private client: PublicClient;
  private config: GasStrategyConfig;
  private priceCache: { fees: GasFees; timestamp: number } | null = null;
  private cacheDuration: number = 5000; // 5 seconds
  
  constructor(client: PublicClient, config: Partial<GasStrategyConfig> = {}) {
    this.client = client;
    
    this.config = {
      maxGasPriceGwei: config.maxGasPriceGwei ?? 50,
      priorityFeeGwei: config.priorityFeeGwei ?? 2,
      gasBufferPercent: config.gasBufferPercent ?? 20,
      useEip1559: config.useEip1559 ?? true,
      targetBlockTime: config.targetBlockTime ?? 2,
    };
  }
  
  /**
   * Get current gas fees
   */
  async getGasFees(estimatedGas: bigint): Promise<GasFees> {
    // Check cache
    if (this.priceCache && Date.now() - this.priceCache.timestamp < this.cacheDuration) {
      return {
        ...this.priceCache.fees,
        estimatedGas,
        totalCostWei: estimatedGas * this.priceCache.fees.gasPrice,
        totalCostUsd: 0, // Will be calculated
      };
    }
    
    try {
      // Get fee history for historical data
      const feeHistory = await this.client.getFeeHistory({
        blockCount: 5,
        rewardPercentiles: [50, 75, 90],
      });
      
      // Get current block data
      const [block, gasPrice] = await Promise.all([
        this.client.getBlock(),
        this.client.getGasPrice(),
      ]);
      
      // Calculate fees
      const baseFee = block.baseFeePerGas || gasPrice;
      
      // Priority fee (median of recent rewards)
      const priorityFee = this.calculatePriorityFee(feeHistory.reward);
      
      // Cap priority fee
      const maxPriorityFeePerGas = this.toWei(this.config.priorityFeeGwei);
      const finalPriorityFee = priorityFee > maxPriorityFeePerGas 
        ? maxPriorityFeePerGas 
        : priorityFee;
      
      // Max fee per gas (base + priority + buffer)
      const maxFeePerGas = this.config.useEip1559
        ? baseFee + finalPriorityFee
        : gasPrice;
      
      // Cap at max
      const maxFeeCap = this.toWei(this.config.maxGasPriceGwei);
      const finalMaxFeePerGas = maxFeePerGas > maxFeeCap ? maxFeeCap : maxFeePerGas;
      
      const gasPriceResult = this.config.useEip1559 ? finalMaxFeePerGas : gasPrice;
      
      const fees: GasFees = {
        gasPrice: gasPriceResult,
        maxFeePerGas: finalMaxFeePerGas,
        maxPriorityFeePerGas: finalPriorityFee,
        estimatedGas,
        totalCostWei: estimatedGas * gasPriceResult,
        totalCostUsd: 0,
      };
      
      // Cache result
      this.priceCache = {
        fees,
        timestamp: Date.now(),
      };
      
      return fees;
      
    } catch (error) {
      // Fallback to simple gas price
      const gasPrice = await this.client.getGasPrice();
      const cappedGasPrice = this.capGasPrice(gasPrice);
      
      return {
        gasPrice: cappedGasPrice,
        maxFeePerGas: cappedGasPrice,
        maxPriorityFeePerGas: this.toWei(this.config.priorityFeeGwei),
        estimatedGas,
        totalCostWei: estimatedGas * cappedGasPrice,
        totalCostUsd: 0,
      };
    }
  }
  
  /**
   * Calculate priority fee from reward history
   */
  private calculatePriorityFee(rewards: bigint[][]): bigint {
    if (!rewards || rewards.length === 0) {
      return this.toWei(this.config.priorityFeeGwei);
    }
    
    // Get median of median rewards
    const medianRewards = rewards.map(r => r[1] || 0n);
    medianRewards.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    
    const mid = Math.floor(medianRewards.length / 2);
    return medianRewards[mid] || this.toWei(this.config.priorityFeeGwei);
  }
  
  /**
   * Cap gas price at maximum
   */
  private capGasPrice(gasPrice: bigint): bigint {
    const maxPrice = this.toWei(this.config.maxGasPriceGwei);
    return gasPrice > maxPrice ? maxPrice : gasPrice;
  }
  
  /**
   * Convert gwei to wei
   */
  private toWei(gwei: number): bigint {
    return BigInt(Math.floor(gwei * 1e9));
  }
  
  /**
   * Calculate total gas cost in USD
   */
  async calculateGasCostUsd(estimatedGas: bigint, ethPrice: number = 3000): Promise<number> {
    const fees = await this.getGasFees(estimatedGas);
    const costEth = Number(fees.totalCostWei) / 1e18;
    return costEth * ethPrice;
  }
  
  /**
   * Check if current gas prices are favorable
   */
  async isGasFavorable(): Promise<boolean> {
    const gasPrice = await this.client.getGasPrice();
    const maxPrice = this.toWei(this.config.maxGasPriceGwei);
    
    // Gas is favorable if below 50% of max
    return gasPrice < maxPrice / 2n;
  }
  
  /**
   * Wait for favorable gas conditions
   */
  async waitForFavorableGas(timeoutMs: number = 60000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      if (await this.isGasFavorable()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    throw new Error('Timeout waiting for favorable gas');
  }
  
  /**
   * Update configuration
   */
  updateConfig(config: Partial<GasStrategyConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }
}

export default GasStrategy;
