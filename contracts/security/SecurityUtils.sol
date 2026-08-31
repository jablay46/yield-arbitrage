// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ReentrancyGuard
 * @notice Prevents reentrancy attacks
 */
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    uint256 private _status;

    error ReentrancyGuardReentrantCall();

    constructor() {
        _status = _NOT_ENTERED;
    }

    /**
     * @dev Prevents reentrancy by setting the status
     */
    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    function _nonReentrantBefore() private {
        if (_status == _ENTERED) {
            revert ReentrancyGuardReentrantCall();
        }
        _status = _ENTERED;
    }

    function _nonReentrantAfter() private {
        _status = _NOT_ENTERED;
    }
}

/**
 * @title Ownable
 * @notice Ownable contract with owner role
 */
abstract contract Ownable {
    address public owner;
    address public pendingOwner;

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );
    event OwnershipPending(
        address indexed previousOwner,
        address indexed newOwner
    );

    error OnlyOwner();
    error OnlyPendingOwner();
    error ZeroAddress();

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Transfer ownership to a new account
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipPending(owner, newOwner);
    }

    /**
     * @notice Accept ownership transfer
     */
    function acceptOwnership() external onlyPendingOwner {
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    /**
     * @notice Renounce ownership
     */
    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyPendingOwner() {
        if (msg.sender != pendingOwner) revert OnlyPendingOwner();
        _;
    }
}

/**
 * @title Pausable
 * @notice Circuit breaker pattern
 */
abstract contract Pausable {
    event Paused(address account);
    event Unpaused(address account);

    bool private _paused;

    error Paused();
    error NotPaused();

    constructor() {
        _paused = false;
    }

    /**
     * @notice Returns if contract is paused
     */
    function paused() public view returns (bool) {
        return _paused;
    }

    /**
     * @notice Pause the contract
     */
    function pause() external onlyOwner whenNotPaused {
        _paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Unpause the contract
     */
    function unpause() external onlyOwner whenPaused {
        _paused = false;
        emit Unpaused(msg.sender);
    }

    modifier whenNotPaused() {
        if (_paused) revert Paused();
        _;
    }

    modifier whenPaused() {
        if (!_paused) revert NotPaused();
        _;
    }

    // Use Ownable for onlyOwner
    function _msgSender() internal view virtual returns (address) {
        return msg.sender;
    }

    function _msgData() internal view virtual returns (bytes calldata) {
        return msg.data;
    }

    modifier onlyOwner() virtual;
}

/**
 * @title SecurityUtils
 * @notice Combined security utilities
 */
abstract contract SecurityUtils is Ownable, ReentrancyGuard, Pausable {
    // Inherit multiple security features
}
