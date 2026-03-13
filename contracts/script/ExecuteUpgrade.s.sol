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
///         Run this after the delay has elapsed:
///           forge script script/ExecuteUpgrade.s.sol --rpc-url $RPC_URL --broadcast
///
///         Set these env vars (from UpgradeAuditFixes output):
///           ACCOUNT_IMPL, AUDIT_IMPL, COLLATERAL_IMPL, ESCROW_IMPL, VOTING_IMPL
contract ExecuteUpgrade is Script {
    // ---- Real UUPS proxy addresses ----
    address constant ACCOUNT_PROXY = 0x5DDa635bbfC9c0c108457873006Dfcecd94f39ec;
    address constant ESCROW_PROXY = 0x50A1Bf4eacED9b9da4B1A5BA3001aA0979E91A21;
    address constant COLLATERAL_PROXY = 0x16C36aCe7aB4525Ed1D0F12a8E6c38f5be29cb16;
    address constant AUDIT_PROXY = 0x46F6DE92b4C37876435c5564E675B0DB885F1155;
    address constant OUTCOME_VOTING_PROXY = 0x28b5738ff35E207E90b2974cbfae2BdC556acAf6;

    // ---- TimelockController ----
    TimelockController constant TIMELOCK = TimelockController(payable(0x391a42fF273c1023095b30244c6F928898E06230));

    // ---- Must match the salt used in UpgradeAuditFixes ----
    bytes32 constant UPGRADE_SALT = keccak256("audit-fixes-2026-03-13");

    function run() external {
        address accountImpl = vm.envAddress("ACCOUNT_IMPL");
        address auditImpl = vm.envAddress("AUDIT_IMPL");
        address collateralImpl = vm.envAddress("COLLATERAL_IMPL");
        address escrowImpl = vm.envAddress("ESCROW_IMPL");
        address votingImpl = vm.envAddress("VOTING_IMPL");

        // Rebuild the exact same batch that was scheduled
        uint256 opCount = 9;
        address[] memory targets = new address[](opCount);
        uint256[] memory values = new uint256[](opCount);
        bytes[] memory payloads = new bytes[](opCount);

        targets[0] = COLLATERAL_PROXY;
        payloads[0] = abi.encodeCall(Collateral.pause, ());

        targets[1] = ESCROW_PROXY;
        payloads[1] = abi.encodeCall(Escrow.pause, ());

        targets[2] = ACCOUNT_PROXY;
        payloads[2] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (accountImpl, ""));

        targets[3] = AUDIT_PROXY;
        payloads[3] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (auditImpl, ""));

        targets[4] = COLLATERAL_PROXY;
        payloads[4] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (collateralImpl, ""));

        targets[5] = ESCROW_PROXY;
        payloads[5] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (escrowImpl, ""));

        targets[6] = OUTCOME_VOTING_PROXY;
        payloads[6] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (votingImpl, ""));

        targets[7] = COLLATERAL_PROXY;
        payloads[7] = abi.encodeCall(Collateral.unpause, ());

        targets[8] = ESCROW_PROXY;
        payloads[8] = abi.encodeCall(Escrow.unpause, ());

        // Verify the batch is ready
        bytes32 batchId = TIMELOCK.hashOperationBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        console.log("Batch operation ID:");
        console.logBytes32(batchId);

        bool isReady = TIMELOCK.isOperationReady(batchId);
        console.log("Is ready:", isReady);
        require(isReady, "Batch not ready yet (72h delay not elapsed)");

        // Execute
        vm.startBroadcast();

        TIMELOCK.executeBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);

        vm.stopBroadcast();

        // Verify
        console.log("");
        console.log("=== UPGRADE EXECUTED ===");
        console.log("All 5 proxies upgraded. Addresses unchanged.");
        console.log("Collateral and Escrow unpaused.");
    }
}
