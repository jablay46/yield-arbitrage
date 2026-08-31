// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {LoopingExecutor} from "contracts/LoopingExecutor.sol";

/**
 * @notice Deploys LoopingExecutor for Base mainnet.
 *         Addresses were verified on-chain via PoolAddressesProvider.getPool().
 *
 * Run: forge script script/Deploy.s.sol --rpc-url base --broadcast --verify
 */
contract Deploy is Script {
    address constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant AAVE_ORACLE = 0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156;

    function run() public {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        LoopingExecutor executor = new LoopingExecutor(
            MORPHO,
            AAVE_POOL,
            AAVE_POOL,
            SWAP_ROUTER,
            AAVE_ORACLE
        );

        console.log("LoopingExecutor deployed at:", address(executor));

        vm.stopBroadcast();
    }
}
