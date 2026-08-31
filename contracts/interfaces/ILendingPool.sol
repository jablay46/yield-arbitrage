// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILendingPool
 * @notice Interface for generic lending pool
 */
interface ILendingPool {
    /**
     * @notice Supplys assets to the pool
     * @param asset The asset to supply
     * @param amount The amount to supply
     * @param onBehalfOf The address to receive the supplied tokens
     * @param referralCode Referral code
     */
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    /**
     * @notice Withdraws assets from the pool
     * @param asset The asset to withdraw
     * @param amount The amount to withdraw
     * @param receiver The address to receive the withdrawn tokens
     * @return The actual amount withdrawn
     */
    function withdraw(
        address asset,
        uint256 amount,
        address receiver
    ) external returns (uint256);

    /**
     * @notice Borrows assets from the pool
     * @param asset The asset to borrow
     * @param amount The amount to borrow
     * @param interestRateMode The interest rate mode (1 for stable, 2 for variable)
     * @param onBehalfOf The address to receive the borrowed tokens
     * @param referralCode Referral code
     */
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    /**
     * @notice Repays borrowed assets
     * @param asset The asset to repay
     * @param amount The amount to repay
     * @param rateMode The interest rate mode
     * @param onBehalfOf The address to repay for
     * @return The actual amount repaid
     */
    function repay(
        address asset,
        uint256 amount,
        uint256 rateMode,
        address onBehalfOf
    ) external returns (uint256);

    /**
     * @notice Gets reserve data
     * @param asset The asset address
     * @return data The reserve data
     */
    function getReserveData(address asset) external view returns (bytes32 data);
}

/**
 * @title ILendingPoolAddressesProvider
 * @notice Interface for lending pool addresses provider
 */
interface ILendingPoolAddressesProvider {
    function getLendingPool() external view returns (address);
}
