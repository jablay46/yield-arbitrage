import 'dotenv/config';
import { createPublicClient, createWalletClient, http, webSocket, Transport, Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { BotConfig, loadConfigFromEnv } from './config';
import { RateMonitor } from './monitor/rate-monitor';
import { HealthMonitor } from './monitor/health-monitor';

import { findLoopCandidates, LoopCandidate } from './strategy/find-candidates';
import { RiskEngine } from './position/risk-engine';
import { PnLTracker } from './position/pnl-tracker';
import { TransactionBuilder } from './orchestrator/tx-builder';
import { GasStrategy } from './utils/gas-strategy';
import { createLogger, Logger } from './utils/logger';

export interface OpenPositionInfo {
  asset: Address;
  symbol: string;
  marginAmount: bigint;
  leverage: number;
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
  private healthMonitor?: HealthMonitor;
  private txBuilder?: TransactionBuilder;
  private openPosition?: OpenPositionInfo;

  private running = false;
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

    this.rateMonitor = new RateMonitor(publicClient);
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
    if (!this.running) return;
    try {
      const rates = await this.rateMonitor.getAllRates();
      const candidates = findLoopCandidates(
        rates,
        this.config.marginAmount,
        Number(this.config.minHealthFactorWad) / 1e18,
        this.config.minNetApyBps
      );

      this.logTopCandidates(candidates);

      if (this.config.autoTrade) {
        await this.maybeOpen(candidates);
      }
    } catch (error) {
      this.logger.error(`Monitor cycle failed: ${error}`);
    }
  }

  private async maybeOpen(candidates: LoopCandidate[]): Promise<void> {
    if (this.riskEngine.getOpenPositions().length > 0) return;
    const best = candidates.find(
      (c) =>
        c.leverage === this.config.leverage &&
        c.asset.toLowerCase() === this.config.marginAsset.toLowerCase()
    );
    if (!best) return;

    const check = this.riskEngine.canOpen({
      symbol: best.symbol,
      leverage: best.leverage,
      // USD valuation skipped here (no price oracle); size is bounded by MARGIN_AMOUNT
      marginUsd: 0,
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
          `(net ${(best.netApyBps / 100).toFixed(2)}% APY, HF ~${best.projectedHealthFactor.toFixed(3)})`
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

    this.riskEngine.recordOpen(
      {
        symbol: best.symbol,
        leverage: best.leverage,
        marginUsd: 0,
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
    };
    this.logger.info(
      `Loop opened: approve=${approve.hash} open=${sent.hash}`
    );
  }

  /** Health factor watchdog — deleverages when critical. */
  private async healthCycle(): Promise<void> {
    if (!this.running || !this.healthMonitor) return;
    try {
      const open = await this.healthMonitor.hasOpenPosition();
      if (!open) return;

      const { snapshot, action } = await this.healthMonitor.check();

      if (action === 'deleverage') {
        const openPos = this.riskEngine.getOpenPositions()[0];
        if (this.config.dryRun || !this.txBuilder) {
          this.logger.error(
            '[DRY RUN] HF critical — would close loop now. HF = ' +
              (Number(snapshot.healthFactor) / 1e18).toFixed(4)
          );
          return;
        }

        const closeAsset = this.openPosition?.asset ?? this.config.marginAsset;
        const sent = await this.txBuilder.closeLoop({
          collateralAsset: closeAsset,
          borrowAsset: closeAsset,
          swapData: '0x',
          minSwapOut: 0n,
        });
        if (openPos) {
          this.riskEngine.recordClose(openPos.id, sent.hash);
          const closedAt = Date.now();
          this.pnlTracker.record({
            id: openPos.id,
            openedAt: openPos.openedAt,
            closedAt,
            asset: openPos.asset,
            leverage: openPos.leverage,
            marginUsd: 0,
            durationHours: (closedAt - openPos.openedAt) / 3_600_000,
            grossYieldUsd: 0,
            gasCostUsd: 0,
            netPnlUsd: 0,
            openTxHash: openPos.openTxHash,
            closeTxHash: sent.hash,
          });
        }
        this.openPosition = undefined;
        this.logger.warn(`Loop closed due to low HF: ${sent.hash}`);
      }
    } catch (error) {
      this.logger.error(`Health cycle failed: ${error}`);
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

