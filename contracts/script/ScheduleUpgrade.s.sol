// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Account as DjinnAccount} from "../src/Account.sol";
import {Escrow} from "../src/Escrow.sol";
import {Audit} from "../src/Audit.sol";
import {OutcomeVoting} from "../src/OutcomeVoting.sol";

/// @title ScheduleUpgrade
/// @notice Deploys new implementations for Account, Escrow, Audit, and OutcomeVoting,
///         then schedules an atomic 12-operation batch through the TimelockController:
///         pause, upgradeToAndCall, unpause for each of the 4 proxies.
///
///         After the 72h timelock delay, run ExecuteUpgrade.s.sol to execute the batch.
///
///         Usage:
///           forge script script/ScheduleUpgrade.s.sol \
///             --rpc-url $BASE_RPC_URL --broadcast --verify
contract ScheduleUpgrade is Script {
    bytes32 constant UPGRADE_SALT = keccak256("queue-based-audits-v2");

    // Proxy addresses (Base Sepolia)
    address constant ACCOUNT_PROXY = 0x4546354Dd32a613B76Abf530F81c8359e7cE440B;
    address constant ESCROW_PROXY = 0xb43BA175a6784973eB3825acF801Cd7920ac692a;
    address constant AUDIT_PROXY = 0xCa7e642FE31BA83a7a857644E8894c1B93a2a44E;
    address constant OUTCOME_VOTING_PROXY = 0xAD534f4CAB13707BD4d65e4EF086A455e6A643e5;
    address constant TIMELOCK = 0x37f41EFfa8492022afF48B9Ef725008963F14f79;

    struct Impls {
        address account;
        address escrow;
        address audit;
        address voting;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(deployerKey);
        TimelockController timelock = TimelockController(payable(TIMELOCK));

        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);
        console.log("");

        vm.startBroadcast(deployerKey);

        // Deploy new implementation contracts
        Impls memory im;
        im.account = address(new DjinnAccount());
        im.escrow = address(new Escrow());
        im.audit = address(new Audit());
        im.voting = address(new OutcomeVoting());

        console.log("New implementations deployed:");
        console.log("  Account impl:", im.account);
        console.log("  Escrow impl:", im.escrow);
        console.log("  Audit impl:", im.audit);
        console.log("  OutcomeVoting impl:", im.voting);
        console.log("");

        // Build the 12-operation batch: (pause, upgrade, unpause) x 4 contracts
        uint256 opCount = 12;
        address[] memory targets = new address[](opCount);
        uint256[] memory values = new uint256[](opCount);
        bytes[] memory payloads = new bytes[](opCount);

        // --- Pause all 4 proxies ---
        targets[0] = ACCOUNT_PROXY;
        payloads[0] = abi.encodeCall(DjinnAccount.pause, ());

        targets[1] = ESCROW_PROXY;
        payloads[1] = abi.encodeCall(Escrow.pause, ());

        targets[2] = AUDIT_PROXY;
        payloads[2] = abi.encodeCall(Audit.pause, ());

        targets[3] = OUTCOME_VOTING_PROXY;
        payloads[3] = abi.encodeCall(OutcomeVoting.pause, ());

        // --- Upgrade all 4 proxies ---
        targets[4] = ACCOUNT_PROXY;
        payloads[4] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (im.account, ""));

        targets[5] = ESCROW_PROXY;
        payloads[5] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (im.escrow, ""));

        targets[6] = AUDIT_PROXY;
        payloads[6] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (im.audit, ""));

        targets[7] = OUTCOME_VOTING_PROXY;
        payloads[7] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (im.voting, ""));

        // --- Unpause all 4 proxies ---
        targets[8] = ACCOUNT_PROXY;
        payloads[8] = abi.encodeCall(DjinnAccount.unpause, ());

        targets[9] = ESCROW_PROXY;
        payloads[9] = abi.encodeCall(Escrow.unpause, ());

        targets[10] = AUDIT_PROXY;
        payloads[10] = abi.encodeCall(Audit.unpause, ());

        targets[11] = OUTCOME_VOTING_PROXY;
        payloads[11] = abi.encodeCall(OutcomeVoting.unpause, ());

        // Schedule the batch through the timelock
        uint256 delay = timelock.getMinDelay();
        console.log("Timelock delay (seconds):", delay);

        timelock.scheduleBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT, delay);
        console.log("Batch scheduled.");

        bytes32 batchId = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        console.log("Batch operation ID:");
        console.logBytes32(batchId);

        vm.stopBroadcast();

        // Write implementation addresses to a file for the execute script
        string memory implJson = string.concat(
            '{"account":"', vm.toString(im.account),
            '","escrow":"', vm.toString(im.escrow),
            '","audit":"', vm.toString(im.audit),
            '","voting":"', vm.toString(im.voting), '"}'
        );
        vm.writeFile("upgrade-impls.json", implJson);
        console.log("");
        console.log("Implementation addresses saved to upgrade-impls.json");

        // Summary
        uint256 executableAt = block.timestamp + delay;
        console.log("");
        console.log("=== UPGRADE SCHEDULED ===");
        console.log("Executable after timestamp:", executableAt);
        console.log("");
        console.log("Proxy addresses (unchanged after upgrade):");
        console.log("  Account:", ACCOUNT_PROXY);
        console.log("  Escrow:", ESCROW_PROXY);
        console.log("  Audit:", AUDIT_PROXY);
        console.log("  OutcomeVoting:", OUTCOME_VOTING_PROXY);
        console.log("");
        console.log("Set these env vars for ExecuteUpgrade.s.sol:");
        console.log("  ACCOUNT_IMPL_V3=", im.account);
        console.log("  ESCROW_IMPL_V3=", im.escrow);
        console.log("  AUDIT_IMPL_V3=", im.audit);
        console.log("  OUTCOME_VOTING_IMPL_V3=", im.voting);
    }
}
