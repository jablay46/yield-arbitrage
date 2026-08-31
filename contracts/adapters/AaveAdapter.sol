// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAavePool} from "../interfaces/IAavePool.sol";

/**
 * @title AaveAdapter
 * @notice Adapter for Aave V3 flashloan operations
 */
contract AaveAdapter {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();

    address public immutable pool;
    address public immutable addressesProvider;

    event FlashloanRequested(
        address indexed asset,
        uint256 amount,
        uint256 fee
    );

    constructor(address _pool, address _addressesProvider) {
        if (_pool == address(0)) revert ZeroAddress();
        pool = _pool;
        addressesProvider = _addressesProvider;
    }

    /**
     * @notice Execute a flashloan from Aave V3
     * @param assets Assets to flashloan
     * @param amounts Amounts to flashloan
     * @param params Additional params
     */
    function flashLoan(
        address[] calldata assets,
        uint256[] calldata amounts,
        bytes calldata params
    ) external {
        if (assets.length == 0 || amounts.length == 0) revert ZeroAmount();

        uint256[] memory modes = new uint256[](assets.length);
        
        IAavePool(pool).flashLoan(
            msg.sender,
            assets,
            amounts,
            modes,
            msg.sender,
            params,
            0
        );

        emit FlashloanRequested(assets[0], amounts[0], 0);
    }

    /**
     * @notice Execute a simple flashloan for a single asset
     * @param asset Asset to flashloan
     * @param amount Amount to flashloan
     * @param params Additional params
     */
    function flashLoanSimple(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external {
        if (amount == 0) revert ZeroAmount();

        IAavePool(pool).flashLoanSimple(
            msg.sender,
            asset,
            amount,
            params,
            0
        );

        emit FlashloanRequested(asset, amount, 0);
    }

    /**
     * @notice Get the Aave pool address
     */
    function getPoolAddress() external view returns (address) {
        return pool;
    }

    receive() external payable {}
}
