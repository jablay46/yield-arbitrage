import { describe, expect, it, vi } from 'vitest';
import { BotConfigSchema } from '../src/config';
import { LoopingBot } from '../src';
import type { EModeCategoryData, MarketRate } from '../src/monitor/rate-monitor';

const config = BotConfigSchema.parse({
  rpcUrl: 'https://mainnet.base.org',
  marginAsset: '0x4200000000000000000000000000000000000006',
  marginAmount: 1_000_000_000_000_000_000n,
});

function botWithRates(ratesPerCycle: MarketRate[][]) {
  const getAllRates = vi
    .fn<() => Promise<MarketRate[]>>()
    .mockResolvedValue([]);
  let call = 0;
  getAllRates.mockImplementation(() => {
    const r = ratesPerCycle[call] ?? [];
    call++;
    return Promise.resolve(r);
  });
  const getEModeCategoryData = vi
    .fn<() => Promise<EModeCategoryData>>()
    .mockResolvedValue({ ltvBps: 8700, liquidationThresholdBps: 9000 });
  const warn = vi.fn();
  const info = vi.fn();
  const error = vi.fn();
  const bot = new LoopingBot(config) as unknown as {
    running: boolean;
    rateMonitor: {
      getAllRates: typeof getAllRates;
      getEModeCategoryData: typeof getEModeCategoryData;
    };
    logger: { info: typeof info; warn: typeof warn; error: typeof error };
    monitorCycle: () => Promise<void>;
  };
  bot.running = true;
  bot.rateMonitor = { getAllRates, getEModeCategoryData };
  bot.logger = { info, warn, error };
  return { bot, warn };
}

const empty: MarketRate[][] = [[], [], [], [], [], []];

describe('LoopingBot rate-fetch circuit breaker', () => {
  it('warns after 5 consecutive empty rate cycles', async () => {
    const { bot, warn } = botWithRates(empty);
    for (let i = 0; i < 4; i++) await bot.monitorCycle();
    // 4 consecutive empties: not yet
    expect(warn).not.toHaveBeenCalled();

    await bot.monitorCycle(); // 5th consecutive empty
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toMatch(/5 consecutive cycles/);
  });

  it('warns again on a 6th consecutive empty cycle', async () => {
    const { bot, warn } = botWithRates(empty);
    for (let i = 0; i < 6; i++) await bot.monitorCycle();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('resets the counter once a non-empty cycle arrives', async () => {
    const rate = {
      asset: '0x4200000000000000000000000000000000000006',
      symbol: 'WETH',
      decimals: 18,
      supplyApyBps: 100,
      borrowAprBps: 40,
      availableLiquidity: 1_000_000n,
      utilizationBps: 10,
      ltvBps: 8000,
      liquidationThresholdBps: 8250,
      borrowingEnabled: true,
      isActive: true,
      isFrozen: false,
      lastUpdated: Date.now(),
    } as MarketRate;
    const { bot, warn } = botWithRates([
      [],
      [],
      [],
      [],
      [rate], // 4 empties then a good one — counter resets, no warn
      [],
      [],
      [],
      [],
      [], // would be 5 in a row only if not reset
    ]);
    for (let i = 0; i < 9; i++) await bot.monitorCycle();
    // 4 empties + good + 4 empties = only 4 consecutive at the end → no warn
    expect(warn).not.toHaveBeenCalled();
  });
});
