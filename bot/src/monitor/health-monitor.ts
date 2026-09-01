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

  /**
   * Create a new HealthMonitor instance.
   * @param client - The viem public client for reading on-chain data
   * @param executor - The LoopingExecutor contract address to monitor
   * @param warnWad - Health factor threshold for warnings (WAD format, 1e18 = 1.0)
   * @param criticalWad - Health factor threshold for emergency deleverage (WAD format)
   * @param logger - Logger instance for health status messages
   * @param usePendingBlock - Whether to read from pending block (Flashblocks on Base)
   */
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

  /**
   * Capture a snapshot of the executor's current account data from Aave.
   * @returns Health snapshot with collateral, debt, and health factor
   */
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

  /**
   * Check if the executor has an open position.
   * @returns True if a position is currently open
   */
  async hasOpenPosition(): Promise<boolean> {
    return this.client.readContract({
      address: this.executor,
      abi: loopingExecutorAbi,
      functionName: 'positionOpen',
    });
  }

  /**
   * @returns Whether the executor contract is paused. The bot treats a pause
   *          as fail-closed (no opens), but the keeper emergency exit remains
   *          callable while paused so a critical position can still be wound down.
   */
  async isPaused(): Promise<boolean> {
    return this.client.readContract({
      address: this.executor,
      abi: loopingExecutorAbi,
      functionName: 'paused',
    });
  }

  /**
   * Read the executor's on-chain keeper trigger. This is configured
   * independently of the bot's own critical threshold, so the paused
   * deleverage path must consult it before calling keeperDeleverage.
   * @returns The contract's criticalHealthFactor (WAD)
   */
  async getCriticalHealthFactor(): Promise<bigint> {
    return this.client.readContract({
      address: this.executor,
      abi: loopingExecutorAbi,
      functionName: 'criticalHealthFactor',
    });
  }

  /**
   * Read the executor's active Aave e-mode category (0 = none). Queried from
   * the pool rather than tracked locally, so e-mode cleanup does not depend
   * on persisted bot state surviving a crash.
   * @returns The active e-mode category id
   */
  async getUserEMode(): Promise<number> {
    const category = await this.client.readContract({
      address: ADDRESSES.aavePool as Address,
      abi: aavePoolAbi,
      functionName: 'getUserEMode',
      args: [this.executor],
    });
    return Number(category);
  }

  /**
   * Retrieve the collateral and borrow assets of the currently open position.
   * @returns Object containing collateral and borrow asset addresses
   */
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

  /**
   * Classify a health snapshot into an action category.
   * @param s - The health snapshot to classify
   * @returns The action to take: 'ok', 'warn', or 'deleverage'
   */
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
