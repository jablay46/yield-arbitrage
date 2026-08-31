import { z } from 'zod';

// Network Configuration
export const NetworkSchema = z.object({
  chainId: z.number(),
  name: z.string(),
  rpcUrl: z.string(),
  explorer: z.string(),
});

export type Network = z.infer<typeof NetworkSchema>;

// Protocol Addresses on Base Mainnet
export const PROTOCOL_ADDRESSES = {
  base: {
    // Aave V3 Pool (Spark)
    aavePool: '0x4fAeC549f4327De1cF0a0D4f4D5d8d9fA0B1C2D3',
    aavePoolDataProvider: '0x2d8A3C5674E4a59E2e7B2F3D4e5F6a7B8c9D0E1F',
    
    // Morpho
    morpho: '0xBBBBbBBBBbbbbBBBBBBBBbbbbbbbbBBBBBBBBBB',
    morphoOracle: '0xCCCCcCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    
    // Moonwell
    moonwellPool: '0xDDDDdDDDDddddDDDDDDDDddddDDDDDDDDDDDD',
    moonwell Artemis: '0xEEEEeEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
    
    // Uniswap V3 Router
    uniswapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    
    // Native tokens
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71B54bdA02913',
    DAI: '0x4fEb4c42B6C8e3bE9C1E1b2D3E4F5A6B7C8D9E0',
    USDT: '0xfde4C96c8591873D46a4af72f87e6aE4D6D3C7A3',
  },
  baseSepolia: {
    aavePool: '0x',
    morpho: '0x',
    moonwellPool: '0x',
    uniswapRouter: '0x',
    WETH: '0x',
    USDC: '0x',
    DAI: '0x',
    USDT: '0x',
  },
} as const;

// Bot Configuration Schema
export const BotConfigSchema = z.object({
  // Network
  network: z.enum(['base', 'baseSepolia']),
  rpcUrl: z.string().url(),
  
  // Private key for execution (hex string without 0x prefix)
  privateKey: z.string().regex(/^[a-fA-F0-9]{64}$/),
  
  // Flashloan settings
  flashloanFeeBps: z.number().min(0).max(1000).default(9), // 0.09%
  maxFlashloanAmount: z.bigint().default(1_000_000n * 1_000_000n), // 1M USD
  
  // Risk parameters
  minProfitUsd: z.number().default(10),
  maxSlippageBps: z.number().default(300), // 3%
  maxGasPriceGwei: z.number().default(50),
  gasBufferPercent: z.number().default(20),
  
  // Monitoring
  pollIntervalMs: z.number().default(5000), // 5 seconds
  opportunityThresholdBps: z.number().default(50), // 0.5%
  
  // Database
  dbPath: z.string().default('./data/arbitrage.db'),
  
  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;

// Rate Monitor Configuration
export const RateMonitorConfigSchema = z.object({
  // Data sources to use
  dataSources: z.enum(['rpc', 'subgraph', 'defillama', 'all']).default('all'),
  
  // DefiLlama API
  defillamaApiUrl: z.string().default('https://api.llama.fi'),
  
  // Subgraph URLs (to be verified)
  subgraphUrls: z.object({
    aave: z.string().optional(),
    morpho: z.string().optional(),
    moonwell: z.string().optional(),
  }).default({}),
  
  // Cache settings
  cacheDurationMs: z.number().default(30000), // 30 seconds
  
  // Rate calculation
  includeIncentives: z.boolean().default(true),
});

export type RateMonitorConfig = z.infer<typeof RateMonitorConfigSchema>;

// Export defaults
export const DEFAULT_CONFIG: Partial<BotConfig> = {
  network: 'base',
  flashloanFeeBps: 9,
  maxFlashloanAmount: 1_000_000n * 1_000_000n,
  minProfitUsd: 10,
  maxSlippageBps: 300,
  maxGasPriceGwei: 50,
  gasBufferPercent: 20,
  pollIntervalMs: 5000,
  opportunityThresholdBps: 50,
  dbPath: './data/arbitrage.db',
  logLevel: 'info',
};
