import { BasePublicClient } from '../client-types';
import { Logger } from '../utils/logger';

export interface GasStrategyConfig {
  maxGasPriceGwei: number;
  priorityFeeGwei: number;
  gasBufferPercent: number;
}

export interface GasFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

const GWEI = 10n ** 9n;

/**
 * EIP-1559 gas pricing for Base with a hard cap.
 */
export class GasStrategy {
  private client: BasePublicClient;
  private config: GasStrategyConfig;
  private logger?: Logger;

  /**
   * Create a new GasStrategy instance.
   * @param client - Viem public client for querying gas prices
   * @param config - Gas strategy configuration with caps and buffers
   * @param logger - Optional logger for warnings
   */
  constructor(client: BasePublicClient, config: GasStrategyConfig, logger?: Logger) {
    this.client = client;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Calculate EIP-1559 gas fees based on recent block history, capped at configured max.
   * @returns Gas fees with maxFeePerGas and maxPriorityFeePerGas
   */
  async getFees(): Promise<GasFees> {
    const maxFeeCap = BigInt(Math.round(this.config.maxGasPriceGwei * 1e9));

    try {
      const feeHistory = await this.client.getFeeHistory({
        blockCount: 5,
        rewardPercentiles: [50],
      });

      const baseFee =
        feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1] ?? 0n;

      const rewards = feeHistory.reward?.map((r) => r[0] ?? 0n) ?? [];
      const medianReward =
        rewards.length > 0
          ? [...rewards].sort((a, b) => (a < b ? -1 : 1))[
              Math.floor(rewards.length / 2)
            ]
          : 0n;

      const priorityCap = BigInt(Math.round(this.config.priorityFeeGwei * 1e9));
      const maxPriorityFeePerGas =
        medianReward > 0n && medianReward < priorityCap
          ? medianReward
          : priorityCap;

      let maxFeePerGas = baseFee + maxPriorityFeePerGas;
      let priorityFee = maxPriorityFeePerGas;
      if (maxFeePerGas > maxFeeCap) {
        maxFeePerGas = maxFeeCap;
        if (priorityFee > maxFeeCap) {
          priorityFee = maxFeeCap;
        }
      }
      if (baseFee > 0n && priorityFee > maxFeePerGas - baseFee) {
        priorityFee = maxFeePerGas - baseFee;
      }

      return { maxFeePerGas, maxPriorityFeePerGas: priorityFee };
    } catch (error) {
      this.logger?.warn(`getFeeHistory failed, using caps: ${error}`);
      // Degrade gracefully: keep the priority within the max cap.
      const priorityCap = BigInt(
        Math.round(this.config.priorityFeeGwei * 1e9)
      );
      return {
        maxFeePerGas: maxFeeCap,
        maxPriorityFeePerGas:
          priorityCap < maxFeeCap ? priorityCap : maxFeeCap,
      };
    }
  }

  /**
   * Apply the configured gas buffer to an estimate.
   * @param estimate - The base gas estimate
   * @returns Gas estimate with buffer applied
   */
  applyGasBuffer(estimate: bigint): bigint {
    return estimate + (estimate * BigInt(this.config.gasBufferPercent)) / 100n;
  }

  /**
   * Hard cap on maxFeePerGas, derived from the configured max gas price.
   * @returns The capped maxFeePerGas in wei.
   */
  maxFeeCap(): bigint {
    return BigInt(Math.round(this.config.maxGasPriceGwei * 1e9));
  }

  /**
   * Check if the current gas price is favorable (less than half of max cap).
   * @returns True if gas price is favorable for submitting transactions
   */
  async isGasFavorable(): Promise<boolean> {
    const gasPrice = await this.client.getGasPrice();
    return gasPrice < (BigInt(this.config.maxGasPriceGwei) * GWEI) / 2n;
  }

  /**
   * Estimate the USD cost of a transaction given gas estimate and ETH price.
   * @param gasEstimate - The gas estimate for the transaction
   * @param ethPriceUsd - Current ETH price in USD
   * @returns Estimated cost in USD
   */
  async estimateCostUsd(
    gasEstimate: bigint,
    ethPriceUsd: number
  ): Promise<number> {
    const fees = await this.getFees();
    const costWei = gasEstimate * fees.maxFeePerGas;
    return (Number(costWei) / 1e18) * ethPriceUsd;
  }
}
