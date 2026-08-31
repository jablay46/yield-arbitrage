// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IMorpho
 * @notice Interface for Morpho Blue / Standard
 */
interface IMorpho {
    /**
     * @notice Executes a flashloan
     * @param token The token to flashloan
     * @param amount The amount to flashloan
     * @param data Additional data for the operation
     */
    function flashLoan(
        address token,
        uint256 amount,
        bytes calldata data
    ) external;

    /**
     * @notice Supplys liquidity to a market
     * @param market The market address
     * @param amount The amount to supply
     */
    function supply(
        address market,
        uint256 amount
    ) external;

    /**
     * @notice Borrows from a market
     * @param market The market address
     * @param amount The amount to borrow
     */
    function borrow(
        address market,
        uint256 amount
    ) external;

    /**
     * @notice Repays a borrow
     * @param market The market address
     * @param amount The amount to repay
     */
    function repay(
        address market,
        uint256 amount
    ) external;

    /**
     * @notice Withdraws from a market
     * @param market The market address
     * @param amount The amount to withdraw
     */
    function withdraw(
        address market,
        uint256 amount,
        address receiver
    ) external returns (uint256);
}

/**
 * @title IMorphoCallback
 * @notice Interface for Morpho flashloan callback
 */
interface IMorphoCallback {
    function onMorphoFlashLoan(
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external;
}
