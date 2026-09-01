import 'dotenv/config';
import { createPublicClient, createWalletClient, http, webSocket, Transport, Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { BotConfig, loadConfig } from './config';
import { EMODE } from './config/constants';
import { RateMonitor } from './monitor/rate-monitor';
import { HealthMonitor } from './monitor/health-monitor';

import { findLoopCandidates, LoopCandidate } from './strategy/find-candidates';
import { RiskEngine } from './position/risk-engine';
import { PnLTracker } from './position/pnl-tracker';
import { estimateRealizedPnL } from './position/pnl-estimate';
import { PositionStore } from './position/position-store';
import { TransactionBuilder } from './orchestrator/tx-builder';
import { GasStrategy } from './utils/gas-strategy';
import { createLogger, Logger } from './utils/logger';

export interface OpenPositionInfo {
  asset: Address;
  symbol: string;
  marginAmount: bigint;
  leverage: number;
  /** USD value of the margin at open time (Aave oracle). */
  marginUsd: number;
  /** Gas used by the approve+open transactions, in gas units (receipt.gasUsed). */
  openTxGasUsed: bigint;
  /** Whether the e-mode preflight was applied at open (reset after close). */
  emodeApplied: boolean;
  openTxHash: Hex;
  /** Epoch ms when the open tx confirmed. */
  openedAt: number;
  /** Risk-engine position id, for close bookkeeping. */
  riskId: string;
  decimals: number;
}

/**
 * Leveraged yield looping bot.
 *
 * - Monitors real Aave V3 rates and ranks leveraged loop candidates.
 * - Optionally opens a loop (autoTrade) via the LoopingExecutor contract.
 * - Continuously watches the on-chain health factor and deleverages
 *   (closeLoop) when it falls below the critical threshold.
 * - Defaults to DRY_RUN: nothing is ever sent without explicit opt-in.
 */
export class LoopingBot {
  private config: BotConfig;
  private logger: Logger;
  private rateMonitor: RateMonitor;
  private riskEngine: RiskEngine;
  private pnlTracker: PnLTracker;
  private positionStore: PositionStore;
  private gasStrategy: GasStrategy;
  private healthMonitor?: HealthMonitor;
  private txBuilder?: TransactionBuilder;
  private openPosition?: OpenPositionInfo;

  private running = false;
  private monitorCycleInFlight = false;
  private healthCycleInFlight = false;
  private consecutiveEmptyRateCycles = 0;
  /** True while the rate feed is empty/blind — disables new opens. */
  private rateBlindMode = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(config: BotConfig) {
    this.config = config;
    this.logger = createLogger(config.logLevel);

    // Prefer the Flashblocks-capable WS endpoint for read/poll traffic;
    // fall back to HTTP when no WS URL is configured.
    const readTransport: Transport = config.wsUrl
      ? webSocket(config.wsUrl)
      : http(config.rpcUrl);
    const publicClient = createPublicClient({
      chain: base,
      transport: readTransport,
    });

    this.rateMonitor = new RateMonitor(
      publicClient,
      undefined,
      config.priceCacheTtlMs,
    );
    this.riskEngine = new RiskEngine({
      maxMarginUsd: config.maxMarginUsd,
      minNetApyBps: config.minNetApyBps,
      cooldownMs: config.cooldownMs,
      minHealthFactor: Number(config.minHealthFactorWad) / 1e18,
    });
    this.pnlTracker = new PnLTracker(config.pnlPath);
    this.positionStore = new PositionStore(config.positionPath);
    // Recover an open position persisted across restarts so the health loop can
    // still close it and compute realized PnL. Reconciled against the on-chain
    // flag in start() to avoid trusting a stale file.
    this.openPosition = this.positionStore.get();

    const gasStrategy = new GasStrategy(
      publicClient,
      {
        maxGasPriceGwei: config.maxGasPriceGwei,
        priorityFeeGwei: config.priorityFeeGwei,
        gasBufferPercent: config.gasBufferPercent,
      },
      this.logger
    );
    this.gasStrategy = gasStrategy;

    if (config.executorAddress) {
      this.healthMonitor = new HealthMonitor(
        publicClient,
        config.executorAddress,
        config.healthFactorWarnWad,
        config.healthFactorCriticalWad,
        this.logger,
        config.usePendingBlock
      );
    }

    if (config.privateKey && config.executorAddress) {
      const account = privateKeyToAccount(
        config.privateKey as `0x${string}`
      );
      const walletClient = createWalletClient({
        chain: base,
        transport: http(config.rpcUrl),
        account,
      });
      this.txBuilder = new TransactionBuilder(
        publicClient,
        walletClient,
        account,
        config.executorAddress,
        gasStrategy,
        this.logger,
        config.usePendingBlock
      );
    }
  }

  /**
   * Start the bot's monitoring and trading loops.
   * Initiates periodic rate monitoring and health checking. Startup
   * reconciliation of the persisted position is awaited before any trading
   * cycle is allowed, so a stale-position reconcile cannot race and erase a
   * newly opened position.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Reconcile the recovered in-memory open position with the on-chain flag
    // before trading begins. A persisted file saying "open" while the
    // contract says "closed" means a close happened out-of-band (or the file
    // is stale); drop it so we don't act on ghost state. Conversely, if the
    // file is empty but the contract is open, we cannot compute PnL but we
    // can still close via getOpenPositionAssets. Doing this first (and
    // awaiting it) prevents a concurrent first cycle from opening a position
    // that reconciliation would then wipe.
    await this.reconcileOpenPosition();

    this.logger.info('Starting looping bot', {
      network: this.config.network,
      dryRun: this.config.dryRun,
      autoTrade: this.config.autoTrade,
      leverage: this.config.leverage,
    });

    if (!this.config.dryRun) {
      this.logger.warn('LIVE MODE — real transactions will be sent');
    }

    this.timers.push(
      setInterval(() => void this.monitorCycle(), this.config.pollIntervalMs)
    );
    if (this.healthMonitor) {
      this.timers.push(
        setInterval(
          () => void this.healthCycle(),
          this.config.healthCheckIntervalMs
        )
      );
    }

    void this.monitorCycle();
  }

  /**
   * Stop the bot and clear all timers.
   */
  stop(): void {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.logger.info('Bot stopped');
  }

  /**
   * Reconcile the persisted open position with the on-chain position flag.
   * If the file says open but the contract says closed (out-of-band close or
   * stale file), drop the persisted state. Failures are logged but never throw,
   * so a transient RPC error cannot block startup.
   */
  private async reconcileOpenPosition(): Promise<void> {
    if (!this.healthMonitor) return;
    try {
      const onChainOpen = await this.healthMonitor.hasOpenPosition();
      if (this.openPosition && !onChainOpen) {
        this.logger.warn(
          'Persisted open position no longer matches on-chain state (closed out-of-band?); clearing',
        );
        this.openPosition = undefined;
        this.positionStore.clear();
      }
    } catch (error) {
      this.logger.warn(`Open-position reconciliation skipped: ${error}`);
    }
  }

  /** Fetch live rates and rank loop candidates. */
  private async monitorCycle(): Promise<void> {
    if (!this.running || this.monitorCycleInFlight) return;
    this.monitorCycleInFlight = true;
    try {
      const [rates, eModeCategory] = await Promise.all([
        this.rateMonitor.getAllRates(),
        this.rateMonitor.getEModeCategoryData(),
      ]);

      // Circuit breaker: rate fetches can return an empty array when the
      // Aave data provider consistently fails (address mismatch, contract
      // paused, RPC issue). After a few consecutive empty cycles the bot is
      // effectively blind to rates; in live mode we must fail closed rather
      // than risk opening on stale/empty data. We block new opens (the flag
      // short-circuits maybeOpen) and, at a higher threshold, pause the
      // executor on-chain so an unattended live deployment cannot keep running.
      if (rates.length === 0) {
        this.consecutiveEmptyRateCycles++;
        if (this.consecutiveEmptyRateCycles >= 5) {
          this.logger.warn(
            `Rate fetch returned no assets for ${this.consecutiveEmptyRateCycles} consecutive cycles — check Aave data provider / RPC`,
          );
        }
        if (!this.rateBlindMode) {
          this.rateBlindMode = true;
          this.logger.warn(
            'Rate feed blind — opening disabled until rates recover',
          );
        }
        // At 10 consecutive empty cycles in live mode, pause the executor so a
        // stalled rate feed cannot leave a position unmonitored/over-opened.
        if (
          this.consecutiveEmptyRateCycles >= 10 &&
          !this.config.dryRun &&
          this.txBuilder &&
          this.healthMonitor
        ) {
          try {
            const paused = await this.healthMonitor.isPaused();
            if (!paused) {
              this.logger.error(
                'Rate feed blind for 10 cycles — pausing executor as a fail-closed measure',
              );
              await this.txBuilder.pause();
            }
          } catch (error) {
            this.logger.error(`Fail-closed pause attempt failed: ${error}`);
          }
        }
      } else {
        this.consecutiveEmptyRateCycles = 0;
        if (this.rateBlindMode) {
          this.rateBlindMode = false;
          this.logger.info('Rate feed recovered — opening re-enabled');
        }
      }

      const candidates = findLoopCandidates(
        rates,
        this.config.marginAmount,
        Number(this.config.minHealthFactorWad) / 1e18,
        this.config.minNetApyBps,
        eModeCategory
      );

      this.logTopCandidates(candidates);

      if (this.config.autoTrade && !this.rateBlindMode) {
        await this.maybeOpen(candidates);
      }
    } catch (error) {
      this.logger.error(`Monitor cycle failed: ${error}`);
    } finally {
      this.monitorCycleInFlight = false;
    }
  }

  /**
   * Evaluate loop candidates and attempt to open a position if conditions are met.
   * Respects risk limits, cooldowns, and verifies no on-chain position exists.
   * @param candidates - Ranked loop candidates from the current rate monitor cycle
   */
  private async maybeOpen(candidates: LoopCandidate[]): Promise<void> {
    if (this.riskEngine.getOpenPositions().length > 0) return;

    // Restart safety: the in-memory risk engine is empty after a restart, so
    // verify the on-chain position flag before attempting an open that the
    // contract would reject anyway (PositionAlreadyOpen).
    if (this.healthMonitor) {
      const alreadyOpen = await this.healthMonitor.hasOpenPosition();
      if (alreadyOpen) {
        this.logger.warn('On-chain position already open; skipping open attempt');
        return;
      }
    }

    const best = candidates.find(
      (c) =>
        c.leverage === this.config.leverage &&
        c.asset.toLowerCase() === this.config.marginAsset.toLowerCase()
    );
    if (!best) return;

    // Real USD valuation via the Aave PriceOracle so the maxMarginUsd guard
    // is actually enforced (was previously hard-coded to 0).
    const marginUsd = await this.rateMonitor.tokenAmountToUsd(
      best.asset,
      best.marginAmount,
      best.decimals,
    );

    const check = this.riskEngine.canOpen({
      symbol: best.symbol,
      leverage: best.leverage,
      marginUsd,
      netApyBps: best.netApyBps,
      projectedHealthFactor: best.projectedHealthFactor,
    });
    if (!check.allowed) {
      this.logger.info(`Skipping candidate: ${check.reason}`);
      return;
    }

    if (this.config.dryRun || !this.txBuilder) {
      this.logger.info(
        `[DRY RUN] Would open ${best.leverage}x loop on ${best.symbol} ` +
          `(net ${(best.netApyBps / 100).toFixed(2)}% APY, HF ~${best.projectedHealthFactor.toFixed(3)}, ` +
          `margin ~$${marginUsd.toFixed(2)})` +
          (best.needsEmode ? ' (needs e-mode category 1)' : '')
      );
      return;
    }

    // Preflight: a high-leverage ETH-correlated loop needs the e-mode category
    // set on the executor before the open can borrow against the higher LT.
    // The bot applies it (category 1 = ETH-correlated) right before opening so
    // the operator doesn't have to remember a manual setEMode. Its gas is a
    // real on-chain cost, so it's folded into openTxGasUsed below.
    const emode = best.needsEmode
      ? await this.txBuilder.setEMode(EMODE.ETH_CORRELATED)
      : undefined;

    const approve = await this.txBuilder.approveMargin(
      best.asset,
      best.marginAmount
    );
    const sent = await this.txBuilder.openLoop({
      collateralAsset: best.asset,
      borrowAsset: best.asset,
      marginAmount: best.marginAmount,
      leverage: best.leverage as 2 | 3 | 5,
      minHealthFactor: this.config.minHealthFactorWad,
      swapData: '0x',
      minSwapOut: 0n,
    });

    const position = this.riskEngine.recordOpen(
      {
        symbol: best.symbol,
        leverage: best.leverage,
        marginUsd,
        netApyBps: best.netApyBps,
        projectedHealthFactor: best.projectedHealthFactor,
      },
      best.marginAmount,
      sent.hash
    );
    this.openPosition = {
      asset: best.asset,
      symbol: best.symbol,
      marginAmount: best.marginAmount,
      leverage: best.leverage,
      marginUsd,
      openTxGasUsed:
        (emode?.gasUsed ?? 0n) +
        (approve.gasUsed ?? 0n) +
        (sent.gasUsed ?? 0n),
      openTxHash: sent.hash,
      openedAt: Date.now(),
      riskId: position.id,
      decimals: best.decimals,
      emodeApplied: best.needsEmode,
    };
    this.positionStore.set(this.openPosition);
    this.logger.info(
      `Loop opened: approve=${approve.hash} open=${sent.hash}`
    );
  }

  /** Health factor watchdog — deleverages when critical. */
  private async healthCycle(): Promise<void> {
    if (!this.running || !this.healthMonitor || this.healthCycleInFlight)
      return;
    this.healthCycleInFlight = true;
    try {
      const open = await this.healthMonitor.hasOpenPosition();
      if (!open) return;

      const { snapshot, action } = await this.healthMonitor.check();

      if (action === 'deleverage') {
        const openPos = this.openPosition;
        if (this.config.dryRun || !this.txBuilder) {
          this.logger.error(
            '[DRY RUN] HF critical — would close loop now. HF = ' +
              (Number(snapshot.healthFactor) / 1e18).toFixed(4)
          );
          return;
        }

        const { collateralAsset, borrowAsset } = openPos
          ? { collateralAsset: openPos.asset, borrowAsset: openPos.asset }
          : await this.healthMonitor.getOpenPositionAssets();
        const closeReq = {
          collateralAsset,
          borrowAsset,
          swapData: '0x' as const,
          minSwapOut: 0n,
        };
        // closeLoop is blocked while the executor is paused (e.g. by the
        // rate-feed circuit breaker) — exactly when a critical position most
        // needs unwinding. Fall back to keeperDeleverage, which the contract
        // deliberately keeps callable while paused.
        const paused = await this.healthMonitor.isPaused();
        const sent = paused
          ? await this.txBuilder.keeperDeleverage(closeReq)
          : await this.txBuilder.closeLoop(closeReq);

        if (openPos) {
          this.riskEngine.recordClose(openPos.riskId, sent.hash);
        }
        this.openPosition = undefined;
        this.positionStore.clear();
        const closedAt = Date.now();
        this.logger.warn(`Loop closed due to low HF: ${sent.hash}`);

        // Leave e-mode the way we found it: while the ETH-correlated category
        // stays active, borrowing any non-category asset reverts, which would
        // block the next non-ETH open until a manual reset.
        if (openPos?.emodeApplied) {
          try {
            await this.txBuilder.setEMode(EMODE.NONE);
          } catch (error) {
            this.logger.error(`E-mode reset after close failed: ${error}`);
          }
        }

        // Realized PnL: estimate accrued yield from the net APY at open over
        // the hold duration, minus gas spent on open + close. This is an
        // on-rate estimate (the margin itself is returned intact for a
        // same-asset unwind), not a balance-delta measurement.
        if (openPos) {
          try {
            const netApyBpsAtOpen =
              this.riskEngine
                .getAllPositions()
                .find((p) => p.id === openPos.riskId)?.netApyBpsAtOpen ?? 0;
            const closeGasUsed = sent.gasUsed ?? 0n;
            const gasWei = openPos.openTxGasUsed + closeGasUsed;

            const [priceUsd, fees] = await Promise.all([
              this.rateMonitor.getAssetPriceUsd(collateralAsset),
              this.gasStrategy.getFees(),
            ]);

            const pnl = estimateRealizedPnL({
              marginUsd: openPos.marginUsd,
              netApyBpsAtOpen,
              holdMs: closedAt - openPos.openedAt,
              gasWei,
              maxFeePerGas: fees.maxFeePerGas,
              gasAssetPriceUsd: priceUsd,
            });

            this.riskEngine.recordRealizedPnl(openPos.riskId, pnl.netPnlUsd);
            this.pnlTracker.record({
              id: openPos.riskId,
              openedAt: openPos.openedAt,
              closedAt,
              asset: openPos.symbol,
              leverage: openPos.leverage,
              marginUsd: openPos.marginUsd,
              durationHours: pnl.durationHours,
              grossYieldUsd: pnl.grossYieldUsd,
              gasCostUsd: pnl.gasCostUsd,
              netPnlUsd: pnl.netPnlUsd,
              openTxHash: openPos.openTxHash,
              closeTxHash: sent.hash,
            });
          } catch (error) {
            this.logger.error(`Closed-loop PnL enrichment failed: ${error}`);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Health cycle failed: ${error}`);
    } finally {
      this.healthCycleInFlight = false;
    }
  }

  /**
   * Log the top 5 loop candidates from the current cycle.
   * @param candidates - Ranked loop candidates to display
   */
  private logTopCandidates(candidates: LoopCandidate[]): void {
    const top = candidates.slice(0, 5);
    if (top.length === 0) {
      this.logger.info('No viable loop candidates this cycle');
      return;
    }
    for (const c of top) {
      this.logger.info(
        `${c.symbol} ${c.leverage}x | supply ${(c.supplyApyBps / 100).toFixed(2)}% ` +
          `| borrow ${(c.borrowAprBps / 100).toFixed(2)}% ` +
          `| net ${(c.netApyBps / 100).toFixed(2)}% | HF ~${c.projectedHealthFactor.toFixed(3)}` +
          (c.needsEmode ? ' | needs e-mode' : '')
      );
    }
  }

  /**
   * Get the current status of the bot including running state and positions.
   * @returns Object with running flag, open positions, and PnL summary
   */
  getStatus() {
    return {
      running: this.running,
      openPositions: this.riskEngine.getOpenPositions(),
      pnl: this.pnlTracker.getSummary(),
    };
  }
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const bot = new LoopingBot(config);

  const shutdown = () => {
    bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.start();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal:', error);
    process.exit(1);
  });
}
