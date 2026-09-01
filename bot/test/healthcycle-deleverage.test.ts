import { describe, expect, it, vi } from 'vitest';
import { BotConfigSchema } from '../src/config';
import { LoopingBot, OpenPositionInfo } from '../src';
import { EMODE } from '../src/config/constants';

const config = BotConfigSchema.parse({
  rpcUrl: 'https://mainnet.base.org',
  marginAsset: '0x4200000000000000000000000000000000000006',
  marginAmount: 1_000_000_000_000_000_000n,
  dryRun: false,
});

const openPos: OpenPositionInfo = {
  asset: '0x4200000000000000000000000000000000000006',
  symbol: 'WETH',
  marginAmount: 1_000_000_000_000_000_000n,
  leverage: 2,
  marginUsd: 2000,
  openTxGasUsed: 100n,
  emodeApplied: false,
  openTxHash: '0xopen',
  openedAt: Date.now() - 60_000,
  riskId: 'loop-1',
  decimals: 18,
};

interface BotHarness {
  running: boolean;
  healthMonitor: {
    hasOpenPosition: ReturnType<typeof vi.fn>;
    check: ReturnType<typeof vi.fn>;
    isPaused: ReturnType<typeof vi.fn>;
  };
  txBuilder: {
    closeLoop: ReturnType<typeof vi.fn>;
    keeperDeleverage: ReturnType<typeof vi.fn>;
    setEMode: ReturnType<typeof vi.fn>;
  };
  riskEngine: {
    recordClose: ReturnType<typeof vi.fn>;
    recordRealizedPnl: ReturnType<typeof vi.fn>;
    getAllPositions: () => unknown[];
  };
  positionStore: { clear: ReturnType<typeof vi.fn> };
  rateMonitor: { getAssetPriceUsd: ReturnType<typeof vi.fn> };
  gasStrategy: {
    getFees: () => Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  };
  pnlTracker: { record: ReturnType<typeof vi.fn> };
  openPosition?: OpenPositionInfo;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  healthCycle: () => Promise<void>;
}

function makeBot(paused: boolean): BotHarness {
  const bot = new LoopingBot(config) as unknown as BotHarness;
  bot.running = true;
  bot.openPosition = { ...openPos };
  bot.healthMonitor = {
    hasOpenPosition: vi.fn().mockResolvedValue(true),
    check: vi.fn().mockResolvedValue({
      snapshot: {
        totalCollateralBase: 0n,
        totalDebtBase: 1n,
        healthFactor: 1_040_000_000_000_000_000n,
        timestamp: Date.now(),
      },
      action: 'deleverage',
    }),
    isPaused: vi.fn().mockResolvedValue(paused),
  };
  bot.txBuilder = {
    closeLoop: vi.fn().mockResolvedValue({ hash: '0xclose', gasUsed: 50n }),
    keeperDeleverage: vi
      .fn()
      .mockResolvedValue({ hash: '0xkeeper', gasUsed: 50n }),
    setEMode: vi.fn().mockResolvedValue({ hash: '0xemode', gasUsed: 10n }),
  };
  bot.riskEngine = {
    recordClose: vi.fn(),
    recordRealizedPnl: vi.fn(),
    getAllPositions: () => [],
  };
  bot.positionStore = { clear: vi.fn() };
  bot.rateMonitor = { getAssetPriceUsd: vi.fn().mockResolvedValue(2000) };
  bot.gasStrategy = {
    getFees: () =>
      Promise.resolve({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
  };
  bot.pnlTracker = { record: vi.fn() };
  bot.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return bot;
}

describe('LoopingBot healthCycle deleverage path', () => {
  it('uses keeperDeleverage when the executor is paused', async () => {
    const bot = makeBot(true);

    await bot.healthCycle();

    expect(bot.txBuilder.keeperDeleverage).toHaveBeenCalledOnce();
    expect(bot.txBuilder.closeLoop).not.toHaveBeenCalled();
    expect(bot.positionStore.clear).toHaveBeenCalledOnce();
  });

  it('uses closeLoop when the executor is not paused', async () => {
    const bot = makeBot(false);

    await bot.healthCycle();

    expect(bot.txBuilder.closeLoop).toHaveBeenCalledOnce();
    expect(bot.txBuilder.keeperDeleverage).not.toHaveBeenCalled();
  });

  it('resets e-mode to NONE after closing a position that used the preflight', async () => {
    const bot = makeBot(false);
    bot.openPosition = { ...openPos, emodeApplied: true };

    await bot.healthCycle();

    expect(bot.txBuilder.setEMode).toHaveBeenCalledWith(EMODE.NONE);
  });

  it('does not touch e-mode after closing a position that never set it', async () => {
    const bot = makeBot(false);

    await bot.healthCycle();

    expect(bot.txBuilder.setEMode).not.toHaveBeenCalled();
  });
});
