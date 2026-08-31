// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LoopingExecutor} from "contracts/LoopingExecutor.sol";
import {FlashloanBase} from "contracts/FlashloanBase.sol";
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

    LoopingExecutor executor;
    ILendingPool pool = ILendingPool(AAVE_POOL);

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

        executor = new LoopingExecutor(MORPHO, AAVE_POOL, AAVE_POOL, SWAP_ROUTER, AAVE_ORACLE);

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
        // WETH normal-mode LTV 80% => 5x needs 4x debt, at the borrowable edge
        vm.expectRevert();
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

    // ---------- security ----------

    function test_executeOperation_reverts_for_external_initiator() public {
        // Attacker triggers an Aave flashloan naming our executor as receiver.
        address attacker = address(0xBAD);
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
