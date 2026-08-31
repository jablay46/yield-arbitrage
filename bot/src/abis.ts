import { parseAbi } from 'viem';

/** Aave V3 Pool — only what the bot reads/calls. */
export const aavePoolAbi = parseAbi([
  'function getReservesList() view returns (address[])',
  'function getEModeCategoryData(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus, address priceSource, string label))',
  'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
]);

/** Aave V3 ProtocolDataProvider — reserve configuration lives here, not on the Pool. */
export const dataProviderAbi = parseAbi([
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

/** LoopingExecutor — see contracts/LoopingExecutor.sol */
export const loopingExecutorAbi = parseAbi([
  'function openLoop((address collateralAsset, address borrowAsset, uint256 marginAmount, uint8 leverage, uint256 minHealthFactor, bytes swapData, uint256 minSwapOut))',
  'function closeLoop((address collateralAsset, address borrowAsset, bytes swapData, uint256 minSwapOut))',
  'function currentDebt(address asset) view returns (uint256)',
  'function currentHealthFactor() view returns (uint256)',
  'function positionOpen() view returns (bool)',
  'function paused() view returns (bool)',
  'function owner() view returns (address)',
  'function setEMode(uint8 categoryId)',
  'function emergencyWithdraw(address token, uint256 amount)',
]);
