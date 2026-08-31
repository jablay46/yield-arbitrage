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
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external returns (uint256);

    /**
     * @param interestRateMode 1 = stable, 2 = variable
     * @dev Parameter order matches Aave V3: referralCode comes BEFORE onBehalfOf.
     */
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external;

    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256);

    function setUserUseReserveAsCollateral(address asset, bool useAsCollateral) external;

    function setUserEMode(uint8 categoryId) external;

    function getReserveData(address asset) external view returns (ReserveData memory);

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
    function getPool() external view returns (address);
    function getPoolDataProvider() external view returns (address);
}
