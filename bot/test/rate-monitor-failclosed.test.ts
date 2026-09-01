import { describe, expect, it, vi } from 'vitest';
import type { BasePublicClient } from '../src/client-types';
import { RateMonitor } from '../src/monitor/rate-monitor';
import { TOKENS } from '../src/config/constants';

const WETH = TOKENS.WETH;
const USDC = TOKENS.USDC;

// Shape returned by Aave's getReserveData for a healthy reserve.
const reserveOk = (aToken: string, vdt: string) => ({
  aTokenAddress: aToken,
  variableDebtTokenAddress: vdt,
  currentLiquidityRate: 1n * 10n ** 25n,
  currentVariableBorrowRate: 3n * 10n ** 25n,
});

// getReserveConfigurationData positional tuple: we only read a few fields.
const configOk = () => [
  0n, // decimals (unused here)
  8000n, // ltv
  8250n, // liquidationThreshold
  0n,
  0n,
  0n,
  true, // borrowingEnabled
  false,
  true, // isActive
  false, // isFrozen
];

type MulticallResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error: unknown };

const ok = (result: unknown): MulticallResult => ({ status: 'success', result });
const fail = (): MulticallResult => ({ status: 'failure', error: new Error('revert') });

describe('RateMonitor getAllRates fail-closed', () => {
  it('omits a reserve whose variable-debt totalSupply read fails', async () => {
    // Two assets, both reserve+config reads succeed. The debt totalSupply
    // multicall returns failure for the FIRST asset (WETH) and success for
    // the second (USDC). WETH must be omitted; USDC retained.
    const monitor = new RateMonitor(
      {
        multicall: vi
          .fn()
          // 1st call: reserveData (both ok)
          .mockResolvedValueOnce([ok(reserveOk('0xa1', '0xd1')), ok(reserveOk('0xa2', '0xd2'))])
          // 2nd call: configData (both ok)
          .mockResolvedValueOnce([ok(configOk()), ok(configOk())])
          // 3rd call: liquidity balanceOf (both ok)
          .mockResolvedValueOnce([ok(500n * 10n ** 18n), ok(1_000_000n * 10n ** 6n)])
          // 4th call: debt totalSupply — FIRST FAILS, second ok
          .mockResolvedValueOnce([fail(), ok(200n * 10n ** 6n)]),
      } as unknown as BasePublicClient,
      [WETH as `0x${string}`, USDC as `0x${string}`],
    );

    const rates = await monitor.getAllRates();

    // Only USDC survives; WETH (failed debt read) is omitted.
    expect(rates).toHaveLength(1);
    expect(rates[0].asset).toBe(USDC);
    // USDC utilization is derived from its real debt/liquidity, not 0.
    expect(rates[0].utilizationBps).toBeGreaterThan(0);
  });

  it('omits a reserve whose liquidity balanceOf read fails', async () => {
    const monitor = new RateMonitor(
      {
        multicall: vi
          .fn()
          .mockResolvedValueOnce([ok(reserveOk('0xa1', '0xd1'))])
          .mockResolvedValueOnce([ok(configOk())])
          // liquidity read FAILS
          .mockResolvedValueOnce([fail()])
          .mockResolvedValueOnce([ok(100n * 10n ** 18n)]),
      } as unknown as BasePublicClient,
      [WETH as `0x${string}`],
    );

    const rates = await monitor.getAllRates();
    expect(rates).toHaveLength(0);
  });

  it('includes a reserve when all reads succeed', async () => {
    const monitor = new RateMonitor(
      {
        multicall: vi
          .fn()
          .mockResolvedValueOnce([ok(reserveOk('0xa1', '0xd1'))])
          .mockResolvedValueOnce([ok(configOk())])
          .mockResolvedValueOnce([ok(900n * 10n ** 18n)])
          .mockResolvedValueOnce([ok(100n * 10n ** 18n)]),
      } as unknown as BasePublicClient,
      [WETH as `0x${string}`],
    );

    const rates = await monitor.getAllRates();
    expect(rates).toHaveLength(1);
    // utilization = 100 / (100 + 900) = 1000 bps (10%)
    expect(rates[0].utilizationBps).toBe(1000);
  });
});
