// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Account as DjinnAccount} from "../src/Account.sol";

/// @title RedeployAccount
/// @notice Redeploys only the Account contract, re-wires all cross-contract references,
///         and transfers ownership to the TimelockController.
contract RedeployAccount is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(deployerKey);

        address oldAccount = vm.envAddress("OLD_ACCOUNT_ADDRESS");
        address escrow = vm.envAddress("ESCROW_ADDRESS");
        address audit = vm.envAddress("AUDIT_ADDRESS");
        address timelock = vm.envAddress("TIMELOCK_ADDRESS");

        console.log("Deployer:", deployer);
        console.log("Old Account:", oldAccount);
        console.log("Timelock:", timelock);

        vm.startBroadcast(deployerKey);

        // Deploy new Account
        DjinnAccount na_ = DjinnAccount(address(new ERC1967Proxy(
            address(new DjinnAccount()),
            abi.encodeCall(DjinnAccount.initialize, (deployer))
        )));
        address na = address(na_);
        console.log("New Account:", na);

        // Authorize Escrow and Audit on the new Account
        na_.setAuthorizedCaller(escrow, true);
        na_.setAuthorizedCaller(audit, true);

        // Update Escrow to point to new Account (requires timelock on Escrow)
        // NOTE: If Escrow is already owned by timelock, this call must go through
        // the timelock. Log it for phase-2 manual execution.
        _call(escrow, abi.encodeWithSignature("setAccount(address)", na));

        // Update Audit to point to new Account
        _call(audit, abi.encodeWithSignature("setAccount(address)", na));

        // Transfer ownership to timelock (CRITICAL — do not skip)
        na_.transferOwnership(timelock);

        vm.stopBroadcast();

        // Verify ownership transfer
        require(na_.owner() == timelock, "Account: owner not timelock after transfer");

        console.log("");
        console.log("=== ACCOUNT REDEPLOYMENT COMPLETE ===");
        console.log("NEXT_PUBLIC_ACCOUNT_ADDRESS=", na);
        console.log("Owner:", na_.owner());
        console.log("");
        console.log("PHASE-2 TIMELOCK OPERATIONS (if Escrow/Audit already owned by timelock):");
        console.log("  - Escrow.setAccount(newAccount) via timelock");
        console.log("  - Audit.setAccount(newAccount) via timelock");
    }

    function _call(address target, bytes memory data) internal {
        (bool ok,) = target.call(data);
        require(ok, "Call failed");
    }
}
