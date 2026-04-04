// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

import {Account as DjinnAccount} from "../src/Account.sol";
import {Escrow} from "../src/Escrow.sol";
import {Audit} from "../src/Audit.sol";
import {OutcomeVoting} from "../src/OutcomeVoting.sol";

/// @title ExecuteUpgradeV3
/// @notice Executes the queue-based-audits-v2 upgrade batch after the 72h timelock delay.
///         Reconstructs the exact 12-operation batch from ScheduleUpgrade.s.sol.
///         Verifies each proxy's implementation slot after execution.
///
///         Required env vars (set from ScheduleUpgrade output):
///           ACCOUNT_IMPL_V3, ESCROW_IMPL_V3, AUDIT_IMPL_V3, OUTCOME_VOTING_IMPL_V3
///
///         Usage:
///           forge script script/ExecuteUpgradeV3.s.sol \
///             --rpc-url $BASE_RPC_URL --broadcast
contract ExecuteUpgradeV3 is Script {
    bytes32 constant UPGRADE_SALT = keccak256("queue-based-audits-v2");

    // Proxy addresses (Base Sepolia) -- must match ScheduleUpgrade exactly
    address constant ACCOUNT_PROXY = 0x4546354Dd32a613B76Abf530F81c8359e7cE440B;
    address constant ESCROW_PROXY = 0xb43BA175a6784973eB3825acF801Cd7920ac692a;
    address constant AUDIT_PROXY = 0xCa7e642FE31BA83a7a857644E8894c1B93a2a44E;
    address constant OUTCOME_VOTING_PROXY = 0xAD534f4CAB13707BD4d65e4EF086A455e6A643e5;
    address constant TIMELOCK = 0x37f41EFfa8492022afF48B9Ef725008963F14f79;

    /// @dev ERC1967 implementation storage slot: keccak256("eip1967.proxy.implementation") - 1
    bytes32 constant IMPL_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        TimelockController timelock = TimelockController(payable(TIMELOCK));

        // Read implementation addresses from env (output of ScheduleUpgrade)
        address accountImpl = vm.envAddress("ACCOUNT_IMPL_V3");
        address escrowImpl = vm.envAddress("ESCROW_IMPL_V3");
        address auditImpl = vm.envAddress("AUDIT_IMPL_V3");
        address votingImpl = vm.envAddress("OUTCOME_VOTING_IMPL_V3");

        console.log("Executing queue-based-audits-v2 upgrade batch...");
        console.log("  Account impl:", accountImpl);
        console.log("  Escrow impl:", escrowImpl);
        console.log("  Audit impl:", auditImpl);
        console.log("  OutcomeVoting impl:", votingImpl);
        console.log("");

        // Rebuild the exact 12-op batch (must match ScheduleUpgrade)
        uint256 opCount = 12;
        address[] memory targets = new address[](opCount);
        uint256[] memory values = new uint256[](opCount);
        bytes[] memory payloads = new bytes[](opCount);

        // Pause
        targets[0] = ACCOUNT_PROXY;
        payloads[0] = abi.encodeCall(DjinnAccount.pause, ());

        targets[1] = ESCROW_PROXY;
        payloads[1] = abi.encodeCall(Escrow.pause, ());

        targets[2] = AUDIT_PROXY;
        payloads[2] = abi.encodeCall(Audit.pause, ());

        targets[3] = OUTCOME_VOTING_PROXY;
        payloads[3] = abi.encodeCall(OutcomeVoting.pause, ());

        // Upgrade
        targets[4] = ACCOUNT_PROXY;
        payloads[4] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (accountImpl, ""));

        targets[5] = ESCROW_PROXY;
        payloads[5] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (escrowImpl, ""));

        targets[6] = AUDIT_PROXY;
        payloads[6] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (auditImpl, ""));

        targets[7] = OUTCOME_VOTING_PROXY;
        payloads[7] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (votingImpl, ""));

        // Unpause
        targets[8] = ACCOUNT_PROXY;
        payloads[8] = abi.encodeCall(DjinnAccount.unpause, ());

        targets[9] = ESCROW_PROXY;
        payloads[9] = abi.encodeCall(Escrow.unpause, ());

        targets[10] = AUDIT_PROXY;
        payloads[10] = abi.encodeCall(Audit.unpause, ());

        targets[11] = OUTCOME_VOTING_PROXY;
        payloads[11] = abi.encodeCall(OutcomeVoting.unpause, ());

        // Verify the batch hash matches what was scheduled
        bytes32 batchId = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        console.log("Batch operation ID:");
        console.logBytes32(batchId);

        bool isReady = timelock.isOperationReady(batchId);
        console.log("Is ready:", isReady);
        require(isReady, "Batch not ready yet (72h delay not elapsed)");

        // Execute the batch
        vm.startBroadcast(deployerKey);
        timelock.executeBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        vm.stopBroadcast();

        // Verify each proxy's implementation slot points to the new impl
        _verifyImpl("Account", ACCOUNT_PROXY, accountImpl);
        _verifyImpl("Escrow", ESCROW_PROXY, escrowImpl);
        _verifyImpl("Audit", AUDIT_PROXY, auditImpl);
        _verifyImpl("OutcomeVoting", OUTCOME_VOTING_PROXY, votingImpl);

        // Verify contracts are unpaused
        require(!DjinnAccount(ACCOUNT_PROXY).paused(), "Account still paused");
        require(!Escrow(ESCROW_PROXY).paused(), "Escrow still paused");
        require(!Audit(AUDIT_PROXY).paused(), "Audit still paused");
        require(!OutcomeVoting(OUTCOME_VOTING_PROXY).paused(), "OutcomeVoting still paused");

        console.log("");
        console.log("=== UPGRADE EXECUTED AND VERIFIED ===");
        console.log("All 4 proxies upgraded to new implementations.");
        console.log("All contracts unpaused and operational.");
    }

    function _verifyImpl(string memory name, address proxy, address expectedImpl) internal view {
        bytes32 raw = vm.load(proxy, IMPL_SLOT);
        address actualImpl = address(uint160(uint256(raw)));
        console.log(string.concat(name, " impl:"), actualImpl);
        require(actualImpl == expectedImpl, string.concat(name, ": implementation mismatch after upgrade"));
    }
}
