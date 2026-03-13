// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {Account as DjinnAccount} from "../src/Account.sol";
import {CreditLedger} from "../src/CreditLedger.sol";
import {SignalCommitment} from "../src/SignalCommitment.sol";
import {Collateral} from "../src/Collateral.sol";
import {Escrow} from "../src/Escrow.sol";
import {Audit} from "../src/Audit.sol";
import {OutcomeVoting} from "../src/OutcomeVoting.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

contract AuditV2 is Audit {
    function version() external pure returns (string memory) { return "v2"; }
}

contract EscrowV2 is Escrow {
    function version() external pure returns (string memory) { return "v2"; }
}

contract CollateralV2 is Collateral {
    function version() external pure returns (string memory) { return "v2"; }
}

/// @title SafetyFeaturesTest
/// @notice Tests activePairCount, upgrade gates, pauser role, and TimelockController
contract SafetyFeaturesTest is Test {
    MockUSDC usdc;
    DjinnAccount account;
    CreditLedger creditLedger;
    SignalCommitment signalCommitment;
    Collateral collateral;
    Escrow escrow;
    Audit audit;
    OutcomeVoting voting;

    address owner;
    address pauser = address(0xAAAA);
    address nonOwner = address(0xDEAD);
    address genius = address(0xBEEF);
    address idiot = address(0xCAFE);
    address genius2 = address(0xBEE2);
    address idiot2 = address(0xCAF2);

    function setUp() public {
        owner = address(this);
        usdc = new MockUSDC();

        account = DjinnAccount(_deployProxy(address(new DjinnAccount()), abi.encodeCall(DjinnAccount.initialize, (owner))));
        creditLedger = CreditLedger(_deployProxy(address(new CreditLedger()), abi.encodeCall(CreditLedger.initialize, (owner))));
        signalCommitment = SignalCommitment(_deployProxy(address(new SignalCommitment()), abi.encodeCall(SignalCommitment.initialize, (owner))));
        collateral = Collateral(_deployProxy(address(new Collateral()), abi.encodeCall(Collateral.initialize, (address(usdc), owner))));
        escrow = Escrow(_deployProxy(address(new Escrow()), abi.encodeCall(Escrow.initialize, (address(usdc), owner))));
        audit = Audit(_deployProxy(address(new Audit()), abi.encodeCall(Audit.initialize, (owner))));
        voting = OutcomeVoting(_deployProxy(address(new OutcomeVoting()), abi.encodeCall(OutcomeVoting.initialize, (owner))));

        // Wire
        audit.setEscrow(address(escrow));
        audit.setCollateral(address(collateral));
        audit.setCreditLedger(address(creditLedger));
        audit.setAccount(address(account));
        audit.setSignalCommitment(address(signalCommitment));
        audit.setProtocolTreasury(owner);
        audit.setOutcomeVoting(address(voting));

        voting.setAudit(address(audit));
        voting.setAccount(address(account));

        escrow.setSignalCommitment(address(signalCommitment));
        escrow.setCollateral(address(collateral));
        escrow.setCreditLedger(address(creditLedger));
        escrow.setAccount(address(account));
        escrow.setAuditContract(address(audit));

        collateral.setAuthorized(address(escrow), true);
        collateral.setAuthorized(address(audit), true);
        creditLedger.setAuthorizedCaller(address(escrow), true);
        creditLedger.setAuthorizedCaller(address(audit), true);
        account.setAuthorizedCaller(address(escrow), true);
        account.setAuthorizedCaller(address(audit), true);
        signalCommitment.setAuthorizedCaller(address(escrow), true);

        // Set pauser
        audit.setPauser(pauser);
        escrow.setPauser(pauser);
        collateral.setPauser(pauser);
        signalCommitment.setPauser(pauser);
        voting.setPauser(pauser);
    }

    // ═══════════════════════════════════════════════════
    // activePairCount tracking
    // ═══════════════════════════════════════════════════

    function test_activePairCount_startsAtZero() public view {
        assertEq(account.activePairCount(), 0);
    }

    function test_activePairCount_incrementsOnFirstPurchase() public {
        account.setAuthorizedCaller(owner, true);
        account.recordPurchase(genius, idiot, 1);
        assertEq(account.activePairCount(), 1);
    }

    function test_activePairCount_doesNotIncrementOnSubsequentPurchases() public {
        account.setAuthorizedCaller(owner, true);
        account.recordPurchase(genius, idiot, 1);
        account.recordPurchase(genius, idiot, 2);
        account.recordPurchase(genius, idiot, 3);
        assertEq(account.activePairCount(), 1);
    }

    function test_activePairCount_incrementsForDifferentPairs() public {
        account.setAuthorizedCaller(owner, true);
        account.recordPurchase(genius, idiot, 1);
        account.recordPurchase(genius2, idiot2, 2);
        assertEq(account.activePairCount(), 2);
    }

    function test_activePairCount_decrementsOnSettleAudit() public {
        account.setAuthorizedCaller(owner, true);
        account.recordPurchase(genius, idiot, 1);
        assertEq(account.activePairCount(), 1);

        account.settleAudit(genius, idiot);
        assertEq(account.activePairCount(), 0);
    }

    function test_activePairCount_fullCycleTwoSettlements() public {
        account.setAuthorizedCaller(owner, true);
        account.recordPurchase(genius, idiot, 1);
        account.recordPurchase(genius2, idiot2, 2);
        assertEq(account.activePairCount(), 2);

        account.settleAudit(genius, idiot);
        assertEq(account.activePairCount(), 1);

        account.settleAudit(genius2, idiot2);
        assertEq(account.activePairCount(), 0);
    }

    function test_activePairCount_noUnderflowOnSettleWithZeroSignals() public {
        account.setAuthorizedCaller(owner, true);
        // Record and settle to get to a clean state
        account.recordPurchase(genius, idiot, 1);
        account.settleAudit(genius, idiot);
        assertEq(account.activePairCount(), 0);

        // Settle again on new cycle (signalCount is 0) — should not underflow
        account.settleAudit(genius, idiot);
        assertEq(account.activePairCount(), 0);
    }

    function test_activePairCount_decrementsOnStartNewCycle() public {
        account.setAuthorizedCaller(owner, true);
        account.recordPurchase(genius, idiot, 1);
        assertEq(account.activePairCount(), 1);

        account.startNewCycle(genius, idiot);
        assertEq(account.activePairCount(), 0);
    }

    function test_activePairCount_reincrementsAfterNewCycle() public {
        account.setAuthorizedCaller(owner, true);
        account.recordPurchase(genius, idiot, 1);
        account.settleAudit(genius, idiot);
        assertEq(account.activePairCount(), 0);

        // New purchase in new cycle
        account.recordPurchase(genius, idiot, 10);
        assertEq(account.activePairCount(), 1);
    }

    // ═══════════════════════════════════════════════════
    // Upgrade gates
    // ═══════════════════════════════════════════════════

    function test_audit_upgradeBlocked_whenNotPaused() public {
        AuditV2 newImpl = new AuditV2();
        vm.expectRevert(abi.encodeWithSignature("ExpectedPause()"));
        audit.upgradeToAndCall(address(newImpl), "");
    }

    function test_audit_upgradeAllowed_whenPaused() public {
        audit.pause();
        AuditV2 newImpl = new AuditV2();
        audit.upgradeToAndCall(address(newImpl), "");
        assertEq(AuditV2(address(audit)).version(), "v2");
    }

    function test_escrow_upgradeBlocked_whenNotPaused() public {
        EscrowV2 newImpl = new EscrowV2();
        vm.expectRevert(abi.encodeWithSignature("ExpectedPause()"));
        escrow.upgradeToAndCall(address(newImpl), "");
    }

    function test_escrow_upgradeAllowed_whenPaused() public {
        escrow.pause();
        EscrowV2 newImpl = new EscrowV2();
        escrow.upgradeToAndCall(address(newImpl), "");
        assertEq(EscrowV2(address(escrow)).version(), "v2");
    }

    function test_collateral_upgradeBlocked_whenNotPaused() public {
        CollateralV2 newImpl = new CollateralV2();
        vm.expectRevert(abi.encodeWithSignature("ExpectedPause()"));
        collateral.upgradeToAndCall(address(newImpl), "");
    }

    function test_collateral_upgradeAllowed_whenPaused() public {
        collateral.pause();
        CollateralV2 newImpl = new CollateralV2();
        collateral.upgradeToAndCall(address(newImpl), "");
        assertEq(CollateralV2(address(collateral)).version(), "v2");
    }

    // ═══════════════════════════════════════════════════
    // Pauser role
    // ═══════════════════════════════════════════════════

    function test_pauser_canPause_audit() public {
        vm.prank(pauser);
        audit.pause();
        assertTrue(audit.paused());
    }

    function test_pauser_cannotUnpause_audit() public {
        audit.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, pauser));
        vm.prank(pauser);
        audit.unpause();
    }

    function test_owner_canStillPause_audit() public {
        audit.pause();
        assertTrue(audit.paused());
    }

    function test_random_cannotPause_audit() public {
        vm.expectRevert(abi.encodeWithSelector(Audit.NotPauserOrOwner.selector, nonOwner));
        vm.prank(nonOwner);
        audit.pause();
    }

    function test_pauser_canPause_escrow() public {
        vm.prank(pauser);
        escrow.pause();
        assertTrue(escrow.paused());
    }

    function test_pauser_canPause_collateral() public {
        vm.prank(pauser);
        collateral.pause();
        assertTrue(collateral.paused());
    }

    function test_pauser_canPause_signalCommitment() public {
        vm.prank(pauser);
        signalCommitment.pause();
        assertTrue(signalCommitment.paused());
    }

    function test_pauser_canPause_outcomeVoting() public {
        vm.prank(pauser);
        voting.pause();
        assertTrue(voting.paused());
    }

    function test_setPauser_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        vm.prank(nonOwner);
        audit.setPauser(nonOwner);
    }

    function test_setPauser_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit Audit.PauserUpdated(nonOwner);
        audit.setPauser(nonOwner);
    }

    function test_setPauser_toZero_disablesPauser() public {
        audit.setPauser(address(0));
        vm.expectRevert(abi.encodeWithSelector(Audit.NotPauserOrOwner.selector, pauser));
        vm.prank(pauser);
        audit.pause();
    }

    // ═══════════════════════════════════════════════════
    // TimelockController integration
    // ═══════════════════════════════════════════════════

    function test_timelock_deployment() public {
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockController timelock = new TimelockController(259200, proposers, executors, address(0));
        assertEq(timelock.getMinDelay(), 259200);
    }

    function test_timelock_ownershipTransfer() public {
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockController timelock = new TimelockController(259200, proposers, executors, address(0));

        audit.transferOwnership(address(timelock));
        assertEq(audit.owner(), address(timelock));
    }

    function test_directPause_failsAfterTimelockOwnership_forNonPauser() public {
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockController timelock = new TimelockController(259200, proposers, executors, address(0));

        audit.transferOwnership(address(timelock));

        // Old owner (not pauser) can no longer pause
        vm.expectRevert(abi.encodeWithSelector(Audit.NotPauserOrOwner.selector, owner));
        audit.pause();
    }

    function test_pauser_stillWorks_afterTimelockOwnership() public {
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockController timelock = new TimelockController(259200, proposers, executors, address(0));

        audit.setPauser(pauser);
        audit.transferOwnership(address(timelock));

        // Pauser can still pause (pauser is separate from owner)
        vm.prank(pauser);
        audit.pause();
        assertTrue(audit.paused());
    }

    function test_timelocked_unpause() public {
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockController timelock = new TimelockController(259200, proposers, executors, address(0));

        audit.setPauser(pauser);
        audit.transferOwnership(address(timelock));

        // Pauser pauses
        vm.prank(pauser);
        audit.pause();

        // Schedule unpause through timelock
        bytes memory data = abi.encodeCall(Audit.unpause, ());
        timelock.schedule(address(audit), 0, data, bytes32(0), bytes32(0), 259200);

        // Cannot execute before delay
        vm.expectRevert();
        timelock.execute(address(audit), 0, data, bytes32(0), bytes32(0));

        // Warp past delay
        vm.warp(block.timestamp + 259201);
        timelock.execute(address(audit), 0, data, bytes32(0), bytes32(0));
        assertFalse(audit.paused());
    }

    function test_timelocked_upgrade() public {
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockController timelock = new TimelockController(259200, proposers, executors, address(0));

        // Set pauser before transferring ownership so we can pause
        audit.setPauser(pauser);
        audit.transferOwnership(address(timelock));

        // Pause the audit contract (required for upgrade)
        vm.prank(pauser);
        audit.pause();

        // Deploy V2
        AuditV2 newImpl = new AuditV2();

        // Schedule upgrade
        bytes memory data = abi.encodeCall(audit.upgradeToAndCall, (address(newImpl), ""));
        timelock.schedule(address(audit), 0, data, bytes32(0), bytes32(0), 259200);

        // Warp past delay and execute
        vm.warp(block.timestamp + 259201);
        timelock.execute(address(audit), 0, data, bytes32(0), bytes32(0));

        assertEq(AuditV2(address(audit)).version(), "v2");
    }

    function test_forceSettle_requiresOwner_afterTimelockTransfer() public {
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockController timelock = new TimelockController(259200, proposers, executors, address(0));

        audit.transferOwnership(address(timelock));

        // Direct forceSettle from old owner fails
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        audit.forceSettle(genius, idiot, 0);
    }
}
