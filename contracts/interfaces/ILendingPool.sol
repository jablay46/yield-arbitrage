// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @notice Aave V3 ReserveData as returned by Pool.getReserveData.
 * @dev Field order must match the on-chain ABI exactly for decoding to work.
 */
struct ReserveData {
    uint256 configuration;
    uint128 liquidityIndex;
    uint128 currentLiquidityRate;
    uint128 variableBorrowIndex;
    uint128 currentVariableBorrowRate;
    uint128 currentStableBorrowRate;
    uint40 lastUpdateTimestamp;
    uint16 id;
    address aTokenAddress;
    address stableDebtTokenAddress;
    address variableDebtTokenAddress;
    address interestRateStrategyAddress;
    uint128 accruedToTreasury;
    uint128 unbacked;
    uint128 isolationModeTotalDebt;
}

/**
 * @title ILendingPool
 * @notice Aave V3 Pool interface used by the looping executor.
 */
interface ILendingPool {
    /**
     * @notice Supply assets to the lending pool
     * @param asset The address of the underlying asset to supply
     * @param amount The amount to be supplied
     * @param onBehalfOf The address that will receive the aTokens
     * @param referralCode Code used to register the integrator originating the operation
     */
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    /**
     * @notice Withdraw assets from the lending pool
     * @param asset The address of the underlying asset to withdraw
     * @param amount The amount to withdraw (type(uint256).max for full balance)
     * @param to The address that will receive the withdrawn assets
     * @return The amount actually withdrawn
     */
    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external returns (uint256);

    /**
     * @notice Borrow assets from the lending pool
     * @param asset The address of the underlying asset to borrow
     * @param amount The amount to be borrowed
     * @param interestRateMode 1 = stable, 2 = variable
     * @param referralCode Code used to register the integrator originating the operation
     * @param onBehalfOf The address that will receive the debt
     * @dev Parameter order matches Aave V3: referralCode comes BEFORE onBehalfOf.
     */
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external;

    /**
     * @notice Repay borrowed assets to the lending pool
     * @param asset The address of the borrowed asset
     * @param amount The amount to repay (type(uint256).max for full debt)
     * @param interestRateMode The interest rate mode (1 = stable, 2 = variable)
     * @param onBehalfOf The address for which debt will be repaid
     * @return The amount actually repaid
     */
    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256);

    /**
     * @notice Enable or disable an asset as collateral
     * @param asset The address of the underlying asset
     * @param useAsCollateral True to use as collateral, false otherwise
     */
    function setUserUseReserveAsCollateral(address asset, bool useAsCollateral) external;

    /**
     * @notice Set the user's efficiency mode (e-mode) category
     * @param categoryId The category ID to set (0 to disable e-mode)
     */
    function setUserEMode(uint8 categoryId) external;

    /**
     * @notice Get reserve data for an asset
     * @param asset The address of the underlying asset
     * @return The reserve data including aToken, debt token addresses, and rates
     */
    function getReserveData(address asset) external view returns (ReserveData memory);

    /**
     * @notice Get user account data across all reserves
     * @param user The address of the user
     * @return totalCollateralBase Total collateral in base currency
     * @return totalDebtBase Total debt in base currency
     * @return availableBorrowsBase Available borrowing power in base currency
     * @return currentLiquidationThreshold Weighted average liquidation threshold
     * @return ltv Weighted average loan-to-value
     * @return healthFactor The health factor of the user
     */
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

/**
 * @title IAavePoolAddressesProvider
 * @notice Interface for the Aave Pool Addresses Provider
 */
interface IAavePoolAddressesProvider {
    /**
     * @notice Get the address of the Aave Pool contract
     * @return The address of the Pool
     */
    function getPool() external view returns (address);

    /**
     * @notice Get the address of the Pool Data Provider contract
     * @return The address of the PoolDataProvider
     */
    function getPoolDataProvider() external view returns (address);
}
