// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Audit} from "../src/Audit.sol";
import {Escrow} from "../src/Escrow.sol";
import {OutcomeVoting} from "../src/OutcomeVoting.sol";

/// @title UpgradeAuditV2
/// @notice Second upgrade batch following the initial audit fixes (UpgradeAuditFixes).
///         Run AFTER the first batch has been executed on 2026-03-16.
///
///         Fixes applied:
///           H-1: Audit.settleByVote/earlyExitByVote bound totalNotional to MAX_CYCLE_NOTIONAL
///           M-2: Escrow.canPurchase includes protocol fee lock in collateral check
///           M-7: OutcomeVoting.resetCycle for stuck cycle recovery
///
///         Step 1 (this script): Deploy new impls + schedule batch. 72h delay.
///         Step 2 (ExecuteUpgradeV2.s.sol): Execute after delay.
contract UpgradeAuditV2 is Script {
    bytes32 constant UPGRADE_SALT = keccak256("audit-v2-2026-03-14");

    struct Proxies {
        address escrow;
        address audit;
        address outcomeVoting;
        TimelockController timelock;
    }

    struct Impls {
        address audit;
        address escrow;
        address voting;
    }

    function run() external {
        Proxies memory px;
        px.escrow = vm.envAddress("ESCROW_PROXY");
        px.audit = vm.envAddress("AUDIT_PROXY");
        px.outcomeVoting = vm.envAddress("OUTCOME_VOTING_PROXY");
        px.timelock = TimelockController(payable(vm.envAddress("TIMELOCK_ADDRESS")));

        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        console.log("Deployer:", vm.addr(deployerKey));
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast(deployerKey);

        Impls memory im;
        im.audit = address(new Audit());
        im.escrow = address(new Escrow());
        im.voting = address(new OutcomeVoting());

        console.log("Audit impl:", im.audit);
        console.log("Escrow impl:", im.escrow);
        console.log("OutcomeVoting impl:", im.voting);

        _scheduleBatch(px, im);

        vm.stopBroadcast();
        _logSummary(px, im);
    }

    function _scheduleBatch(Proxies memory px, Impls memory im) internal {
        uint256 opCount = 9;
        address[] memory targets = new address[](opCount);
        uint256[] memory values = new uint256[](opCount);
        bytes[] memory payloads = new bytes[](opCount);

        // Pause
        targets[0] = px.escrow;
        payloads[0] = abi.encodeCall(Escrow.pause, ());
        targets[1] = px.audit;
        payloads[1] = abi.encodeCall(Audit.pause, ());
        targets[2] = px.outcomeVoting;
        payloads[2] = abi.encodeCall(OutcomeVoting.pause, ());

        // Upgrade
        targets[3] = px.audit;
        payloads[3] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (im.audit, ""));
        targets[4] = px.escrow;
        payloads[4] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (im.escrow, ""));
        targets[5] = px.outcomeVoting;
        payloads[5] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (im.voting, ""));

        // Unpause
        targets[6] = px.escrow;
        payloads[6] = abi.encodeCall(Escrow.unpause, ());
        targets[7] = px.audit;
        payloads[7] = abi.encodeCall(Audit.unpause, ());
        targets[8] = px.outcomeVoting;
        payloads[8] = abi.encodeCall(OutcomeVoting.unpause, ());

        uint256 delay = px.timelock.getMinDelay();
        console.log("Timelock delay (seconds):", delay);

        px.timelock.scheduleBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT, delay);
        console.log("Batch scheduled.");

        bytes32 batchId = px.timelock.hashOperationBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        console.log("Batch ID:");
        console.logBytes32(batchId);
    }

    function _logSummary(Proxies memory px, Impls memory im) internal pure {
        console.log("");
        console.log("=== AUDIT V2 UPGRADE SCHEDULED ===");
        console.log("Proxies: Audit=", px.audit);
        console.log("         Escrow=", px.escrow);
        console.log("         OutcomeVoting=", px.outcomeVoting);
        console.log("Impls:   Audit=", im.audit);
        console.log("         Escrow=", im.escrow);
        console.log("         OutcomeVoting=", im.voting);
    }
}
