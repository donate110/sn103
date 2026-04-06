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

/// @title CancelV4AndRescheduleV5
/// @notice Cancels the V4 batch (missing fee fix in SignalCommitment),
///         deploys fresh implementations with all fixes, reschedules.
contract CancelV4AndRescheduleV5 is Script {
    bytes32 constant V4_SALT = keccak256("combined-v4-offchain-decoys");
    bytes32 constant V5_SALT = keccak256("combined-v5-with-fee-fix");

    address constant ACCOUNT_PROXY = 0x4546354Dd32a613B76Abf530F81c8359e7cE440B;
    address constant ESCROW_PROXY = 0xb43BA175a6784973eB3825acF801Cd7920ac692a;
    address constant AUDIT_PROXY = 0xCa7e642FE31BA83a7a857644E8894c1B93a2a44E;
    address constant OUTCOME_VOTING_PROXY = 0xAD534f4CAB13707BD4d65e4EF086A455e6A643e5;
    address constant SIGNAL_COMMITMENT_PROXY = 0x4712479Ba57c9ED40405607b2B18967B359209C0;
    address constant TIMELOCK = 0x37f41EFfa8492022afF48B9Ef725008963F14f79;

    // V4 impl addresses (needed to reconstruct the V4 batch for cancellation)
    address constant V4_ACCOUNT = 0xdb15FAA8a177B0c47cfCe365adA26a9Fd2749375;
    address constant V4_ESCROW = 0xB7Fba20f65159A0A25B573eAB714b85830eeefB2;
    address constant V4_AUDIT = 0x4a3D3E0F83dfe2BC8B36409e9F6E2C34D3E9C83A;
    address constant V4_VOTING = 0x116565A7Bcd1b6E9A2F58cbf403E3Bc28337514B;
    address constant V4_SIGNAL = 0x191a5aEB79fD8a704FbE953DC849DAc31D59A26B;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        TimelockController timelock = TimelockController(payable(TIMELOCK));

        console.log("Deployer:", vm.addr(deployerKey));

        // ---- Step 1: Cancel V4 ----
        address[5] memory v4Impls = [V4_ACCOUNT, V4_ESCROW, V4_AUDIT, V4_VOTING, V4_SIGNAL];
        (address[] memory v4t, uint256[] memory v4v, bytes[] memory v4p) = _buildBatch(v4Impls);
        bytes32 v4Id = timelock.hashOperationBatch(v4t, v4v, v4p, bytes32(0), V4_SALT);

        bool v4Pending = timelock.isOperationPending(v4Id);
        console.log("V4 batch pending:", v4Pending);

        vm.startBroadcast(deployerKey);

        if (v4Pending) {
            timelock.cancel(v4Id);
            console.log("V4 CANCELLED");
        } else {
            console.log("V4 not pending, skipping cancel");
        }

        // ---- Step 2: Deploy fresh implementations ----
        address[5] memory impls;
        impls[0] = address(new DjinnAccount());
        impls[1] = address(new Escrow());
        impls[2] = address(new Audit());
        impls[3] = address(new OutcomeVoting());
        impls[4] = address(new SignalCommitment());

        console.log("Account:", impls[0]);
        console.log("Escrow:", impls[1]);
        console.log("Audit:", impls[2]);
        console.log("OutcomeVoting:", impls[3]);
        console.log("SignalCommitment:", impls[4]);

        // ---- Step 3: Schedule V5 ----
        (address[] memory t, uint256[] memory v, bytes[] memory p) = _buildBatch(impls);
        uint256 delay = timelock.getMinDelay();
        timelock.scheduleBatch(t, v, p, bytes32(0), V5_SALT, delay);

        bytes32 v5Id = timelock.hashOperationBatch(t, v, p, bytes32(0), V5_SALT);
        console.log("V5 scheduled. Batch ID:");
        console.logBytes32(v5Id);
        console.log("Executable after:", block.timestamp + delay);

        vm.stopBroadcast();
    }

    function _buildBatch(address[5] memory impls) internal pure returns (
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory payloads
    ) {
        address[5] memory proxies = [ACCOUNT_PROXY, ESCROW_PROXY, AUDIT_PROXY, OUTCOME_VOTING_PROXY, SIGNAL_COMMITMENT_PROXY];
        targets = new address[](15);
        values = new uint256[](15);
        payloads = new bytes[](15);

        for (uint256 i; i < 5; ++i) {
            targets[i] = proxies[i];
            payloads[i] = abi.encodeWithSignature("pause()");
            targets[i + 5] = proxies[i];
            payloads[i + 5] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (impls[i], ""));
            targets[i + 10] = proxies[i];
            payloads[i + 10] = abi.encodeWithSignature("unpause()");
        }
    }
}
