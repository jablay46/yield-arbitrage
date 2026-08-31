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

  constructor(client: BasePublicClient, config: GasStrategyConfig, logger?: Logger) {
    this.client = client;
    this.config = config;
    this.logger = logger;
  }

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
      if (maxFeePerGas > maxFeeCap) maxFeePerGas = maxFeeCap;

      return { maxFeePerGas, maxPriorityFeePerGas };
    } catch (error) {
      this.logger?.warn(`getFeeHistory failed, using caps: ${error}`);
      return {
        maxFeePerGas: maxFeeCap,
        maxPriorityFeePerGas: BigInt(
          Math.round(this.config.priorityFeeGwei * 1e9)
        ),
      };
    }
  }

  /** Apply the configured buffer to a gas estimate. */
  applyGasBuffer(estimate: bigint): bigint {
    return estimate + (estimate * BigInt(this.config.gasBufferPercent)) / 100n;
  }

  async isGasFavorable(): Promise<boolean> {
    const gasPrice = await this.client.getGasPrice();
    return gasPrice < (BigInt(this.config.maxGasPriceGwei) * GWEI) / 2n;
  }

  async estimateCostUsd(
    gasEstimate: bigint,
    ethPriceUsd: number
  ): Promise<number> {
    const fees = await this.getFees();
    const costWei = gasEstimate * fees.maxFeePerGas;
    return (Number(costWei) / 1e18) * ethPriceUsd;
  }
}
