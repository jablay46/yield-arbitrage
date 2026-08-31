import 'dotenv/config';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { base } from 'viem/chains';

import { RateMonitor } from './monitor/rate-monitor';
import { OpportunityFilter } from './monitor/opportunity-filter';
import { RiskEngine } from './position/risk-engine';
import { PnLTracker } from './position/pnl-tracker';
import { TransactionBuilder } from './orchestrator/tx-builder';
import { BotConfig, DEFAULT_CONFIG } from './config';

/**
 * Main Arbitrage Bot
 * Coordinates all components for yield arbitrage execution
 */
export class ArbitrageBot {
  private config: BotConfig;
  private rateMonitor: RateMonitor;
  private opportunityFilter: OpportunityFilter;
  private riskEngine: RiskEngine;
  private pnlTracker: PnLTracker;
  private txBuilder?: TransactionBuilder;
  
  private isRunning: boolean = false;
  private lastExecutionTime: number = 0;
  
  constructor(config: Partial<BotConfig> = {}) {
    // Merge configs
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      // Ensure required fields
      network: config.network ?? 'base',
      rpcUrl: config.rpcUrl ?? process.env.BASE_RPC_URL ?? '',
      privateKey: config.privateKey ?? process.env.PRIVATE_KEY ?? '',
    } as BotConfig;
    
    // Initialize components
    const publicClient = createPublicClient({
      chain: base,
      transport: http(this.config.rpcUrl),
    });
    
    this.rateMonitor = new RateMonitor(this.config.rpcUrl);
    this.opportunityFilter = new OpportunityFilter(
      {
        minProfitUsd: this.config.minProfitUsd,
        maxSlippageBps: this.config.maxSlippageBps,
        maxGasPriceGwei: this.config.maxGasPriceGwei,
        gasBufferPercent: this.config.gasBufferPercent,
      },
      publicClient
    );
    
    this.riskEngine = new RiskEngine({
      maxPositionSizeUsd: Number(this.config.maxFlashloanAmount) / 1e6,
      maxDailyLossUsd: this.config.minProfitUsd * 100,
    });
    
    this.pnlTracker = new PnLTracker();
    
