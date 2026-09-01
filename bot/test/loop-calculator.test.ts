import { describe, it, expect } from 'vitest';
import {
  flashloanAmountFor,
  totalCollateralFor,
  netApyBps,
  projectedHealthFactor,
  maxLeverageForLtv,
  leverageAllowed,
  liquidationBuffer,
  minSwapOutFromOracle,
} from '../src/strategy/loop-calculator';

describe('loop-calculator', () => {
  it('computes flashloan size from margin and leverage', () => {
    expect(flashloanAmountFor(1_000n, 2)).toBe(1_000n);
    expect(flashloanAmountFor(1_000n, 3)).toBe(2_000n);
    expect(flashloanAmountFor(1_000n, 5)).toBe(4_000n);
  });

  it('computes total collateral', () => {
    expect(totalCollateralFor(1_000n, 5)).toBe(5_000n);
  });

  it('computes net leveraged APY in bps', () => {
    // 2x on 3% supply vs 2% borrow: 2*300 - 1*200 = 400 bps
    expect(netApyBps(300, 200, 2)).toBe(400);
    // 3x: 3*300 - 2*200 = 500 bps on margin
    expect(netApyBps(300, 200, 3)).toBe(500);
    // negative when borrow cost exceeds yield
    expect(netApyBps(100, 200, 2)).toBe(0);
    expect(netApyBps(100, 300, 3)).toBeLessThan(0);
  });

  it('computes projected health factor after open', () => {
    // WETH LT 82.5%: HF = L*0.825/(L-1)
    expect(projectedHealthFactor(2, 8250)).toBeCloseTo(1.65, 5);
    expect(projectedHealthFactor(3, 8250)).toBeCloseTo(1.2375, 5);
    expect(projectedHealthFactor(5, 8250)).toBeCloseTo(1.03125, 5);
    // always above 1 while LT > (L-1)/L
  });

  it('computes max leverage from LTV with safety margin', () => {
    // LTV 80%: floor(1 / (1 - (0.80 - 0.02))) = floor(1/0.22) = 4
    expect(maxLeverageForLtv(8000, 200)).toBe(4);
    // LTV 50%: floor(1 / 0.52) = 1 -> no leverage
    expect(maxLeverageForLtv(5000, 200)).toBe(1);
    expect(maxLeverageForLtv(0)).toBe(1);
  });

  it('allows leverage only when HF floor and LTV permit', () => {
    // 2x on WETH normal mode: HF 1.65, LTV ok
    expect(leverageAllowed(2, 8250, 8000, 1.05)).toBe(true);
    // 5x on WETH normal mode: HF 1.03 < 1.05
    expect(leverageAllowed(5, 8250, 8000, 1.05)).toBe(false);
    // 5x in e-mode LT 90%, LTV 87%: HF = 5*0.9/4 = 1.125, max lev = 8
    expect(leverageAllowed(5, 9000, 8700, 1.05)).toBe(true);
    // leverage above LTV-implied max never allowed
    expect(leverageAllowed(9, 9000, 8700, 1.05)).toBe(false);
  });

  it('computes liquidation buffer', () => {
    const buffer = liquidationBuffer(2, 8250);
    // 1 - (1 / (2 * 0.825)) = 1 - 0.606 = 0.394 adverse move tolerated
    expect(buffer).toBeCloseTo(0.394, 3);
  });

  it('derives a slippage-guarded minSwapOut from oracle prices', () => {
    // Swap 1 WETH (1e18, ~$2000) into USDC (1e6, ~$1).
    // fairOut = 1e18 * 2000e8 / 1e8 = 2e21 -> /1e12 decimal adjust = 2e9 (2000 USDC).
    // With 50 bps slippage: 2000e6 * 0.995 = 1990e6.
    const minOut = minSwapOutFromOracle(
      1_000_000_000_000_000_000n, // 1 WETH
      200_000_000_000n, // $2000 in 1e8
      100_000_000n, // $1 in 1e8
      18, // WETH
      6, // USDC
      50, // 0.5%
    );
    expect(minOut).toBe(1_990_000_000n); // 1990 USDC
  });

  it('minSwapOut handles equal decimals', () => {
    // 1000 units in -> out same decimals, 1% slippage -> 990
    const minOut = minSwapOutFromOracle(1000n, 1n, 1n, 18, 18, 100);
    expect(minOut).toBe(990n);
  });

  it('preserves fractional output when scaling up decimals (no truncation)', () => {
    // One base unit of a 6-decimal $1 token into an 18-decimal $2000 token.
    // fair = 1 * 1e8 / (2000e8) = 1/2000 = 0.0005; scaled up by 1e12 gives
    // 5e8 wei. The old order divided first (0) then scaled -> 0 (understated).
    const minOut = minSwapOutFromOracle(1n, 100_000_000n, 200_000_000_000n, 6, 18, 0);
    expect(minOut).toBe(500_000_000n); // 0.0005 of the 18-decimal out token
  });
});
