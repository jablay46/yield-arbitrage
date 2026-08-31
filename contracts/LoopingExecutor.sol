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

    error UnsupportedLeverage(uint8 leverage);
    error ZeroMargin();
    error PositionAlreadyOpen();
    error NoOpenPosition();
    error HealthFactorTooLow(uint256 healthFactor, uint256 minimum);
    error InsufficientToRepay(uint256 balance, uint256 required);
    error RouterNotSet();
    error SlippageExceeded(uint256 amountOut, uint256 minOut);
    error MissingSwapData();
    error RepayMismatch(uint256 repaid, uint256 expected);
    error ConversionOverflow();

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

    ILendingPool public lendingPool;
    IAaveOracle public oracle;
    address public swapRouter;
    uint256 public minHealthFactor = 1.05e18;
    bool public positionOpen;

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
        _initiateFlashloan(p.borrowAsset, flashAmount, abi.encode(Mode.Open, p));
    }

    /**
     * @notice Close the loop and sweep all remaining funds to the owner.
     * @dev The flashloan is sized from the live on-chain debt balance.
     */
    function closeLoop(
        CloseParams calldata p
    ) external onlyOwner nonReentrant whenNotPaused {
        if (!positionOpen) revert NoOpenPosition();

        ReserveData memory rd = lendingPool.getReserveData(p.borrowAsset);
        uint256 debt = IERC20(rd.variableDebtTokenAddress).balanceOf(
            address(this)
        );
        if (debt == 0) revert NoOpenPosition();

        uint256 flashAmount = debt + (debt * CLOSE_BUFFER_BPS) / 10000;

        positionOpen = false;
        _initiateFlashloan(p.borrowAsset, flashAmount, abi.encode(Mode.Close, p));

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
            (, CloseParams memory p) = abi.decode(data, (Mode, CloseParams));
            _executeClose(asset, amount, premium, p);
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

        // 4. Enforce the health factor floor
        uint256 minimum = p.minHealthFactor > 0
            ? p.minHealthFactor
            : minHealthFactor;
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
        CloseParams memory p
    ) internal {
        // 1. Repay the full debt
        ReserveData memory rd = lendingPool.getReserveData(p.borrowAsset);
        uint256 debt = IERC20(rd.variableDebtTokenAddress).balanceOf(
            address(this)
        );
        IERC20(p.borrowAsset).forceApprove(address(lendingPool), debt);
        uint256 repaid = lendingPool.repay(
            p.borrowAsset,
            debt,
            VARIABLE_RATE_MODE,
            address(this)
        );
        if (repaid != debt) revert RepayMismatch(repaid, debt);

        // 2. Withdraw all collateral
        uint256 withdrawn = lendingPool.withdraw(
            p.collateralAsset,
            type(uint256).max,
            address(this)
        );

        // 3. Convert collateral back into the flashloaned asset if needed
        if (p.collateralAsset != p.borrowAsset) {
            _swap(
                p.swapData,
                p.collateralAsset,
                withdrawn,
                p.borrowAsset,
                p.minSwapOut
            );
        }

        // 4. The callback wrapper must be able to repay flash + premium
        uint256 required = flashAmount + premium;
        uint256 balance = IERC20(flashAsset).balanceOf(address(this));
        if (balance < required) revert InsufficientToRepay(balance, required);

        emit LoopClosed(p.collateralAsset, p.borrowAsset, debt, withdrawn);
    }

    /**
     * @notice Swap through the configured router using owner-built calldata.
     * @dev Only the trusted router may be targeted and the output is
     *      slippage-checked, so arbitrary calldata cannot drain the contract.
     */
    function _swap(
        bytes memory swapData,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minOut
    ) internal returns (uint256 amountOut) {
        if (swapRouter == address(0)) revert RouterNotSet();

        IERC20(tokenIn).forceApprove(swapRouter, amountIn);
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));

        (bool success, bytes memory returndata) = swapRouter.call(swapData);
        if (!success) {
            assembly {
                revert(add(returndata, 32), mload(returndata))
            }
        }

        amountOut = IERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
        if (amountOut < minOut) revert SlippageExceeded(amountOut, minOut);
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
            IERC20(token).safeTransfer(owner, balance);
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
        swapRouter = _swapRouter;
        emit SwapRouterUpdated(_swapRouter);
    }

    /**
     * @notice Update the minimum health factor required after opening a loop
     * @param _minHealthFactor The new minimum health factor in WAD units (e.g., 1.05e18)
     */
    function setMinHealthFactor(uint256 _minHealthFactor) external onlyOwner {
        minHealthFactor = _minHealthFactor;
        emit MinHealthFactorUpdated(_minHealthFactor);
    }

    /// @notice Join an e-mode category on the lending pool (e.g. correlated ETH assets)
    function setEMode(uint8 categoryId) external onlyOwner {
        lendingPool.setUserEMode(categoryId);
    }
}
