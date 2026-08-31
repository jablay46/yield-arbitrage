import { describe, it, expect } from 'vitest';
import { findLoopCandidates } from '../src/strategy/find-candidates';
import { MarketRate } from '../src/monitor/rate-monitor';
import { TOKENS } from '../src/config/constants';

function makeRate(partial: Partial<MarketRate> = {}): MarketRate {
  return {
    asset: TOKENS.WETH,
    symbol: 'WETH',
    decimals: 18,
    supplyApyBps: 300,
    borrowAprBps: 200,
    availableLiquidity: 1_000_000n,
    utilizationBps: 0,
    ltvBps: 8000,
    liquidationThresholdBps: 8250,
    borrowingEnabled: true,
    isActive: true,
    isFrozen: false,
    lastUpdated: Date.now(),
    ...partial,
  };
}

describe('find-candidates', () => {
  const minHF = 1.05;
  const eModeCategory = {
    ltvBps: 8700,
    liquidationThresholdBps: 9000,
  };

  it('ranks 2x and 3x candidates for a healthy market', () => {
    const candidates = findLoopCandidates(
      [makeRate()],
      1000n,
      minHF,
      0,
      eModeCategory
    );
    const leverages = candidates.map((c) => c.leverage);
    expect(leverages).toContain(2);
    expect(leverages).toContain(3);
    // sorted by net APY desc: 5x (700) > 3x (500) > 2x (400)
    expect(candidates[0].leverage).toBe(5);
    expect(candidates[0].netApyBps).toBe(700);
  });

  it('flags e-mode need for 5x on WETH normal mode', () => {
    const candidates = findLoopCandidates(
      [makeRate()],
      1000n,
      minHF,
      0,
      eModeCategory
    );
    const fiveX = candidates.find((c) => c.leverage === 5);
    expect(fiveX).toBeDefined();
    expect(fiveX!.needsEmode).toBe(true);
    // e-mode HF = 5*0.90/4 = 1.125
    expect(fiveX!.projectedHealthFactor).toBeCloseTo(1.125, 3);
  });

  it('excludes frozen, inactive, or borrow-disabled reserves', () => {
    expect(
      findLoopCandidates(
        [makeRate({ isFrozen: true })],
        1000n,
        minHF,
        0,
        eModeCategory
      )
    ).toHaveLength(0);
    expect(
      findLoopCandidates(
        [makeRate({ isActive: false })],
        1000n,
        minHF,
        0,
        eModeCategory
      )
    ).toHaveLength(0);
    expect(
      findLoopCandidates(
        [makeRate({ borrowingEnabled: false })],
        1000n,
        minHF,
        0,
        eModeCategory
      )
    ).toHaveLength(0);
  });

  it('excludes negative-yield loops at a positive min APY', () => {
    // supply 1%, borrow 2% -> 2x net = 2*100 - 1*200 = 0 bps < min 50
    const candidates = findLoopCandidates(
      [makeRate({ supplyApyBps: 100, borrowAprBps: 200 })],
      1000n,
      minHF,
      50,
      eModeCategory
    );
    expect(candidates).toHaveLength(0);
  });

  it('excludes non-ETH-correlated assets for e-mode rescue', () => {
    const usdc = makeRate({
      asset: TOKENS.USDC,
      symbol: 'USDC',
      decimals: 6,
      liquidationThresholdBps: 8300,
    });
    const candidates = findLoopCandidates(
      [usdc],
      1000n,
      minHF,
      0,
      eModeCategory
    );
    expect(candidates.find((c) => c.leverage === 5)).toBeUndefined();
    expect(candidates.find((c) => c.leverage === 2)).toBeDefined();
  });

  it('skips markets with insufficient flashloan liquidity', () => {
    const candidates = findLoopCandidates(
      [makeRate({ availableLiquidity: 100n })],
      1000n,
      minHF,
      0,
      eModeCategory
    );
    expect(candidates).toHaveLength(0);
  });

  it('uses the supplied on-chain e-mode limits for eligibility and health factor', () => {
    const candidates = findLoopCandidates([makeRate()], 1000n, minHF, 0, {
      ltvBps: 9000,
      liquidationThresholdBps: 9300,
    });
    const fiveX = candidates.find((c) => c.leverage === 5);
    expect(fiveX).toBeDefined();
    expect(fiveX!.projectedHealthFactor).toBeCloseTo(1.1625, 4);

    const lowLtv = findLoopCandidates([makeRate()], 1000n, minHF, 0, {
      ltvBps: 8100,
      liquidationThresholdBps: 9300,
    });
    expect(lowLtv.find((c) => c.leverage === 5)).toBeUndefined();
  });
});
