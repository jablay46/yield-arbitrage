/**
 * Verified Base mainnet addresses.
 * Aave pool/data-provider were resolved on-chain via the canonical
 * PoolAddressesProvider (0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D).
 */
export const ADDRESSES = {
  // Aave V3 (Base) — resolved on-chain, do not guess
  aavePoolAddressesProvider: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D',
  aavePool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  aaveProtocolDataProvider: '0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A',

  // Morpho Blue singleton (0% flashloan fee)
  morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',

  // Aave V3 PriceOracle (USD, 8 decimals) — resolved via PoolAddressesProvider.getPriceOracle()
  aaveOracle: '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156',

  // Uniswap V3 SwapRouter02 (Base)
  swapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481',
} as const;

/** Tokens present in the Aave V3 Base reserves list (verified via getReservesList). */
export const TOKENS = {
  WETH: '0x4200000000000000000000000000000000000006',
  cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  wstETH: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
  weETH: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71B54bdA02913',
  USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
  cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  EURC: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
} as const;

export const TOKEN_DECIMALS: Record<string, number> = {
  WETH: 18,
  cbETH: 18,
  wstETH: 18,
  weETH: 18,
  USDC: 6,
  USDbC: 6,
  cbBTC: 8,
  EURC: 6,
};

/** Allowed leverage multipliers — enforced on-chain by LoopingExecutor. */
export const LEVERAGE_LEVELS = [2, 3, 5] as const;

/** Verified on-chain: Aave V3 Base FLASHLOAN_PREMIUM_TOTAL (was 9 bps at launch). */
export const AAVE_FLASHLOAN_PREMIUM_BPS = 5;
/** Morpho Blue flashloans are free. */
export const MORPHO_FLASHLOAN_PREMIUM_BPS = 0;

/** Aave e-mode categories on Base (verified via getEModeCategoryData). */
export const EMODE = {
  NONE: 0,
  ETH_CORRELATED: 1, // LT 90%
} as const;

export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
export const RAY = 10n ** 27n;
export const WAD = 10n ** 18n;
export const BPS_DENOMINATOR = 10000;

/** Rough gas estimates used for cost projection before simulation. */
export const GAS_ESTIMATES = {
  openLoopSameAsset: 650_000,
  openLoopCrossAsset: 900_000,
  closeLoopSameAsset: 700_000,
  closeLoopCrossAsset: 950_000,
} as const;
