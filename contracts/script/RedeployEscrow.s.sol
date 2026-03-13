// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Escrow} from "../src/Escrow.sol";

/// @title RedeployEscrow
/// @notice Redeploys only the Escrow contract, re-wires all cross-contract references,
///         and transfers ownership to the TimelockController.
contract RedeployEscrow is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(deployerKey);

        address usdc = vm.envAddress("USDC_ADDRESS");
        address oldEscrow = vm.envAddress("OLD_ESCROW_ADDRESS");
        address sc = vm.envAddress("SIGNAL_COMMITMENT_ADDRESS");
        address coll = vm.envAddress("COLLATERAL_ADDRESS");
        address cl = vm.envAddress("CREDIT_LEDGER_ADDRESS");
        address acct = vm.envAddress("ACCOUNT_ADDRESS");
        address aud = vm.envAddress("AUDIT_ADDRESS");
        address timelock = vm.envAddress("TIMELOCK_ADDRESS");
        address pauserAddr = vm.envOr("PAUSER_ADDRESS", deployer);

        console.log("Deployer:", deployer);
        console.log("Old Escrow:", oldEscrow);
        console.log("Timelock:", timelock);

        vm.startBroadcast(deployerKey);

        // Deploy new Escrow behind UUPS proxy
        Escrow esc_ = Escrow(address(new ERC1967Proxy(
            address(new Escrow()),
            abi.encodeCall(Escrow.initialize, (usdc, deployer))
        )));
        address ne = address(esc_);
        console.log("New Escrow:", ne);

        // Wire new Escrow to its dependencies
        esc_.setSignalCommitment(sc);
        esc_.setCollateral(coll);
        esc_.setCreditLedger(cl);
        esc_.setAccount(acct);
        esc_.setAuditContract(aud);

        // Set pauser
        esc_.setPauser(pauserAddr);

        // Update Audit to point to new Escrow (only if deployer is still owner)
        if (_isOwner(aud, deployer)) {
            _call(aud, abi.encodeWithSignature("setEscrow(address)", ne));
        } else {
            console.log("SKIP: Audit owned by timelock. Schedule setEscrow via timelock.");
        }

        // Collateral: swap authorization
        if (_isOwner(coll, deployer)) {
            _call(coll, abi.encodeWithSignature("setAuthorized(address,bool)", oldEscrow, false));
            _call(coll, abi.encodeWithSignature("setAuthorized(address,bool)", ne, true));
        } else {
            console.log("SKIP: Collateral owned by timelock. Schedule auth swap via timelock.");
        }

        // CreditLedger: swap authorization
        if (_isOwner(cl, deployer)) {
            _call(cl, abi.encodeWithSignature("setAuthorizedCaller(address,bool)", oldEscrow, false));
            _call(cl, abi.encodeWithSignature("setAuthorizedCaller(address,bool)", ne, true));
        } else {
            console.log("SKIP: CreditLedger owned by timelock. Schedule auth swap via timelock.");
        }

        // Account: swap authorization
        if (_isOwner(acct, deployer)) {
            _call(acct, abi.encodeWithSignature("setAuthorizedCaller(address,bool)", oldEscrow, false));
            _call(acct, abi.encodeWithSignature("setAuthorizedCaller(address,bool)", ne, true));
        } else {
            console.log("SKIP: Account owned by timelock. Schedule auth swap via timelock.");
        }

        // SignalCommitment: swap authorization
        if (_isOwner(sc, deployer)) {
            _call(sc, abi.encodeWithSignature("setAuthorizedCaller(address,bool)", oldEscrow, false));
            _call(sc, abi.encodeWithSignature("setAuthorizedCaller(address,bool)", ne, true));
        } else {
            console.log("SKIP: SignalCommitment owned by timelock. Schedule auth swap via timelock.");
        }

        // Transfer ownership to timelock (CRITICAL — do not skip)
        esc_.transferOwnership(timelock);

        vm.stopBroadcast();

        // Verify ownership transfer
        require(esc_.owner() == timelock, "Escrow: owner not timelock after transfer");
        require(esc_.pauser() == pauserAddr, "Escrow: pauser not set");

        console.log("");
        console.log("=== ESCROW REDEPLOYMENT COMPLETE ===");
        console.log("NEXT_PUBLIC_ESCROW_ADDRESS=", ne);
        console.log("Owner:", esc_.owner());
        console.log("");
        console.log("PHASE-2 TIMELOCK OPERATIONS (if other contracts already owned by timelock):");
        console.log("  - Audit.setEscrow(newEscrow) via timelock");
        console.log("  - Collateral.setAuthorized(old, false) + setAuthorized(new, true) via timelock");
        console.log("  - CreditLedger.setAuthorizedCaller(old, false) + setAuthorizedCaller(new, true) via timelock");
        console.log("  - Account.setAuthorizedCaller(old, false) + setAuthorizedCaller(new, true) via timelock");
        console.log("  - SignalCommitment.setAuthorizedCaller(old, false) + setAuthorizedCaller(new, true) via timelock");
    }

    function _call(address target, bytes memory data) internal {
        require(target.code.length > 0, "Target is not a contract");
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }

    function _isOwner(address target, address expectedOwner) internal view returns (bool) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (address)) == expectedOwner;
    }
}
