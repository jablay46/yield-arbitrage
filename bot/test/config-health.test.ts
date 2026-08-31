import { describe, it, expect } from 'vitest';
import { BotConfigSchema, loadConfigFromEnv } from '../src/config';
import { HealthMonitor } from '../src/monitor/health-monitor';

describe('config schema', () => {
  const base = {
    rpcUrl: 'https://mainnet.base.org',
    marginAsset: '0x4200000000000000000000000000000000000006',
    marginAmount: 1_000_000_000_000_000_000n,
  };

  it('parses a minimal valid config with defaults', () => {
    const cfg = BotConfigSchema.parse(base);
    expect(cfg.network).toBe('base');
    expect(cfg.dryRun).toBe(true);
    expect(cfg.leverage).toBe(2);
    expect(cfg.minHealthFactorWad).toBe(1_050_000_000_000_000_000n);
  });

  it('rejects non-0x margin asset', () => {
    expect(() =>
      BotConfigSchema.parse({ ...base, marginAsset: 'WETH' })
    ).toThrow();
  });

  it('rejects unsupported leverage', () => {
    expect(() =>
      BotConfigSchema.parse({ ...base, leverage: 4 })
    ).toThrow();
  });

  it('requires a private key for live mode', () => {
    expect(() =>
      loadConfigFromEnv({
        DRY_RUN: 'false',
        MARGIN_ASSET: '0x4200000000000000000000000000000000000006',
        MARGIN_AMOUNT: '1000000000000000000',
        EXECUTOR_ADDRESS: '0x1111111111111111111111111111111111111111',
      })
    ).toThrow(/EXECUTOR_PRIVATE_KEY/);
  });

  it('accepts a valid live config', () => {
    const cfg = loadConfigFromEnv({
      DRY_RUN: 'false',
      MARGIN_ASSET: '0x4200000000000000000000000000000000000006',
      MARGIN_AMOUNT: '1000000000000000000',
      EXECUTOR_ADDRESS: '0x1111111111111111111111111111111111111111',
      EXECUTOR_PRIVATE_KEY: '0x' + 'ab'.repeat(32),
    });
    expect(cfg.dryRun).toBe(false);
    expect(cfg.marginAmount).toBe(1_000_000_000_000_000_000n);
  });
});

describe('HealthMonitor.classify', () => {
  const WAD = 10n ** 18n;
  const monitor = HealthMonitor.prototype as {
    classify: (s: {
      totalCollateralBase: bigint;
      totalDebtBase: bigint;
      healthFactor: bigint;
      timestamp: number;
    }) => 'ok' | 'warn' | 'deleverage';
    warnWad: bigint;
    criticalWad: bigint;
  };

  function classify(
    healthFactorWad: bigint,
    debt: bigint
  ): 'ok' | 'warn' | 'deleverage' {
    const bound = Object.create(HealthMonitor.prototype) as HealthMonitor;
    Object.assign(bound, {
      warnWad: 1.2 * Number(WAD) === 0 ? 1200000000000000000n : 1200000000000000000n,
      criticalWad: 1100000000000000000n,
    });
    return bound.classify({
      totalCollateralBase: 0n,
      totalDebtBase: debt,
      healthFactor: healthFactorWad,
      timestamp: 0,
    });
  }

  it('is ok with no debt', () => {
    expect(classify(1n * WAD, 0n)).toBe('ok');
  });

  it('ok above warn threshold', () => {
    expect(classify(13n * WAD / 10n, 100n)).toBe('ok'); // 1.3
  });

  it('warns between thresholds', () => {
    expect(classify(115n * WAD / 100n, 100n)).toBe('warn'); // 1.15
  });

  it('deleverages below critical', () => {
    expect(classify(105n * WAD / 100n, 100n)).toBe('deleverage'); // 1.05
  });

  void monitor;
});
