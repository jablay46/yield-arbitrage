import { describe, expect, it, vi } from 'vitest';
import { BotConfigSchema } from '../src/config';
import { LoopingBot } from '../src';
import type {
  EModeCategoryData,
  MarketRate,
} from '../src/monitor/rate-monitor';

const config = BotConfigSchema.parse({
  rpcUrl: 'https://mainnet.base.org',
  marginAsset: '0x4200000000000000000000000000000000000006',
  marginAmount: 1_000_000_000_000_000_000n,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('LoopingBot cycle guards', () => {
  it('does not overlap monitor cycles and clears the guard after settlement', async () => {
    const rates = deferred<MarketRate[]>();
    const getAllRates = vi
      .fn<() => Promise<MarketRate[]>>()
      .mockReturnValueOnce(rates.promise)
      .mockResolvedValue([]);
    const getEModeCategoryData = vi
      .fn<() => Promise<EModeCategoryData>>()
      .mockResolvedValue({ ltvBps: 8700, liquidationThresholdBps: 9000 });
    const bot = new LoopingBot(config) as unknown as {
      running: boolean;
      rateMonitor: {
        getAllRates: typeof getAllRates;
        getEModeCategoryData: typeof getEModeCategoryData;
      };
      logger: {
        info: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
      };
      monitorCycle: () => Promise<void>;
    };
    bot.running = true;
    bot.rateMonitor = { getAllRates, getEModeCategoryData };
    bot.logger = { info: vi.fn(), error: vi.fn() };

    const first = bot.monitorCycle();
    await bot.monitorCycle();
    expect(getAllRates).toHaveBeenCalledOnce();

    rates.reject(new Error('rate failure'));
    await first;
    await bot.monitorCycle();
    expect(getAllRates).toHaveBeenCalledTimes(2);
  });

  it('does not overlap health cycles and clears the guard after settlement', async () => {
    const open = deferred<boolean>();
    const hasOpenPosition = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(open.promise)
      .mockResolvedValue(false);
    const bot = new LoopingBot(config) as unknown as {
      running: boolean;
      healthMonitor: { hasOpenPosition: typeof hasOpenPosition };
      logger: { error: ReturnType<typeof vi.fn> };
      healthCycle: () => Promise<void>;
    };
    bot.running = true;
    bot.healthMonitor = { hasOpenPosition };
    bot.logger = { error: vi.fn() };

    const first = bot.healthCycle();
    await bot.healthCycle();
    expect(hasOpenPosition).toHaveBeenCalledOnce();

    open.reject(new Error('health failure'));
    await first;
    await bot.healthCycle();
    expect(hasOpenPosition).toHaveBeenCalledTimes(2);
  });
});
