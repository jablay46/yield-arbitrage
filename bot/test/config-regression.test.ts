import { describe, it, expect } from 'vitest';
import { loadConfigFromEnv, loadConfig, loadConfigFile } from '../src/config';
import { findLoopCandidates } from '../src/strategy/find-candidates';
import { MarketRate } from '../src/monitor/rate-monitor';

const MARGIN_ASSET = '0x4200000000000000000000000000000000000006';
const E_MODE_CATEGORY = {
  ltvBps: 8700,
  liquidationThresholdBps: 9000,
};

describe('config file (non-secret) merge', () => {
  it('returns {} when the path is missing or corrupt', () => {
    expect(loadConfigFile(undefined)).toEqual({});
    expect(loadConfigFile('/nonexistent/path.json')).toEqual({});
  });

  it('loads non-secret values from a JSON file and lets env override them', () => {
    const tmp = `/tmp/bot-cfg-${Date.now()}.json`;
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        marginAsset: MARGIN_ASSET,
        marginAmount: '1000000000000000000',
        leverage: 3,
        maxGasPriceGwei: 25,
        dryRun: false,
      }),
    );
    try {
      const EXEC_ADDR = '0x' + 'b'.repeat(40) as `0x${string}`;
      // No env override: file values apply (leverage 3, gas 25).
      const cfg = loadConfig(
        {
          EXECUTOR_PRIVATE_KEY: '0x' + 'a'.repeat(64),
          EXECUTOR_ADDRESS: EXEC_ADDR,
        },
        tmp,
      );
      expect(cfg.leverage).toBe(3);
      expect(cfg.maxGasPriceGwei).toBe(25);
      expect(cfg.dryRun).toBe(false);

      // Env overrides file values.
      const cfg2 = loadConfig(
        {
          EXECUTOR_PRIVATE_KEY: '0x' + 'a'.repeat(64),
          EXECUTOR_ADDRESS: EXEC_ADDR,
          LEVERAGE: '5',
          MAX_GAS_PRICE_GWEI: '40',
        },
        tmp,
      );
      expect(cfg2.leverage).toBe(5);
      expect(cfg2.maxGasPriceGwei).toBe(40);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

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

describe('file value hardening (review regression)', () => {
  const EXEC_ADDR = '0x' + 'b'.repeat(40) as `0x${string}`;
  const PK = '0x' + 'a'.repeat(64);
  const baseEnv = {
    EXECUTOR_PRIVATE_KEY: PK,
    EXECUTOR_ADDRESS: EXEC_ADDR,
    MARGIN_ASSET,
  };

  it('rejects a string "false" for autoTrade in the file (no truthy coercion)', () => {
    const tmp = `/tmp/bot-cfg-${Date.now()}.json`;
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(
      tmp,
      JSON.stringify({ marginAmount: '1000000000000000000', autoTrade: 'false' }),
    );
    try {
      expect(() => loadConfig({ ...baseEnv }, tmp)).toThrow(/invalid boolean file value/);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('accepts a real boolean for autoTrade in the file', () => {
    const tmp = `/tmp/bot-cfg-${Date.now()}.json`;
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(
      tmp,
      JSON.stringify({ marginAmount: '1000000000000000000', autoTrade: true }),
    );
    try {
      const cfg = loadConfig({ ...baseEnv }, tmp);
      expect(cfg.autoTrade).toBe(true);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('accepts a WAD decimal string from the file', () => {
    const tmp = `/tmp/bot-cfg-${Date.now()}.json`;
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        marginAmount: '1000000000000000000',
        minHealthFactorWad: '1100000000000000000',
      }),
    );
    try {
      const cfg = loadConfig({ ...baseEnv }, tmp);
      expect(cfg.minHealthFactorWad).toBe(1_100_000_000_000_000_000n);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('rejects a numeric margin amount above MAX_SAFE_INTEGER in the file', () => {
    const tmp = `/tmp/bot-cfg-${Date.now()}.json`;
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(
      tmp,
      JSON.stringify({ marginAmount: 1e21 }), // > MAX_SAFE_INTEGER, would be rounded
    );
    try {
      expect(() => loadConfig({ ...baseEnv }, tmp)).toThrow(/invalid token amount file value/);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
