import 'dotenv/config';
import { createPublicClient, createWalletClient, http, webSocket, Transport, Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { BotConfig, loadConfigFromEnv } from './config';
import { RateMonitor } from './monitor/rate-monitor';
import { HealthMonitor } from './monitor/health-monitor';

import { findLoopCandidates, LoopCandidate } from './strategy/find-candidates';
import { RiskEngine } from './position/risk-engine';
import { PnLTracker } from './position/pnl-tracker';
import { estimateRealizedPnL } from './position/pnl-estimate';
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
  /** Gas used by the approve+open transactions, in wei units. */
  openTxGasUsed: bigint;
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
  private gasStrategy: GasStrategy;
  private healthMonitor?: HealthMonitor;
  private txBuilder?: TransactionBuilder;
  private openPosition?: OpenPositionInfo;

  private running = false;
  private monitorCycleInFlight = false;
  private healthCycleInFlight = false;
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

  start(): void {
    if (this.running) return;
    this.running = true;

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

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.logger.info('Bot stopped');
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
      const candidates = findLoopCandidates(
        rates,
        this.config.marginAmount,
        Number(this.config.minHealthFactorWad) / 1e18,
        this.config.minNetApyBps,
        eModeCategory
      );

      this.logTopCandidates(candidates);

      if (this.config.autoTrade) {
        await this.maybeOpen(candidates);
      }
    } catch (error) {
      this.logger.error(`Monitor cycle failed: ${error}`);
    } finally {
      this.monitorCycleInFlight = false;
    }
  }

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
          `margin ~$${marginUsd.toFixed(2)})`
      );
      return;
    }

    if (best.needsEmode) {
      this.logger.info('Candidate requires e-mode; set it on the executor first');
      return;
    }

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
      openTxGasUsed: (approve.gasUsed ?? 0n) + (sent.gasUsed ?? 0n),
      openTxHash: sent.hash,
      openedAt: Date.now(),
      riskId: position.id,
      decimals: best.decimals,
    };
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
        const sent = await this.txBuilder.closeLoop({
          collateralAsset,
          borrowAsset,
          swapData: '0x',
          minSwapOut: 0n,
        });

        if (openPos) {
          this.riskEngine.recordClose(openPos.riskId, sent.hash);
        }
        this.openPosition = undefined;
        const closedAt = Date.now();
        this.logger.warn(`Loop closed due to low HF: ${sent.hash}`);

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

  getStatus() {
    return {
      running: this.running,
      openPositions: this.riskEngine.getOpenPositions(),
      pnl: this.pnlTracker.getSummary(),
    };
  }
}

export async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const bot = new LoopingBot(config);

  const shutdown = () => {
    bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  bot.start();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal:', error);
    process.exit(1);
  });
}
