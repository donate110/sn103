// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Account as DjinnAccount} from "../src/Account.sol";
import {Audit} from "../src/Audit.sol";
import {Collateral} from "../src/Collateral.sol";
import {Escrow} from "../src/Escrow.sol";
import {OutcomeVoting} from "../src/OutcomeVoting.sol";

/// @title ExecuteUpgrade
/// @notice Executes the scheduled audit-fix upgrade batch after the 72h timelock delay.
///         Must reproduce the exact 13-op batch from UpgradeAuditFixes.s.sol.
contract ExecuteUpgrade is Script {
    bytes32 constant UPGRADE_SALT = keccak256("audit-fixes-2026-03-13");

    struct Proxies {
        address account;
        address escrow;
        address collateral;
        address audit;
        address outcomeVoting;
        TimelockController timelock;
    }

    struct Impls {
        address account;
        address audit;
        address collateral;
        address escrow;
        address voting;
    }

    function run() external {
        Proxies memory px;
        px.account = vm.envAddress("ACCOUNT_PROXY");
        px.escrow = vm.envAddress("ESCROW_PROXY");
        px.collateral = vm.envAddress("COLLATERAL_PROXY");
        px.audit = vm.envAddress("AUDIT_PROXY");
        px.outcomeVoting = vm.envAddress("OUTCOME_VOTING_PROXY");
        px.timelock = TimelockController(payable(vm.envAddress("TIMELOCK_ADDRESS")));

        Impls memory im;
        im.account = vm.envAddress("ACCOUNT_IMPL");
        im.audit = vm.envAddress("AUDIT_IMPL");
        im.collateral = vm.envAddress("COLLATERAL_IMPL");
        im.escrow = vm.envAddress("ESCROW_IMPL");
        im.voting = vm.envAddress("VOTING_IMPL");

        // Rebuild the exact 13-op batch from UpgradeAuditFixes._scheduleBatch
        uint256 opCount = 13;
        address[] memory targets = new address[](opCount);
        uint256[] memory values = new uint256[](opCount);
        bytes[] memory payloads = new bytes[](opCount);

        // Pause phase (4 ops)
        targets[0] = px.collateral;
        payloads[0] = abi.encodeCall(Collateral.pause, ());

        targets[1] = px.escrow;
        payloads[1] = abi.encodeCall(Escrow.pause, ());

        targets[2] = px.audit;
        payloads[2] = abi.encodeCall(Audit.pause, ());

        targets[3] = px.account;
        payloads[3] = abi.encodeCall(DjinnAccount.pause, ());

        // Upgrade phase (5 ops)
        targets[4] = px.account;
        payloads[4] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (im.account, ""));

        targets[5] = px.audit;
        payloads[5] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (im.audit, ""));

        targets[6] = px.collateral;
        payloads[6] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (im.collateral, ""));

        targets[7] = px.escrow;
        payloads[7] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (im.escrow, ""));

        targets[8] = px.outcomeVoting;
        payloads[8] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (im.voting, ""));

        // Unpause phase (4 ops)
        targets[9] = px.collateral;
        payloads[9] = abi.encodeCall(Collateral.unpause, ());

        targets[10] = px.escrow;
        payloads[10] = abi.encodeCall(Escrow.unpause, ());

        targets[11] = px.audit;
        payloads[11] = abi.encodeCall(Audit.unpause, ());

        targets[12] = px.account;
        payloads[12] = abi.encodeCall(DjinnAccount.unpause, ());

        // Verify the batch hash matches the scheduled one
        bytes32 batchId = px.timelock.hashOperationBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        console.log("Batch operation ID:");
        console.logBytes32(batchId);

        bool isReady = px.timelock.isOperationReady(batchId);
        console.log("Is ready:", isReady);
        require(isReady, "Batch not ready yet (72h delay not elapsed)");

        // Execute
        vm.startBroadcast();
        px.timelock.executeBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        vm.stopBroadcast();

        console.log("");
        console.log("=== UPGRADE EXECUTED ===");
        console.log("All 5 proxies upgraded. Addresses unchanged.");
        console.log("All contracts unpaused.");
    }
}
