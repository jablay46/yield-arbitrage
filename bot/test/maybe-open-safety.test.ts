import { describe, expect, it, vi } from 'vitest';
import { BotConfigSchema } from '../src/config';
import { LoopingBot } from '../src';
import type { LoopCandidate } from '../src/strategy/find-candidates';

const config = BotConfigSchema.parse({
  rpcUrl: 'https://mainnet.base.org',
  marginAsset: '0x4200000000000000000000000000000000000006',
  marginAmount: 1_000_000_000_000_000_000n,
});

const candidate: LoopCandidate = {
  asset: '0x4200000000000000000000000000000000000006',
  symbol: 'WETH',
  decimals: 18,
  leverage: 2,
  marginAmount: 1_000_000_000_000_000_000n,
  flashloanAmount: 1_000_000_000_000_000_000n,
  supplyApyBps: 300,
  borrowAprBps: 200,
  netApyBps: 400,
  projectedHealthFactor: 1.65,
  needsEmode: false,
};

describe('LoopingBot maybeOpen restart safety', () => {
  it('checks the on-chain position flag before attempting an open', async () => {
    const hasOpenPosition = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(true);
    const tokenAmountToUsd = vi
      .fn<(asset: string, amount: bigint, decimals: number) => Promise<number>>()
      .mockResolvedValue(2000);
    const bot = new LoopingBot(config) as unknown as {
      running: boolean;
      riskEngine: { getOpenPositions: () => unknown[] };
      healthMonitor: { hasOpenPosition: typeof hasOpenPosition };
      rateMonitor: { tokenAmountToUsd: typeof tokenAmountToUsd };
      logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
      maybeOpen: (candidates: LoopCandidate[]) => Promise<void>;
    };
    bot.running = true;
    bot.riskEngine = { getOpenPositions: () => [] };
    bot.healthMonitor = { hasOpenPosition };
    bot.rateMonitor = { tokenAmountToUsd };
    bot.logger = { info: vi.fn(), warn: vi.fn() };

    await bot.maybeOpen([candidate]);

    // An on-chain open position must short-circuit before any USD valuation
    expect(hasOpenPosition).toHaveBeenCalledOnce();
    expect(tokenAmountToUsd).not.toHaveBeenCalled();
  });

  it('proceeds to USD valuation when no on-chain position is open', async () => {
    const hasOpenPosition = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false);
    const tokenAmountToUsd = vi
      .fn<(asset: string, amount: bigint, decimals: number) => Promise<number>>()
      .mockResolvedValue(2000);
    const bot = new LoopingBot(config) as unknown as {
      running: boolean;
      riskEngine: {
        getOpenPositions: () => unknown[];
        canOpen: () => { allowed: boolean; reason?: string };
      };
      healthMonitor: { hasOpenPosition: typeof hasOpenPosition };
      rateMonitor: { tokenAmountToUsd: typeof tokenAmountToUsd };
      logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
      maybeOpen: (candidates: LoopCandidate[]) => Promise<void>;
    };
    bot.running = true;
    bot.riskEngine = {
      getOpenPositions: () => [],
      canOpen: () => ({ allowed: true }),
    };
    bot.healthMonitor = { hasOpenPosition };
    bot.rateMonitor = { tokenAmountToUsd };
    bot.logger = { info: vi.fn(), warn: vi.fn() };

    // dryRun defaults to true -> logs a DRY RUN line after valuation
    await bot.maybeOpen([candidate]);

    expect(hasOpenPosition).toHaveBeenCalledOnce();
    expect(tokenAmountToUsd).toHaveBeenCalledOnce();
  });
});
