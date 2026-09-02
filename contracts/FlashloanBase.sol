// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IFlashLoanReceiver} from "./interfaces/IFlashLoanReceiver.sol";
import {IAavePool} from "./interfaces/IAavePool.sol";
import {IMorpho, IMorphoFlashLoanCallback} from "./interfaces/IMorpho.sol";
import {SecurityUtils} from "./security/SecurityUtils.sol";

/**
 * @title FlashloanBase
 * @notice Base flashloan receiver supporting Morpho Blue (0% fee, primary)
 *         and Aave V3 (0.05% fee, fallback).
 *
 * @dev Callbacks are intentionally NOT nonReentrant: they are invoked from
 *      within nonReentrant entry points. They are instead protected by strict
 *      caller/initiator validation, which is what actually matters here.
 */
abstract contract FlashloanBase is
    IFlashLoanReceiver,
    IMorphoFlashLoanCallback,
    SecurityUtils
{
    using SafeERC20 for IERC20;

    error OnlyAavePool();
    error OnlyMorpho();
    error InvalidInitiator();
    error InvalidAmount();
    error NoActiveFlashloan();

    enum FlashloanSource {
        Morpho, // 0% fee
        Aave    // 0.05% fee (FLASHLOAN_PREMIUM_TOTAL)
    }

    address public aavePool;
    address public morpho;
    FlashloanSource public preferredSource;

    /// @dev Morpho's callback does not carry the token address, so it is
    ///      stored right before initiating and cleared after repayment.
    address private _activeFlashAsset;

    event FlashloanInitiated(
        FlashloanSource indexed source,
        address indexed asset,
        uint256 amount
    );
    event FlashloanSourceChanged(FlashloanSource newSource);
    // Keep these events unindexed for log-encoding compatibility with
    // deployed instances and existing consumers.
    // forge-lint: disable-start(event-fields)
    event AavePoolUpdated(address newPool);
    event MorphoUpdated(address newMorpho);
    // forge-lint: disable-end(event-fields)
    event EmergencyWithdraw(
        address indexed token,
        uint256 amount,
        address indexed to
    );

    constructor(address _morpho, address _aavePool) Ownable(msg.sender) {
        if (_morpho == address(0) || _aavePool == address(0)) {
            revert ZeroAddress();
        }
        morpho = _morpho;
        aavePool = _aavePool;
        preferredSource = FlashloanSource.Morpho;
    }

    /**
     * @notice Set the preferred flashloan source (Morpho or Aave)
     * @param source The flashloan source to use (Morpho = 0% fee, Aave = 0.05% fee)
     */
    function setPreferredSource(FlashloanSource source) external onlyOwner {
        preferredSource = source;
        emit FlashloanSourceChanged(source);
    }

    /**
     * @notice Update the Aave pool address
     * @param _aavePool The new Aave pool address
     */
    function setAavePool(address _aavePool) external onlyOwner {
        if (_aavePool == address(0)) revert ZeroAddress();
        aavePool = _aavePool;
        emit AavePoolUpdated(_aavePool);
    }

    /**
     * @notice Update the Morpho Blue contract address
     * @param _morpho The new Morpho Blue address
     */
    function setMorpho(address _morpho) external onlyOwner {
        if (_morpho == address(0)) revert ZeroAddress();
        morpho = _morpho;
        emit MorphoUpdated(_morpho);
    }

    /**
     * @notice Initiate a flashloan from the preferred source
     */
    function _initiateFlashloan(
        address asset,
        uint256 amount,
        bytes memory data
    ) internal {
        if (amount == 0) revert InvalidAmount();

        emit FlashloanInitiated(preferredSource, asset, amount);

        if (preferredSource == FlashloanSource.Morpho) {
            _activeFlashAsset = asset;
            // Reentrancy into the callback is guarded by the entry
            // functions' nonReentrant modifier in LoopingExecutor.
            // forge-lint: disable-next-line(reentrancy-no-eth)
            IMorpho(morpho).flashLoan(asset, amount, data);
            _activeFlashAsset = address(0);
        } else {
            address[] memory assets = new address[](1);
            assets[0] = asset;

            uint256[] memory amounts = new uint256[](1);
            amounts[0] = amount;

            uint256[] memory modes = new uint256[](1);
            modes[0] = 0; // 0 = no debt, full repayment

            // forge-lint: disable-start(reentrancy-no-eth)
            IAavePool(aavePool).flashLoan(
                address(this),
                assets,
                amounts,
                modes,
                address(this),
                data,
                0
            );
            // forge-lint: disable-end(reentrancy-no-eth)
        }
    }

    /**
     * @notice Aave V3 flashloan callback
     * @dev Only callable by the Aave pool, and only for loans initiated by
     *      this contract — otherwise anyone could force this contract into
     *      arbitrary flashloan logic.
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != aavePool) revert OnlyAavePool();
        if (initiator != address(this)) revert InvalidInitiator();

        _executeWithFunds(assets[0], amounts[0], premiums[0], params);

        // Approve the pool to pull back principal + premium
        IERC20(assets[0]).forceApprove(aavePool, amounts[0] + premiums[0]);
        return true;
    }

    /**
     * @notice Morpho Blue flashloan callback (0% fee)
     * @dev Morpho Blue pulls repayment via transferFrom after this callback,
     *      so it only needs an allowance.
     */
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != morpho) revert OnlyMorpho();
        address asset = _activeFlashAsset;
        if (asset == address(0)) revert NoActiveFlashloan();

        _executeWithFunds(asset, assets, 0, data);

        IERC20(asset).forceApprove(morpho, assets);
    }

    /**
     * @notice Strategy logic executed while holding flashloaned funds.
     *         Must leave the contract with >= amount + premium of `asset`.
     */
    function _executeWithFunds(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory data
    ) internal virtual;

    /**
     * @notice Rescue tokens stuck on the contract.
     * @dev Overridable so derived contracts can forbid withdrawing assets that
     *      back an active position (which would silently break the loop).
     */
    function emergencyWithdraw(address token, uint256 amount) external virtual onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
        emit EmergencyWithdraw(token, amount, owner());
    }
}
