// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IFlashLoanReceiver
 * @notice Interface for flashloan receivers
 */
interface IFlashLoanReceiver {
    /**
     * @notice Executes the flashloan operation
     * @param assets The addresses of the flash-borrowed assets
     * @param amounts The amounts of the flash-borrowed assets
     * @param premiums The fees for the flash-borrowed assets
     * @param initiator The address that initiated the flashloan
     * @param params Additional parameters for the operation
     * @return success Whether the operation was successful
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}
