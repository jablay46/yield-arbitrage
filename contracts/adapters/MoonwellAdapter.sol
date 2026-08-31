// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MoonwellAdapter
 * @notice Adapter for Moonwell flashloan operations
 * @dev Moonwell uses similar interface to Aave V3
 */
contract MoonwellAdapter {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();

    address public immutable pool;

    event FlashloanRequested(
        address indexed asset,
        uint256 amount,
        uint256 fee
    );

    constructor(address _pool) {
        if (_pool == address(0)) revert ZeroAddress();
        pool = _pool;
    }

    /**
     * @notice Execute a flashloan from Moonwell
     * @param receiver Receiver contract for flashloan
     * @param assets Assets to flashloan
     * @param amounts Amounts to flashloan
     * @param modes Mode for each asset (0 = repay, 1 = stable borrow, 2 = variable borrow)
     * @param params Additional params
     */
    function flashLoan(
        address receiver,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata modes,
        bytes calldata params
    ) external {
        if (assets.length == 0 || amounts.length == 0) revert ZeroAmount();

        // Moonwell uses Aave V3 compatible interface
        // bytes4(keccak256("flashLoan(address,address[],uint256[],uint256[],address,bytes,uint16)"))
        (bool success, ) = pool.call(
            abi.encodeWithSignature(
                "flashLoan(address,address[],uint256[],uint256[],address,bytes,uint16)",
                receiver,
                assets,
                amounts,
                modes,
                address(this), // onBehalfOf
                params,
                0 // referralCode
            )
        );

        require(success, "Flashloan failed");

        emit FlashloanRequested(assets[0], amounts[0], 0);
    }

    /**
     * @notice Supply assets to Moonwell
     * @param asset Asset to supply
     * @param amount Amount to supply
     */
    function supply(address asset, uint256 amount) external {
        IERC20(asset).forceApprove(pool, amount);
        
        (bool success, ) = pool.call(
            abi.encodeWithSignature(
                "supply(address,uint256,address,uint16)",
                asset,
                amount,
                address(this),
                0
            )
        );
        
        require(success, "Supply failed");
    }

    /**
     * @notice Borrow assets from Moonwell
     * @param asset Asset to borrow
     * @param amount Amount to borrow
     * @param interestRateMode Interest rate mode (1 = stable, 2 = variable)
     */
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode
    ) external {
        (bool success, ) = pool.call(
            abi.encodeWithSignature(
                "borrow(address,uint256,uint256,address,uint16)",
                asset,
                amount,
                interestRateMode,
                address(this),
                0
            )
        );
        
        require(success, "Borrow failed");
    }

    /**
     * @notice Repay borrowed assets
     * @param asset Asset to repay
     * @param amount Amount to repay
     * @param rateMode Interest rate mode
     */
    function repay(
        address asset,
        uint256 amount,
        uint256 rateMode
    ) external {
        IERC20(asset).forceApprove(pool, amount);
        
        (bool success, ) = pool.call(
            abi.encodeWithSignature(
                "repay(address,uint256,uint256,address)",
                asset,
                amount,
                rateMode,
                address(this)
            )
        );
        
        require(success, "Repay failed");
    }

    /**
     * @notice Withdraw supplied assets
     * @param asset Asset to withdraw
     * @param amount Amount to withdraw
     */
    function withdraw(address asset, uint256 amount) external {
        (bool success, ) = pool.call(
            abi.encodeWithSignature(
                "withdraw(address,uint256,address)",
                asset,
                amount,
                address(this)
            )
        );
        
        require(success, "Withdraw failed");
    }

    /**
     * @notice Get Moonwell pool address
     */
    function getPoolAddress() external view returns (address) {
        return pool;
    }

    receive() external payable {}
}
