// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Account as DjinnAccount} from "../src/Account.sol";
import {Audit} from "../src/Audit.sol";
import {Collateral} from "../src/Collateral.sol";
import {Escrow} from "../src/Escrow.sol";
import {OutcomeVoting} from "../src/OutcomeVoting.sol";
import {TrackRecord} from "../src/TrackRecord.sol";

/// @title UpgradeAuditFixes
/// @notice Deploys new implementations and schedules UUPS upgrades through the TimelockController.
///         Step 1 (this script): Deploy impls + schedule batch. Takes effect after 72h.
///         Step 2 (ExecuteUpgrade.s.sol): Execute the batch after the delay.
///
///         The batch atomically: pause Collateral/Escrow/Audit, upgrade all 5 proxies, unpause.
///         Also deploys a fresh TrackRecord proxy (not previously deployed).
contract UpgradeAuditFixes is Script {
    // ---- Salt for this upgrade batch (prevents collisions with other scheduled ops) ----
    bytes32 constant UPGRADE_SALT = keccak256("audit-fixes-2026-03-13");

    // CF-16: Proxy/timelock addresses are packed into a struct to avoid stack-too-deep
    struct Proxies {
        address account;
        address escrow;
        address collateral;
        address audit;
        address outcomeVoting;
        TimelockController timelock;
    }

    function _loadProxies() internal view returns (Proxies memory p) {
        p.account = vm.envAddress("ACCOUNT_PROXY");
        p.escrow = vm.envAddress("ESCROW_PROXY");
        p.collateral = vm.envAddress("COLLATERAL_PROXY");
        p.audit = vm.envAddress("AUDIT_PROXY");
        p.outcomeVoting = vm.envAddress("OUTCOME_VOTING_PROXY");
        p.timelock = TimelockController(payable(vm.envAddress("TIMELOCK_ADDRESS")));
    }

    struct Impls {
        address account;
        address audit;
        address collateral;
        address escrow;
        address voting;
        address trackRecord;
        address trackRecordProxy;
    }

    function run() external {
        // CF-16: Read proxy addresses from environment for reusability across chains
        Proxies memory px = _loadProxies();

        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);
        console.log("");

        vm.startBroadcast(deployerKey);

        Impls memory im;
        im.account = address(new DjinnAccount());
        console.log("Account impl:", im.account);

        im.audit = address(new Audit());
        console.log("Audit impl:", im.audit);

        im.collateral = address(new Collateral());
        console.log("Collateral impl:", im.collateral);

        im.escrow = address(new Escrow());
        console.log("Escrow impl:", im.escrow);

        im.voting = address(new OutcomeVoting());
        console.log("OutcomeVoting impl:", im.voting);

        _scheduleBatch(px, im);

        im.trackRecord = address(new TrackRecord());
        im.trackRecordProxy = address(
            new ERC1967Proxy(
                im.trackRecord,
                abi.encodeCall(TrackRecord.initialize, (deployer))
            )
        );
        console.log("TrackRecord proxy (NEW):", im.trackRecordProxy);

        vm.stopBroadcast();

        _logSummary(px, px.timelock.getMinDelay(), im);
    }

    function _scheduleBatch(Proxies memory px, Impls memory im) internal {
        uint256 opCount = 13;
        address[] memory targets = new address[](opCount);
        uint256[] memory values = new uint256[](opCount);
        bytes[] memory payloads = new bytes[](opCount);

        // Op 0: Collateral.pause()
        targets[0] = px.collateral;
        payloads[0] = abi.encodeCall(Collateral.pause, ());

        // Op 1: Escrow.pause()
        targets[1] = px.escrow;
        payloads[1] = abi.encodeCall(Escrow.pause, ());

        // Op 2: Audit.pause() (CF-01: required before upgrade, _authorizeUpgrade is whenPaused)
        targets[2] = px.audit;
        payloads[2] = abi.encodeCall(Audit.pause, ());

        // Op 3: Account.pause() (CF-10: Account._authorizeUpgrade is whenPaused)
        targets[3] = px.account;
        payloads[3] = abi.encodeCall(DjinnAccount.pause, ());

        // Op 4-8: Upgrade all 5 proxies
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

        // Op 9-12: Unpause
        targets[9] = px.collateral;
        payloads[9] = abi.encodeCall(Collateral.unpause, ());

        targets[10] = px.escrow;
        payloads[10] = abi.encodeCall(Escrow.unpause, ());

        targets[11] = px.audit;
        payloads[11] = abi.encodeCall(Audit.unpause, ());

        // Op 12: Account.unpause() (CF-10)
        targets[12] = px.account;
        payloads[12] = abi.encodeCall(DjinnAccount.unpause, ());

        uint256 delay = px.timelock.getMinDelay();
        console.log("Timelock delay (seconds):", delay);

        px.timelock.scheduleBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT, delay);
        console.log("Batch scheduled. Executable after delay.");

        bytes32 batchId = px.timelock.hashOperationBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        console.log("Batch operation ID:");
        console.logBytes32(batchId);
    }

    function _logSummary(Proxies memory px, uint256 delay, Impls memory im) internal pure {
        console.log("");
        console.log("=== SCHEDULE COMPLETE ===");
        console.log("Upgrades will be executable after", delay, "seconds");
        console.log("");
        console.log("Proxy addresses (UNCHANGED after upgrade):");
        console.log("  Account:", px.account);
        console.log("  Audit:", px.audit);
        console.log("  Collateral:", px.collateral);
        console.log("  Escrow:", px.escrow);
        console.log("  OutcomeVoting:", px.outcomeVoting);
        console.log("  TrackRecord (NEW):", im.trackRecordProxy);
        console.log("");
        console.log("New implementations:");
        console.log("  Account:", im.account);
        console.log("  Audit:", im.audit);
        console.log("  Collateral:", im.collateral);
        console.log("  Escrow:", im.escrow);
        console.log("  OutcomeVoting:", im.voting);
        console.log("  TrackRecord:", im.trackRecord);
    }
}
