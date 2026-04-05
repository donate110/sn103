// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {SignalCommitment} from "../src/SignalCommitment.sol";
import {Escrow} from "../src/Escrow.sol";

/// @title ScheduleUpgradeV4
/// @notice Deploys new implementations for SignalCommitment and Escrow (DEV-042),
///         then schedules a 6-operation batch through the TimelockController:
///         pause, upgradeToAndCall, unpause for each of the 2 proxies.
///
///         Changes:
///         - SignalCommitment: v2 off-chain decoy lines (linesHash, lineCount, bpaMode)
///         - Escrow: lockedOdds field in Purchase struct
///
///         After the 72h timelock delay, run ExecuteUpgradeV4.s.sol to execute.
///
///         Usage:
///           forge script script/ScheduleUpgradeV4.s.sol \
///             --rpc-url $BASE_RPC_URL --broadcast --verify
contract ScheduleUpgradeV4 is Script {
    bytes32 constant UPGRADE_SALT = keccak256("offchain-decoys-v4");

    // Proxy addresses (Base Sepolia)
    address constant SIGNAL_COMMITMENT_PROXY = 0x4712479Ba57c9ED40405607b2B18967B359209C0;
    address constant ESCROW_PROXY = 0xb43BA175a6784973eB3825acF801Cd7920ac692a;
    address constant TIMELOCK = 0x37f41EFfa8492022afF48B9Ef725008963F14f79;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(deployerKey);
        TimelockController timelock = TimelockController(payable(TIMELOCK));

        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);
        console.log("");

        vm.startBroadcast(deployerKey);

        // Deploy new implementation contracts
        address signalImpl = address(new SignalCommitment());
        address escrowImpl = address(new Escrow());

        console.log("New implementations deployed:");
        console.log("  SignalCommitment impl:", signalImpl);
        console.log("  Escrow impl:", escrowImpl);
        console.log("");

        // Build the 6-operation batch: (pause, upgrade, unpause) x 2 contracts
        uint256 opCount = 6;
        address[] memory targets = new address[](opCount);
        uint256[] memory values = new uint256[](opCount);
        bytes[] memory payloads = new bytes[](opCount);

        // --- Pause both proxies ---
        targets[0] = SIGNAL_COMMITMENT_PROXY;
        payloads[0] = abi.encodeCall(SignalCommitment.pause, ());

        targets[1] = ESCROW_PROXY;
        payloads[1] = abi.encodeCall(Escrow.pause, ());

        // --- Upgrade both proxies ---
        targets[2] = SIGNAL_COMMITMENT_PROXY;
        payloads[2] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (signalImpl, ""));

        targets[3] = ESCROW_PROXY;
        payloads[3] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (escrowImpl, ""));

        // --- Unpause both proxies ---
        targets[4] = SIGNAL_COMMITMENT_PROXY;
        payloads[4] = abi.encodeCall(SignalCommitment.unpause, ());

        targets[5] = ESCROW_PROXY;
        payloads[5] = abi.encodeCall(Escrow.unpause, ());

        // Schedule the batch through the timelock
        uint256 delay = timelock.getMinDelay();
        console.log("Timelock delay (seconds):", delay);

        timelock.scheduleBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT, delay);
        console.log("Batch scheduled.");

        bytes32 batchId = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        console.log("Batch operation ID:");
        console.logBytes32(batchId);

        vm.stopBroadcast();

        // Write implementation addresses for the execute script
        string memory implJson = string.concat(
            '{"signalCommitment":"', vm.toString(signalImpl),
            '","escrow":"', vm.toString(escrowImpl), '"}'
        );
        vm.writeFile("upgrade-impls-v4.json", implJson);
        console.log("");
        console.log("Implementation addresses saved to upgrade-impls-v4.json");

        // Summary
        uint256 executableAt = block.timestamp + delay;
        console.log("");
        console.log("=== UPGRADE SCHEDULED (DEV-042: Off-chain Decoys) ===");
        console.log("Executable after timestamp:", executableAt);
        console.log("");
        console.log("Proxy addresses (unchanged after upgrade):");
        console.log("  SignalCommitment:", SIGNAL_COMMITMENT_PROXY);
        console.log("  Escrow:", ESCROW_PROXY);
        console.log("");
        console.log("Set these env vars for ExecuteUpgradeV4.s.sol:");
        console.log("  SIGNAL_IMPL_V4=", signalImpl);
        console.log("  ESCROW_IMPL_V4=", escrowImpl);
    }
}
