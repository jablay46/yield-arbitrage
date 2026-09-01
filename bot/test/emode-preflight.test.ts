import { describe, expect, it, vi } from 'vitest';
import { BotConfigSchema } from '../src/config';
import { LoopingBot } from '../src';
import type { LoopCandidate } from '../src/strategy/find-candidates';

const liveConfig = (leverage: 2 | 3 | 5) =>
  BotConfigSchema.parse({
    rpcUrl: 'https://mainnet.base.org',
    marginAsset: '0x4200000000000000000000000000000000000006',
    marginAmount: 1_000_000_000_000_000_000n,
    dryRun: false,
    autoTrade: true,
    leverage,
    executorAddress: '0x0000000000000000000000000000000000000001',
    privateKey:
      '0x0000000000000000000000000000000000000000000000000000000000000001',
  });

const emodeCandidate: LoopCandidate = {
  asset: '0x4200000000000000000000000000000000000006',
  symbol: 'WETH',
  decimals: 18,
  leverage: 5,
  marginAmount: 1_000_000_000_000_000_000n,
  flashloanAmount: 4_000_000_000_000_000_000n,
  supplyApyBps: 300,
  borrowAprBps: 200,
  netApyBps: 700,
  projectedHealthFactor: 1.125,
  needsEmode: true,
};

type StubbedBot = {
  running: boolean;
  openPosition?: { openTxGasUsed: bigint };
  riskEngine: {
    getOpenPositions: () => unknown[];
    canOpen: () => { allowed: boolean; reason?: string };
    recordOpen: () => { id: string };
  };
  healthMonitor: { hasOpenPosition: () => Promise<boolean> };
  rateMonitor: {
    tokenAmountToUsd: (asset: string, amount: bigint, decimals: number) => Promise<number>;
  };
  txBuilder: {
    setEMode: (categoryId: number) => Promise<{ hash: string; gasUsed?: bigint }>;
    approveMargin: (token: string, amount: bigint) => Promise<{ hash: string; gasUsed?: bigint }>;
    openLoop: (req: unknown) => Promise<{ hash: string; gasUsed?: bigint }>;
  };
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  maybeOpen: (candidates: LoopCandidate[]) => Promise<void>;
};

function stubBot(bot: LoopingBot): StubbedBot {
  return bot as unknown as StubbedBot;
}

describe('LoopingBot e-mode preflight', () => {
  it('sets e-mode category 1 before approving/opening a needsEmode candidate', async () => {
    const setEMode = vi
      .fn<(categoryId: number) => Promise<{ hash: string; gasUsed?: bigint }>>()
      .mockResolvedValue({ hash: '0xem', gasUsed: 50_000n });
    const approveMargin = vi
      .fn<(token: string, amount: bigint) => Promise<{ hash: string; gasUsed?: bigint }>>()
      .mockResolvedValue({ hash: '0xap', gasUsed: 50_000n });
    const openLoop = vi
      .fn<(req: unknown) => Promise<{ hash: string; gasUsed?: bigint }>>()
      .mockResolvedValue({ hash: '0xop', gasUsed: 500_000n });

    const hasOpenPosition = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const tokenAmountToUsd = vi
      .fn<(asset: string, amount: bigint, decimals: number) => Promise<number>>()
      .mockResolvedValue(2000);

    const bot = stubBot(new LoopingBot(liveConfig(5)));
    bot.running = true;
    bot.riskEngine = {
      getOpenPositions: () => [],
      canOpen: () => ({ allowed: true }),
      recordOpen: () => ({ id: 'loop-1' }),
    };
    bot.healthMonitor = { hasOpenPosition };
    bot.rateMonitor = { tokenAmountToUsd };
    bot.txBuilder = { setEMode, approveMargin, openLoop };
    bot.logger = { info: vi.fn(), warn: vi.fn() };

    await bot.maybeOpen([emodeCandidate]);

    // e-mode must be applied first, before approve and open.
    expect(setEMode).toHaveBeenCalledOnce();
    expect(setEMode).toHaveBeenCalledWith(1);
    expect(approveMargin).toHaveBeenCalledOnce();
    expect(openLoop).toHaveBeenCalledOnce();
    expect(setEMode.mock.invocationCallOrder[0]).toBeLessThan(
      approveMargin.mock.invocationCallOrder[0],
    );

    // The e-mode tx gas is a real on-chain cost and must be folded into the
    // recorded openTxGasUsed so realized PnL isn't overstated.
    expect(bot.openPosition?.openTxGasUsed).toBe(
      50_000n + 50_000n + 500_000n,
    );
  });

  it('skips setEMode for a candidate that does not need e-mode', async () => {
    const setEMode = vi.fn();
    const approveMargin = vi
      .fn<(token: string, amount: bigint) => Promise<{ hash: string; gasUsed?: bigint }>>()
      .mockResolvedValue({ hash: '0xap', gasUsed: 50_000n });
    const openLoop = vi
      .fn<(req: unknown) => Promise<{ hash: string; gasUsed?: bigint }>>()
      .mockResolvedValue({ hash: '0xop', gasUsed: 500_000n });

    const hasOpenPosition = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const tokenAmountToUsd = vi
      .fn<(asset: string, amount: bigint, decimals: number) => Promise<number>>()
      .mockResolvedValue(2000);

    const bot = stubBot(new LoopingBot(liveConfig(2)));
    bot.running = true;
    bot.riskEngine = {
      getOpenPositions: () => [],
      canOpen: () => ({ allowed: true }),
      recordOpen: () => ({ id: 'loop-2' }),
    };
    bot.healthMonitor = { hasOpenPosition };
    bot.rateMonitor = { tokenAmountToUsd };
    bot.txBuilder = { setEMode, approveMargin, openLoop };
    bot.logger = { info: vi.fn(), warn: vi.fn() };

    const normal: LoopCandidate = {
      ...emodeCandidate,
      leverage: 2,
      flashloanAmount: 1_000_000_000_000_000_000n,
      needsEmode: false,
    };
    await bot.maybeOpen([normal]);

    expect(setEMode).not.toHaveBeenCalled();
    expect(approveMargin).toHaveBeenCalledOnce();
    expect(openLoop).toHaveBeenCalledOnce();
  });
});

