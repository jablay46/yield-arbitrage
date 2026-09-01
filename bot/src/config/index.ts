import { z } from 'zod';
import type { Address } from 'viem';

const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'invalid address') as unknown as z.ZodType<Address>;

const PrivateKeySchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'private key must be 0x-prefixed 64-char hex');

export const BotConfigSchema = z.object({
  network: z.enum(['base']).default('base'),
  rpcUrl: z.string().url(),

  /** Optional WebSocket endpoint (wss://) — Flashblocks-capable reads/polls */
  wsUrl: z.string().url().optional(),

  /** Only required when dryRun = false */
  privateKey: PrivateKeySchema.optional(),

  /** Deployed LoopingExecutor address (optional for monitor-only mode) */
  executorAddress: AddressSchema.optional(),

  // Strategy
  marginAsset: AddressSchema,
  marginAmount: z.bigint().positive(),
  leverage: z.union([z.literal(2), z.literal(3), z.literal(5)]).default(2),
  minNetApyBps: z.number().default(50), // only consider loops yielding >= 0.5%/yr net

  // Safety
  dryRun: z.boolean().default(true),
  autoTrade: z.boolean().default(false),
  minHealthFactorWad: z.bigint().default(1_050_000_000_000_000_000n), // 1.05
  healthFactorWarnWad: z.bigint().default(1_200_000_000_000_000_000n), // 1.20
  healthFactorCriticalWad: z.bigint().default(1_100_000_000_000_000_000n), // 1.10

      // Loop control
  pollIntervalMs: z.number().default(30_000),
  healthCheckIntervalMs: z.number().default(60_000),
  cooldownMs: z.number().default(60_000),

  /** Base Flashblocks: simulate/read against the ~200ms preconfirmed block */
  usePendingBlock: z.boolean().default(true),

  // Limits
  maxMarginUsd: z.number().default(50_000),

  /** TTL for the cached oracle price, in ms. Avoids a fresh getAssetPrice
   *  RPC every cycle when autoTrade is polling for an open. */
  priceCacheTtlMs: z.number().finite().nonnegative().default(30_000),

  // Gas
  maxGasPriceGwei: z.number().default(50),
  priorityFeeGwei: z.number().default(0.1),
  gasBufferPercent: z.number().default(20),

  // Storage / logging
  pnlPath: z.string().default('./data/pnl.json'),
  /** Path to the persisted open-position file (survives restart). */
  positionPath: z.string().default('./data/position.json'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;

/**
 * Load non-secret config from an optional JSON file at `configPath` and merge
 * it with environment variables. Environment variables always win, so secrets
 * (private key, RPC URLs with keys) stay out of the versioned config file while
 * reusable settings (leverage, intervals, paths, gas caps) can live in a file.
 *
 * Returns the raw merged object (not yet schema-validated) or `{}` when no
 * file path is given or the file is missing.
 */
export function loadConfigFile(
  configPath: string | undefined,
): Record<string, unknown> {
  if (!configPath) return {};
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A corrupt config file should not crash startup; env vars still apply.
    return {};
  }
}

/**
 * Parse a boolean value from an environment variable string.
 * @param v - The environment variable value
 * @param fallback - Default value if the variable is undefined
 * @returns The parsed boolean value
 * @throws Error if the value is not a recognized boolean format
 */
function boolFromEnv(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const s = v.toLowerCase();
  if (['1', 'true', 'yes'].includes(s)) return true;
  if (['0', 'false', 'no'].includes(s)) return false;
  throw new Error(`invalid boolean env value: "${v}" (expected true/false)`);
}

/** Prefer an env value, else fall back to a file value. */
function envOrFile<T>(envVal: T | undefined, fileVal: T | undefined): T | undefined {
  return envVal !== undefined ? envVal : fileVal;
}

/**
 * Load and validate config from an optional JSON file plus environment
 * variables. Env values override file values for every overlapping key, and
 * secrets (e.g. EXECUTOR_PRIVATE_KEY) should only ever come from env.
 * @param env - Environment variables (defaults to process.env)
 * @param configPath - Path to an optional JSON config file (defaults to CONFIG_PATH env var)
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  configPath: string | undefined = env.CONFIG_PATH,
): BotConfig {
  const file = loadConfigFile(configPath);
  // Env vars override file values for overlapping keys; the spread of `file`
  // already seeds non-secret defaults from the config file.
  const raw = {
    ...file,
    rpcUrl:
      env.RPC_URL ?? env.BASE_RPC_URL ?? file.rpcUrl ?? 'https://mainnet.base.org',
    wsUrl: envOrFile(env.BASE_WS_URL, file.wsUrl),
    privateKey: env.EXECUTOR_PRIVATE_KEY || undefined,
    executorAddress: envOrFile(env.EXECUTOR_ADDRESS, file.executorAddress),
    marginAsset: envOrFile(env.MARGIN_ASSET, file.marginAsset),
    marginAmount: env.MARGIN_AMOUNT
      ? BigInt(env.MARGIN_AMOUNT)
      : file.marginAmount !== undefined
        ? BigInt(file.marginAmount as string | number | bigint)
        : undefined,
    leverage: env.LEVERAGE ? Number(env.LEVERAGE) : file.leverage,
    dryRun: boolFromEnv(env.DRY_RUN, Boolean(file.dryRun ?? true)),
    autoTrade: boolFromEnv(env.AUTO_TRADE, Boolean(file.autoTrade ?? false)),
    minNetApyBps: env.MIN_NET_APY_BPS
      ? Number(env.MIN_NET_APY_BPS)
      : file.minNetApyBps,
    minHealthFactorWad: env.MIN_HEALTH_FACTOR_WAD
      ? BigInt(env.MIN_HEALTH_FACTOR_WAD)
      : file.minHealthFactorWad,
    healthFactorWarnWad: env.HEALTH_FACTOR_WARN_WAD
      ? BigInt(env.HEALTH_FACTOR_WARN_WAD)
      : file.healthFactorWarnWad,
    healthFactorCriticalWad: env.HEALTH_FACTOR_CRITICAL_WAD
      ? BigInt(env.HEALTH_FACTOR_CRITICAL_WAD)
      : file.healthFactorCriticalWad,
    pollIntervalMs: env.POLL_INTERVAL_MS
      ? Number(env.POLL_INTERVAL_MS)
      : file.pollIntervalMs,
    healthCheckIntervalMs: env.HEALTH_CHECK_INTERVAL_MS
      ? Number(env.HEALTH_CHECK_INTERVAL_MS)
      : file.healthCheckIntervalMs,
    cooldownMs: env.COOLDOWN_MS ? Number(env.COOLDOWN_MS) : file.cooldownMs,
    usePendingBlock: env.USE_PENDING_BLOCK
      ? boolFromEnv(env.USE_PENDING_BLOCK, true)
      : file.usePendingBlock,
    maxMarginUsd: env.MAX_MARGIN_USD
      ? Number(env.MAX_MARGIN_USD)
      : file.maxMarginUsd,
    priceCacheTtlMs: env.PRICE_CACHE_TTL_MS
      ? Number(env.PRICE_CACHE_TTL_MS)
      : file.priceCacheTtlMs,
    maxGasPriceGwei: env.MAX_GAS_PRICE_GWEI
      ? Number(env.MAX_GAS_PRICE_GWEI)
      : file.maxGasPriceGwei,
    priorityFeeGwei: env.PRIORITY_FEE_GWEI
      ? Number(env.PRIORITY_FEE_GWEI)
      : file.priorityFeeGwei,
    gasBufferPercent: env.GAS_BUFFER_PERCENT
      ? Number(env.GAS_BUFFER_PERCENT)
      : file.gasBufferPercent,
    pnlPath: envOrFile(env.PNL_PATH, file.pnlPath),
    positionPath: envOrFile(env.POSITION_PATH, file.positionPath),
    logLevel: envOrFile(env.LOG_LEVEL, file.logLevel),
  };

  const config = BotConfigSchema.parse(raw);

  if (!config.dryRun && !config.privateKey) {
    throw new Error('EXECUTOR_PRIVATE_KEY is required when DRY_RUN=false');
  }
  if (!config.dryRun && !config.executorAddress) {
    throw new Error('EXECUTOR_ADDRESS is required when DRY_RUN=false');
  }

  return config;
}

/**
 * Backwards-compatible alias for `loadConfig` (env-only, no config file).
 * Kept so existing tests and entrypoints that call `loadConfigFromEnv(env)`
 * continue to work; new code should call `loadConfig` to also pick up a
 * `CONFIG_PATH` JSON file.
 */
export const loadConfigFromEnv = loadConfig;
