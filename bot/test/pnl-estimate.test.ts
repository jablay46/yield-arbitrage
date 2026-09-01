import { describe, it, expect } from 'vitest';
import { estimateRealizedPnL } from '../src/position/pnl-estimate';

describe('estimateRealizedPnL', () => {
  it('estimates gross yield from net APY over the hold duration', () => {
    // $1000 margin, 400 bps net APY (4%), held exactly 1 year -> $40 gross
    const pnl = estimateRealizedPnL({
      marginUsd: 1000,
      netApyBpsAtOpen: 400,
      holdMs: 365 * 24 * 60 * 60 * 1000,
      gasWei: 0n,
      maxFeePerGas: 0n,
      gasAssetPriceUsd: 0,
    });
    expect(pnl.grossYieldUsd).toBeCloseTo(40, 5);
    expect(pnl.gasCostUsd).toBe(0);
    expect(pnl.netPnlUsd).toBeCloseTo(40, 5);
    expect(pnl.durationHours).toBeCloseTo(8760, 1);
  });

  it('scales linearly with a fraction of a year', () => {
    // Half a year at 400 bps on $1000 -> $20
    const pnl = estimateRealizedPnL({
      marginUsd: 1000,
      netApyBpsAtOpen: 400,
      holdMs: (365 * 24 * 60 * 60 * 1000) / 2,
      gasWei: 0n,
      maxFeePerGas: 0n,
      gasAssetPriceUsd: 0,
    });
    expect(pnl.grossYieldUsd).toBeCloseTo(20, 5);
  });

  it('subtracts gas cost in USD from the gross yield', () => {
    // 1 gwei maxFee * 1e6 gas = 1e15 wei = 0.001 ETH; @ $2000 = $2 gas
    const pnl = estimateRealizedPnL({
      marginUsd: 1000,
      netApyBpsAtOpen: 400,
      holdMs: 365 * 24 * 60 * 60 * 1000,
      gasWei: 1_000_000n,
      maxFeePerGas: 1_000_000_000n, // 1 gwei
      gasAssetPriceUsd: 2000,
    });
    expect(pnl.gasCostUsd).toBeCloseTo(2, 6);
    expect(pnl.netPnlUsd).toBeCloseTo(38, 5);
  });

  it('returns zero yield for a zero-duration (same-block) hold', () => {
    const pnl = estimateRealizedPnL({
      marginUsd: 1000,
      netApyBpsAtOpen: 400,
      holdMs: 0,
      gasWei: 1_000_000n,
      maxFeePerGas: 1_000_000_000n,
      gasAssetPriceUsd: 2000,
    });
    expect(pnl.grossYieldUsd).toBe(0);
    expect(pnl.netPnlUsd).toBeCloseTo(-2, 6);
  });

  it('clamps a negative hold duration to zero', () => {
    const pnl = estimateRealizedPnL({
      marginUsd: 1000,
      netApyBpsAtOpen: 400,
      holdMs: -5000,
      gasWei: 0n,
      maxFeePerGas: 0n,
      gasAssetPriceUsd: 0,
    });
    expect(pnl.grossYieldUsd).toBe(0);
    expect(pnl.durationHours).toBe(0);
  });
});
