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
  priceCacheTtlMs: z.number().default(30_000),

  // Gas
  maxGasPriceGwei: z.number().default(50),
  priorityFeeGwei: z.number().default(0.1),
  gasBufferPercent: z.number().default(20),

  // Storage / logging
  pnlPath: z.string().default('./data/pnl.json'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;

function boolFromEnv(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const s = v.toLowerCase();
  if (['1', 'true', 'yes'].includes(s)) return true;
  if (['0', 'false', 'no'].includes(s)) return false;
  throw new Error(`invalid boolean env value: "${v}" (expected true/false)`);
}

/**
 * Load config from environment variables. Throws with a readable message
 * on invalid configuration.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const raw = {
    rpcUrl: env.RPC_URL ?? env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    wsUrl: env.BASE_WS_URL,
    privateKey: env.EXECUTOR_PRIVATE_KEY || undefined,
    executorAddress: env.EXECUTOR_ADDRESS || undefined,
    marginAsset: env.MARGIN_ASSET,
    marginAmount: env.MARGIN_AMOUNT ? BigInt(env.MARGIN_AMOUNT) : undefined,
    leverage: env.LEVERAGE ? Number(env.LEVERAGE) : undefined,
    dryRun: boolFromEnv(env.DRY_RUN, true),
    autoTrade: boolFromEnv(env.AUTO_TRADE, false),
    minNetApyBps: env.MIN_NET_APY_BPS ? Number(env.MIN_NET_APY_BPS) : undefined,
    minHealthFactorWad: env.MIN_HEALTH_FACTOR_WAD
      ? BigInt(env.MIN_HEALTH_FACTOR_WAD)
      : undefined,
    healthFactorWarnWad: env.HEALTH_FACTOR_WARN_WAD
      ? BigInt(env.HEALTH_FACTOR_WARN_WAD)
      : undefined,
    healthFactorCriticalWad: env.HEALTH_FACTOR_CRITICAL_WAD
      ? BigInt(env.HEALTH_FACTOR_CRITICAL_WAD)
      : undefined,
    pollIntervalMs: env.POLL_INTERVAL_MS ? Number(env.POLL_INTERVAL_MS) : undefined,
    healthCheckIntervalMs: env.HEALTH_CHECK_INTERVAL_MS
      ? Number(env.HEALTH_CHECK_INTERVAL_MS)
      : undefined,
    cooldownMs: env.COOLDOWN_MS ? Number(env.COOLDOWN_MS) : undefined,
    usePendingBlock: env.USE_PENDING_BLOCK
      ? boolFromEnv(env.USE_PENDING_BLOCK, true)
      : undefined,
    maxMarginUsd: env.MAX_MARGIN_USD ? Number(env.MAX_MARGIN_USD) : undefined,
    priceCacheTtlMs: env.PRICE_CACHE_TTL_MS
      ? Number(env.PRICE_CACHE_TTL_MS)
      : undefined,
    maxGasPriceGwei: env.MAX_GAS_PRICE_GWEI
      ? Number(env.MAX_GAS_PRICE_GWEI)
      : undefined,
    priorityFeeGwei: env.PRIORITY_FEE_GWEI
      ? Number(env.PRIORITY_FEE_GWEI)
      : undefined,
    gasBufferPercent: env.GAS_BUFFER_PERCENT
      ? Number(env.GAS_BUFFER_PERCENT)
      : undefined,
    pnlPath: env.PNL_PATH,
    logLevel: env.LOG_LEVEL,
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
