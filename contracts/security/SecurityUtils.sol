// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SecurityUtils
 * @notice Combined security base delegating to OpenZeppelin's audited modules:
 *         two-step ownership, reentrancy guard, and a pause circuit breaker.
 *
 *         A thin `ZeroAddress` error is exposed so inheriting contracts can
 *         keep their existing validation messages without colliding with
 *         OZ's own error selectors.
 */
abstract contract SecurityUtils is Ownable2Step, ReentrancyGuard, Pausable {
    error ZeroAddress();

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
