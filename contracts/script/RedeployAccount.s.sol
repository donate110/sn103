// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Account as DjinnAccount} from "../src/Account.sol";

/// @title RedeployAccount
/// @notice Redeploys only the Account contract and re-wires all cross-contract references.
contract RedeployAccount is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(deployerKey);

        address oldAccount = vm.envAddress("OLD_ACCOUNT_ADDRESS");
        address escrow = vm.envAddress("ESCROW_ADDRESS");
        address audit = vm.envAddress("AUDIT_ADDRESS");

        console.log("Deployer:", deployer);
        console.log("Old Account:", oldAccount);

        vm.startBroadcast(deployerKey);

        // Deploy new Account
        DjinnAccount na_ = DjinnAccount(address(new ERC1967Proxy(
            address(new DjinnAccount()),
            abi.encodeCall(DjinnAccount.initialize, (deployer))
        )));
        address na = address(na_);
        console.log("New Account:", na);

        // Authorize Escrow and Audit on the new Account
        _call(na, abi.encodeWithSignature("setAuthorizedCaller(address,bool)", escrow, true));
        _call(na, abi.encodeWithSignature("setAuthorizedCaller(address,bool)", audit, true));

        // Update Escrow to point to new Account
        _call(escrow, abi.encodeWithSignature("setAccount(address)", na));

        // Update Audit to point to new Account
        _call(audit, abi.encodeWithSignature("setAccount(address)", na));

        vm.stopBroadcast();

        console.log("");
        console.log("=== ACCOUNT REDEPLOYMENT COMPLETE ===");
        console.log("NEXT_PUBLIC_ACCOUNT_ADDRESS=", na);
    }

    function _call(address target, bytes memory data) internal {
        (bool ok,) = target.call(data);
        require(ok, "Call failed");
    }
}
