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

const HF_CRITICAL = 1_040_000_000_000_000_000n; // 1.04 — below bot default 1.10
const ON_CHAIN_CRITICAL = 1_020_000_000_000_000_000n; // contract default 1.02

const openPos: OpenPositionInfo = {
  asset: '0x4200000000000000000000000000000000000006',
  symbol: 'WETH',
  marginAmount: 1_000_000_000_000_000_000n,
  leverage: 2,
  marginUsd: 2000,
  openTxGasUsed: 100n,
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
    getCriticalHealthFactor: ReturnType<typeof vi.fn>;
    getUserEMode: ReturnType<typeof vi.fn>;
  };
  txBuilder: {
    closeLoop: ReturnType<typeof vi.fn>;
    keeperDeleverage: ReturnType<typeof vi.fn>;
    setEMode: ReturnType<typeof vi.fn>;
    setCriticalHealthFactor: ReturnType<typeof vi.fn>;
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
  reconcileOpenPosition: () => Promise<void>;
}

function makeBot(opts: {
  paused: boolean;
  onChainCritical?: bigint;
  userEMode?: number;
}): BotHarness {
  const bot = new LoopingBot(config) as unknown as BotHarness;
  bot.running = true;
  bot.openPosition = { ...openPos };
  bot.healthMonitor = {
    hasOpenPosition: vi.fn().mockResolvedValue(true),
    check: vi.fn().mockResolvedValue({
      snapshot: {
        totalCollateralBase: 0n,
        totalDebtBase: 1n,
        healthFactor: HF_CRITICAL,
        timestamp: Date.now(),
      },
      action: 'deleverage',
    }),
    isPaused: vi.fn().mockResolvedValue(opts.paused),
    getCriticalHealthFactor: vi
      .fn()
      .mockResolvedValue(opts.onChainCritical ?? ON_CHAIN_CRITICAL),
    getUserEMode: vi.fn().mockResolvedValue(opts.userEMode ?? 0),
  };
  bot.txBuilder = {
    closeLoop: vi.fn().mockResolvedValue({ hash: '0xclose', gasUsed: 50n }),
    keeperDeleverage: vi
      .fn()
      .mockResolvedValue({ hash: '0xkeeper', gasUsed: 50n }),
    setEMode: vi.fn().mockResolvedValue({ hash: '0xemode', gasUsed: 10n }),
    setCriticalHealthFactor: vi
      .fn()
      .mockResolvedValue({ hash: '0xcritical', gasUsed: 5n }),
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
    const bot = makeBot({ paused: true, onChainCritical: HF_CRITICAL + 1n });

    await bot.healthCycle();

    expect(bot.txBuilder.keeperDeleverage).toHaveBeenCalledOnce();
    expect(bot.txBuilder.closeLoop).not.toHaveBeenCalled();
    expect(bot.positionStore.clear).toHaveBeenCalledOnce();
  });

  it('uses closeLoop when the executor is not paused', async () => {
    const bot = makeBot({ paused: false });

    await bot.healthCycle();

    expect(bot.txBuilder.closeLoop).toHaveBeenCalledOnce();
    expect(bot.txBuilder.keeperDeleverage).not.toHaveBeenCalled();
  });

  it('raises the on-chain keeper trigger when the HF sits between the two thresholds', async () => {
    // HF 1.04 is below the bot's 1.10 trigger but above the contract's 1.02:
    // keeperDeleverage would revert HealthFactorNotCritical unless the
    // on-chain trigger is synced first.
    const bot = makeBot({ paused: true, onChainCritical: ON_CHAIN_CRITICAL });

    await bot.healthCycle();

    expect(bot.txBuilder.setCriticalHealthFactor).toHaveBeenCalledWith(
      config.healthFactorCriticalWad,
    );
    expect(bot.txBuilder.keeperDeleverage).toHaveBeenCalledOnce();
  });

  it('does not touch the on-chain trigger when the HF is already below it', async () => {
    const bot = makeBot({ paused: true, onChainCritical: HF_CRITICAL + 1n });

    await bot.healthCycle();

    expect(bot.txBuilder.setCriticalHealthFactor).not.toHaveBeenCalled();
    expect(bot.txBuilder.keeperDeleverage).toHaveBeenCalledOnce();
  });

  it('resets e-mode after close when the pool still reports a category', async () => {
    const bot = makeBot({ paused: false, userEMode: 1 });

    await bot.healthCycle();

    expect(bot.txBuilder.setEMode).toHaveBeenCalledWith(EMODE.NONE);
  });

  it('does not touch e-mode when the pool reports NONE', async () => {
    const bot = makeBot({ paused: false, userEMode: 0 });

    await bot.healthCycle();

    expect(bot.txBuilder.setEMode).not.toHaveBeenCalled();
  });

  it('includes the e-mode reset gas in realized PnL', async () => {
    const bot = makeBot({ paused: false, userEMode: 1 });

    await bot.healthCycle();

    // gas units: open 100 + close 50 + reset 10 = 160, at 1 wei/gas and
    // $2000/ETH -> 160e-18 * 2000 = 3.2e-13 USD
    const record = bot.pnlTracker.record.mock.calls[0][0] as {
      gasCostUsd: number;
    };
    expect(record.gasCostUsd).toBeCloseTo(3.2e-13, 15);
  });

  it('resets a stale e-mode category during startup reconciliation', async () => {
    const bot = makeBot({ paused: false, userEMode: 1 });
    bot.openPosition = undefined;
    bot.healthMonitor.hasOpenPosition = vi.fn().mockResolvedValue(false);

    await bot.reconcileOpenPosition();

    expect(bot.txBuilder.setEMode).toHaveBeenCalledWith(EMODE.NONE);
  });

  it('leaves e-mode alone during reconciliation when the pool reports NONE', async () => {
    const bot = makeBot({ paused: false, userEMode: 0 });
    bot.openPosition = undefined;
    bot.healthMonitor.hasOpenPosition = vi.fn().mockResolvedValue(false);

    await bot.reconcileOpenPosition();

    expect(bot.txBuilder.setEMode).not.toHaveBeenCalled();
  });
});
