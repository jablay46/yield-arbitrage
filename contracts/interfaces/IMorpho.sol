// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IMorpho
 * @notice Minimal interface for the Morpho Blue singleton.
 *         Morpho Blue flashloans charge no fee. The borrower must transfer the
 *         exact amount back inside the callback; Morpho checks its balance delta.
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
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}
