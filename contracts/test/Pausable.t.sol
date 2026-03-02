// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {SignalCommitment} from "../src/SignalCommitment.sol";
import {Escrow} from "../src/Escrow.sol";
import {Collateral} from "../src/Collateral.sol";
import {CreditLedger} from "../src/CreditLedger.sol";
import {Account as DjinnAccount} from "../src/Account.sol";
import {Audit} from "../src/Audit.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

/// @title PausableTest
/// @notice Tests the emergency pause mechanism on Escrow, Collateral, and Audit
contract PausableTest is Test {
    MockUSDC usdc;
    SignalCommitment signalCommitment;
    Escrow escrow;
    Collateral collateral;
    CreditLedger creditLedger;
    DjinnAccount account;
    Audit audit;

    address owner;
    address nonOwner = address(0xDEAD);
    address genius = address(0xBEEF);
    address idiot = address(0xCAFE);

    function setUp() public {
        owner = address(this);

        usdc = new MockUSDC();
        signalCommitment = SignalCommitment(_deployProxy(address(new SignalCommitment()), abi.encodeCall(SignalCommitment.initialize, (owner))));
        escrow = Escrow(_deployProxy(address(new Escrow()), abi.encodeCall(Escrow.initialize, (address(usdc), owner))));
        collateral = Collateral(_deployProxy(address(new Collateral()), abi.encodeCall(Collateral.initialize, (address(usdc), owner))));
        creditLedger = CreditLedger(_deployProxy(address(new CreditLedger()), abi.encodeCall(CreditLedger.initialize, (owner))));
        account = DjinnAccount(_deployProxy(address(new DjinnAccount()), abi.encodeCall(DjinnAccount.initialize, (owner))));
        audit = Audit(_deployProxy(address(new Audit()), abi.encodeCall(Audit.initialize, (owner))));

        // Wire contracts
        escrow.setSignalCommitment(address(signalCommitment));
        escrow.setCollateral(address(collateral));
        escrow.setCreditLedger(address(creditLedger));
        escrow.setAccount(address(account));
        escrow.setAuditContract(address(audit));

        audit.setEscrow(address(escrow));
        audit.setCollateral(address(collateral));
        audit.setCreditLedger(address(creditLedger));
        audit.setAccount(address(account));
        audit.setSignalCommitment(address(signalCommitment));

        signalCommitment.setAuthorizedCaller(address(escrow), true);
        collateral.setAuthorized(address(escrow), true);
        collateral.setAuthorized(address(audit), true);
        creditLedger.setAuthorizedCaller(address(escrow), true);
        creditLedger.setAuthorizedCaller(address(audit), true);
        account.setAuthorizedCaller(address(escrow), true);
        account.setAuthorizedCaller(address(audit), true);
        account.setAuthorizedCaller(owner, true);
    }

    // ─── Escrow Pause Tests
    // ─────────────────────────────────────────────

    function test_escrow_pause_onlyOwner() public {
        escrow.pause();
        assertTrue(escrow.paused(), "Should be paused");
    }

    function test_escrow_pause_reverts_nonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Escrow.NotPauserOrOwner.selector, nonOwner));
        vm.prank(nonOwner);
        escrow.pause();
    }

    function test_escrow_unpause_onlyOwner() public {
        escrow.pause();
        escrow.unpause();
        assertFalse(escrow.paused(), "Should be unpaused");
    }

    function test_escrow_unpause_reverts_nonOwner() public {
        escrow.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        vm.prank(nonOwner);
        escrow.unpause();
    }

    function test_escrow_deposit_reverts_whenPaused() public {
        usdc.mint(idiot, 1000e6);
        vm.prank(idiot);
        usdc.approve(address(escrow), 1000e6);

        escrow.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(idiot);
        escrow.deposit(1000e6);
    }

    function test_escrow_withdraw_reverts_whenPaused() public {
        // First deposit while unpaused
        usdc.mint(idiot, 1000e6);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), 1000e6);
        escrow.deposit(1000e6);
        vm.stopPrank();

        escrow.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(idiot);
        escrow.withdraw(500e6);
    }

    function test_escrow_purchase_reverts_whenPaused() public {
        escrow.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(idiot);
        escrow.purchase(1, 1000e6, 1_910_000);
    }

    function test_escrow_deposit_works_afterUnpause() public {
        usdc.mint(idiot, 1000e6);
        vm.prank(idiot);
        usdc.approve(address(escrow), 1000e6);

        escrow.pause();
        escrow.unpause();

        vm.prank(idiot);
        escrow.deposit(1000e6);

        assertEq(escrow.getBalance(idiot), 1000e6, "Deposit should work after unpause");
    }

    function test_escrow_withdraw_works_afterUnpause() public {
        usdc.mint(idiot, 1000e6);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), 1000e6);
        escrow.deposit(1000e6);
        vm.stopPrank();

        escrow.pause();
        escrow.unpause();

        vm.prank(idiot);
        escrow.withdraw(500e6);

        assertEq(escrow.getBalance(idiot), 500e6, "Withdraw should work after unpause");
    }

    // ─── Collateral Pause Tests
    // ─────────────────────────────────────────

    function test_collateral_pause_onlyOwner() public {
        collateral.pause();
        assertTrue(collateral.paused(), "Should be paused");
    }

    function test_collateral_pause_reverts_nonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Collateral.NotPauserOrOwner.selector, nonOwner));
        vm.prank(nonOwner);
        collateral.pause();
    }

    function test_collateral_unpause_onlyOwner() public {
        collateral.pause();
        collateral.unpause();
        assertFalse(collateral.paused(), "Should be unpaused");
    }

    function test_collateral_unpause_reverts_nonOwner() public {
        collateral.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        vm.prank(nonOwner);
        collateral.unpause();
    }

    function test_collateral_deposit_reverts_whenPaused() public {
        usdc.mint(genius, 5000e6);
        vm.prank(genius);
        usdc.approve(address(collateral), 5000e6);

        collateral.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(genius);
        collateral.deposit(5000e6);
    }

    function test_collateral_withdraw_reverts_whenPaused() public {
        // Deposit first
        usdc.mint(genius, 5000e6);
        vm.startPrank(genius);
        usdc.approve(address(collateral), 5000e6);
        collateral.deposit(5000e6);
        vm.stopPrank();

        collateral.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(genius);
        collateral.withdraw(2000e6);
    }

    function test_collateral_deposit_works_afterUnpause() public {
        usdc.mint(genius, 5000e6);
        vm.prank(genius);
        usdc.approve(address(collateral), 5000e6);

        collateral.pause();
        collateral.unpause();

        vm.prank(genius);
        collateral.deposit(5000e6);

        assertEq(collateral.getDeposit(genius), 5000e6, "Deposit should work after unpause");
    }

    // ─── Audit Pause Tests
    // ──────────────────────────────────────────────

    function test_audit_pause_onlyOwner() public {
        audit.pause();
        assertTrue(audit.paused(), "Should be paused");
    }

    function test_audit_pause_reverts_nonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Audit.NotPauserOrOwner.selector, nonOwner));
        vm.prank(nonOwner);
        audit.pause();
    }

    function test_audit_unpause_onlyOwner() public {
        audit.pause();
        audit.unpause();
        assertFalse(audit.paused(), "Should be unpaused");
    }

    function test_audit_unpause_reverts_nonOwner() public {
        audit.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        vm.prank(nonOwner);
        audit.unpause();
    }

    function test_audit_trigger_reverts_whenPaused() public {
        audit.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        audit.trigger(genius, idiot);
    }

    function test_audit_settle_reverts_whenPaused() public {
        audit.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        audit.settle(genius, idiot);
    }

    function test_audit_earlyExit_reverts_whenPaused() public {
        audit.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        audit.earlyExit(genius, idiot);
    }

    // ─── Cross-contract pause isolation
    // ─────────────────────────────────

    function test_escrow_pause_does_not_affect_collateral() public {
        escrow.pause();

        // Collateral should still work
        usdc.mint(genius, 5000e6);
        vm.startPrank(genius);
        usdc.approve(address(collateral), 5000e6);
        collateral.deposit(5000e6);
        vm.stopPrank();

        assertEq(collateral.getDeposit(genius), 5000e6, "Collateral deposit should work when only escrow is paused");
    }

    function test_collateral_pause_does_not_affect_escrow() public {
        collateral.pause();

        // Escrow should still work
        usdc.mint(idiot, 1000e6);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), 1000e6);
        escrow.deposit(1000e6);
        vm.stopPrank();

        assertEq(escrow.getBalance(idiot), 1000e6, "Escrow deposit should work when only collateral is paused");
    }

    // ─── Pause state queries
    // ────────────────────────────────────────────

    function test_escrow_starts_unpaused() public view {
        assertFalse(escrow.paused(), "Escrow should start unpaused");
    }

    function test_collateral_starts_unpaused() public view {
        assertFalse(collateral.paused(), "Collateral should start unpaused");
    }

    function test_audit_starts_unpaused() public view {
        assertFalse(audit.paused(), "Audit should start unpaused");
    }

    function test_double_pause_reverts() public {
        escrow.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.pause();
    }

    function test_double_unpause_reverts() public {
        vm.expectRevert(Pausable.ExpectedPause.selector);
        escrow.unpause();
    }

    // ─── SignalCommitment Pause Tests
    // ─────────────────────────────────

    function test_signalCommitment_pause_onlyOwner() public {
        signalCommitment.pause();
        assertTrue(signalCommitment.paused(), "Should be paused");
    }

    function test_signalCommitment_pause_reverts_nonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.NotPauserOrOwner.selector, nonOwner));
        vm.prank(nonOwner);
        signalCommitment.pause();
    }

    function test_signalCommitment_unpause_onlyOwner() public {
        signalCommitment.pause();
        signalCommitment.unpause();
        assertFalse(signalCommitment.paused(), "Should be unpaused");
    }

    function test_signalCommitment_unpause_reverts_nonOwner() public {
        signalCommitment.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        vm.prank(nonOwner);
        signalCommitment.unpause();
    }

    function test_signalCommitment_commit_reverts_whenPaused() public {
        signalCommitment.pause();

        string[] memory decoys = new string[](10);
        for (uint256 i; i < 10; i++) decoys[i] = "decoy";
        string[] memory books = new string[](1);
        books[0] = "DraftKings";

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: 1,
                encryptedBlob: hex"deadbeef",
                commitHash: keccak256("signal"),
                sport: "NFL",
                maxPriceBps: 500,
                slaMultiplierBps: 15000,
                maxNotional: 10_000e6,
                minNotional: 0,
                expiresAt: block.timestamp + 1 days,
                decoyLines: decoys,
                availableSportsbooks: books
            })
        );
    }

    function test_signalCommitment_commit_works_afterUnpause() public {
        signalCommitment.pause();
        signalCommitment.unpause();

        string[] memory decoys = new string[](10);
        for (uint256 i; i < 10; i++) decoys[i] = "decoy";
        string[] memory books = new string[](1);
        books[0] = "DraftKings";

        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: 1,
                encryptedBlob: hex"deadbeef",
                commitHash: keccak256("signal"),
                sport: "NFL",
                maxPriceBps: 500,
                slaMultiplierBps: 15000,
                maxNotional: 10_000e6,
                minNotional: 0,
                expiresAt: block.timestamp + 1 days,
                decoyLines: decoys,
                availableSportsbooks: books
            })
        );

        assertEq(signalCommitment.getSignal(1).genius, genius, "Signal should be created after unpause");
    }

    function test_signalCommitment_starts_unpaused() public view {
        assertFalse(signalCommitment.paused(), "SignalCommitment should start unpaused");
    }

    function test_signalCommitment_pause_does_not_affect_escrow() public {
        signalCommitment.pause();

        // Escrow should still work
        usdc.mint(idiot, 1000e6);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), 1000e6);
        escrow.deposit(1000e6);
        vm.stopPrank();

        assertEq(escrow.getBalance(idiot), 1000e6, "Escrow should work when only SignalCommitment is paused");
    }
}
