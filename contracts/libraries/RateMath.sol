// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RateMath
 * @notice Fixed-point helpers for lending rate math (ray = 27 decimals)
 */
library RateMath {
    uint256 internal constant RAY = 1e27;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    /**
     * @notice Convert wad (18 decimals) to ray (27 decimals)
     */
    function wadToRay(uint256 wad) internal pure returns (uint256) {
        return wad * 1e9;
    }

    /**
     * @notice Convert ray (27 decimals) to wad (18 decimals)
     */
    function rayToWad(uint256 ray) internal pure returns (uint256) {
        return ray / 1e9;
    }

    /**
     * @notice Continuous-compounding factor e^(rate * duration), in ray
     * @param ratePerSecond Interest rate per second, in ray. MUST be a
     *        realistic per-second value (for Aave, annual ray rate divided
     *        by SECONDS_PER_YEAR). Inputs where x = rate*duration/RAY is
     *        large (>~5) overflow — the fuzz suite pins the safe domain.
     * @param duration Seconds to compound over
     * @dev Taylor expansion of e^x around 0 with x = rate * duration / RAY.
     *      10 iterations give ~1e-4 relative accuracy for x <= ~1.6 (APR up to ~500%).
     */
    function compound(
        uint256 ratePerSecond,
        uint256 duration
    ) internal pure returns (uint256) {
        if (duration == 0) return RAY;

        uint256 result = RAY;
        uint256 term = RAY;

        for (uint256 i = 1; i <= 10; i++) {
            term = (term * ratePerSecond * duration) / (i * RAY);
            result += term;
        }

        return result;
    }

    /**
     * @notice APY (ray) from a per-second rate (ray).
     *         Returns the yield over one year, i.e. e^(rate*t) - 1.
     */
    function ratePerSecondToApy(uint256 ratePerSecond) internal pure returns (uint256) {
        return compound(ratePerSecond, SECONDS_PER_YEAR) - RAY;
    }

    /**
     * @notice Percentage of a value, in basis points (10000 = 100%)
     */
    function bpsOf(uint256 value, uint256 bps) internal pure returns (uint256) {
        return (value * bps) / 10000;
    }

    /**
     * @notice Reduce an amount by a slippage tolerance in basis points
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
 * @notice General math utilities
 */
library MathUtils {
    /**
     * @notice Return the minimum of two values
     * @param a First value
     * @param b Second value
     * @return The smaller of the two values
     */
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /**
     * @notice Return the maximum of two values
     * @param a First value
     * @param b Second value
     * @return The larger of the two values
     */
    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    /**
     * @notice Clamp a value between a minimum and maximum
     * @param value The value to clamp
     * @param minValue The minimum allowed value
     * @param maxValue The maximum allowed value
     * @return The clamped value
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
     * @notice Calculate the average of two values
     * @param a First value
     * @param b Second value
     * @return The average of the two values (overflow-safe)
     */
    function average(uint256 a, uint256 b) internal pure returns (uint256) {
        // Overflow-safe average
        return (a & b) + ((a ^ b) >> 1);
    }

    /**
     * @notice Square root (Babylonian method)
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
