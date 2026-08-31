// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {FlashloanArbitrage} from "./FlashloanArbitrage.sol";
import {ILendingPool} from "./interfaces/ILendingPool.sol";

/**
 * @title ArbitrageExecutor
 * @notice Executes lending protocol arbitrage between supply and borrow rates
 */
contract ArbitrageExecutor is FlashloanArbitrage {
    using SafeERC20 for IERC20;

    // Custom errors
    error InsufficientProfit();
    error SwapFailed();
    error SupplyFailed();
    error BorrowFailed();
    error RepayFailed();
    error WithdrawFailed();
    error InvalidToken();

    // State variables
    address public supplyPool;  // Protocol to supply to (higher APY)
    address public borrowPool; // Protocol to borrow from (lower APR)
    address public swapRouter; // Uniswap/Curve router for swapping

    // Min profit threshold (in wei)
    uint256 public minProfit = 1e18;

    // Events
    event ArbitrageExecuted(
        address indexed asset,
        uint256 flashloanAmount,
        uint256 profit,
        address indexed supplyProtocol,
        address indexed borrowProtocol
    );
    event SupplyCompleted(address indexed asset, uint256 amount, address indexed protocol);
    event BorrowCompleted(address indexed asset, uint256 amount, address indexed protocol);
    event RepayCompleted(address indexed asset, uint256 amount, address indexed protocol);
    event WithdrawCompleted(address indexed asset, uint256 amount, address indexed protocol);

    /**
     * @notice Constructor
     * @param _morpho Morpho address (primary flashloan - 0 fee)
     * @param _aavePool Aave V3 pool (fallback)
     * @param _supplyPool Protocol to supply (higher APY)
     * @param _borrowPool Protocol to borrow from (lower APR)
     * @param _swapRouter Uniswap/Curve router for swaps
     */
    constructor(
        address _morpho,
        address _aavePool,
        address _supplyPool,
        address _borrowPool,
        address _swapRouter
    ) FlashloanArbitrage(_morpho, _aavePool) {
        supplyPool = _supplyPool;
        borrowPool = _borrowPool;
        swapRouter = _swapRouter;
    }

    /**
     * @notice Struct for arbitrage parameters
     */
    struct ArbitrageParams {
        address supplyToken;   // Token to supply (e.g., USDC)
        address borrowToken;   // Token to borrow (e.g., DAI)
        uint256 supplyAmount; // Amount to supply
        uint256 borrowAmount; // Amount to borrow
        uint256 flashloanAmount;
        uint256 minProfit;
        address[] path;       // Swap path: flashloanToken -> borrowToken -> flashloanToken
    }

    /**
     * @notice Execute the arbitrage strategy
     * @param params Encoded arbitrage parameters
     */
    function executeArbitrage(bytes calldata params) external onlyOwner {
        ArbitrageParams memory arbParams = _decodeParams(params);

        // Step 1: Supply to high APY protocol
        _supply(arbParams.supplyToken, arbParams.supplyAmount);

        // Step 2: Borrow from low APR protocol
        _borrow(arbParams.borrowToken, arbParams.borrowAmount);

        // Step 3: Swap borrowed token back to original (if different)
        if (arbParams.borrowToken != arbParams.supplyToken) {
            _swap(arbParams.path, arbParams.borrowAmount);
        }

        // Step 4: Repay flashloan (done in executeOperation)
    }

    /**
     * @dev Internal execution logic called by FlashloanArbitrage
     */
    function _executeArbitrage(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address,
        bytes calldata params
    ) internal override {
        ArbitrageParams memory arbParams = _decodeParams(params);

        // Ensure we have the flashloan asset
        address flashloanAsset = assets[0];
        uint256 flashloanAmount = amounts[0];
        uint256 flashloanFee = premiums[0];

        // Step 1: Supply to supplyPool (high APY)
        _supply(arbParams.supplyToken, arbParams.supplyAmount);

        // Step 2: Borrow from borrowPool (low APR)
        _borrow(arbParams.borrowToken, arbParams.borrowAmount);

        // Step 3: Swap borrowed to flashloan token
        if (arbParams.borrowToken != flashloanAsset) {
            _swap(arbParams.path, arbParams.borrowAmount);
        }

        // Step 4: Check profit
        uint256 balance = IERC20(flashloanAsset).balanceOf(address(this));
        uint256 repayAmount = flashloanAmount + flashloanFee;

        if (balance < repayAmount) {
            revert InsufficientProfit();
        }

        // Calculate profit
        uint256 profit = balance - repayAmount;

        if (profit < arbParams.minProfit) {
            revert InsufficientProfit();
        }

        // Step 5: Withdraw from supply pool
        _withdraw(arbParams.supplyToken, arbParams.supplyAmount);

        emit ArbitrageExecuted(
            flashloanAsset,
            flashloanAmount,
            profit,
            supplyPool,
            borrowPool
        );
    }

    /**
     * @notice Supply assets to lending protocol
     */
    function _supply(address asset, uint256 amount) internal {
        IERC20(asset).forceApprove(supplyPool, amount);
        ILendingPool(supplyPool).supply(asset, amount, address(this), 0);
        emit SupplyCompleted(asset, amount, supplyPool);
    }

    /**
     * @notice Borrow assets from lending protocol
     */
    function _borrow(address asset, uint256 amount) internal {
        ILendingPool(borrowPool).borrow(asset, amount, 2, address(this), 0);
        emit BorrowCompleted(asset, amount, borrowPool);
    }

    /**
     * @notice Repay borrowed assets
     */
    function _repay(address asset, uint256 amount) internal {
        IERC20(asset).forceApprove(borrowPool, amount);
        ILendingPool(borrowPool).repay(asset, amount, 2, address(this));
        emit RepayCompleted(asset, amount, borrowPool);
    }

    /**
     * @notice Withdraw supplied assets
     */
    function _withdraw(address asset, uint256 amount) internal {
        uint256 withdrawn = ILendingPool(supplyPool).withdraw(asset, amount, address(this));
        emit WithdrawCompleted(asset, withdrawn, supplyPool);
    }

    /**
     * @notice Swap tokens via router
     */
    function _swap(address[] calldata path, uint256 amount) internal {
        if (path.length < 2) revert InvalidToken();
        
        // This is a simplified version - in production, use exact input swap
        IERC20(path[0]).forceApprove(swapRouter, amount);
        
        // Uniswap V2 style swap
        // In production, implement proper swap with slippage protection
        (bool success, ) = swapRouter.call(
            abi.encodeWithSignature(
                "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
                amount,
                0, // minAmountOut - should calculate dynamically
                path,
                address(this),
                block.timestamp + 300
            )
        );
        
        if (!success) revert SwapFailed();
    }

    /**
     * @notice Decode arbitrage parameters from bytes
     */
    function _decodeParams(bytes calldata params) 
        internal 
        pure 
        returns (ArbitrageParams memory) 
    {
        return abi.decode(params, (ArbitrageParams));
    }

    /**
     * @notice Set supply pool address
     */
    function setSupplyPool(address _supplyPool) external onlyOwner {
        supplyPool = _supplyPool;
    }

    /**
     * @notice Set borrow pool address
     */
    function setBorrowPool(address _borrowPool) external onlyOwner {
        borrowPool = _borrowPool;
    }

    /**
     * @notice Set swap router address
     */
    function setSwapRouter(address _swapRouter) external onlyOwner {
        swapRouter = _swapRouter;
    }

    /**
     * @notice Set minimum profit threshold
     */
    function setMinProfit(uint256 _minProfit) external onlyOwner {
        minProfit = _minProfit;
    }
}
