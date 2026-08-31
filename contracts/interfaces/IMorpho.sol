// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IMorpho
 * @notice Minimal interface for the Morpho Blue singleton.
 *         Morpho Blue flashloans charge no fee. Repayment is pulled by Morpho
 *         via transferFrom after the onMorphoFlashLoan callback returns, so the
 *         borrower must approve the Morpho contract for the full flashloaned
 *         amount before the callback ends.
 */
interface IMorpho {
    /**
     * @notice Executes a flashloan
     * @param token The token to flashloan
     * @param assets The amount to flashloan
     * @param data Arbitrary data forwarded to the callback
     */
    function flashLoan(
        address token,
        uint256 assets,
        bytes calldata data
    ) external;
}

/**
 * @title IMorphoFlashLoanCallback
 * @notice Callback invoked by Morpho Blue on the flashloan initiator.
 */
interface IMorphoFlashLoanCallback {
    /**
     * @notice Callback invoked by Morpho Blue during a flashloan
     * @param assets The amount of assets flashloaned
     * @param data Arbitrary data forwarded from the flashLoan call
     */
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}
