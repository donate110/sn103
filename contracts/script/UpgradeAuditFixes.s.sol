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
///         The batch atomically: pause Collateral/Escrow, upgrade all 5 proxies, unpause.
///         Also deploys a fresh TrackRecord proxy (not previously deployed).
contract UpgradeAuditFixes is Script {
    // ---- Real UUPS proxy addresses (Base Sepolia, deployed 2026-03-02) ----
    address constant ACCOUNT_PROXY = 0x5DDa635bbfC9c0c108457873006Dfcecd94f39ec;
    address constant ESCROW_PROXY = 0x50A1Bf4eacED9b9da4B1A5BA3001aA0979E91A21;
    address constant COLLATERAL_PROXY = 0x16C36aCe7aB4525Ed1D0F12a8E6c38f5be29cb16;
    address constant AUDIT_PROXY = 0x46F6DE92b4C37876435c5564E675B0DB885F1155;
    address constant OUTCOME_VOTING_PROXY = 0x28b5738ff35E207E90b2974cbfae2BdC556acAf6;

    // ---- TimelockController ----
    TimelockController constant TIMELOCK = TimelockController(payable(0x391a42fF273c1023095b30244c6F928898E06230));

    // ---- Salt for this upgrade batch (prevents collisions with other scheduled ops) ----
    bytes32 constant UPGRADE_SALT = keccak256("audit-fixes-2026-03-13");

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);
        console.log("");

        vm.startBroadcast(deployerKey);

        // ================================================================
        // 1. Deploy new implementation contracts
        // ================================================================

        DjinnAccount accountImpl = new DjinnAccount();
        console.log("Account impl:", address(accountImpl));

        Audit auditImpl = new Audit();
        console.log("Audit impl:", address(auditImpl));

        Collateral collateralImpl = new Collateral();
        console.log("Collateral impl:", address(collateralImpl));

        Escrow escrowImpl = new Escrow();
        console.log("Escrow impl:", address(escrowImpl));

        OutcomeVoting votingImpl = new OutcomeVoting();
        console.log("OutcomeVoting impl:", address(votingImpl));

        // ================================================================
        // 2. Build the batch: pause, upgrade x5, unpause (9 operations)
        // ================================================================

        uint256 opCount = 9;
        address[] memory targets = new address[](opCount);
        uint256[] memory values = new uint256[](opCount);
        bytes[] memory payloads = new bytes[](opCount);

        // Op 0: Collateral.pause()
        targets[0] = COLLATERAL_PROXY;
        payloads[0] = abi.encodeCall(Collateral.pause, ());

        // Op 1: Escrow.pause()
        targets[1] = ESCROW_PROXY;
        payloads[1] = abi.encodeCall(Escrow.pause, ());

        // Op 2: Account.upgradeToAndCall(newImpl, "")
        targets[2] = ACCOUNT_PROXY;
        payloads[2] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(accountImpl), ""));

        // Op 3: Audit.upgradeToAndCall(newImpl, "")
        targets[3] = AUDIT_PROXY;
        payloads[3] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(auditImpl), ""));

        // Op 4: Collateral.upgradeToAndCall(newImpl, "")
        targets[4] = COLLATERAL_PROXY;
        payloads[4] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(collateralImpl), ""));

        // Op 5: Escrow.upgradeToAndCall(newImpl, "")
        targets[5] = ESCROW_PROXY;
        payloads[5] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(escrowImpl), ""));

        // Op 6: OutcomeVoting.upgradeToAndCall(newImpl, "")
        targets[6] = OUTCOME_VOTING_PROXY;
        payloads[6] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(votingImpl), ""));

        // Op 7: Collateral.unpause()
        targets[7] = COLLATERAL_PROXY;
        payloads[7] = abi.encodeCall(Collateral.unpause, ());

        // Op 8: Escrow.unpause()
        targets[8] = ESCROW_PROXY;
        payloads[8] = abi.encodeCall(Escrow.unpause, ());

        // ================================================================
        // 3. Schedule the batch through the TimelockController
        // ================================================================

        uint256 delay = TIMELOCK.getMinDelay();
        console.log("Timelock delay (seconds):", delay);

        TIMELOCK.scheduleBatch(
            targets,
            values,
            payloads,
            bytes32(0), // no predecessor
            UPGRADE_SALT,
            delay
        );
        console.log("Batch scheduled. Executable after delay.");

        // Compute and log the batch operation ID for the execute script
        bytes32 batchId = TIMELOCK.hashOperationBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        console.log("Batch operation ID:");
        console.logBytes32(batchId);

        // ================================================================
        // 4. Deploy fresh TrackRecord proxy (no existing proxy)
        // ================================================================

        TrackRecord trImpl = new TrackRecord();
        address trProxy = address(
            new ERC1967Proxy(
                address(trImpl),
                abi.encodeCall(TrackRecord.initialize, (deployer))
            )
        );
        console.log("TrackRecord proxy (NEW):", trProxy);

        vm.stopBroadcast();

        // ================================================================
        // Summary
        // ================================================================
        console.log("");
        console.log("=== SCHEDULE COMPLETE ===");
        console.log("Upgrades will be executable after", delay, "seconds");
        console.log("");
        console.log("Proxy addresses (UNCHANGED after upgrade):");
        console.log("  Account:", ACCOUNT_PROXY);
        console.log("  Audit:", AUDIT_PROXY);
        console.log("  Collateral:", COLLATERAL_PROXY);
        console.log("  Escrow:", ESCROW_PROXY);
        console.log("  OutcomeVoting:", OUTCOME_VOTING_PROXY);
        console.log("  TrackRecord (NEW):", trProxy);
        console.log("");
        console.log("New implementations:");
        console.log("  Account:", address(accountImpl));
        console.log("  Audit:", address(auditImpl));
        console.log("  Collateral:", address(collateralImpl));
        console.log("  Escrow:", address(escrowImpl));
        console.log("  OutcomeVoting:", address(votingImpl));
        console.log("  TrackRecord:", address(trImpl));
    }
}
