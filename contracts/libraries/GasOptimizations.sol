// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GasOptimizations
 * @notice Gas optimization utilities
 */
library GasOptimizations {
    /**
     * @notice Convert wad to ray (18 decimals to 27 decimals)
     */
    function wadToRay(uint256 wad) internal pure returns (uint256) {
        return wad * 1e9;
    }

    /**
     * @notice Convert ray to wad (27 decimals to 18 decimals)
     */
    function rayToWad(uint256 ray) internal pure returns (uint256) {
        return ray / 1e9;
    }

    /**
     * @notice Calculate compound interest (ray based)
     * @param rate The rate in ray (27 decimal fixed point)
     * @param seconds The number of seconds to compound
     */
    function compound(
        uint256 rate,
        uint256 seconds
    ) internal pure returns (uint256) {
        if (seconds == 0) return 1e27;
        
        // Using approximation: (1 + r)^t ≈ e^(t*ln(1+r))
        // For small rates, this is accurate enough
        uint256 t = seconds;
        uint256 r = rate;
        
        // Simple power series approximation
        uint256 result = 1e27;
        uint256 term = 1e27;
        
        // 10 iterations for accuracy
        for (uint256 i = 1; i <= 10; i++) {
            term = (term * r * seconds) / (i * 1e27);
            result += term;
        }
        
        return result;
    }

    /**
     * @notice Calculate APY from APR
     * @param apr The APR in ray
     * @param blocksPerYear Number of blocks per year
     */
    function aprToApy(
        uint256 apr,
        uint256 blocksPerYear
    ) internal pure returns (uint256) {
        return compound(apr, blocksPerYear);
    }

    /**
     * @notice Calculate annual rate from rate per second
     * @param ratePerSecond Rate per second in ray
     */
    function calculateApy(uint256 ratePerSecond) internal pure returns (uint256) {
        // 365 days * 24 hours * 60 minutes * 12 seconds (Base block time ~12s)
        uint256 secondsPerYear = 365 days;
        return compound(ratePerSecond, secondsPerYear);
    }

    /**
     * @notice Safe division with precision
     */
    function divPrecise(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * 1e18) / b;
    }

    /**
     * @notice Calculate percentage of value
     * @param value The base value
     * @param percentage The percentage (in basis points, 10000 = 100%)
     */
    function percentageOf(
        uint256 value,
        uint256 percentage
    ) internal pure returns (uint256) {
        return (value * percentage) / 10000;
    }

    /**
     * @notice Apply slippage to amount
     * @param amount The expected amount
     * @param slippageBps Slippage in basis points (e.g., 300 = 0.3%)
     */
    function applySlippage(
        uint256 amount,
        uint256 slippageBps
    ) internal pure returns (uint256) {
        return (amount * (10000 - slippageBps)) / 10000;
    }
}

/**
 * @title MathUtils
 * @notice Additional math utilities
 */
library MathUtils {
    /**
     * @notice Minimum of two values
     */
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /**
     * @notice Maximum of two values
     */
    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    /**
     * @notice Clamp value between min and max
     */
    function clamp(
        uint256 value,
        uint256 minValue,
        uint256 maxValue
    ) internal pure returns (uint256) {
        if (value < minValue) return minValue;
        if (value > maxValue) return maxValue;
        return value;
    }

    /**
     * @notice Calculate average of two values
     */
    function average(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b) / 2;
    }

    /**
     * @notice Square root calculation (Babylonian method)
     */
    function sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        
        z = x;
        uint256 y = (x + 1) / 2;
        
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
    }
}
