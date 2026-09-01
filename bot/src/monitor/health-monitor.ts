import { Address } from 'viem';
import { BasePublicClient } from '../client-types';
import { aavePoolAbi, loopingExecutorAbi } from '../abis';
import { ADDRESSES } from '../config/constants';
import { Logger } from '../utils/logger';

export interface HealthSnapshot {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  healthFactor: bigint; // WAD; type(uint256).max when no debt
  timestamp: number;
}

export type HealthAction = 'ok' | 'warn' | 'deleverage';

/**
 * Watches the executor's on-chain health factor and classifies the state
 * so the orchestrator can warn or trigger an emergency close.
 */
export class HealthMonitor {
  private client: BasePublicClient;
  private executor: Address;
  private warnWad: bigint;
  private criticalWad: bigint;
  private logger: Logger;
  private usePendingBlock: boolean;

  constructor(
    client: BasePublicClient,
    executor: Address,
    warnWad: bigint,
    criticalWad: bigint,
    logger: Logger,
    usePendingBlock = true
  ) {
    this.client = client;
    this.executor = executor;
    this.warnWad = warnWad;
    this.criticalWad = criticalWad;
    this.logger = logger;
    this.usePendingBlock = usePendingBlock;
  }

  async snapshot(): Promise<HealthSnapshot> {
    // blockTag 'pending' = latest Flashblock on Base (~200ms fresh)
    const blockTag = this.usePendingBlock ? ('pending' as const) : undefined;
    const [totalCollateralBase, totalDebtBase, , , , healthFactor] =
      await this.client.readContract({
        address: ADDRESSES.aavePool as Address,
        abi: aavePoolAbi,
        functionName: 'getUserAccountData',
        args: [this.executor],
        blockTag,
      });

    return {
      totalCollateralBase,
      totalDebtBase,
      healthFactor,
      timestamp: Date.now(),
    };
  }

  async hasOpenPosition(): Promise<boolean> {
    return this.client.readContract({
      address: this.executor,
      abi: loopingExecutorAbi,
      functionName: 'positionOpen',
    });
  }

  async getOpenPositionAssets(): Promise<{
    collateralAsset: Address;
    borrowAsset: Address;
  }> {
    const [collateralAsset, borrowAsset] = await this.client.readContract({
      address: this.executor,
      abi: loopingExecutorAbi,
      functionName: 'openPosition',
    });
    return { collateralAsset, borrowAsset };
  }

  classify(s: HealthSnapshot): HealthAction {
    // No debt -> HF is type(uint256).max, always fine
    if (s.totalDebtBase === 0n) return 'ok';
    if (s.healthFactor < this.criticalWad) return 'deleverage';
    if (s.healthFactor < this.warnWad) return 'warn';
    return 'ok';
  }

  /** Poll once; returns the action the orchestrator should take. */
  async check(): Promise<{ snapshot: HealthSnapshot; action: HealthAction }> {
    const snapshot = await this.snapshot();
    const action = this.classify(snapshot);

    const hf = (Number(snapshot.healthFactor) / 1e18).toFixed(4);
    if (action === 'deleverage') {
      this.logger.error(`HEALTH FACTOR CRITICAL: ${hf} — deleveraging required`);
    } else if (action === 'warn') {
      this.logger.warn(`Health factor declining: ${hf}`);
    } else {
      this.logger.debug(`Health factor OK: ${hf}`);
    }

    return { snapshot, action };
  }
}
