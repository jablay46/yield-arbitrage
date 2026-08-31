// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IMorpho, IMorphoCallback} from "../interfaces/IMorpho.sol";

/**
 * @title MorphoAdapter
 * @notice Adapter for Morpho flashloan operations
 */
contract MorphoAdapter {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();
    error OnlyMorpho();

    address public immutable morpho;

    event FlashloanRequested(
        address indexed asset,
        uint256 amount,
        uint256 fee
    );

    constructor(address _morpho) {
        if (_morpho == address(0)) revert ZeroAddress();
        morpho = _morpho;
    }

    /**
     * @notice Execute a flashloan from Morpho
     * @param asset Asset to flashloan
     * @param amount Amount to flashloan
     * @param params Additional params (can include callback data)
     */
    function flashLoan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external {
        if (amount == 0) revert ZeroAmount();

        IMorpho(morpho).flashLoan(asset, amount, params);

        emit FlashloanRequested(asset, amount, 0);
    }

    /**
     * @notice Supply liquidity to Morpho market
     * @param market Market address
     * @param asset Asset to supply
     * @param amount Amount to supply
     */
    function supply(
        address market,
        address asset,
        uint256 amount
    ) external {
        IERC20(asset).forceApprove(morpho, amount);
        IMorpho(morpho).supply(market, amount);
    }

    /**
     * @notice Borrow from Morpho market
     * @param market Market address
     * @param asset Asset to borrow
     * @param amount Amount to borrow
     */
    function borrow(
        address market,
        address asset,
        uint256 amount
    ) external {
        IMorpho(morpho).borrow(market, amount);
    }

    /**
     * @notice Repay debt on Morpho market
     * @param market Market address
     * @param asset Asset to repay
     * @param amount Amount to repay
     */
    function repay(
        address market,
        address asset,
        uint256 amount
    ) external {
        IERC20(asset).forceApprove(morpho, amount);
        IMorpho(morpho).repay(market, amount);
    }

    /**
     * @notice Withdraw from Morpho market
     * @param market Market address
     * @param asset Asset to withdraw
     * @param amount Amount to withdraw
     * @param receiver Receiver of withdrawn tokens
     */
    function withdraw(
        address market,
        address asset,
        uint256 amount,
        address receiver
    ) external {
        IMorpho(morpho).withdraw(market, amount, receiver);
    }

    /**
     * @notice Get Morpho address
     */
    function getMorphoAddress() external view returns (address) {
        return morpho;
    }

    receive() external payable {}
}
