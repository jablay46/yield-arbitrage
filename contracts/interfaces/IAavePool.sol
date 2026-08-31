// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAavePool
 * @notice Interface for Aave V3 Pool
 */
interface IAavePool {
    /**
     * @notice Initiates a flashloan
     * @param assets The addresses of the assets to flashloan
     * @param amounts The amounts to flashloan
     * @param modes 0 for flashloan, 1 for borrow
     * @param onBehalfOf The address to receive the flashloan
     * @param params Additional parameters
     * @param referralCode Referral code
     */
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata modes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /**
     * @notice Simple flashloan without needing a receiver
     * @param asset The asset to flashloan
     * @param amount The amount to flashloan
     * @param params Additional parameters
     */
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/**
 * @title IAavePoolAddressesProvider
 * @notice Interface for Aave Pool Addresses Provider
 */
interface IAavePoolAddressesProvider {
    /**
     * @notice Get the address of the Aave Pool contract
     * @return The address of the Pool
     */
    function getPool() external view returns (address);
}
