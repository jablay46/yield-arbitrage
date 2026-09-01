// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {FlashloanBase} from "./FlashloanBase.sol";
import {ILendingPool, ReserveData} from "./interfaces/ILendingPool.sol";
import {IAaveOracle} from "./interfaces/IAaveOracle.sol";

/**
 * @title LoopingExecutor
 * @notice Leveraged yield looping on an Aave V3 compatible pool, funded
 *         atomically by a flashloan.
 *
 *         Open:  flashloan (leverage-1)x margin -> supply margin + flash ->
 *                borrow flash (+premium) -> repay flashloan.
 *         Close: flashloan debt -> repay debt -> withdraw all collateral ->
 *                repay flashloan -> sweep remainder to owner.
 *
 *         Supported leverage: 2x, 3x, 5x. The post-open health factor is
 *         enforced on-chain; 5x typically requires correlated-asset e-mode
 *         or a high liquidation threshold.
 */
contract LoopingExecutor is FlashloanBase {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;
    uint256 internal constant VARIABLE_RATE_MODE = 2;
    uint256 internal constant ORACLE_DECIMALS = 1e8;
    /// @dev Buffer added on top of debt when sizing the close flashloan so the
    ///      premium and interest accrued since the debt snapshot are covered.
    uint256 internal constant CLOSE_BUFFER_BPS = 10; // 0.1%
    /// @dev Slippage tolerance applied to the oracle-derived minimum swap
    ///      output on a keeper-driven cross-asset deleverage, so a malicious
    ///      keeper cannot set minSwapOut to zero and route through an adverse
    ///      path.
    uint256 internal constant KEEPER_SLIPPAGE_BPS = 500; // 5%

    /// @dev Absolute lower bound enforceable via setMinHealthFactor, so a
    ///      compromised or mistaken owner cannot weaken the guard to permit
    ///      near-liquidation opens. WAD: 1.01e18 = 1.01.
    uint256 public constant MIN_HEALTH_FACTOR_FLOOR = 1.01e18;

    error UnsupportedLeverage(uint8 leverage);
    error ZeroMargin();
    error PositionAlreadyOpen();
    error NoOpenPosition();
    error PositionMismatch();
    error HealthFactorTooLow(uint256 healthFactor, uint256 minimum);
    error HealthFactorNotCritical(uint256 healthFactor, uint256 criticalThreshold);
    error HealthFactorFloorTooLow(uint256 provided, uint256 minimum);
    error InsufficientToRepay(uint256 balance, uint256 required);
    error RouterNotSet();
    error SlippageExceeded(uint256 amountOut, uint256 minOut);
    error MissingSwapData();
    error RepayMismatch(uint256 remaining);
    error ConversionOverflow();
    error SwapTokenMismatch(address expected, address actual);
    error SwapExcessPulled(uint256 pulled, uint256 expected);
    error CannotWithdrawActiveAsset(address token);

    enum Mode {
        Open,
        Close
    }

    struct LoopParams {
        address collateralAsset;
        address borrowAsset;
        uint256 marginAmount; // owner collateral pulled via transferFrom
        uint8 leverage; // 2, 3 or 5
        uint256 minHealthFactor; // WAD; 0 = contract default
        bytes swapData; // router calldata; empty for same-asset loops
        uint256 minSwapOut; // slippage guard for the open swap (collateral units)
    }

    struct CloseParams {
        address collateralAsset;
        address borrowAsset;
        bytes swapData; // router calldata for cross-asset unwind
        uint256 minSwapOut; // slippage guard for the close swap (borrow units)
    }

    /// @dev Records the assets of the currently open loop so closeLoop can
    ///      validate its parameters against the position that was actually
    ///      opened, rather than trusting the caller to repeat them.
    struct OpenPosition {
        address collateralAsset;
        address borrowAsset;
        uint8 leverage;
    }

    ILendingPool public lendingPool;
    IAaveOracle public oracle;
    address public swapRouter;
    uint256 public minHealthFactor = 1.05e18;
    /// @dev Health factor at which a keeper may trigger an emergency deleverage.
    ///      Floored at MIN_HEALTH_FACTOR_FLOOR so it cannot be set dangerously low.
    uint256 public criticalHealthFactor = 1.02e18;
    bool public positionOpen;
    OpenPosition public openPosition;

    event LoopOpened(
        address indexed collateralAsset,
        address indexed borrowAsset,
        uint256 marginAmount,
        uint256 totalSupplied,
        uint256 totalDebt,
        uint8 leverage,
        uint256 healthFactor
    );
    event LoopClosed(
        address indexed collateralAsset,
        address indexed borrowAsset,
        uint256 debtRepaid,
        uint256 collateralWithdrawn
    );
    event MinHealthFactorUpdated(uint256 newMinHealthFactor);
    event CriticalHealthFactorUpdated(uint256 newCriticalHealthFactor);
    event SwapRouterUpdated(address newRouter);

    constructor(
        address _morpho,
        address _aavePool,
        address _lendingPool,
        address _swapRouter,
        address _oracle
    ) FlashloanBase(_morpho, _aavePool) {
        if (_lendingPool == address(0)) revert ZeroAddress();
        if (_swapRouter == address(0)) revert ZeroAddress();
        if (_oracle == address(0)) revert ZeroAddress();
        lendingPool = ILendingPool(_lendingPool);
        oracle = IAaveOracle(_oracle);
        swapRouter = _swapRouter;
    }

    /**
     * @notice Open a leveraged loop. The caller must have approved this
     *         contract for `marginAmount` of `collateralAsset`.
     */
    function openLoop(
        LoopParams calldata p
    ) external onlyOwner nonReentrant whenNotPaused {
        if (p.leverage != 2 && p.leverage != 3 && p.leverage != 5) {
            revert UnsupportedLeverage(p.leverage);
        }
        if (p.marginAmount == 0) revert ZeroMargin();
        if (positionOpen) revert PositionAlreadyOpen();
        if (p.collateralAsset != p.borrowAsset && p.swapData.length == 0) {
            revert MissingSwapData();
        }

        IERC20(p.collateralAsset).safeTransferFrom(
            msg.sender,
            address(this),
            p.marginAmount
        );

        uint256 flashAmount = _borrowAmount(p);

        positionOpen = true;
        openPosition = OpenPosition({
            collateralAsset: p.collateralAsset,
            borrowAsset: p.borrowAsset,
            leverage: p.leverage
        });
        _initiateFlashloan(p.borrowAsset, flashAmount, abi.encode(Mode.Open, p));
    }

    /**
     * @notice Close the loop and sweep all remaining funds to the owner.
     * @dev The flashloan is sized from the live on-chain debt balance. The
     *      close parameters must match the position recorded at open time so
     *      the unwind cannot target a different asset pair.
     */
    function closeLoop(
        CloseParams calldata p
    ) external onlyOwner nonReentrant whenNotPaused {
        _closeLoop(p);
    }

    /**
     * @notice Keeper-callable emergency deleverage.
     * @dev Anyone may call this, but only when the on-chain health factor has
     *      dropped below the configured critical threshold. It runs the same
     *      unwind as closeLoop, so a stalled owner/bot cannot leave a position
     *      to be liquidated. Still nonReentrant. Deliberately not guarded by
     *      whenNotPaused: a paused executor (e.g. rate-feed circuit breaker)
     *      must not strand an active position whose health factor has gone
     *      critical, so the emergency exit has to remain available. The
     *      position pair is taken from the recorded open position; `p` must
     *      match it.
     */
    function keeperDeleverage(
        CloseParams calldata p
    ) external nonReentrant {
        if (!positionOpen) revert NoOpenPosition();

        (, , , , , uint256 hf) = lendingPool.getUserAccountData(address(this));
        if (hf >= criticalHealthFactor)
            revert HealthFactorNotCritical(hf, criticalHealthFactor);

        _closeLoopImpl(p, true);
    }

    function _closeLoop(CloseParams memory p) internal {
        _closeLoopImpl(p, false);
    }

    /**
     * @notice Shared close implementation. When `enforceOracleMinSwapOut` is
     *         set (keeper deleverage), a cross-asset swap must meet at least
     *         the oracle-derived fair value less the keeper slippage, so a
     *         malicious keeper cannot pair adverse router calldata with a zero
     *         minSwapOut to unwind a position at a loss.
     */
    function _closeLoopImpl(CloseParams memory p, bool enforceOracleMinSwapOut)
        internal
    {
        if (!positionOpen) revert NoOpenPosition();

        OpenPosition memory stored = openPosition;
        if (
            p.collateralAsset != stored.collateralAsset ||
            p.borrowAsset != stored.borrowAsset
        ) revert PositionMismatch();
        if (p.collateralAsset != p.borrowAsset && p.swapData.length == 0) {
            revert MissingSwapData();
        }

        ReserveData memory rd = lendingPool.getReserveData(p.borrowAsset);
        uint256 debt = IERC20(rd.variableDebtTokenAddress).balanceOf(
            address(this)
        );
        if (debt == 0) revert NoOpenPosition();

        uint256 flashAmount = debt + (debt * CLOSE_BUFFER_BPS) / 10000;

        positionOpen = false;
        _initiateFlashloan(
            p.borrowAsset,
            flashAmount,
            abi.encode(Mode.Close, p, enforceOracleMinSwapOut)
        );

        // Everything left after repayment belongs to the owner.
        _sweep(p.collateralAsset);
        _sweep(p.borrowAsset);
    }

    /**
     * @notice Current variable debt of this contract in `asset`
     */
    function currentDebt(address asset) external view returns (uint256) {
        ReserveData memory rd = lendingPool.getReserveData(asset);
        return IERC20(rd.variableDebtTokenAddress).balanceOf(address(this));
    }

    /**
     * @notice Current health factor of this contract (WAD)
     */
    function currentHealthFactor() external view returns (uint256) {
        (, , , , , uint256 hf) = lendingPool.getUserAccountData(address(this));
        return hf;
    }

    /**
     * @notice Execute strategy logic while holding flashloaned funds
     * @param asset The flashloaned asset
     * @param amount The flashloaned amount
     * @param premium The flashloan fee
     * @param data Encoded operation parameters (Mode + LoopParams or CloseParams)
     */
    function _executeWithFunds(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory data
    ) internal override {
        Mode mode = abi.decode(data, (Mode));
        if (mode == Mode.Open) {
            (, LoopParams memory p) = abi.decode(data, (Mode, LoopParams));
            _executeOpen(amount, premium, p);
        } else {
            (, CloseParams memory p, bool enforceOracleMinSwapOut) = abi.decode(
                data,
                (Mode, CloseParams, bool)
            );
            _executeClose(asset, amount, premium, p, enforceOracleMinSwapOut);
        }
    }

    /**
     * @notice Execute the open loop operation during flashloan callback
     * @param flashAmount The amount of borrow asset received from the flashloan
     * @param premium The flashloan fee to be repaid
     * @param p Loop parameters including collateral, borrow asset, margin, and leverage
     */
    function _executeOpen(
        uint256 flashAmount,
        uint256 premium,
        LoopParams memory p
    ) internal {
        // 1. Convert the flashloaned borrow asset into collateral if needed
        uint256 flashInCollateral = flashAmount;
        if (p.borrowAsset != p.collateralAsset) {
            flashInCollateral = _swap(
                p.swapData,
                p.borrowAsset,
                flashAmount,
                p.collateralAsset,
                p.minSwapOut
            );
        }

        // 2. Supply margin + flashloan value as collateral
        uint256 totalSupplied = p.marginAmount + flashInCollateral;
        IERC20(p.collateralAsset).forceApprove(address(lendingPool), totalSupplied);
        lendingPool.supply(p.collateralAsset, totalSupplied, address(this), 0);
        lendingPool.setUserUseReserveAsCollateral(p.collateralAsset, true);

        // 3. Borrow enough of the borrow asset to repay the flashloan
        uint256 borrowAmount = flashAmount + premium;
        lendingPool.borrow(
            p.borrowAsset,
            borrowAmount,
            VARIABLE_RATE_MODE,
            0,
            address(this)
        );

        // 4. Enforce the health factor floor. The effective threshold is the
        //    caller's per-call override when set, but it can never fall below
        //    the absolute MIN_HEALTH_FACTOR_FLOOR — a compromised or mistaken
        //    owner cannot smuggle a near-liquidation open past the guard.
        uint256 minimum = p.minHealthFactor > minHealthFactor
            ? p.minHealthFactor
            : minHealthFactor;
        if (minimum < MIN_HEALTH_FACTOR_FLOOR) {
            minimum = MIN_HEALTH_FACTOR_FLOOR;
        }
        (, , , , , uint256 hf) = lendingPool.getUserAccountData(address(this));
        if (hf < minimum) revert HealthFactorTooLow(hf, minimum);

        emit LoopOpened(
            p.collateralAsset,
            p.borrowAsset,
            p.marginAmount,
            totalSupplied,
            borrowAmount,
            p.leverage,
            hf
        );
    }

    /**
     * @notice Execute the close loop operation during flashloan callback
     * @param flashAsset The flashloaned asset (same as borrow asset)
     * @param flashAmount The amount borrowed to repay the debt
     * @param premium The flashloan fee
     * @param p Close parameters including collateral and borrow assets, swap data
     */
    function _executeClose(
        address flashAsset,
        uint256 flashAmount,
        uint256 premium,
        CloseParams memory p,
        bool enforceOracleMinSwapOut
    ) internal {
        // 1. Repay the full current debt. Approve the flashloaned amount and
        //    pass the max-uint sentinel so repayment covers whatever variable
        //    debt is currently outstanding (accrual since the snapshot is fine).
        ReserveData memory rd = lendingPool.getReserveData(p.borrowAsset);
        uint256 debt = IERC20(rd.variableDebtTokenAddress).balanceOf(
            address(this)
        );
        IERC20(p.borrowAsset).forceApprove(address(lendingPool), flashAmount);
        lendingPool.repay(
            p.borrowAsset,
            type(uint256).max,
            VARIABLE_RATE_MODE,
            address(this)
        );
        uint256 remaining = IERC20(rd.variableDebtTokenAddress).balanceOf(
            address(this)
        );
        if (remaining != 0) revert RepayMismatch(remaining);

        // 2. Withdraw all collateral
        uint256 withdrawn = lendingPool.withdraw(
            p.collateralAsset,
            type(uint256).max,
            address(this)
        );

        // 3. Convert collateral back into the flashloaned asset if needed.
        //    On a keeper-driven deleverage, the keeper cannot set a sub-oracle
        //    floor: raise minSwapOut to the oracle fair value less keeper
        //    slippage so adverse router calldata cannot unwind at a loss.
        if (p.collateralAsset != p.borrowAsset) {
            uint256 minOut = p.minSwapOut;
            if (enforceOracleMinSwapOut) {
                uint256 oracleFloor = _oracleMinSwapOut(
                    p.collateralAsset,
                    p.borrowAsset,
                    withdrawn
                );
                if (oracleFloor > minOut) minOut = oracleFloor;
            }
            _swap(
                p.swapData,
                p.collateralAsset,
                withdrawn,
                p.borrowAsset,
                minOut
            );
        }

        // 4. The callback wrapper must be able to repay flash + premium
        uint256 required = flashAmount + premium;
        uint256 balance = IERC20(flashAsset).balanceOf(address(this));
        if (balance < required) revert InsufficientToRepay(balance, required);

        // 5. Clear the recorded position now that the unwind succeeded.
        delete openPosition;

        emit LoopClosed(p.collateralAsset, p.borrowAsset, debt, withdrawn);
    }

    /**
     * @notice Swap through the configured router using owner-built calldata.
     * @dev The swap is bound to the active loop's asset pair when a position is
     *      open, so arbitrary calldata cannot target an unrelated token the
     *      contract may hold. The router may pull at most `amountIn` of
     *      `tokenIn` (the pre-approval is exactly that), and the realized pull
     *      is asserted so a malicious router cannot drain a residual balance.
     */
    function _swap(
        bytes memory swapData,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minOut
    ) internal returns (uint256 amountOut) {
        if (swapRouter == address(0)) revert RouterNotSet();

        // When a position is open, the swap pair must match the recorded
        // collateral/borrow assets — the open swap converts borrow->collateral
        // and the close swap converts collateral->borrow. Anything else would
        // let the calldata target an unrelated token the contract holds.
        if (positionOpen) {
            OpenPosition memory stored = openPosition;
            if (tokenIn != stored.borrowAsset && tokenIn != stored.collateralAsset) {
                revert SwapTokenMismatch(stored.borrowAsset, tokenIn);
            }
            if (tokenOut != stored.collateralAsset && tokenOut != stored.borrowAsset) {
                revert SwapTokenMismatch(stored.collateralAsset, tokenOut);
            }
        }

        uint256 tokenInBefore = IERC20(tokenIn).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(swapRouter, amountIn);
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));

        (bool success, bytes memory returndata) = swapRouter.call(swapData);
        if (!success) {
            assembly {
                revert(add(returndata, 32), mload(returndata))
            }
        }

        // The router may only pull what we approved, and no more than amountIn.
        uint256 pulled = tokenInBefore - IERC20(tokenIn).balanceOf(address(this));
        if (pulled > amountIn) revert SwapExcessPulled(pulled, amountIn);

        amountOut = IERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
        // Reset the router allowance so no residual approval lingers between swaps.
        IERC20(tokenIn).forceApprove(swapRouter, 0);
        if (amountOut < minOut) revert SlippageExceeded(amountOut, minOut);
    }

    /**
     * @notice Oracle-derived minimum swap output for a keeper deleverage.
     * @dev Bounds the cross-asset unwind so a keeper cannot pair adverse
     *      router calldata with a zero slippage floor. Returns the fair value
     *      of `amountIn` collateral in borrow-asset units, minus the keeper
     *      slippage tolerance. The numerator is scaled before the division to
     *      avoid truncation when the output token has more decimals.
     */
    function _oracleMinSwapOut(
        address collateralAsset,
        address borrowAsset,
        uint256 amountIn
    ) internal view returns (uint256) {
        uint256 collateralPrice = oracle.getAssetPrice(collateralAsset);
        uint256 borrowPrice = oracle.getAssetPrice(borrowAsset);
        uint8 collateralDecimals = IERC20Metadata(collateralAsset).decimals();
        uint8 borrowDecimals = IERC20Metadata(borrowAsset).decimals();

        // fair = amountIn * collateralPrice / borrowPrice, decimal-adjusted so
        // the result is in borrow-asset units. Scale the numerator first.
        uint256 numerator;
        uint256 divisor = borrowPrice;
        if (borrowDecimals >= collateralDecimals) {
            uint256 decimalDiff = borrowDecimals - collateralDecimals;
            if (decimalDiff > 77) revert ConversionOverflow();
            numerator = amountIn * collateralPrice * (10 ** decimalDiff);
        } else {
            uint256 decimalDiff = collateralDecimals - borrowDecimals;
            if (decimalDiff > 77) revert ConversionOverflow();
            divisor = borrowPrice * (10 ** decimalDiff);
            numerator = amountIn * collateralPrice;
        }
        uint256 fairOut = Math.mulDiv(numerator, 1, divisor);
        // Apply the keeper slippage tolerance.
        return (fairOut * (10_000 - KEEPER_SLIPPAGE_BPS)) / 10_000;
    }

    /**
     * @notice Size the open flashloan. For same-asset loops this is the
     *         simple multiplier; for cross-asset loops it converts the
     *         margin into borrow-asset units via the Aave price oracle so
     *         the (leverage-1)-sized debt is priced in the right currency.
     */
    function _borrowAmount(
        LoopParams memory p
    ) internal view returns (uint256) {
        if (p.borrowAsset == p.collateralAsset) {
            return p.marginAmount * (uint256(p.leverage) - 1);
        }

        uint256 collateralPrice = oracle.getAssetPrice(p.collateralAsset);
        uint256 borrowPrice = oracle.getAssetPrice(p.borrowAsset);
        uint8 collateralDecimals = IERC20Metadata(p.collateralAsset).decimals();
        uint8 borrowDecimals = IERC20Metadata(p.borrowAsset).decimals();

        uint256 valueInBorrow;

        if (borrowDecimals > collateralDecimals) {
            uint256 decimalDifference = borrowDecimals - collateralDecimals;
            if (decimalDifference > 77) revert ConversionOverflow();
            uint256 scale = 10 ** decimalDifference;

            valueInBorrow = Math.mulDiv(
                p.marginAmount,
                collateralPrice,
                borrowPrice
            );

            // Preserve the remainder from the price conversion before scaling
            // up, while keeping both multiplications full-precision.
            uint256 scaledRemainder = Math.mulDiv(
                mulmod(p.marginAmount, collateralPrice, borrowPrice),
                scale,
                borrowPrice
            );
            if (
                valueInBorrow >
                (type(uint256).max - scaledRemainder) / scale
            ) revert ConversionOverflow();
            valueInBorrow = valueInBorrow * scale + scaledRemainder;
        } else if (collateralDecimals > borrowDecimals) {
            uint256 decimalDifference = collateralDecimals - borrowDecimals;
            if (decimalDifference > 77) revert ConversionOverflow();
            uint256 scale = 10 ** decimalDifference;
            if (borrowPrice > type(uint256).max / scale) {
                revert ConversionOverflow();
            }
            valueInBorrow = Math.mulDiv(
                p.marginAmount,
                collateralPrice,
                borrowPrice * scale
            );
        } else {
            valueInBorrow = Math.mulDiv(
                p.marginAmount,
                collateralPrice,
                borrowPrice
            );
        }

        if (valueInBorrow == 0) revert ConversionOverflow();

        uint256 leverageMultiplier = uint256(p.leverage) - 1;
        if (valueInBorrow > type(uint256).max / leverageMultiplier) {
            revert ConversionOverflow();
        }
        return valueInBorrow * leverageMultiplier;
    }

    /**
     * @notice Transfer the entire balance of a token to the owner
     * @param token The token address to sweep
     */
    function _sweep(address token) internal {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(owner(), balance);
        }
    }

    /**
     * @notice Update the Aave lending pool address
     * @param _lendingPool The new lending pool address
     */
    function setLendingPool(address _lendingPool) external onlyOwner {
        if (_lendingPool == address(0)) revert ZeroAddress();
        lendingPool = ILendingPool(_lendingPool);
    }

    /**
     * @notice Update the swap router address for cross-asset loops
     * @param _swapRouter The new swap router address
     */
    function setSwapRouter(address _swapRouter) external onlyOwner {
        if (_swapRouter == address(0)) revert ZeroAddress();
        swapRouter = _swapRouter;
        emit SwapRouterUpdated(_swapRouter);
    }

    /**
     * @notice Update the minimum health factor required after opening a loop
     * @param _minHealthFactor The new minimum health factor in WAD units (e.g., 1.05e18)
     */
    function setMinHealthFactor(uint256 _minHealthFactor) external onlyOwner {
        if (_minHealthFactor < MIN_HEALTH_FACTOR_FLOOR) {
            revert HealthFactorFloorTooLow(_minHealthFactor, MIN_HEALTH_FACTOR_FLOOR);
        }
        minHealthFactor = _minHealthFactor;
        emit MinHealthFactorUpdated(_minHealthFactor);
    }

    /**
     * @notice Update the critical health factor that permits a keeper deleverage.
     * @param _criticalHealthFactor WAD units; must be at least MIN_HEALTH_FACTOR_FLOOR.
     */
    function setCriticalHealthFactor(uint256 _criticalHealthFactor) external onlyOwner {
        if (_criticalHealthFactor < MIN_HEALTH_FACTOR_FLOOR) {
            revert HealthFactorFloorTooLow(_criticalHealthFactor, MIN_HEALTH_FACTOR_FLOOR);
        }
        criticalHealthFactor = _criticalHealthFactor;
        emit CriticalHealthFactorUpdated(_criticalHealthFactor);
    }

    /// @notice Join an e-mode category on the lending pool (e.g. correlated ETH assets)
    function setEMode(uint8 categoryId) external onlyOwner {
        lendingPool.setUserEMode(categoryId);
    }

    /**
     * @notice Rescue tokens stuck on the contract.
     * @dev Forbids withdrawing the collateral or borrow asset of an open loop,
     *      which would leave the position under-collateralized and un-closeable
     *      via the normal flashloan unwind.
     */
    function emergencyWithdraw(address token, uint256 amount) external override onlyOwner {
        if (positionOpen) {
            OpenPosition memory stored = openPosition;
            if (token == stored.collateralAsset || token == stored.borrowAsset) {
                revert CannotWithdrawActiveAsset(token);
            }
        }
        IERC20(token).safeTransfer(owner(), amount);
        emit EmergencyWithdraw(token, amount, owner());
    }
}
