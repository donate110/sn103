// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Account as DjinnAccount} from "../src/Account.sol";
import {Escrow} from "../src/Escrow.sol";
import {Audit} from "../src/Audit.sol";
import {OutcomeVoting} from "../src/OutcomeVoting.sol";
import {SignalCommitment} from "../src/SignalCommitment.sol";

/// @title CancelAndRescheduleV4
/// @notice 1) Cancels the pending V3 batch (queue-based-audits-v2)
///         2) Deploys new implementations for ALL 5 contracts
///         3) Schedules a combined 15-op batch (pause, upgrade, unpause x5)
///
///         This merges the V3 (queue-based-audits) and V4 (off-chain decoys)
///         upgrades into a single atomic timelock operation.
///
///         Usage:
///           forge script script/CancelAndRescheduleV4.s.sol \
///             --rpc-url $BASE_RPC_URL --broadcast --verify
contract CancelAndRescheduleV4 is Script {
    // Salt for the OLD V3 batch (must match ScheduleUpgrade.s.sol exactly)
    bytes32 constant V3_SALT = keccak256("queue-based-audits-v2");
    // Salt for the NEW combined batch
    bytes32 constant V4_SALT = keccak256("combined-v4-offchain-decoys");

    // Proxy addresses (Base Sepolia)
    address constant ACCOUNT_PROXY = 0x4546354Dd32a613B76Abf530F81c8359e7cE440B;
    address constant ESCROW_PROXY = 0xb43BA175a6784973eB3825acF801Cd7920ac692a;
    address constant AUDIT_PROXY = 0xCa7e642FE31BA83a7a857644E8894c1B93a2a44E;
    address constant OUTCOME_VOTING_PROXY = 0xAD534f4CAB13707BD4d65e4EF086A455e6A643e5;
    address constant SIGNAL_COMMITMENT_PROXY = 0x4712479Ba57c9ED40405607b2B18967B359209C0;
    address constant TIMELOCK = 0x37f41EFfa8492022afF48B9Ef725008963F14f79;

    // Old V3 implementation addresses (needed to reconstruct the batch hash for cancellation)
    address constant V3_ACCOUNT_IMPL = 0xC7546F1C6Fb3B393305ECD11D56A88AD027Bf35A;
    address constant V3_ESCROW_IMPL = 0xE585313D56798A4CF0ba7AF599a3FE2A5AE57c18;
    address constant V3_AUDIT_IMPL = 0x2afA767Fe7C1F0905eF5d0902026Fd114D1503D2;
    address constant V3_VOTING_IMPL = 0x77c04Fe1ec2e0b24E386d5d7ad3631845790a4B2;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(deployerKey);
        TimelockController timelock = TimelockController(payable(TIMELOCK));

        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);
        console.log("");

        // ─── Step 1: Cancel the pending V3 batch ───
        // Reconstruct the V3 batch to get its ID
        (address[] memory v3Targets, uint256[] memory v3Values, bytes[] memory v3Payloads) = _buildV3Batch();
        bytes32 v3BatchId = timelock.hashOperationBatch(v3Targets, v3Values, v3Payloads, bytes32(0), V3_SALT);

        bool v3Pending = timelock.isOperationPending(v3BatchId);
        console.log("V3 batch ID:");
        console.logBytes32(v3BatchId);
        console.log("V3 batch pending:", v3Pending);

        vm.startBroadcast(deployerKey);

        if (v3Pending) {
            timelock.cancel(v3BatchId);
            console.log("V3 batch CANCELLED.");
        } else {
            console.log("V3 batch not pending (already executed or never scheduled). Skipping cancel.");
        }

        // ─── Step 2: Deploy + schedule combined batch ───
        address[5] memory impls;
        impls[0] = address(new DjinnAccount());
        impls[1] = address(new Escrow());
        impls[2] = address(new Audit());
        impls[3] = address(new OutcomeVoting());
        impls[4] = address(new SignalCommitment());

        console.log("New implementations deployed:");
        console.log("  Account:", impls[0]);
        console.log("  Escrow:", impls[1]);
        console.log("  Audit:", impls[2]);
        console.log("  OutcomeVoting:", impls[3]);
        console.log("  SignalCommitment:", impls[4]);

        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _buildV4Batch(impls);

        uint256 delay = timelock.getMinDelay();
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), V4_SALT, delay);

        bytes32 batchId = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), V4_SALT);
        console.log("Combined batch scheduled. Batch ID:");
        console.logBytes32(batchId);

        vm.stopBroadcast();

        vm.writeFile("upgrade-impls-v4.json", string.concat(
            '{"account":"', vm.toString(impls[0]),
            '","escrow":"', vm.toString(impls[1]),
            '","audit":"', vm.toString(impls[2]),
            '","voting":"', vm.toString(impls[3]),
            '","signal":"', vm.toString(impls[4]), '"}'
        ));

        console.log("");
        console.log("=== COMBINED UPGRADE SCHEDULED ===");
        console.log("Executable after:", block.timestamp + delay);
        console.log("Delay (seconds):", delay);
    }

    function _buildV4Batch(address[5] memory impls) internal pure returns (
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory payloads
    ) {
        targets = new address[](15);
        values = new uint256[](15);
        payloads = new bytes[](15);

        // Must match ExecuteUpgradeV4 exactly (abi.encodeCall, same order)
        targets[0] = ACCOUNT_PROXY;
        payloads[0] = abi.encodeCall(DjinnAccount.pause, ());
        targets[1] = ESCROW_PROXY;
        payloads[1] = abi.encodeCall(Escrow.pause, ());
        targets[2] = AUDIT_PROXY;
        payloads[2] = abi.encodeCall(Audit.pause, ());
        targets[3] = OUTCOME_VOTING_PROXY;
        payloads[3] = abi.encodeCall(OutcomeVoting.pause, ());
        targets[4] = SIGNAL_COMMITMENT_PROXY;
        payloads[4] = abi.encodeCall(SignalCommitment.pause, ());

        for (uint256 i; i < 5; ++i) {
            targets[i + 5] = targets[i];
            payloads[i + 5] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (impls[i], ""));
        }

        targets[10] = ACCOUNT_PROXY;
        payloads[10] = abi.encodeCall(DjinnAccount.unpause, ());
        targets[11] = ESCROW_PROXY;
        payloads[11] = abi.encodeCall(Escrow.unpause, ());
        targets[12] = AUDIT_PROXY;
        payloads[12] = abi.encodeCall(Audit.unpause, ());
        targets[13] = OUTCOME_VOTING_PROXY;
        payloads[13] = abi.encodeCall(OutcomeVoting.unpause, ());
        targets[14] = SIGNAL_COMMITMENT_PROXY;
        payloads[14] = abi.encodeCall(SignalCommitment.unpause, ());
    }

    /// @dev Reconstructs the exact V3 batch to compute its hash for cancellation.
    function _buildV3Batch() internal pure returns (
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory payloads
    ) {
        uint256 opCount = 12;
        targets = new address[](opCount);
        values = new uint256[](opCount);
        payloads = new bytes[](opCount);

        // Pause 4
        targets[0] = ACCOUNT_PROXY;
        payloads[0] = abi.encodeCall(DjinnAccount.pause, ());
        targets[1] = ESCROW_PROXY;
        payloads[1] = abi.encodeCall(Escrow.pause, ());
        targets[2] = AUDIT_PROXY;
        payloads[2] = abi.encodeCall(Audit.pause, ());
        targets[3] = OUTCOME_VOTING_PROXY;
        payloads[3] = abi.encodeCall(OutcomeVoting.pause, ());

        // Upgrade 4 (with V3 impl addresses)
        targets[4] = ACCOUNT_PROXY;
        payloads[4] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (V3_ACCOUNT_IMPL, ""));
        targets[5] = ESCROW_PROXY;
        payloads[5] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (V3_ESCROW_IMPL, ""));
        targets[6] = AUDIT_PROXY;
        payloads[6] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (V3_AUDIT_IMPL, ""));
        targets[7] = OUTCOME_VOTING_PROXY;
        payloads[7] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (V3_VOTING_IMPL, ""));

        // Unpause 4
        targets[8] = ACCOUNT_PROXY;
        payloads[8] = abi.encodeCall(DjinnAccount.unpause, ());
        targets[9] = ESCROW_PROXY;
        payloads[9] = abi.encodeCall(Escrow.unpause, ());
        targets[10] = AUDIT_PROXY;
        payloads[10] = abi.encodeCall(Audit.unpause, ());
        targets[11] = OUTCOME_VOTING_PROXY;
        payloads[11] = abi.encodeCall(OutcomeVoting.unpause, ());
    }
}
