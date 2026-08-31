// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAaveOracle
 * @notice Thin interface over the Aave V3 PriceOracle used by the Pool.
 *         Prices are returned with 8 decimals (USD).
 */
interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}
