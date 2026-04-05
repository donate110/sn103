// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {Account as DjinnAccount} from "../src/Account.sol";
import {Audit, AuditResult} from "../src/Audit.sol";
import {Escrow} from "../src/Escrow.sol";
import {OutcomeVoting} from "../src/OutcomeVoting.sol";
import {Outcome, PairQueueState} from "../src/interfaces/IDjinn.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title ForkUpgrade
/// @notice Tests the UUPS upgrade of Account, Audit, Escrow, and OutcomeVoting
///         against the live Base Sepolia deployment. Verifies:
///         1. Storage is not corrupted after upgrade
///         2. New queue-based flows work with real on-chain state
///         3. Existing authorized callers still work
///         4. Old data is still readable (legacy views)
contract ForkUpgradeTest is Test {
    // Live Base Sepolia proxy addresses
    address constant ACCOUNT_PROXY = 0x4546354Dd32a613B76Abf530F81c8359e7cE440B;
    address constant ESCROW_PROXY = 0xb43BA175a6784973eB3825acF801Cd7920ac692a;
    address constant AUDIT_PROXY = 0xCa7e642FE31BA83a7a857644E8894c1B93a2a44E;
    address constant OUTCOME_VOTING_PROXY = 0xAD534f4CAB13707BD4d65e4EF086A455e6A643e5;
    address constant COLLATERAL_PROXY = 0x71F0a8c6BBFc4C83c5203807fAdd305B0C0F4C88;
    address constant SIGNAL_COMMITMENT_PROXY = 0x4712479Ba57c9ED40405607b2B18967B359209C0;
    address constant TIMELOCK = 0x37f41EFfa8492022afF48B9Ef725008963F14f79;
    address constant USDC = 0x00e8293b05dbD3732EF3396ad1483E87e7265054;

    // Deployer is the timelock proposer
    address constant DEPLOYER = 0xD717b5fbA93F123f6ad530ae2Ab327B4DcDa1e37;

    DjinnAccount account;
    Audit audit;
    Escrow escrow;
    OutcomeVoting voting;

    function setUp() public {
        // Fork Base Sepolia at latest block
        vm.createSelectFork("https://sepolia.base.org");

        account = DjinnAccount(ACCOUNT_PROXY);
        audit = Audit(AUDIT_PROXY);
        escrow = Escrow(ESCROW_PROXY);
        voting = OutcomeVoting(OUTCOME_VOTING_PROXY);
    }

    // ─── Test 1: Upgrade Account proxy ──────────────────────────

    function test_upgradeAccount() public {
        // Read pre-upgrade state
        address preOwner = account.owner();
        address prePauser = account.pauser();
        bool preAuth = account.authorizedCallers(ESCROW_PROXY);

        // Deploy new implementation
        DjinnAccount newImpl = new DjinnAccount();

        // Simulate timelock executing the upgrade
        // The timelock is the owner of the proxy
        vm.prank(TIMELOCK);
        account.pause();

        vm.prank(TIMELOCK);
        UUPSUpgradeable(address(account)).upgradeToAndCall(
            address(newImpl),
            "" // no re-initialization needed
        );

        vm.prank(TIMELOCK);
        account.unpause();

        // Verify state survived
        assertEq(account.owner(), preOwner, "Owner changed after upgrade");
        assertEq(account.pauser(), prePauser, "Pauser changed after upgrade");
        assertEq(account.authorizedCallers(ESCROW_PROXY), preAuth, "Escrow auth lost");
        assertEq(account.authorizedCallers(AUDIT_PROXY), true, "Audit auth lost");
    }

    // ─── Test 2: Upgrade Escrow proxy ───────────────────────────

    function test_upgradeEscrow() public {
        address preOwner = escrow.owner();
        uint256 preNextId = escrow.nextPurchaseId();

        Escrow newImpl = new Escrow();

        vm.prank(TIMELOCK);
        escrow.pause();

        vm.prank(TIMELOCK);
        UUPSUpgradeable(address(escrow)).upgradeToAndCall(address(newImpl), "");

        vm.prank(TIMELOCK);
        escrow.unpause();

        assertEq(escrow.owner(), preOwner, "Owner changed");
        assertEq(escrow.nextPurchaseId(), preNextId, "nextPurchaseId changed");
        assertEq(address(escrow.usdc()), USDC, "USDC address changed");
    }

    // ─── Test 3: Upgrade Audit proxy ────────────────────────────

    function test_upgradeAudit() public {
        address preOwner = audit.owner();
        address preTreasury = audit.protocolTreasury();

        Audit newImpl = new Audit();

        vm.prank(TIMELOCK);
        audit.pause();

        vm.prank(TIMELOCK);
        UUPSUpgradeable(address(audit)).upgradeToAndCall(address(newImpl), "");

        vm.prank(TIMELOCK);
        audit.unpause();

        assertEq(audit.owner(), preOwner, "Owner changed");
        assertEq(audit.protocolTreasury(), preTreasury, "Treasury changed");
        assertEq(audit.outcomeVoting(), OUTCOME_VOTING_PROXY, "OutcomeVoting ref changed");
    }

    // ─── Test 4: Upgrade OutcomeVoting proxy ────────────────────

    function test_upgradeOutcomeVoting() public {
        address preOwner = voting.owner();
        uint256 preValidatorCount = voting.validatorCount();

        OutcomeVoting newImpl = new OutcomeVoting();

        vm.prank(TIMELOCK);
        voting.pause();

        vm.prank(TIMELOCK);
        UUPSUpgradeable(address(voting)).upgradeToAndCall(address(newImpl), "");

        vm.prank(TIMELOCK);
        voting.unpause();

        assertEq(voting.owner(), preOwner, "Owner changed");
        assertEq(voting.validatorCount(), preValidatorCount, "Validator count changed");
    }

    // ─── Test 5: Full upgrade + new queue flow ──────────────────

    function test_fullUpgrade_thenNewPurchaseFlow() public {
        // Upgrade all 4 contracts
        _upgradeAll();

        // Now test the new queue-based flow with a fresh pair
        address genius = makeAddr("forkTestGenius");
        address idiot = makeAddr("forkTestIdiot");

        // Record purchases via authorized caller (Escrow proxy)
        vm.startPrank(ESCROW_PROXY);
        account.recordPurchase(genius, idiot, 999001);
        account.recordPurchase(genius, idiot, 999002);
        account.recordPurchase(genius, idiot, 999003);
        vm.stopPrank();

        // Verify queue state
        PairQueueState memory qs = account.getQueueState(genius, idiot);
        assertEq(qs.totalPurchases, 3, "Should have 3 purchases");
        assertEq(qs.resolvedCount, 0, "None resolved yet");
        assertEq(qs.auditedCount, 0, "None audited");

        // Record outcomes
        vm.startPrank(ESCROW_PROXY);
        account.recordOutcome(genius, idiot, 999001, Outcome.Favorable);
        account.recordOutcome(genius, idiot, 999002, Outcome.Unfavorable);
        account.recordOutcome(genius, idiot, 999003, Outcome.Void);
        vm.stopPrank();

        qs = account.getQueueState(genius, idiot);
        assertEq(qs.resolvedCount, 3, "All 3 resolved");

        // Legacy views should work
        assertEq(account.getSignalCount(genius, idiot), 3, "Legacy signalCount");
        assertFalse(account.isAuditReady(genius, idiot), "Not audit ready (< 10)");
    }

    // ─── Test 6: No purchase limit after upgrade ────────────────

    function test_fullUpgrade_noPurchaseLimit() public {
        _upgradeAll();

        address genius = makeAddr("unlimitedGenius");
        address idiot = makeAddr("unlimitedIdiot");

        // Record 25 purchases (would have failed at 11 in v1)
        vm.startPrank(ESCROW_PROXY);
        for (uint256 i = 1; i <= 25; i++) {
            account.recordPurchase(genius, idiot, 800000 + i);
        }
        vm.stopPrank();

        PairQueueState memory qs = account.getQueueState(genius, idiot);
        assertEq(qs.totalPurchases, 25, "All 25 recorded");

        uint256[] memory ids = account.getPairPurchaseIds(genius, idiot);
        assertEq(ids.length, 25, "25 IDs in queue");
    }

    // ─── Test 7: Self-purchase blocked after upgrade ────────────

    function test_fullUpgrade_selfPurchaseReverts() public {
        _upgradeAll();

        address selfTrader = makeAddr("selfTrader");

        vm.expectRevert(DjinnAccount.SelfPurchase.selector);
        vm.prank(ESCROW_PROXY);
        account.recordPurchase(selfTrader, selfTrader, 777001);
    }

    // ─── Test 8: Mark batch audited after upgrade ───────────────

    function test_fullUpgrade_markBatchAudited() public {
        _upgradeAll();

        address genius = makeAddr("batchGenius");
        address idiot = makeAddr("batchIdiot");

        // Create and resolve 10 purchases
        vm.startPrank(ESCROW_PROXY);
        for (uint256 i = 1; i <= 10; i++) {
            account.recordPurchase(genius, idiot, 600000 + i);
            account.recordOutcome(genius, idiot, 600000 + i, Outcome.Favorable);
        }
        vm.stopPrank();

        assertTrue(account.isAuditReady(genius, idiot), "Should be audit ready");

        // Mark batch audited (via Audit proxy, which is authorized)
        uint256[] memory batch = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            batch[i] = 600001 + i;
        }

        vm.prank(AUDIT_PROXY);
        uint256 batchId = account.markBatchAudited(genius, idiot, batch);
        assertEq(batchId, 0, "First batch should be ID 0");

        // Verify batch recorded
        uint256[] memory stored = account.getAuditBatch(genius, idiot, 0);
        assertEq(stored.length, 10, "Batch has 10 purchases");

        // All purchases marked as audited
        for (uint256 i = 0; i < 10; i++) {
            assertTrue(account.isPurchaseAudited(600001 + i));
        }

        // Queue state updated
        PairQueueState memory qs = account.getQueueState(genius, idiot);
        assertEq(qs.auditedCount, 10);
        assertEq(qs.auditBatchCount, 1);
    }

    // ─── Test 9: Escrow recordBatchClaimable after upgrade ──────

    function test_fullUpgrade_escrowBatchClaimable() public {
        _upgradeAll();

        address genius = makeAddr("claimGenius");
        address idiot = makeAddr("claimIdiot");

        // Record claimable via Audit proxy
        vm.prank(AUDIT_PROXY);
        escrow.recordBatchClaimable(genius, idiot, 0, 500e6);

        assertEq(escrow.batchClaimable(genius, idiot, 0), 500e6);
    }

    // ─── Test 10: Lazy migration of v1 pair data ─────────────────

    function test_fullUpgrade_lazyMigrationOfExistingPair() public {
        // BEFORE upgrade: create v1 data using the existing genius wallet
        // The E2E test genius (0x68fc) has 10 purchases with our buyer
        // We know from earlier diagnostics: signalCount=10, cycle=0, auditReady=true

        address genius = 0x68fc8eeC9E5551d4c93a89b6d861f0a05e0A2A1d;
        address buyer = 0xa01C91f04C37d049D5887fd4D7B08AeEFc8Ca434;

        // Read v1 state before upgrade
        uint256 v1SignalCount = account.getSignalCount(genius, buyer);

        // Upgrade
        _upgradeAll();

        // AFTER upgrade: v1 data should be visible through v2 views
        // without any explicit migration call
        PairQueueState memory qs = account.getQueueState(genius, buyer);
        assertEq(qs.totalPurchases, v1SignalCount, "V1 purchases should be visible");

        uint256[] memory ids = account.getPairPurchaseIds(genius, buyer);
        assertEq(ids.length, v1SignalCount, "V1 purchase IDs should be returned");

        // signalCount should reflect v1 data
        assertEq(account.getSignalCount(genius, buyer), v1SignalCount, "Legacy signalCount should match");

        // Now trigger lazy migration by recording a new purchase
        vm.prank(ESCROW_PROXY);
        account.recordPurchase(genius, buyer, 888888);

        // After migration, the new purchase should be appended to v1 data
        qs = account.getQueueState(genius, buyer);
        assertEq(qs.totalPurchases, v1SignalCount + 1, "V1 + new purchase");

        ids = account.getPairPurchaseIds(genius, buyer);
        assertEq(ids.length, v1SignalCount + 1, "All IDs including new one");
        assertEq(ids[ids.length - 1], 888888, "New purchase is last");
    }

    // ─── Test 11: V1 pair with outcomes migrates resolved count ──

    function test_fullUpgrade_migratedResolvedCount() public {
        // Create a fresh v1 pair with some outcomes before upgrade
        address genius = makeAddr("v1Genius");
        address idiot = makeAddr("v1Idiot");

        // Record 3 purchases and 2 outcomes via authorized callers (v1 contracts)
        vm.startPrank(ESCROW_PROXY);
        account.recordPurchase(genius, idiot, 500001);
        account.recordPurchase(genius, idiot, 500002);
        account.recordPurchase(genius, idiot, 500003);
        account.recordOutcome(genius, idiot, 500001, Outcome.Favorable);
        account.recordOutcome(genius, idiot, 500002, Outcome.Unfavorable);
        // 500003 left Pending
        vm.stopPrank();

        // Upgrade
        _upgradeAll();

        // View functions should see 3 purchases, 2 resolved (before migration)
        PairQueueState memory qs = account.getQueueState(genius, idiot);
        assertEq(qs.totalPurchases, 3, "3 v1 purchases visible");
        assertEq(qs.resolvedCount, 2, "2 resolved visible");

        // Trigger lazy migration via a new purchase
        vm.prank(ESCROW_PROXY);
        account.recordPurchase(genius, idiot, 500004);

        qs = account.getQueueState(genius, idiot);
        assertEq(qs.totalPurchases, 4, "3 v1 + 1 v2");
        assertEq(qs.resolvedCount, 2, "Still 2 resolved (new one is pending)");

        // Resolve the old pending one through v2
        vm.prank(ESCROW_PROXY);
        account.recordOutcome(genius, idiot, 500003, Outcome.Void);

        qs = account.getQueueState(genius, idiot);
        assertEq(qs.resolvedCount, 3, "Now 3 resolved");
    }

    // ─── Helper: upgrade all 4 contracts ────────────────────────

    function _upgradeAll() internal {
        DjinnAccount newAccount = new DjinnAccount();
        Escrow newEscrow = new Escrow();
        Audit newAudit = new Audit();
        OutcomeVoting newVoting = new OutcomeVoting();

        vm.startPrank(TIMELOCK);

        account.pause();
        UUPSUpgradeable(address(account)).upgradeToAndCall(address(newAccount), "");
        account.unpause();

        escrow.pause();
        UUPSUpgradeable(address(escrow)).upgradeToAndCall(address(newEscrow), "");
        escrow.unpause();

        audit.pause();
        UUPSUpgradeable(address(audit)).upgradeToAndCall(address(newAudit), "");
        audit.unpause();

        voting.pause();
        UUPSUpgradeable(address(voting)).upgradeToAndCall(address(newVoting), "");
        voting.unpause();

        vm.stopPrank();
    }
}
