import { describe, it, expect } from 'vitest';
import { loadConfigFromEnv } from '../src/config';
import { findLoopCandidates } from '../src/strategy/find-candidates';
import { MarketRate } from '../src/monitor/rate-monitor';

const MARGIN_ASSET = '0x4200000000000000000000000000000000000006';
const E_MODE_CATEGORY = {
  ltvBps: 8700,
  liquidationThresholdBps: 9000,
};

describe('MIN_NET_APY_BPS (review regression)', () => {
  const rates: MarketRate[] = [
    {
      asset: MARGIN_ASSET,
      symbol: 'WETH',
      decimals: 18,
      supplyApyBps: 300,
      borrowAprBps: 100,
      availableLiquidity: 1_000_000n,
      utilizationBps: 0,
      ltvBps: 8000,
      liquidationThresholdBps: 8250,
      borrowingEnabled: true,
      isActive: true,
      isFrozen: false,
      lastUpdated: Date.now(),
    },
  ];

  it('default of 50 keeps the loop floor unchanged', () => {
    const cfg = loadConfigFromEnv({
      MARGIN_ASSET,
      MARGIN_AMOUNT: '1000000000000000000',
    });
    expect(cfg.minNetApyBps).toBe(50);
  });

  it('a non-default env value reaches the candidate filter', () => {
    // Fixture nets 500 bps at 2x, 700 at 3x, 1100 at 5x (net = L*s - (L-1)*b).
    // A floor of 1200 rejects everything; a floor of 1000 keeps only 5x.
    const strict = loadConfigFromEnv({
      MARGIN_ASSET,
      MARGIN_AMOUNT: '1000000000000000000',
      MIN_NET_APY_BPS: '1200',
    });
    const lenient = loadConfigFromEnv({
      MARGIN_ASSET,
      MARGIN_AMOUNT: '1000000000000000000',
      MIN_NET_APY_BPS: '1000',
    });

    const strictOut = findLoopCandidates(
      rates,
      1000n,
      1.05,
      strict.minNetApyBps,
      E_MODE_CATEGORY
    );
    const lenientOut = findLoopCandidates(
      rates,
      1000n,
      1.05,
      lenient.minNetApyBps,
      E_MODE_CATEGORY
    );
    expect(strictOut).toHaveLength(0);
    expect(lenientOut.length).toBeGreaterThan(0);
  });
});

describe('boolean parsing (review regression)', () => {
  it('fail-closes on unparsable DRY_RUN values', () => {
    expect(() =>
      loadConfigFromEnv({
        MARGIN_ASSET,
        MARGIN_AMOUNT: '1000000000000000000',
        DRY_RUN: 'ture', // typo must not silently switch off dry-run
      })
    ).toThrow(/invalid boolean env value/);
  });

  it('accepts canonical boolean strings', () => {
    const cfg = loadConfigFromEnv({
      MARGIN_ASSET,
      MARGIN_AMOUNT: '1000000000000000000',
      DRY_RUN: 'true',
      AUTO_TRADE: 'no',
    });
    expect(cfg.dryRun).toBe(true);
    expect(cfg.autoTrade).toBe(false);
  });
});
