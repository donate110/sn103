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

/// @title ExecuteUpgradeV4
/// @notice Executes the combined V4 upgrade (queue-based-audits + off-chain decoys)
///         after the 72h timelock delay. Upgrades all 5 UUPS proxies atomically.
///
///         Required env vars (from CancelAndRescheduleV4 output):
///           ACCOUNT_IMPL_V4, ESCROW_IMPL_V4, AUDIT_IMPL_V4,
///           OUTCOME_VOTING_IMPL_V4, SIGNAL_IMPL_V4
///
///         Usage:
///           forge script script/ExecuteUpgradeV4.s.sol \
///             --rpc-url $BASE_RPC_URL --broadcast
contract ExecuteUpgradeV4 is Script {
    bytes32 constant UPGRADE_SALT = keccak256("combined-v4-offchain-decoys");

    address constant ACCOUNT_PROXY = 0x4546354Dd32a613B76Abf530F81c8359e7cE440B;
    address constant ESCROW_PROXY = 0xb43BA175a6784973eB3825acF801Cd7920ac692a;
    address constant AUDIT_PROXY = 0xCa7e642FE31BA83a7a857644E8894c1B93a2a44E;
    address constant OUTCOME_VOTING_PROXY = 0xAD534f4CAB13707BD4d65e4EF086A455e6A643e5;
    address constant SIGNAL_COMMITMENT_PROXY = 0x4712479Ba57c9ED40405607b2B18967B359209C0;
    address constant TIMELOCK = 0x37f41EFfa8492022afF48B9Ef725008963F14f79;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        TimelockController timelock = TimelockController(payable(TIMELOCK));

        address accountImpl = vm.envAddress("ACCOUNT_IMPL_V4");
        address escrowImpl = vm.envAddress("ESCROW_IMPL_V4");
        address auditImpl = vm.envAddress("AUDIT_IMPL_V4");
        address votingImpl = vm.envAddress("OUTCOME_VOTING_IMPL_V4");
        address signalImpl = vm.envAddress("SIGNAL_IMPL_V4");

        // Reconstruct the exact 15-op batch
        uint256 opCount = 15;
        address[] memory targets = new address[](opCount);
        uint256[] memory values = new uint256[](opCount);
        bytes[] memory payloads = new bytes[](opCount);

        // Pause 5
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

        // Upgrade 5
        targets[5] = ACCOUNT_PROXY;
        payloads[5] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (accountImpl, ""));
        targets[6] = ESCROW_PROXY;
        payloads[6] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (escrowImpl, ""));
        targets[7] = AUDIT_PROXY;
        payloads[7] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (auditImpl, ""));
        targets[8] = OUTCOME_VOTING_PROXY;
        payloads[8] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (votingImpl, ""));
        targets[9] = SIGNAL_COMMITMENT_PROXY;
        payloads[9] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (signalImpl, ""));

        // Unpause 5
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

        bytes32 batchId = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        console.log("Batch ID:");
        console.logBytes32(batchId);

        bool isReady = timelock.isOperationReady(batchId);
        console.log("Operation ready:", isReady);
        require(isReady, "Operation not ready (72h delay not elapsed)");

        vm.startBroadcast(deployerKey);
        timelock.executeBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        console.log("Batch executed.");
        vm.stopBroadcast();

        // Verify all 5 implementation slots (ERC-1967 impl slot)
        bytes32 implSlot = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
        address[5] memory proxies = [ACCOUNT_PROXY, ESCROW_PROXY, AUDIT_PROXY, OUTCOME_VOTING_PROXY, SIGNAL_COMMITMENT_PROXY];
        address[5] memory expectedImpls = [accountImpl, escrowImpl, auditImpl, votingImpl, signalImpl];
        string[5] memory names = ["Account", "Escrow", "Audit", "OutcomeVoting", "SignalCommitment"];

        console.log("");
        console.log("=== POST-UPGRADE VERIFICATION ===");
        for (uint256 i = 0; i < 5; i++) {
            address actual = address(uint160(uint256(vm.load(proxies[i], implSlot))));
            console.log(names[i]);
            console.log("  Actual:", actual);
            console.log("  Match:", actual == expectedImpls[i]);
            require(actual == expectedImpls[i], "Implementation mismatch");
        }
        console.log("");
        console.log("All 5 proxies upgraded and verified.");
    }
}
