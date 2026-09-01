import { parseAbi } from 'viem';

/** Aave V3 Pool — only what the bot reads/calls. */
export const aavePoolAbi = parseAbi([
  'function getReservesList() view returns (address[])',
  'function getEModeCategoryData(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus, address priceSource, string label))',
  'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getUserEMode(address user) view returns (uint256)',
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
]);

/** Aave V3 ProtocolDataProvider — reserve configuration lives here, not on the Pool. */
export const dataProviderAbi = parseAbi([
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
]);

/** Aave V3 PriceOracle — asset prices in USD with 8 decimals. */
export const aaveOracleAbi = parseAbi([
  'function getAssetPrice(address asset) view returns (uint256)',
  'function getAssetsPrices(address[] assets) view returns (uint256[])',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
]);

/** LoopingExecutor — see contracts/LoopingExecutor.sol */
export const loopingExecutorAbi = parseAbi([
  'function openLoop((address collateralAsset, address borrowAsset, uint256 marginAmount, uint8 leverage, uint256 minHealthFactor, bytes swapData, uint256 minSwapOut))',
  'function closeLoop((address collateralAsset, address borrowAsset, bytes swapData, uint256 minSwapOut))',
  'function currentDebt(address asset) view returns (uint256)',
  'function currentHealthFactor() view returns (uint256)',
  'function openPosition() view returns (address collateralAsset, address borrowAsset, uint8 leverage)',
  'function positionOpen() view returns (bool)',
  'function paused() view returns (bool)',
  'function owner() view returns (address)',
  'function setEMode(uint8 categoryId)',
  'function emergencyWithdraw(address token, uint256 amount)',
  'function keeperDeleverage((address collateralAsset, address borrowAsset, bytes swapData, uint256 minSwapOut))',
  'function setCriticalHealthFactor(uint256 criticalHealthFactor)',
  'function criticalHealthFactor() view returns (uint256)',
  'function pause()',
  'function unpause()',
]);
