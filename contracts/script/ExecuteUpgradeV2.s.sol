// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Audit} from "../src/Audit.sol";
import {Escrow} from "../src/Escrow.sol";
import {OutcomeVoting} from "../src/OutcomeVoting.sol";

/// @title ExecuteUpgradeV2
/// @notice Executes the Audit V2 upgrade batch after the 72h timelock delay.
///         Requires AUDIT_IMPL_V2, ESCROW_IMPL_V2, OUTCOME_VOTING_IMPL_V2 env vars
///         set to the implementation addresses from UpgradeAuditV2 output.
contract ExecuteUpgradeV2 is Script {
    bytes32 constant UPGRADE_SALT = keccak256("audit-v2-2026-03-14");

    function run() external {
        address escrowProxy = vm.envAddress("ESCROW_PROXY");
        address auditProxy = vm.envAddress("AUDIT_PROXY");
        address outcomeVotingProxy = vm.envAddress("OUTCOME_VOTING_PROXY");
        TimelockController timelock = TimelockController(payable(vm.envAddress("TIMELOCK_ADDRESS")));

        address auditImpl = vm.envAddress("AUDIT_IMPL_V2");
        address escrowImpl = vm.envAddress("ESCROW_IMPL_V2");
        address votingImpl = vm.envAddress("OUTCOME_VOTING_IMPL_V2");

        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");

        console.log("Executing Audit V2 upgrade batch...");

        uint256 opCount = 9;
        address[] memory targets = new address[](opCount);
        uint256[] memory values = new uint256[](opCount);
        bytes[] memory payloads = new bytes[](opCount);

        targets[0] = escrowProxy;
        payloads[0] = abi.encodeCall(Escrow.pause, ());
        targets[1] = auditProxy;
        payloads[1] = abi.encodeCall(Audit.pause, ());
        targets[2] = outcomeVotingProxy;
        payloads[2] = abi.encodeCall(OutcomeVoting.pause, ());

        targets[3] = auditProxy;
        payloads[3] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (auditImpl, ""));
        targets[4] = escrowProxy;
        payloads[4] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (escrowImpl, ""));
        targets[5] = outcomeVotingProxy;
        payloads[5] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (votingImpl, ""));

        targets[6] = escrowProxy;
        payloads[6] = abi.encodeCall(Escrow.unpause, ());
        targets[7] = auditProxy;
        payloads[7] = abi.encodeCall(Audit.unpause, ());
        targets[8] = outcomeVotingProxy;
        payloads[8] = abi.encodeCall(OutcomeVoting.unpause, ());

        vm.startBroadcast(deployerKey);
        timelock.executeBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        vm.stopBroadcast();

        console.log("Audit V2 upgrade executed successfully.");
    }
}
