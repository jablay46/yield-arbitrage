// Token addresses on Base
export const TOKENS = {
  // Native/Wrapped
  ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  WETH: '0x4200000000000000000000000000000000000006',
  
  // Stablecoins
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71B54bdA02913',
  DAI: '0x4fEb4c42B6C8e3bE9C1E1b2D3E4F5A6B7C8D9E0',
  USDT: '0xfde4C96c8591873D46a4af72f87e6aE4D6D3C7A3',
  USDbC: '0xd9aAEc86B65D86f6A7B5B1b0a6B1c2d3e4f5A6B',
  
  // Other assets
  cbBTC: '0xcbB7C0000aB88B3b5a3b2c0D1E2F3A4B5C6D7E8',
  WBTC: '0x68f5c6aA807200A08BF4B3c1D2D2c9e6f1A3B4C5',
} as const;

// Token decimals
export const TOKEN_DECIMALS: Record<string, number> = {
  ETH: 18,
  WETH: 18,
  USDC: 6,
  DAI: 18,
  USDT: 6,
  USDbC: 6,
  cbBTC: 8,
  WBTC: 8,
};

// Token symbols to addresses
export const TOKEN_BY_SYMBOL: Record<string, string> = {
  ETH: TOKENS.ETH,
  WETH: TOKENS.WETH,
  USDC: TOKENS.USDC,
  DAI: TOKENS.DAI,
  USDT: TOKENS.USDT,
  USDbC: TOKENS.USDbC,
};

// Protocol identifiers
export enum Protocol {
  AAVE = 'aave',
  MORPHO = 'morpho',
  MOONWELL = 'moonwell',
}

// Protocol configurations
export const PROTOCOLS = {
  [Protocol.AAVE]: {
    name: 'Aave V3 (Spark)',
    poolAddress: '0x4fAeC549f4327De1cF0a0D4f4D5d8d9fA0B1C2D3',
    flashloanFeeBps: 9, // 0.09%
    supportsFlashloan: true,
  },
  [Protocol.MORPHO]: {
    name: 'Morpho',
    poolAddress: '0xBBBBbBBBBbbbbBBBBBBBBbbbbbbbbBBBBBBBBBB',
    flashloanFeeBps: 0, // Varies by market
    supportsFlashloan: true,
  },
  [Protocol.MOONWELL]: {
    name: 'Moonwell',
    poolAddress: '0xDDDDdDDDDddddDDDDDDDDddddDDDDDDDDDDDD',
    flashloanFeeBps: 0, // Check current fee
    supportsFlashloan: true,
  },
} as const;

// Liquidity pair configurations for arbitrage
export const ARBITRAGE_PAIRS = [
  {
    name: 'USDC-DAI',
    supplyToken: TOKENS.USDC,
    borrowToken: TOKENS.DAI,
    protocols: [Protocol.AAVE, Protocol.MORPHO, Protocol.MOONWELL],
  },
  {
    name: 'USDC-USDT',
    supplyToken: TOKENS.USDC,
    borrowToken: TOKENS.USDT,
    protocols: [Protocol.AAVE, Protocol.MORPHO, Protocol.MOONWELL],
  },
  {
    name: 'DAI-USDC',
    supplyToken: TOKENS.DAI,
    borrowToken: TOKENS.USDC,
    protocols: [Protocol.AAVE, Protocol.MORPHO, Protocol.MOONWELL],
  },
] as const;

// Block times (approximate)
export const BLOCK_TIMES = {
  base: 2, // seconds
  baseSepolia: 2,
} as const;

// Gas estimates (approximate in gas units)
export const GAS_ESTIMATES = {
  flashloan: 350000,
  supply: 200000,
  borrow: 150000,
  repay: 150000,
  withdraw: 200000,
  swap: 250000,
  // Total arbitrage execution
  arbitrage: 500000,
} as const;

// Maximum values
export const MAX_VALUES = {
  maxUint256: 2n ** 256n - 1n,
  maxUint128: 2n ** 128n - 1n,
  maxUint64: 2n ** 64n - 1n,
} as const;

// Basis points conversion
export const BPS = {
  ONE: 10000n,
  DECIMAL: 10000,
} as const;
