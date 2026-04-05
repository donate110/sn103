// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {Account as DjinnAccount} from "../src/Account.sol";
import {AccountState, PairQueueState, Outcome} from "../src/interfaces/IDjinn.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

contract AccountTest is Test {
    DjinnAccount public acct;

    address public owner = address(this);
    address public authorizedCaller = address(0xA1);
    address public unauthorizedCaller = address(0xA2);
    address public genius = address(0xB1);
    address public idiot = address(0xB2);

    function setUp() public {
        acct = DjinnAccount(_deployProxy(address(new DjinnAccount()), abi.encodeCall(DjinnAccount.initialize, (owner))));
        acct.setAuthorizedCaller(authorizedCaller, true);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _recordPurchase(uint256 purchaseId) internal {
        vm.prank(authorizedCaller);
        acct.recordPurchase(genius, idiot, purchaseId);
    }

    function _recordOutcome(uint256 purchaseId, Outcome outcome) internal {
        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, purchaseId, outcome);
    }

    function _recordPurchaseAndOutcome(uint256 purchaseId, Outcome outcome) internal {
        _recordPurchase(purchaseId);
        _recordOutcome(purchaseId, outcome);
    }

    /// @dev Records N purchases with IDs 1..n and resolves them all as Favorable
    function _fillAndResolve(uint256 n) internal {
        for (uint256 i = 1; i <= n; i++) {
            _recordPurchase(i);
        }
        for (uint256 i = 1; i <= n; i++) {
            _recordOutcome(i, Outcome.Favorable);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 1. Recording Purchases
    // ═══════════════════════════════════════════════════════════════

    function test_recordPurchase_single() public {
        _recordPurchase(1);

        uint256[] memory ids = acct.getPairPurchaseIds(genius, idiot);
        assertEq(ids.length, 1);
        assertEq(ids[0], 1);
        assertTrue(acct.isPurchaseRecorded(genius, idiot, 1));
    }

    function test_recordPurchase_multiple() public {
        for (uint256 i = 1; i <= 5; i++) {
            _recordPurchase(i);
        }

        uint256[] memory ids = acct.getPairPurchaseIds(genius, idiot);
        assertEq(ids.length, 5);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(ids[i], i + 1);
        }
    }

    function test_recordPurchase_noLimitAt10() public {
        for (uint256 i = 1; i <= 10; i++) {
            _recordPurchase(i);
        }

        // 11th purchase succeeds (no cycle limit in v2)
        _recordPurchase(11);

        uint256[] memory ids = acct.getPairPurchaseIds(genius, idiot);
        assertEq(ids.length, 11);
    }

    function test_recordPurchase_twentyPlus() public {
        for (uint256 i = 1; i <= 25; i++) {
            _recordPurchase(i);
        }

        uint256[] memory ids = acct.getPairPurchaseIds(genius, idiot);
        assertEq(ids.length, 25);
        assertEq(ids[24], 25);
    }

    function test_recordPurchase_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit DjinnAccount.PurchaseRecorded(genius, idiot, 42, 1);

        vm.prank(authorizedCaller);
        acct.recordPurchase(genius, idiot, 42);
    }

    function test_recordPurchase_eventTotalIncrementsCorrectly() public {
        _recordPurchase(1);

        vm.expectEmit(true, true, false, true);
        emit DjinnAccount.PurchaseRecorded(genius, idiot, 2, 2);

        vm.prank(authorizedCaller);
        acct.recordPurchase(genius, idiot, 2);
    }

    function test_recordPurchase_revertDuplicate() public {
        _recordPurchase(42);

        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.PurchaseAlreadyRecorded.selector, genius, idiot, 42));
        _recordPurchase(42);
    }

    function test_recordPurchase_differentPairsIndependent() public {
        address genius2 = address(0xC1);
        address idiot2 = address(0xC2);

        _recordPurchase(1);

        vm.prank(authorizedCaller);
        acct.recordPurchase(genius2, idiot2, 1);

        assertEq(acct.getPairPurchaseIds(genius, idiot).length, 1);
        assertEq(acct.getPairPurchaseIds(genius2, idiot2).length, 1);
    }

    function test_recordPurchase_samePurchaseIdDifferentPairs() public {
        address genius2 = address(0xC1);
        address idiot2 = address(0xC2);

        _recordPurchase(100);

        vm.prank(authorizedCaller);
        acct.recordPurchase(genius2, idiot2, 100);

        assertTrue(acct.isPurchaseRecorded(genius, idiot, 100));
        assertTrue(acct.isPurchaseRecorded(genius2, idiot2, 100));
    }

    // ═══════════════════════════════════════════════════════════════
    // 2. Recording Outcomes
    // ═══════════════════════════════════════════════════════════════

    function test_recordOutcome_favorable() public {
        _recordPurchase(1);
        _recordOutcome(1, Outcome.Favorable);

        assertEq(uint8(acct.getOutcome(genius, idiot, 1)), uint8(Outcome.Favorable));
    }

    function test_recordOutcome_unfavorable() public {
        _recordPurchase(1);
        _recordOutcome(1, Outcome.Unfavorable);

        assertEq(uint8(acct.getOutcome(genius, idiot, 1)), uint8(Outcome.Unfavorable));
    }

    function test_recordOutcome_void() public {
        _recordPurchase(1);
        _recordOutcome(1, Outcome.Void);

        assertEq(uint8(acct.getOutcome(genius, idiot, 1)), uint8(Outcome.Void));
    }

    function test_recordOutcome_incrementsResolvedCount() public {
        _recordPurchase(1);
        _recordPurchase(2);
        _recordPurchase(3);

        _recordOutcome(1, Outcome.Favorable);
        _recordOutcome(2, Outcome.Unfavorable);

        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        assertEq(qs.totalPurchases, 3);
        assertEq(qs.resolvedCount, 2);
    }

    function test_recordOutcome_voidAlsoResolved() public {
        _recordPurchaseAndOutcome(1, Outcome.Void);

        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        assertEq(qs.resolvedCount, 1);
    }

    function test_recordOutcome_emitsEvent() public {
        _recordPurchase(1);

        vm.expectEmit(true, true, false, true);
        emit DjinnAccount.OutcomeRecorded(genius, idiot, 1, Outcome.Favorable);

        _recordOutcome(1, Outcome.Favorable);
    }

    function test_recordOutcome_revertOnPending() public {
        _recordPurchase(1);

        vm.expectRevert(DjinnAccount.InvalidOutcome.selector);
        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 1, Outcome.Pending);
    }

    function test_recordOutcome_revertOnDuplicate() public {
        _recordPurchaseAndOutcome(1, Outcome.Favorable);

        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.OutcomeAlreadyRecorded.selector, genius, idiot, 1));
        _recordOutcome(1, Outcome.Unfavorable);
    }

    function test_recordOutcome_revertForNonExistentPurchase() public {
        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.PurchaseNotFound.selector, genius, idiot, 999));
        _recordOutcome(999, Outcome.Favorable);
    }

    // ═══════════════════════════════════════════════════════════════
    // 3. Marking Batches as Audited
    // ═══════════════════════════════════════════════════════════════

    function test_markBatchAudited_basic() public {
        _fillAndResolve(10);

        uint256[] memory batch = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            batch[i] = i + 1;
        }

        vm.prank(authorizedCaller);
        uint256 batchId = acct.markBatchAudited(genius, idiot, batch);

        assertEq(batchId, 0);
        assertEq(acct.getAuditBatchCount(genius, idiot), 1);

        uint256[] memory stored = acct.getAuditBatch(genius, idiot, 0);
        assertEq(stored.length, 10);
        for (uint256 i = 0; i < 10; i++) {
            assertEq(stored[i], i + 1);
            assertTrue(acct.isPurchaseAudited(i + 1));
        }
    }

    function test_markBatchAudited_multipleBatches() public {
        _fillAndResolve(20);

        uint256[] memory batch1 = new uint256[](10);
        uint256[] memory batch2 = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            batch1[i] = i + 1;
            batch2[i] = i + 11;
        }

        vm.prank(authorizedCaller);
        uint256 id1 = acct.markBatchAudited(genius, idiot, batch1);
        vm.prank(authorizedCaller);
        uint256 id2 = acct.markBatchAudited(genius, idiot, batch2);

        assertEq(id1, 0);
        assertEq(id2, 1);
        assertEq(acct.getAuditBatchCount(genius, idiot), 2);
    }

    function test_markBatchAudited_emitsEvent() public {
        _fillAndResolve(10);

        uint256[] memory batch = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            batch[i] = i + 1;
        }

        vm.expectEmit(true, true, false, true);
        emit DjinnAccount.AuditBatchCompleted(genius, idiot, 0, 10);

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);
    }

    function test_markBatchAudited_updatesQueueState() public {
        _fillAndResolve(15);

        uint256[] memory batch = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            batch[i] = i + 1;
        }

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);

        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        assertEq(qs.totalPurchases, 15);
        assertEq(qs.resolvedCount, 15);
        assertEq(qs.auditedCount, 10);
        assertEq(qs.auditBatchCount, 1);
    }

    function test_markBatchAudited_partialBatch() public {
        _fillAndResolve(5);

        uint256[] memory batch = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) {
            batch[i] = i + 1;
        }

        vm.prank(authorizedCaller);
        uint256 batchId = acct.markBatchAudited(genius, idiot, batch);
        assertEq(batchId, 0);
        assertEq(acct.getAuditBatchCount(genius, idiot), 1);
    }

    function test_markBatchAudited_singlePurchase() public {
        _recordPurchaseAndOutcome(1, Outcome.Favorable);

        uint256[] memory batch = new uint256[](1);
        batch[0] = 1;

        vm.prank(authorizedCaller);
        uint256 batchId = acct.markBatchAudited(genius, idiot, batch);
        assertEq(batchId, 0);
        assertTrue(acct.isPurchaseAudited(1));
    }

    // ─── markBatchAudited validation errors ─────────────────────────

    function test_markBatchAudited_revertEmptyBatch() public {
        uint256[] memory batch = new uint256[](0);

        vm.expectRevert(DjinnAccount.EmptyBatch.selector);
        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);
    }

    function test_markBatchAudited_revertPurchaseNotInPair() public {
        _recordPurchaseAndOutcome(1, Outcome.Favorable);

        uint256[] memory batch = new uint256[](1);
        batch[0] = 999; // not recorded

        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.PurchaseNotInPair.selector, 999));
        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);
    }

    function test_markBatchAudited_revertPurchaseNotResolved() public {
        _recordPurchase(1); // no outcome recorded

        uint256[] memory batch = new uint256[](1);
        batch[0] = 1;

        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.PurchaseNotResolved.selector, 1));
        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);
    }

    function test_markBatchAudited_revertPurchaseAlreadyAudited() public {
        _recordPurchaseAndOutcome(1, Outcome.Favorable);

        uint256[] memory batch = new uint256[](1);
        batch[0] = 1;

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);

        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.PurchaseAlreadyAudited.selector, 1));
        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);
    }

    function test_markBatchAudited_revertMixedValidAndInvalid() public {
        _recordPurchaseAndOutcome(1, Outcome.Favorable);
        _recordPurchase(2); // not resolved

        uint256[] memory batch = new uint256[](2);
        batch[0] = 1;
        batch[1] = 2;

        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.PurchaseNotResolved.selector, 2));
        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);
    }

    function test_markBatchAudited_revertDuplicateInSameBatch() public {
        _recordPurchaseAndOutcome(1, Outcome.Favorable);

        uint256[] memory batch = new uint256[](2);
        batch[0] = 1;
        batch[1] = 1;

        // Second entry will fail because first already marked audited
        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.PurchaseAlreadyAudited.selector, 1));
        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);
    }

    // ═══════════════════════════════════════════════════════════════
    // 4. Queue State Tracking
    // ═══════════════════════════════════════════════════════════════

    function test_getQueueState_emptyPair() public view {
        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        assertEq(qs.totalPurchases, 0);
        assertEq(qs.resolvedCount, 0);
        assertEq(qs.auditedCount, 0);
        assertEq(qs.auditBatchCount, 0);
    }

    function test_getQueueState_afterPurchasesOnly() public {
        for (uint256 i = 1; i <= 3; i++) {
            _recordPurchase(i);
        }

        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        assertEq(qs.totalPurchases, 3);
        assertEq(qs.resolvedCount, 0);
        assertEq(qs.auditedCount, 0);
        assertEq(qs.auditBatchCount, 0);
    }

    function test_getQueueState_afterPartialResolution() public {
        for (uint256 i = 1; i <= 5; i++) {
            _recordPurchase(i);
        }
        _recordOutcome(1, Outcome.Favorable);
        _recordOutcome(2, Outcome.Unfavorable);

        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        assertEq(qs.totalPurchases, 5);
        assertEq(qs.resolvedCount, 2);
        assertEq(qs.auditedCount, 0);
    }

    function test_getQueueState_fullLifecycle() public {
        // 15 purchases, all resolved, 10 audited in first batch
        _fillAndResolve(15);

        uint256[] memory batch = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            batch[i] = i + 1;
        }

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);

        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        assertEq(qs.totalPurchases, 15);
        assertEq(qs.resolvedCount, 15);
        assertEq(qs.auditedCount, 10);
        assertEq(qs.auditBatchCount, 1);
    }

    // ═══════════════════════════════════════════════════════════════
    // 5. Active Pair Counting
    // ═══════════════════════════════════════════════════════════════

    function test_activePairCount_incrementsOnFirstPurchase() public {
        assertEq(acct.activePairCount(), 0);
        _recordPurchase(1);
        assertEq(acct.activePairCount(), 1);
    }

    function test_activePairCount_staysAfterSecondPurchase() public {
        _recordPurchase(1);
        _recordPurchase(2);
        assertEq(acct.activePairCount(), 1);
    }

    function test_activePairCount_multipleDistinctPairs() public {
        address genius2 = address(0xC1);
        address idiot2 = address(0xC2);

        _recordPurchase(1);
        vm.prank(authorizedCaller);
        acct.recordPurchase(genius2, idiot2, 1);

        assertEq(acct.activePairCount(), 2);
    }

    function test_activePairCount_decrementsWhenAllAudited() public {
        _recordPurchaseAndOutcome(1, Outcome.Favorable);

        assertEq(acct.activePairCount(), 1);

        uint256[] memory batch = new uint256[](1);
        batch[0] = 1;

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);

        assertEq(acct.activePairCount(), 0);
    }

    function test_activePairCount_staysActiveWithUnauditedRemaining() public {
        _recordPurchaseAndOutcome(1, Outcome.Favorable);
        _recordPurchase(2); // not resolved, not audited

        uint256[] memory batch = new uint256[](1);
        batch[0] = 1;

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);

        // Still active because purchase 2 is unaudited
        assertEq(acct.activePairCount(), 1);
    }

    function test_activePairCount_reactivatesAfterNewPurchase() public {
        // Fully audit the pair to deactivate it
        _recordPurchaseAndOutcome(1, Outcome.Favorable);

        uint256[] memory batch = new uint256[](1);
        batch[0] = 1;

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);
        assertEq(acct.activePairCount(), 0);

        // New purchase reactivates
        _recordPurchase(2);
        assertEq(acct.activePairCount(), 1);
    }

    // ═══════════════════════════════════════════════════════════════
    // 6. Legacy View Compatibility
    // ═══════════════════════════════════════════════════════════════

    function test_getCurrentCycle_returnsAuditBatchCount() public {
        assertEq(acct.getCurrentCycle(genius, idiot), 0);

        _fillAndResolve(10);

        uint256[] memory batch = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            batch[i] = i + 1;
        }

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);

        assertEq(acct.getCurrentCycle(genius, idiot), 1);
    }

    function test_isAuditReady_falseBelow10Resolved() public {
        for (uint256 i = 1; i <= 9; i++) {
            _recordPurchaseAndOutcome(i, Outcome.Favorable);
        }
        assertFalse(acct.isAuditReady(genius, idiot));
    }

    function test_isAuditReady_trueAt10Resolved() public {
        for (uint256 i = 1; i <= 10; i++) {
            _recordPurchaseAndOutcome(i, Outcome.Favorable);
        }
        assertTrue(acct.isAuditReady(genius, idiot));
    }

    function test_isAuditReady_basedOnUnauditedResolved() public {
        // 10 resolved, audit them all, then check
        _fillAndResolve(10);

        uint256[] memory batch = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            batch[i] = i + 1;
        }

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);

        // All resolved are now audited, so not ready
        assertFalse(acct.isAuditReady(genius, idiot));

        // Add 10 more resolved purchases to make it ready again
        for (uint256 i = 11; i <= 20; i++) {
            _recordPurchaseAndOutcome(i, Outcome.Favorable);
        }
        assertTrue(acct.isAuditReady(genius, idiot));
    }

    function test_isAuditReady_falseForNewPair() public view {
        assertFalse(acct.isAuditReady(genius, idiot));
    }

    function test_getSignalCount_returnsUnaudited() public {
        for (uint256 i = 1; i <= 5; i++) {
            _recordPurchase(i);
        }

        assertEq(acct.getSignalCount(genius, idiot), 5);

        // Resolve and audit 3
        for (uint256 i = 1; i <= 3; i++) {
            _recordOutcome(i, Outcome.Favorable);
        }

        uint256[] memory batch = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            batch[i] = i + 1;
        }

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);

        assertEq(acct.getSignalCount(genius, idiot), 2);
    }

    function test_getAccountState_defaultValues() public view {
        AccountState memory state = acct.getAccountState(genius, idiot);
        assertEq(state.currentCycle, 0);
        assertEq(state.signalCount, 0);
        assertEq(state.outcomeBalance, 0);
        assertEq(state.purchaseIds.length, 0);
        assertFalse(state.settled);
    }

    function test_getAccountState_mapsToQueueState() public {
        _fillAndResolve(15);

        uint256[] memory batch = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            batch[i] = i + 1;
        }

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);

        AccountState memory state = acct.getAccountState(genius, idiot);
        assertEq(state.currentCycle, 1); // auditBatchCount
        assertEq(state.signalCount, 5); // total(15) - audited(10)
        assertEq(state.outcomeBalance, 0); // always 0 in v2
        assertEq(state.purchaseIds.length, 15);
        assertFalse(state.settled); // always false in v2
    }

    // ═══════════════════════════════════════════════════════════════
    // 7. Authorization Checks
    // ═══════════════════════════════════════════════════════════════

    function test_recordPurchase_revertByUnauthorized() public {
        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.CallerNotAuthorized.selector, unauthorizedCaller));
        vm.prank(unauthorizedCaller);
        acct.recordPurchase(genius, idiot, 1);
    }

    function test_recordOutcome_revertByUnauthorized() public {
        _recordPurchase(1);

        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.CallerNotAuthorized.selector, unauthorizedCaller));
        vm.prank(unauthorizedCaller);
        acct.recordOutcome(genius, idiot, 1, Outcome.Favorable);
    }

    function test_markBatchAudited_revertByUnauthorized() public {
        _recordPurchaseAndOutcome(1, Outcome.Favorable);

        uint256[] memory batch = new uint256[](1);
        batch[0] = 1;

        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.CallerNotAuthorized.selector, unauthorizedCaller));
        vm.prank(unauthorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);
    }

    function test_setAuthorizedCaller_onlyOwner() public {
        vm.expectRevert();
        vm.prank(unauthorizedCaller);
        acct.setAuthorizedCaller(address(0xF0), true);
    }

    function test_setAuthorizedCaller_revertZeroAddress() public {
        vm.expectRevert(DjinnAccount.ZeroAddress.selector);
        acct.setAuthorizedCaller(address(0), true);
    }

    function test_setAuthorizedCaller_grantAndRevoke() public {
        address newCaller = address(0xF1);
        acct.setAuthorizedCaller(newCaller, true);
        assertTrue(acct.authorizedCallers(newCaller));

        acct.setAuthorizedCaller(newCaller, false);
        assertFalse(acct.authorizedCallers(newCaller));
    }

    function test_setAuthorizedCaller_emitsEvent() public {
        address newCaller = address(0xF2);

        vm.expectEmit(true, false, false, true);
        emit DjinnAccount.AuthorizedCallerSet(newCaller, true);

        acct.setAuthorizedCaller(newCaller, true);
    }

    // ═══════════════════════════════════════════════════════════════
    // 8. Address Validation
    // ═══════════════════════════════════════════════════════════════

    function test_recordPurchase_revertZeroGenius() public {
        vm.expectRevert(DjinnAccount.ZeroGeniusAddress.selector);
        vm.prank(authorizedCaller);
        acct.recordPurchase(address(0), idiot, 1);
    }

    function test_recordPurchase_revertZeroIdiot() public {
        vm.expectRevert(DjinnAccount.ZeroIdiotAddress.selector);
        vm.prank(authorizedCaller);
        acct.recordPurchase(genius, address(0), 1);
    }

    function test_recordPurchase_selfPurchaseAllowed() public {
        vm.prank(authorizedCaller);
        acct.recordPurchase(genius, genius, 1);
        assertEq(acct.getPairPurchaseIds(genius, genius).length, 1);
    }

    function test_recordOutcome_revertZeroGenius() public {
        vm.expectRevert(DjinnAccount.ZeroGeniusAddress.selector);
        vm.prank(authorizedCaller);
        acct.recordOutcome(address(0), idiot, 1, Outcome.Favorable);
    }

    function test_recordOutcome_selfPurchaseAllowed() public {
        vm.prank(authorizedCaller);
        acct.recordPurchase(genius, genius, 1);
        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, genius, 1, Outcome.Favorable);
        assertEq(uint256(acct.getOutcome(genius, genius, 1)), uint256(Outcome.Favorable));
    }

    function test_markBatchAudited_revertZeroGenius() public {
        uint256[] memory batch = new uint256[](1);
        batch[0] = 1;

        vm.expectRevert(DjinnAccount.ZeroGeniusAddress.selector);
        vm.prank(authorizedCaller);
        acct.markBatchAudited(address(0), idiot, batch);
    }

    function test_markBatchAudited_selfPurchaseAllowed() public {
        vm.prank(authorizedCaller);
        acct.recordPurchase(genius, genius, 1);
        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, genius, 1, Outcome.Favorable);

        uint256[] memory batch = new uint256[](1);
        batch[0] = 1;
        vm.prank(authorizedCaller);
        uint256 batchId = acct.markBatchAudited(genius, genius, batch);
        assertEq(batchId, 0);
    }

    // ═══════════════════════════════════════════════════════════════
    // 9. Edge Cases
    // ═══════════════════════════════════════════════════════════════

    function test_isPurchaseRecorded_falseForUnrecorded() public view {
        assertFalse(acct.isPurchaseRecorded(genius, idiot, 42));
    }

    function test_isPurchaseAudited_falseForUnaudited() public view {
        assertFalse(acct.isPurchaseAudited(42));
    }

    function test_getOutcome_defaultsPending() public view {
        assertEq(uint8(acct.getOutcome(genius, idiot, 42)), uint8(Outcome.Pending));
    }

    function test_getAuditBatch_emptyForNonExistentBatch() public view {
        uint256[] memory batch = acct.getAuditBatch(genius, idiot, 0);
        assertEq(batch.length, 0);
    }

    function test_getPairPurchaseIds_emptyForNewPair() public view {
        uint256[] memory ids = acct.getPairPurchaseIds(genius, idiot);
        assertEq(ids.length, 0);
    }

    function test_purchaseId_zeroIsValid() public {
        _recordPurchase(0);
        assertTrue(acct.isPurchaseRecorded(genius, idiot, 0));
    }

    function test_purchaseId_maxUint256() public {
        _recordPurchase(type(uint256).max);
        assertTrue(acct.isPurchaseRecorded(genius, idiot, type(uint256).max));
    }

    function test_continuousPurchaseAfterAudit() public {
        // Record 10, resolve, audit, then keep recording more
        _fillAndResolve(10);

        uint256[] memory batch = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            batch[i] = i + 1;
        }

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);

        // New purchases continue seamlessly
        for (uint256 i = 11; i <= 20; i++) {
            _recordPurchase(i);
        }

        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        assertEq(qs.totalPurchases, 20);
        assertEq(qs.auditedCount, 10);
        assertEq(qs.auditBatchCount, 1);
    }

    function test_auditOnlySubsetOfResolved() public {
        // 20 resolved, audit only 5 of them
        _fillAndResolve(20);

        uint256[] memory batch = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) {
            batch[i] = i + 1;
        }

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);

        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        assertEq(qs.auditedCount, 5);
        assertEq(qs.resolvedCount, 20);
    }

    function test_auditNonConsecutiveIds() public {
        // Record IDs 10, 20, 30 and audit only 10 and 30
        _recordPurchaseAndOutcome(10, Outcome.Favorable);
        _recordPurchaseAndOutcome(20, Outcome.Unfavorable);
        _recordPurchaseAndOutcome(30, Outcome.Void);

        uint256[] memory batch = new uint256[](2);
        batch[0] = 10;
        batch[1] = 30;

        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);

        assertTrue(acct.isPurchaseAudited(10));
        assertFalse(acct.isPurchaseAudited(20));
        assertTrue(acct.isPurchaseAudited(30));

        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        assertEq(qs.auditedCount, 2);
    }

    // ═══════════════════════════════════════════════════════════════
    // 10. Pause Functionality
    // ═══════════════════════════════════════════════════════════════

    function test_pause_onlyPauserOrOwner() public {
        // Owner can pause
        acct.pause();
        acct.unpause();

        // Pauser can pause
        address pauser = address(0xD1);
        acct.setPauser(pauser);
        vm.prank(pauser);
        acct.pause();
        acct.unpause();

        // Random address cannot pause
        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.NotPauserOrOwner.selector, unauthorizedCaller));
        vm.prank(unauthorizedCaller);
        acct.pause();
    }

    function test_unpause_onlyOwner() public {
        acct.pause();

        vm.expectRevert();
        vm.prank(unauthorizedCaller);
        acct.unpause();

        acct.unpause();
    }

    function test_recordPurchase_revertWhenPaused() public {
        acct.pause();

        vm.expectRevert();
        _recordPurchase(1);
    }

    function test_recordOutcome_revertWhenPaused() public {
        _recordPurchase(1);
        acct.pause();

        vm.expectRevert();
        _recordOutcome(1, Outcome.Favorable);
    }

    function test_markBatchAudited_revertWhenPaused() public {
        _recordPurchaseAndOutcome(1, Outcome.Favorable);
        acct.pause();

        uint256[] memory batch = new uint256[](1);
        batch[0] = 1;

        vm.expectRevert();
        vm.prank(authorizedCaller);
        acct.markBatchAudited(genius, idiot, batch);
    }

    function test_setPauser_emitsEvent() public {
        address pauser = address(0xD2);

        vm.expectEmit(true, false, false, false);
        emit DjinnAccount.PauserUpdated(pauser);

        acct.setPauser(pauser);
    }

    // ═══════════════════════════════════════════════════════════════
    // 11. Upgrade Guard
    // ═══════════════════════════════════════════════════════════════

    function test_renounceOwnership_disabled() public {
        vm.expectRevert("disabled");
        acct.renounceOwnership();
    }
}
