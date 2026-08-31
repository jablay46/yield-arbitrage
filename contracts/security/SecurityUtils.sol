// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ReentrancyGuard
 * @notice Prevents reentrant calls to protected functions
 */
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    uint256 private _status;

    error ReentrancyGuardReentrantCall();

    constructor() {
        _status = _NOT_ENTERED;
    }

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
 * @title Ownable2Step
 * @notice Ownership with a two-step transfer to avoid accidental loss of control
 */
abstract contract Ownable2Step {
    address public owner;
    address public pendingOwner;

    event OwnershipTransferStarted(
        address indexed previousOwner,
        address indexed newOwner
    );
    event OwnershipTransferred(
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
     * @notice Initiate ownership transfer to a new address, or cancel a
     *         pending transfer by passing address(0).
     * @param newOwner The address of the new owner, or address(0) to cancel
     * @dev The new owner must call acceptOwnership to complete the transfer.
     *      Passing address(0) clears any pending nomination without changing
     *      the current owner.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            // Cancel any pending transfer without relinquishing control.
            if (pendingOwner != address(0)) {
                emit OwnershipTransferStarted(owner, address(0));
                pendingOwner = address(0);
            }
            return;
        }
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /**
     * @notice Accept ownership transfer
     * @dev Only callable by the pending owner
     */
    function acceptOwnership() external onlyPendingOwner {
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    /**
     * @notice Renounce ownership, leaving the contract without an owner
     * @dev This action is irreversible and will disable all onlyOwner
     *      functions. Any pending nomination is cleared so a previously
     *      nominated account cannot accept ownership afterwards.
     */
    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
        pendingOwner = address(0);
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
 * @notice Circuit breaker. Pause control is exposed by the inheriting contract.
 */
abstract contract Pausable {
    event Paused(address account);
    event Unpaused(address account);

    error EnforcedPause();
    error ExpectedPause();

    bool private _paused;

    /**
     * @notice Check if the contract is currently paused
     * @return True if the contract is paused, false otherwise
     */
    function paused() public view returns (bool) {
        return _paused;
    }

    /**
     * @notice Internal function to pause the contract
     * @dev Triggers the Paused event and sets the paused state to true
     */
    function _pause() internal whenNotPaused {
        _paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Internal function to unpause the contract
     * @dev Triggers the Unpaused event and sets the paused state to false
     */
    function _unpause() internal whenPaused {
        _paused = false;
        emit Unpaused(msg.sender);
    }

    modifier whenNotPaused() {
        if (_paused) revert EnforcedPause();
        _;
    }

    modifier whenPaused() {
        if (!_paused) revert ExpectedPause();
        _;
    }
}

/**
 * @title SecurityUtils
 * @notice Combined security base: 2-step ownership, reentrancy guard, circuit breaker
 */
abstract contract SecurityUtils is Ownable2Step, ReentrancyGuard, Pausable {
    /**
     * @notice Pause the contract to prevent critical operations
     * @dev Only callable by the owner
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the contract to resume operations
     * @dev Only callable by the owner
     */
    function unpause() external onlyOwner {
        _unpause();
    }
}
