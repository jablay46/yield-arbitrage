// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {RateMath, MathUtils} from "../contracts/libraries/RateMath.sol";

/**
 * Property (fuzz) tests for the math libraries — no fork needed, pure math.
 */
contract RateMathFuzzTest is Test {
    uint256 constant RAY = 1e27;

    // Safe domain: rate = per-second ray value for <=~500% annual APR,
    // duration <= 1 year -> x = rate*duration/RAY <= ~5 (Taylor converges).
    function testFuzz_compound_monotonic(uint256 ratePerSecond, uint256 duration) public pure {
        ratePerSecond = bound(ratePerSecond, 0, 1.6e20);
        duration = bound(duration, 0, 365 days);

        uint256 factor = RateMath.compound(ratePerSecond, duration);
        assertGe(factor, RAY, "compound factor must be >= 1");
        if (ratePerSecond > 0 && duration > 0) {
            assertGt(factor, RAY, "positive rate+duration must grow");
        }
        if (duration == 0) {
            assertEq(factor, RAY, "zero duration == 1");
        }
    }

    function testFuzz_compound_greaterLonger(uint256 ratePerSecond, uint256 d1, uint256 d2) public pure {
        ratePerSecond = bound(ratePerSecond, 1, 1.6e20);
        uint256 a = bound(d1, 1, 365 days);
        uint256 b = bound(d2, 1, 365 days);
        uint256 long1 = a > b ? a : b;
        uint256 short1 = a > b ? b : a;
        if (long1 != short1) {
            uint256 fLong = RateMath.compound(ratePerSecond, long1);
            uint256 fShort = RateMath.compound(ratePerSecond, short1);
            assertGt(fLong, fShort, "longer duration must compound more");
        }
    }

    function testFuzz_bpsOf_proportion(uint256 value, uint256 bps) public pure {
        value = bound(value, 0, type(uint128).max);
        bps = bound(bps, 0, 10000);
        uint256 result = RateMath.bpsOf(value, bps);
        assertLe(result, value, "bps cut never exceeds input");
        if (bps == 10000) {
            assertEq(result, value);
        }
    }

    function testFuzz_applySlippage_reduces(uint256 amount, uint256 slippageBps) public pure {
        amount = bound(amount, 0, type(uint128).max);
        slippageBps = bound(slippageBps, 0, 10000);
        uint256 out = RateMath.applySlippage(amount, slippageBps);
        assertLe(out, amount, "slippage never increases");
    }

    function testFuzz_wadToRay_roundTrip(uint256 wad) public pure {
        wad = bound(wad, 0, 1e24 - 1e9);
        uint256 ray = RateMath.wadToRay(wad);
        uint256 back = RateMath.rayToWad(ray);
        assertEq(back, wad, "wad->ray->wad round trip");
    }

    function testFuzz_mathutils_minmax(uint256 a, uint256 b) public pure {
        uint256 lo = MathUtils.min(a, b);
        uint256 hi = MathUtils.max(a, b);
        assertLe(lo, a, "min <= a");
        assertLe(lo, b, "min <= b");
        assertGe(hi, a, "max >= a");
        assertGe(hi, b, "max >= b");
        assertTrue(lo == a || lo == b, "min must equal an input");
        assertTrue(hi == a || hi == b, "max must equal an input");
    }

    function testFuzz_mathutils_clamp(uint256 value, uint256 lo, uint256 hi) public pure {
        if (lo > hi) (lo, hi) = (hi, lo);
        uint256 c = MathUtils.clamp(value, lo, hi);
        if (value < lo) {
            assertEq(c, lo, "below range clamps to lo");
        } else if (value > hi) {
            assertEq(c, hi, "above range clamps to hi");
        } else {
            assertEq(c, value, "in-range value is unchanged");
        }
    }

    function testFuzz_sqrt_matchesKnown(uint256 x) public pure {
        x = bound(x, 0, type(uint128).max);
        uint256 s = MathUtils.sqrt(x);
        assertLe(s * s, x, "sqrt squared must not over-estimate");
        if (s < type(uint64).max) {
            uint256 next = s + 1;
            assertGt(next * next, x, "next squared must exceed");
        }
    }
}