    // Initialize transaction builder if private key provided
    if (this.config.privateKey) {
      try {
        const walletClient = createWalletClient({
          chain: base,
          transport: http(this.config.rpcUrl),
          account: this.config.privateKey as any,
        });
        
        this.txBuilder = new TransactionBuilder(
          publicClient,
          walletClient,
          walletClient.account,
          {
            arbitrageExecutorAddress: '0x', // Set from config
          }
        );
      } catch (error) {
        console.warn('Failed to initialize wallet client:', error);
      }
    }
  }
  
  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Bot is already running');
      return;
    }
    
    this.isRunning = true;
    console.log('Starting Arbitrage Bot...');
    console.log(`Network: ${this.config.network}`);
    console.log(`Poll interval: ${this.config.pollIntervalMs}ms`);
    
    this.runLoop();
  }
  
  /**
   * Stop the bot
   */
  stop(): void {
    this.isRunning = false;
    console.log('Bot stopped');
  }
  
  /**
   * Main bot loop
   */
  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.scanAndExecute();
      } catch (error) {
        console.error('Error in bot loop:', error);
      }
      
      // Wait for next poll
      await this.sleep(this.config.pollIntervalMs);
    }
  }
  
  /**
   * Scan for opportunities and execute if profitable
   */
  private async scanAndExecute(): Promise<void> {
    console.log('\n--- Scanning for opportunities ---');
    
    // Get current rates
    const rates = await this.rateMonitor.getAllRates();
    console.log(`Fetched ${rates.length} market rates`);
    
    // Find opportunities
    const opportunities = this.rateMonitor.findOpportunities(
      rates,
      this.config.opportunityThresholdBps
    );
    console.log(`Found ${opportunities.length} potential opportunities`);
    
    if (opportunities.length === 0) return;
    
    // Filter and validate opportunities
    const validated = await this.opportunityFilter.filter(opportunities);
    console.log(`${validated.filter(o => o.isProfitable).length} profitable opportunities`);
    
    // Execute best opportunity
    for (const opportunity of validated) {
      if (!opportunity.isProfitable) continue;
      
      // Risk check
      const riskCheck = this.riskEngine.canExecute(opportunity);
      if (!riskCheck.allowed) {
        console.log(`Risk check failed: ${riskCheck.reason}`);
        continue;
      }
      
      // Execute
      await this.executeOpportunity(opportunity);
      
      // Wait between executions
      await this.sleep(5000);
    }
  }
  
  /**
   * Execute an arbitrage opportunity
   */
  private async executeOpportunity(opportunity: any): Promise<void> {
    console.log(`\n>>> Executing arbitrage:`);
    console.log(`    Supply: ${opportunity.supplyProtocol} @ ${opportunity.supplyApy / 100}% APY`);
    console.log(`    Borrow: ${opportunity.borrowProtocol} @ ${opportunity.borrowApr / 100}% APR`);
    console.log(`    Spread: ${opportunity.spread / 100}%`);
    console.log(`    Est. profit: $${opportunity.netProfitUsd.toFixed(2)}`);
    console.log(`    Flashloan: $${(Number(opportunity.flashloanAmount) / 1e6).toFixed(2)}`);
    
    // Open position
    const position = this.riskEngine.openPosition(opportunity);
    console.log(`    Position ID: ${position.id}`);
    
    // In production, send transaction here
    // For now, simulate execution
    try {
      // Simulate execution delay
      await this.sleep(2000);
      
      // Simulate success/failure (90% success rate for demo)
      const success = Math.random() > 0.1;
      
      if (success) {
        // Simulate profit (50-150% of estimated)
        const profitMultiplier = 0.5 + Math.random();
        position.profitUsd = opportunity.netProfitUsd * profitMultiplier;
        position.netProfitUsd = position.profitUsd - position.gasCostUsd;
        position.status = 'completed';
        
        console.log(`    ✓ Success! Net profit: $${position.netProfitUsd.toFixed(2)}`);
      } else {
        position.status = 'failed';
        position.error = 'Simulated failure';
        position.netProfitUsd = -position.gasCostUsd;
        
        console.log(`    ✗ Failed: ${position.error}`);
      }
      
      // Update position
      this.riskEngine.updatePosition(position.id, position.status, {
        profitUsd: position.profitUsd,
        netProfitUsd: position.netProfitUsd,
      });
      
      // Record PnL
      this.pnlTracker.recordTrade(position);
      
    } catch (error: any) {
      position.status = 'failed';
      position.error = error.message;
      position.netProfitUsd = -position.gasCostUsd;
      
      this.riskEngine.updatePosition(position.id, 'failed', {
        error: error.message,
      });
      
      console.log(`    ✗ Error: ${error.message}`);
    }
    
    // Print stats
    this.printStats();
  }
  
  /**
   * Print current statistics
   */
  private printStats(): void {
    const riskStats = this.riskEngine.getStats();
    const pnlSummary = this.pnlTracker.getSummary();
    
    console.log('\n--- Stats ---');
    console.log(`Active positions: ${riskStats.activePositions}`);
    console.log(`Daily PnL: $${pnlSummary.profitToday.toFixed(2)}`);
    console.log(`Total PnL: $${pnlSummary.totalNetProfit.toFixed(2)}`);
    console.log(`Win rate: ${pnlSummary.winRate.toFixed(1)}%`);
  }
  
  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Get bot status
   */
  getStatus(): {
    isRunning: boolean;
    stats: ReturnType<typeof this.riskEngine.getStats>;
    pnl: ReturnType<typeof this.pnlTracker.getSummary>;
  } {
    return {
      isRunning: this.isRunning,
      stats: this.riskEngine.getStats(),
      pnl: this.pnlTracker.getSummary(),
    };
  }
}

// Export for CLI usage
export async function main(): Promise<void> {
  const config: Partial<BotConfig> = {
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    privateKey: process.env.PRIVATE_KEY || '',
    network: 'base',
    pollIntervalMs: 10000,
    minProfitUsd: 10,
  };
  
  const bot = new ArbitrageBot(config);
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    bot.stop();
    process.exit(0);
  });
  
  await bot.start();
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
