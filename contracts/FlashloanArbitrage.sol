// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IFlashLoanReceiver} from "./interfaces/IFlashLoanReceiver.sol";
import {IAavePool} from "./interfaces/IAavePool.sol";
import {IMorpho} from "./interfaces/IMorpho.sol";

/**
 * @title FlashloanArbitrage
 * @notice Core flashloan receiver contract for arbitrage execution
 */
contract FlashloanArbitrage is IFlashLoanReceiver {
    using SafeERC20 for IERC20;

    // Custom errors
    error OnlyAavePool();
    error OnlyMorpho();
    error InvalidCaller();
    error InvalidAmount();
    error FlashloanFailed();

    // State variables
    address public owner;
    address public aavePool;
    address public morpho;

    // Preferred flashloan source (0 = Morpho, 1 = Aave)
    // Default to Morpho (0 fee)
    uint8 public preferredSource; // 0 = Morpho, 1 = Aave

    // Flashloan fee (0.09% = 900)
    uint256 public constant AAVE_FEE = 900;
    uint256 public constant FEE_BASE = 1000000;

    // Events
    event FlashloanExecuted(
        address indexed asset,
        uint256 amount,
        uint256 fee,
        address indexed initiator
    );
    event AaveFlashloan(
        address indexed asset,
        uint256 amount,
        uint256 premium
    );
    event MorphoFlashloan(
        address indexed asset,
        uint256 amount,
        uint256 fee
    );
    event FlashloanSourceChanged(uint8 newSource);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    /**
     * @notice Constructor
     * @param _morpho Morpho address (primary flashloan source - 0 fee)
     * @param _aavePool Aave V3 pool address (fallback - 0.09% fee)
     */
    constructor(address _morpho, address _aavePool) {
        owner = msg.sender;
        morpho = _morpho;
        aavePool = _aavePool;
        preferredSource = 0; // Default to Morpho (0 fee)
    }

    /**
     * @notice Execute flashloan using preferred source (Morpho by default)
     * @param asset The asset to flashloan
     * @param amount The amount to flashloan
     * @param params Additional params encoded
     */
    function executeFlashloan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        if (preferredSource == 0) {
            executeMorphoFlashloan(asset, amount, params);
        } else {
            executeAaveFlashloan(asset, amount, params);
        }
    }

    /**
     * @notice Set preferred flashloan source
     * @param source 0 = Morpho (default, 0 fee), 1 = Aave (0.09% fee)
     */
    function setPreferredSource(uint8 source) external onlyOwner {
        require(source <= 1, "Invalid source");
        preferredSource = source;
        emit FlashloanSourceChanged(source);
    }

    /**
     * @notice Execute flashloan from Aave V3
     * @param asset The asset to flashloan
     * @param amount The amount to flashloan
     * @param params Additional params encoded
     */
    function executeAaveFlashloan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        if (amount == 0) revert InvalidAmount();

        address[] memory assets = new address[](1);
        assets[0] = asset;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        uint256[] memory modes = new uint256[](1);
        modes[0] = 0; // No borrow, just flashloan

        IAavePool(aavePool).flashLoan(
            address(this),
            assets,
            amounts,
            modes,
            address(this),
            params,
            0
        );
    }

    /**
     * @notice Execute flashloan from Morpho
     * @param asset The asset to flashloan
     * @param amount The amount to flashloan
     * @param params Additional params encoded
     */
    function executeMorphoFlashloan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        if (amount == 0) revert InvalidAmount();

        IMorpho(morpho).flashLoan(asset, amount, params);
    }

    /**
     * @notice Aave V3 flashloan callback
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // Validate caller is Aave pool
        if (msg.sender != aavePool) revert OnlyAavePool();

        // Emit event for each asset
        for (uint256 i = 0; i < assets.length; i++) {
            emit AaveFlashloan(assets[i], amounts[i], premiums[i]);
        }

        // Decode and execute the arbitrage
        _executeArbitrage(assets, amounts, premiums, initiator, params);

        // Approve pool to pull back flashloaned amounts + fees
        for (uint256 i = 0; i < assets.length; i++) {
            uint256 amountToRepay = amounts[i] + premiums[i];
            IERC20(assets[i].safeApprove(aavePool, amountToRepay));
        }

        return true;
    }

    /**
     * @notice Internal function to execute arbitrage logic
     * @dev This should be overridden to implement specific arbitrage strategies
     */
    function _executeArbitrage(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) internal virtual {
        // Decode params - to be implemented by child contracts
        // This is a placeholder that should be overridden
        (initiator, assets, amounts, premiums); // Silence unused warning
        require(params.length > 0, "No params");
    }

    /**
     * @notice Emergency withdraw - retrieve stuck tokens
     * @param token The token to withdraw
     * @param amount The amount to withdraw
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner, amount);
    }

    /**
     * @notice Update Aave pool address
     * @param _aavePool New pool address
     */
    function setAavePool(address _aavePool) external onlyOwner {
        aavePool = _aavePool;
    }

    /**
     * @notice Update Morpho address
     * @param _morpho New Morpho address
     */
    function setMorpho(address _morpho) external onlyOwner {
        morpho = _morpho;
    }

    receive() external payable {}
}
