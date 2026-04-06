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

contract ExecuteUpgradeV5 is Script {
    bytes32 constant UPGRADE_SALT = keccak256("combined-v5-with-fee-fix");
    address constant ACCOUNT_PROXY = 0x4546354Dd32a613B76Abf530F81c8359e7cE440B;
    address constant ESCROW_PROXY = 0xb43BA175a6784973eB3825acF801Cd7920ac692a;
    address constant AUDIT_PROXY = 0xCa7e642FE31BA83a7a857644E8894c1B93a2a44E;
    address constant OUTCOME_VOTING_PROXY = 0xAD534f4CAB13707BD4d65e4EF086A455e6A643e5;
    address constant SIGNAL_COMMITMENT_PROXY = 0x4712479Ba57c9ED40405607b2B18967B359209C0;
    address constant TIMELOCK = 0x37f41EFfa8492022afF48B9Ef725008963F14f79;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        TimelockController timelock = TimelockController(payable(TIMELOCK));
        address[5] memory impls = [
            vm.envAddress("ACCOUNT_IMPL_V5"),
            vm.envAddress("ESCROW_IMPL_V5"),
            vm.envAddress("AUDIT_IMPL_V5"),
            vm.envAddress("OUTCOME_VOTING_IMPL_V5"),
            vm.envAddress("SIGNAL_IMPL_V5")
        ];
        address[5] memory proxies = [ACCOUNT_PROXY, ESCROW_PROXY, AUDIT_PROXY, OUTCOME_VOTING_PROXY, SIGNAL_COMMITMENT_PROXY];
        address[] memory targets = new address[](15);
        uint256[] memory values = new uint256[](15);
        bytes[] memory payloads = new bytes[](15);
        for (uint256 i; i < 5; ++i) {
            targets[i] = proxies[i];
            payloads[i] = abi.encodeWithSignature("pause()");
            targets[i+5] = proxies[i];
            payloads[i+5] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (impls[i], ""));
            targets[i+10] = proxies[i];
            payloads[i+10] = abi.encodeWithSignature("unpause()");
        }
        bytes32 batchId = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        require(timelock.isOperationReady(batchId), "Not ready (72h not elapsed)");
        vm.startBroadcast(deployerKey);
        timelock.executeBatch(targets, values, payloads, bytes32(0), UPGRADE_SALT);
        vm.stopBroadcast();
        console.log("V5 upgrade executed. All 5 proxies upgraded.");
    }
}
