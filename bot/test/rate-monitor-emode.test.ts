import { describe, expect, it, vi } from 'vitest';
import type { BasePublicClient } from '../src/client-types';
import { RateMonitor } from '../src/monitor/rate-monitor';

const VALID_CATEGORY = {
  ltv: 8700,
  liquidationThreshold: 9000,
  liquidationBonus: 10100,
  priceSource: '0x0000000000000000000000000000000000000000',
  label: 'ETH correlated',
} as const;

describe('RateMonitor e-mode category', () => {
  it('fetches category 1 once and caches its validated limits', async () => {
    const readContract = vi.fn().mockResolvedValue(VALID_CATEGORY);
    const monitor = new RateMonitor(
      { readContract } as unknown as BasePublicClient,
      []
    );

    const [first, second] = await Promise.all([
      monitor.getEModeCategoryData(),
      monitor.getEModeCategoryData(),
    ]);

    expect(first).toEqual({
      ltvBps: 8700,
      liquidationThresholdBps: 9000,
    });
    expect(second).toEqual(first);
    expect(readContract).toHaveBeenCalledOnce();
    expect(readContract.mock.calls[0][0]).toMatchObject({ args: [1] });
  });

  it('rejects invalid limits and retries the read next time', async () => {
    const readContract = vi
      .fn()
      .mockResolvedValueOnce({
        ...VALID_CATEGORY,
        ltv: 9100,
        label: 'invalid',
      })
      .mockResolvedValueOnce(VALID_CATEGORY);
    const monitor = new RateMonitor(
      { readContract } as unknown as BasePublicClient,
      []
    );

    await expect(monitor.getEModeCategoryData()).rejects.toThrow(
      /invalid ETH-correlated e-mode category data/
    );
    await expect(monitor.getEModeCategoryData()).resolves.toEqual({
      ltvBps: 8700,
      liquidationThresholdBps: 9000,
    });
    expect(readContract).toHaveBeenCalledTimes(2);
  });
});
