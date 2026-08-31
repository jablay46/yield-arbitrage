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
  pollIntervalMs: z.number().default(15_000),
  healthCheckIntervalMs: z.number().default(30_000),
  cooldownMs: z.number().default(60_000),

  /** Base Flashblocks: simulate/read against the ~200ms preconfirmed block */
  usePendingBlock: z.boolean().default(true),

  // Limits
  maxMarginUsd: z.number().default(50_000),

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
  return ['1', 'true', 'yes'].includes(v.toLowerCase());
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
    pollIntervalMs: env.POLL_INTERVAL_MS ? Number(env.POLL_INTERVAL_MS) : undefined,
    usePendingBlock: env.USE_PENDING_BLOCK
      ? boolFromEnv(env.USE_PENDING_BLOCK, true)
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
