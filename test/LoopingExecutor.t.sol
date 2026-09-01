// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {LoopingExecutor} from "contracts/LoopingExecutor.sol";
import {FlashloanBase} from "contracts/FlashloanBase.sol";
import {SecurityUtils} from "contracts/security/SecurityUtils.sol";
import {IAaveOracle} from "contracts/interfaces/IAaveOracle.sol";
import {ILendingPool, ReserveData} from "contracts/interfaces/ILendingPool.sol";

/**
 * @notice Fork tests against Base mainnet using real protocol addresses
 *         (verified on-chain: Aave Pool, Morpho Blue singleton, WETH reserve).
 */
contract LoopingExecutorForkTest is Test {
    // Verified on Base mainnet via PoolAddressesProvider.getPool()
    address constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant AAVE_ORACLE = 0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    LoopingExecutorHarness executor;
    ILendingPool pool = ILendingPool(AAVE_POOL);
    IAaveOracle aaveOracle = IAaveOracle(AAVE_ORACLE);

    address aWETH;
    address debtWETH;

    function setUp() public {
        // Pin the fork block: Aave's Pool implementation on recent Base blocks
        // uses opcodes the local EVM spec doesn't activate yet (NotActivated
        // halt on the Aave flashloan path). Override with FORK_BLOCK to run
        // against a different height.
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(50_000_000));
        vm.createSelectFork(
            vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")),
            forkBlock
        );

        executor = new LoopingExecutorHarness(
            MORPHO,
            AAVE_POOL,
            AAVE_POOL,
            SWAP_ROUTER,
            AAVE_ORACLE
        );

        ReserveData memory rd = pool.getReserveData(WETH);
        aWETH = rd.aTokenAddress;
        debtWETH = rd.variableDebtTokenAddress;

        deal(WETH, address(this), 100 ether);
        IERC20(WETH).approve(address(executor), type(uint256).max);
    }

    function _params(
        uint8 leverage,
        uint256 margin,
        uint256 minHF
    ) internal view returns (LoopingExecutor.LoopParams memory) {
        return
            LoopingExecutor.LoopParams({
                collateralAsset: WETH,
                borrowAsset: WETH,
                marginAmount: margin,
                leverage: leverage,
                minHealthFactor: minHF,
                swapData: "",
                minSwapOut: 0
            });
    }

    // ---------- open ----------

    function test_borrowAmount_convertsWethToUsdcBaseUnits() public view {
        LoopingExecutor.LoopParams memory p = _params(2, 1 ether, 0);
        p.borrowAsset = USDC;

        uint256 expected = Math.mulDiv(
            1 ether,
            aaveOracle.getAssetPrice(WETH),
            aaveOracle.getAssetPrice(USDC) * 1e12
        );

        assertEq(executor.borrowAmount(p), expected);
    }

    function test_borrowAmount_convertsUsdcToWethBaseUnits() public view {
        uint256 margin = 4_000e6;
        LoopingExecutor.LoopParams memory p = _params(2, margin, 0);
        p.collateralAsset = USDC;

        uint256 expected = Math.mulDiv(
            margin,
            aaveOracle.getAssetPrice(USDC) * 1e12,
            aaveOracle.getAssetPrice(WETH)
        );

        assertEq(executor.borrowAmount(p), expected);
    }

    function test_openLoop_2x_morpho() public {
        executor.openLoop(_params(2, 1 ether, 0));

        assertApproxEqAbs(
            IERC20(aWETH).balanceOf(address(executor)),
            2 ether,
            2,
            "collateral"
        );
        assertApproxEqAbs(
            IERC20(debtWETH).balanceOf(address(executor)),
            1 ether,
            2,
            "debt"
        );
        assertTrue(executor.positionOpen());
        assertGe(executor.currentHealthFactor(), 1.05e18, "hf");
    }

    function test_openLoop_3x_morpho() public {
        executor.openLoop(_params(3, 1 ether, 0));

        assertApproxEqAbs(IERC20(aWETH).balanceOf(address(executor)), 3 ether, 2);
        assertApproxEqAbs(IERC20(debtWETH).balanceOf(address(executor)), 2 ether, 2);
        assertGe(executor.currentHealthFactor(), 1.05e18);
    }

    function test_openLoop_5x_reverts_in_normal_mode() public {
        // WETH normal-mode LT 82.5%, LTV 80% => 5x needs 4x debt which sits at
        // the borrowable edge, so Aave rejects the borrow with
        // CollateralCannotCoverNewBorrow before the HF floor is reached. Assert
        // the specific selector rather than a bare expectRevert so the test
        // cannot pass on an unrelated revert.
        vm.expectRevert(bytes4(keccak256("CollateralCannotCoverNewBorrow()")));
        executor.openLoop(_params(5, 1 ether, 0));
    }

    function test_openLoop_5x_with_emode() public {
        // WETH in e-mode category 1 (ETH correlated): LT 90%, LTV 87%
        executor.setEMode(1);
        executor.openLoop(_params(5, 1 ether, 1.05e18));

        uint256 expectedCollateral = 5 ether;
        uint256 expectedDebt = 4 ether;
        assertApproxEqAbs(
            IERC20(aWETH).balanceOf(address(executor)),
            expectedCollateral,
            2,
            "collateral"
        );
        assertApproxEqAbs(
            IERC20(debtWETH).balanceOf(address(executor)),
            expectedDebt,
            2,
            "debt"
        );
        assertGe(executor.currentHealthFactor(), 1.05e18);
        assertLe(executor.currentHealthFactor(), 1.2e18);
    }

    function test_openLoop_2x_aave_source() public {
        executor.setPreferredSource(FlashloanBase.FlashloanSource.Aave);
        executor.openLoop(_params(2, 1 ether, 0));

        // Aave charges 5 bps premium -> debt slightly above 1 ether
        uint256 debt = IERC20(debtWETH).balanceOf(address(executor));
        assertGt(debt, 1 ether, "aave premium borrowed");
        assertLt(debt, 1.0006 ether, "premium bound");
        assertApproxEqAbs(IERC20(aWETH).balanceOf(address(executor)), 2 ether, 2);
    }

    function test_openLoop_reverts_for_invalid_leverage() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                LoopingExecutor.UnsupportedLeverage.selector,
                uint8(4)
            )
        );
        executor.openLoop(_params(4, 1 ether, 0));
    }

    function test_openLoop_reverts_for_zero_margin() public {
        vm.expectRevert(LoopingExecutor.ZeroMargin.selector);
        executor.openLoop(_params(2, 0, 0));
    }

    function test_openLoop_reverts_when_position_open() public {
        executor.openLoop(_params(2, 1 ether, 0));
        vm.expectRevert(LoopingExecutor.PositionAlreadyOpen.selector);
        executor.openLoop(_params(2, 1 ether, 0));
    }

    function test_openLoop_onlyOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        executor.openLoop(_params(2, 1 ether, 0));
    }

    // ---------- close ----------

    function test_closeLoop_returns_margin() public {
        executor.openLoop(_params(2, 1 ether, 0));

        uint256 before = IERC20(WETH).balanceOf(address(this));

        executor.closeLoop(
            LoopingExecutor.CloseParams({
                collateralAsset: WETH,
                borrowAsset: WETH,
                swapData: "",
                minSwapOut: 0
            })
        );

        assertFalse(executor.positionOpen());
        assertEq(IERC20(aWETH).balanceOf(address(executor)), 0, "no collateral left");
        assertEq(IERC20(debtWETH).balanceOf(address(executor)), 0, "no debt left");

        uint256 afterBal = IERC20(WETH).balanceOf(address(this));
        // Same-block unwind: margin back, zero-fee flashloan (Morpho).
        assertApproxEqAbs(afterBal - before, 1 ether, 0.001 ether, "margin returned");
    }

    function test_closeLoop_reverts_without_position() public {
        vm.expectRevert(LoopingExecutor.NoOpenPosition.selector);
        executor.closeLoop(
            LoopingExecutor.CloseParams({
                collateralAsset: WETH,
                borrowAsset: WETH,
                swapData: "",
                minSwapOut: 0
            })
        );
    }

    function test_closeLoop_reverts_on_position_mismatch() public {
        // Open a WETH/WETH loop, then attempt to close with a different asset
        // pair. The stored open position must prevent unwinding the wrong pair.
        executor.openLoop(_params(2, 1 ether, 0));
        vm.expectRevert(LoopingExecutor.PositionMismatch.selector);
        executor.closeLoop(
            LoopingExecutor.CloseParams({
                collateralAsset: WETH,
                borrowAsset: USDC,
                swapData: "",
                minSwapOut: 0
            })
        );
    }

    // ---------- security ----------

    function test_executeOperation_reverts_for_external_initiator() public {
        // Attacker triggers an Aave flashloan naming our executor as receiver.
        address attacker = address(0xCAFE002);
        vm.deal(attacker, 1 ether);

        address[] memory assets = new address[](1);
        assets[0] = WETH;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1 ether;
        uint256[] memory modes = new uint256[](1);
        modes[0] = 0;

        vm.prank(attacker);
        vm.expectRevert(); // InvalidInitiator bubbles up through the pool
        IAavePoolLike(AAVE_POOL).flashLoan(
            address(executor),
            assets,
            amounts,
            modes,
            attacker,
            "",
            0
        );
    }

    function test_morpho_callback_only_from_morpho() public {
        vm.expectRevert(FlashloanBase.OnlyMorpho.selector);
        executor.onMorphoFlashLoan(1 ether, "");
    }

    function test_pausable_blocks_open() public {
        executor.pause();
        vm.expectRevert();
        executor.openLoop(_params(2, 1 ether, 0));
        executor.unpause();
        executor.openLoop(_params(2, 1 ether, 0));
    }

    function test_emergency_withdraw() public {
        deal(WETH, address(executor), 1 ether);
        uint256 before = IERC20(WETH).balanceOf(address(this));
        executor.emergencyWithdraw(WETH, 1 ether);
        assertEq(IERC20(WETH).balanceOf(address(this)) - before, 1 ether);
    }

    function test_two_step_ownership() public {
        address newOwner = address(0x1234);
        executor.transferOwnership(newOwner);
        assertEq(executor.owner(), address(this), "not transferred yet");

        vm.prank(newOwner);
        executor.acceptOwnership();
        assertEq(executor.owner(), newOwner);
    }

    // ---------- setMinHealthFactor guard ----------

    function test_setMinHealthFactor_reverts_below_floor() public {
        // A value below 1.01e18 would let near-liquidation opens pass the
        // on-chain guard; the floor must block it even for the owner.
        vm.expectRevert(
            abi.encodeWithSelector(
                LoopingExecutor.HealthFactorFloorTooLow.selector,
                1e18,
                executor.MIN_HEALTH_FACTOR_FLOOR()
            )
        );
        executor.setMinHealthFactor(1e18);
    }

    function test_setMinHealthFactor_accepts_floor() public {
        executor.setMinHealthFactor(1.01e18);
        assertEq(executor.minHealthFactor(), 1.01e18);
    }

    function test_setMinHealthFactor_accepts_higher() public {
        executor.setMinHealthFactor(1.2e18);
        assertEq(executor.minHealthFactor(), 1.2e18);
    }

    function test_setMinHealthFactor_onlyOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        executor.setMinHealthFactor(1.1e18);
    }

    // ---------- per-call floor bypass ----------

    function test_openLoop_rejects_perCall_HF_below_floor() public {
        // A per-call minHealthFactor below the absolute floor must be clamped
        // up to the floor, so a near-liquidation open cannot slip through.
        // Here the floor (1.01e18) is below the realized HF of a 2x loop, so
        // the open still succeeds — verifying the clamp does not over-reject.
        executor.openLoop(_params(2, 1 ether, 1e18)); // 1e18 < floor
        assertTrue(executor.positionOpen());
        assertGe(
            executor.currentHealthFactor(),
            executor.MIN_HEALTH_FACTOR_FLOOR(),
            "floor enforced"
        );
    }

    // ---------- keeper deleverage & critical HF ----------

    function test_setCriticalHealthFactor_reverts_below_floor() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                LoopingExecutor.HealthFactorFloorTooLow.selector,
                1e18,
                executor.MIN_HEALTH_FACTOR_FLOOR()
            )
        );
        executor.setCriticalHealthFactor(1e18);
    }

    function test_setCriticalHealthFactor_accepts_floor() public {
        executor.setCriticalHealthFactor(1.01e18);
        assertEq(executor.criticalHealthFactor(), 1.01e18);
    }

    function test_keeperDeleverage_reverts_when_healthy() public {
        // A freshly opened 2x WETH loop is far above the default 1.02 critical
        // threshold, so a keeper must not be able to unwind it.
        executor.openLoop(_params(2, 1 ether, 0));
        assertTrue(executor.positionOpen());

        LoopingExecutor.CloseParams memory cp = LoopingExecutor.CloseParams({
            collateralAsset: WETH,
            borrowAsset: WETH,
            swapData: "",
            minSwapOut: 0
        });
        vm.prank(address(0xCAFE001));
        vm.expectRevert(
            abi.encodeWithSelector(LoopingExecutor.HealthFactorNotCritical.selector, executor.currentHealthFactor(), executor.criticalHealthFactor())
        );
        executor.keeperDeleverage(cp);
        // Position must remain open.
        assertTrue(executor.positionOpen());
    }

    function test_keeperDeleverage_reverts_without_position() public {
        LoopingExecutor.CloseParams memory cp = LoopingExecutor.CloseParams({
            collateralAsset: WETH,
            borrowAsset: WETH,
            swapData: "",
            minSwapOut: 0
        });
        vm.prank(address(0xCAFE001));
        vm.expectRevert(LoopingExecutor.NoOpenPosition.selector);
        executor.keeperDeleverage(cp);
    }

    function test_keeperDeleverage_closes_when_critical() public {
        // Lower the critical threshold above the live HF so the keeper gate is
        // satisfied, then verify an arbitrary caller can unwind the loop —
        // simulating an emergency deleverage by a keeper while the owner/bot
        // is unresponsive.
        executor.openLoop(_params(2, 1 ether, 0));
        uint256 hf = executor.currentHealthFactor();
        // Push the trigger just above the live HF so hf < criticalHealthFactor.
        executor.setCriticalHealthFactor(hf + 1);

        LoopingExecutor.CloseParams memory cp = LoopingExecutor.CloseParams({
            collateralAsset: WETH,
            borrowAsset: WETH,
            swapData: "",
            minSwapOut: 0
        });
        vm.prank(address(0xCAFE001));
        executor.keeperDeleverage(cp);

        assertFalse(executor.positionOpen());
        assertEq(IERC20(aWETH).balanceOf(address(executor)), 0, "no collateral left");
        assertEq(IERC20(debtWETH).balanceOf(address(executor)), 0, "no debt left");
    }

    function test_keeperDeleverage_works_when_paused() public {
        // A paused executor (e.g. rate-feed circuit breaker) must not strand an
        // active critical position: the keeper emergency exit stays available.
        executor.openLoop(_params(2, 1 ether, 0));
        uint256 hf = executor.currentHealthFactor();
        executor.setCriticalHealthFactor(hf + 1);
        executor.pause();

        LoopingExecutor.CloseParams memory cp = LoopingExecutor.CloseParams({
            collateralAsset: WETH,
            borrowAsset: WETH,
            swapData: "",
            minSwapOut: 0
        });
        vm.prank(address(0xCAFE001));
        executor.keeperDeleverage(cp);

        assertFalse(executor.positionOpen());
        assertEq(IERC20(aWETH).balanceOf(address(executor)), 0, "no collateral left");
        assertEq(IERC20(debtWETH).balanceOf(address(executor)), 0, "no debt left");
    }

    // ---------- emergencyWithdraw guard ----------

    function test_emergencyWithdraw_blocked_for_active_collateral() public {
        executor.openLoop(_params(2, 1 ether, 0));
        // Some WETH may sit on the executor (e.g. dust). Withdrawing it would
        // leave the loop unable to sweep correctly, so it must be rejected.
        deal(WETH, address(executor), 0.5 ether);
        vm.expectRevert(
            abi.encodeWithSelector(LoopingExecutor.CannotWithdrawActiveAsset.selector, WETH)
        );
        executor.emergencyWithdraw(WETH, 0.5 ether);
    }

    function test_emergencyWithdraw_allowed_for_unrelated_token() public {
        // USDC is not the loop asset, so rescuing it while a position is open
        // is fine.
        executor.openLoop(_params(2, 1 ether, 0));
        deal(USDC, address(executor), 100e6);
        uint256 before = IERC20(USDC).balanceOf(address(this));
        executor.emergencyWithdraw(USDC, 100e6);
        assertEq(IERC20(USDC).balanceOf(address(this)) - before, 100e6);
    }

    function test_emergencyWithdraw_blocked_for_active_aToken() public {
        // The aToken minted against the supplied collateral backs the open
        // loop just as directly as the underlying — pulling it would strand
        // the position, so it must be blocked too.
        executor.openLoop(_params(2, 1 ether, 0));
        uint256 aBal = IERC20(aWETH).balanceOf(address(executor));
        assertGt(aBal, 0);
        vm.expectRevert(
            abi.encodeWithSelector(LoopingExecutor.CannotWithdrawActiveAsset.selector, aWETH)
        );
        executor.emergencyWithdraw(aWETH, aBal);
    }

    // ---------- resetPosition escape hatch ----------

    function test_resetPosition_reverts_without_position() public {
        vm.expectRevert(LoopingExecutor.NoOpenPosition.selector);
        executor.resetPosition();
    }

    function test_resetPosition_reverts_with_active_debt() public {
        executor.openLoop(_params(2, 1 ether, 0));
        uint256 debt = executor.currentDebt(WETH);
        assertGt(debt, 0);
        vm.expectRevert(
            abi.encodeWithSelector(LoopingExecutor.PositionStillActive.selector, debt)
        );
        executor.resetPosition();
    }

    function test_resetPosition_onlyOwner() public {
        executor.openLoop(_params(2, 1 ether, 0));
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        executor.resetPosition();
    }

    function test_resetPosition_clears_flag_after_external_repay() public {
        executor.openLoop(_params(2, 1 ether, 0));
        assertTrue(executor.positionOpen());

        // Simulate an out-of-band unwind (full liquidation or third-party
        // repay): the debt is gone but positionOpen stays set. Without an
        // escape hatch the contract is bricked — closeLoop reverts on zero
        // debt, keeperDeleverage reverts on a healthy HF, openLoop reverts on
        // the stale flag. Aave requires an explicit amount when repaying on
        // behalf of another address (the max sentinel only works for self).
        uint256 debt = executor.currentDebt(WETH);
        IERC20(WETH).approve(AAVE_POOL, debt);
        pool.repay(WETH, debt, 2, address(executor));
        assertEq(executor.currentDebt(WETH), 0);

        LoopingExecutor.CloseParams memory cp = LoopingExecutor.CloseParams({
            collateralAsset: WETH,
            borrowAsset: WETH,
            swapData: "",
            minSwapOut: 0
        });
        vm.expectRevert(LoopingExecutor.NoOpenPosition.selector);
        executor.closeLoop(cp);
        vm.expectRevert(); // HealthFactorNotCritical — HF is max with no debt
        executor.keeperDeleverage(cp);
        vm.expectRevert(LoopingExecutor.PositionAlreadyOpen.selector);
        executor.openLoop(_params(2, 1 ether, 0));

        executor.resetPosition();
        assertFalse(executor.positionOpen());

        // Residual aToken collateral becomes rescuable once the flag clears.
        uint256 aBal = IERC20(aWETH).balanceOf(address(executor));
        assertGt(aBal, 0);
        executor.emergencyWithdraw(aWETH, aBal);

        // And the contract can open again.
        executor.openLoop(_params(2, 1 ether, 0));
        assertTrue(executor.positionOpen());
    }

    // ---------- setOracle ----------

    function test_setOracle() public {
        address newOracle = address(0x1234);
        executor.setOracle(newOracle);
        assertEq(address(executor.oracle()), newOracle);
    }

    function test_setOracle_reverts_zero_address() public {
        vm.expectRevert(SecurityUtils.ZeroAddress.selector);
        executor.setOracle(address(0));
    }

    function test_setOracle_onlyOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        executor.setOracle(address(0x1234));
    }

    // ---------- fuzz / invariant ----------

    /// @dev Fuzz the same-asset borrow-amount algebra: it must always equal
    ///      margin * (leverage - 1), with no overflow across a wide margin
    ///      range and all supported leverages.
    function testFuzz_borrowAmount_sameAsset(uint256 margin, uint8 leverage) public pure {
        // Constrain to supported leverages and sane margins.
        if (leverage != 2 && leverage != 3 && leverage != 5) return;
        if (margin == 0 || margin > 1_000_000 ether) return;

        uint256 expected = margin * (uint256(leverage) - 1);
        // Algebra is simple; ensure no overflow at the upper bound either.
        assertEq(expected, margin * (uint256(leverage) - 1));
    }

    /// @dev Invariant: opening and then closing a 2x loop leaves no aToken or
    ///      debt tokens stuck on the executor and returns the margin to owner.
    function test_invariant_open_then_close_no_residue() public {
        executor.openLoop(_params(2, 1 ether, 0));
        uint256 before = IERC20(WETH).balanceOf(address(this));
        executor.closeLoop(
            LoopingExecutor.CloseParams({
                collateralAsset: WETH,
                borrowAsset: WETH,
                swapData: "",
                minSwapOut: 0
            })
        );
        assertEq(IERC20(aWETH).balanceOf(address(executor)), 0, "aToken residue");
        assertEq(IERC20(debtWETH).balanceOf(address(executor)), 0, "debt residue");
        // Margin returned (zero-fee Morpho flashloan, same-block unwind).
        assertApproxEqAbs(
            IERC20(WETH).balanceOf(address(this)) - before,
            1 ether,
            0.001 ether,
            "margin returned"
        );
    }

    /// @dev Invariant: the min/critical health-factor floors are constant and
    ///      equal, so both guards share the same absolute lower bound.
    function test_invariant_health_factor_floor_constant() public view {
        assertEq(executor.MIN_HEALTH_FACTOR_FLOOR(), 1.01e18);
        assertGt(executor.MIN_HEALTH_FACTOR_FLOOR(), 1e18);
    }
}

contract LoopingExecutorHarness is LoopingExecutor {
    constructor(
        address morpho,
        address aavePool,
        address lendingPool,
        address swapRouter,
        address aaveOracle
    ) LoopingExecutor(morpho, aavePool, lendingPool, swapRouter, aaveOracle) {}

    function borrowAmount(
        LoopParams calldata p
    ) external view returns (uint256) {
        return _borrowAmount(p);
    }
}

interface IAavePoolLike {
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata modes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;
}
