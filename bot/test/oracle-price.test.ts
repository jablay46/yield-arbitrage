import { describe, expect, it, vi } from 'vitest';
import type { BasePublicClient } from '../src/client-types';
import { RateMonitor, ORACLE_USD_DECIMALS } from '../src/monitor/rate-monitor';
import { ADDRESSES } from '../src/config/constants';

const WETH = '0x4200000000000000000000000000000000000006';

describe('RateMonitor oracle price conversion', () => {
  it('reads the USD price from the Aave oracle and scales to a JS number', async () => {
    // WETH @ $2500 -> oracle returns 2500 * 1e8
    const priceRaw = 2500n * 10n ** BigInt(ORACLE_USD_DECIMALS);
    const readContract = vi.fn().mockResolvedValue(priceRaw);
    const monitor = new RateMonitor(
      { readContract } as unknown as BasePublicClient,
      [],
    );

    const price = await monitor.getAssetPriceUsd(WETH);

    expect(readContract).toHaveBeenCalledOnce();
    expect(readContract.mock.calls[0][0]).toMatchObject({
      address: ADDRESSES.aaveOracle,
      functionName: 'getAssetPrice',
      args: [WETH],
    });
    expect(price).toBeCloseTo(2500, 6);
  });

  it('converts a token amount to USD using the oracle price and decimals', async () => {
    // 2 WETH (18 decimals) @ $2500 -> $5000
    const priceRaw = 2500n * 10n ** BigInt(ORACLE_USD_DECIMALS);
    const readContract = vi.fn().mockResolvedValue(priceRaw);
    const monitor = new RateMonitor(
      { readContract } as unknown as BasePublicClient,
      [],
    );

    const usd = await monitor.tokenAmountToUsd(WETH, 2n * 10n ** 18n, 18);
    expect(usd).toBeCloseTo(5000, 4);
  });

  it('handles 6-decimal stablecoins correctly', async () => {
    // 5000 USDC (6 decimals) @ $1 -> $5000
    const priceRaw = 1n * 10n ** BigInt(ORACLE_USD_DECIMALS);
    const readContract = vi.fn().mockResolvedValue(priceRaw);
    const monitor = new RateMonitor(
      { readContract } as unknown as BasePublicClient,
      [],
    );

    const usd = await monitor.tokenAmountToUsd(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      5000n * 10n ** 6n,
      6,
    );
    expect(usd).toBeCloseTo(5000, 4);
  });

  it('caches the price for TTL ms, avoiding a fresh RPC per call', async () => {
    const priceRaw = 2500n * 10n ** BigInt(ORACLE_USD_DECIMALS);
    const readContract = vi.fn().mockResolvedValue(priceRaw);
    // TTL of 60s — both reads within the window should hit the cache.
    const monitor = new RateMonitor(
      { readContract } as unknown as BasePublicClient,
      [],
      60_000,
    );

    const first = await monitor.getAssetPriceUsd(WETH);
    const second = await monitor.getAssetPriceUsd(WETH);

    expect(first).toBeCloseTo(2500, 6);
    expect(second).toBe(first);
    // Only one on-chain read despite two calls.
    expect(readContract).toHaveBeenCalledOnce();
  });

  it('re-fetches after the TTL expires', async () => {
    let calls = 0;
    const readContract = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(BigInt(calls) * 10n ** BigInt(ORACLE_USD_DECIMALS));
    });
    const monitor = new RateMonitor(
      { readContract } as unknown as BasePublicClient,
      [],
      // 1 ms TTL so the second call lands outside the window.
      1,
    );

    const first = await monitor.getAssetPriceUsd(WETH);
    await new Promise((r) => setTimeout(r, 5));
    const second = await monitor.getAssetPriceUsd(WETH);

    expect(first).toBeCloseTo(1, 6);
    expect(second).toBeCloseTo(2, 6);
    expect(readContract).toHaveBeenCalledTimes(2);
  });
});
