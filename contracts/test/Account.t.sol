// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {Account as DjinnAccount} from "../src/Account.sol";
import {AccountState, Outcome} from "../src/interfaces/IDjinn.sol";
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

    // ─── Helpers
    // ─────────────────────────────────────────────────────────

    function _recordPurchase(uint256 purchaseId) internal {
        vm.prank(authorizedCaller);
        acct.recordPurchase(genius, idiot, purchaseId);
    }

    // ─── Tests: Record purchases up to 10
    // ────────────────────────────────

    function test_recordPurchase_singlePurchase() public {
        _recordPurchase(1);

        assertEq(acct.getSignalCount(genius, idiot), 1);
        uint256[] memory ids = acct.getPurchaseIds(genius, idiot);
        assertEq(ids.length, 1);
        assertEq(ids[0], 1);
    }

    function test_recordPurchase_tenPurchases() public {
        for (uint256 i = 1; i <= 10; i++) {
            _recordPurchase(i);
        }

        assertEq(acct.getSignalCount(genius, idiot), 10);
        uint256[] memory ids = acct.getPurchaseIds(genius, idiot);
        assertEq(ids.length, 10);
        for (uint256 i = 0; i < 10; i++) {
            assertEq(ids[i], i + 1);
        }
    }

    function test_recordPurchase_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit DjinnAccount.PurchaseRecorded(genius, idiot, 42, 1);

        vm.prank(authorizedCaller);
        acct.recordPurchase(genius, idiot, 42);
    }

    // ─── Tests: Revert on 11th purchase
    // ──────────────────────────────────

    function test_recordPurchase_revertOn11thPurchase() public {
        for (uint256 i = 1; i <= 10; i++) {
            _recordPurchase(i);
        }

        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.CycleSignalLimitReached.selector, genius, idiot, 10));
        _recordPurchase(11);
    }

    // ─── Tests: Record outcomes
    // ──────────────────────────────────────────

    function test_recordOutcome_favorable() public {
        _recordPurchase(1);

        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 1, Outcome.Favorable);

        assertEq(uint8(acct.getOutcome(genius, idiot, 1)), uint8(Outcome.Favorable));

        AccountState memory state = acct.getAccountState(genius, idiot);
        assertEq(state.outcomeBalance, 1);
    }

    function test_recordOutcome_unfavorable() public {
        _recordPurchase(1);

        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 1, Outcome.Unfavorable);

        assertEq(uint8(acct.getOutcome(genius, idiot, 1)), uint8(Outcome.Unfavorable));

        AccountState memory state = acct.getAccountState(genius, idiot);
        assertEq(state.outcomeBalance, -1);
    }

    function test_recordOutcome_void() public {
        _recordPurchase(1);

        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 1, Outcome.Void);

        assertEq(uint8(acct.getOutcome(genius, idiot, 1)), uint8(Outcome.Void));

        // Void does not affect quality score
        AccountState memory state = acct.getAccountState(genius, idiot);
        assertEq(state.outcomeBalance, 0);
    }

    function test_recordOutcome_emitsEvent() public {
        _recordPurchase(1);

        vm.expectEmit(true, true, false, true);
        emit DjinnAccount.OutcomeRecorded(genius, idiot, 1, Outcome.Favorable);

        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 1, Outcome.Favorable);
    }

    function test_recordOutcome_multipleOutcomes_outcomeBalanceAccumulates() public {
        // 3 favorable, 2 unfavorable, 1 void => quality = 3 - 2 = 1
        for (uint256 i = 1; i <= 6; i++) {
            _recordPurchase(i);
        }

        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 1, Outcome.Favorable);
        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 2, Outcome.Favorable);
        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 3, Outcome.Favorable);
        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 4, Outcome.Unfavorable);
        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 5, Outcome.Unfavorable);
        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 6, Outcome.Void);

        AccountState memory state = acct.getAccountState(genius, idiot);
        assertEq(state.outcomeBalance, 1);
    }

    function test_recordOutcome_revertOnPending() public {
        _recordPurchase(1);

        vm.expectRevert(DjinnAccount.InvalidOutcome.selector);
        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 1, Outcome.Pending);
    }

    function test_recordOutcome_revertOnDuplicate() public {
        _recordPurchase(1);

        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 1, Outcome.Favorable);

        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.OutcomeAlreadyRecorded.selector, genius, idiot, 1));
        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 1, Outcome.Unfavorable);
    }

    // ─── Tests: isAuditReady returns true at 10
    // ──────────────────────────

    function test_isAuditReady_falseBelow10() public {
        for (uint256 i = 1; i <= 9; i++) {
            _recordPurchase(i);
        }
        assertFalse(acct.isAuditReady(genius, idiot));
    }

    function test_isAuditReady_trueAt10() public {
        for (uint256 i = 1; i <= 10; i++) {
            _recordPurchase(i);
        }
        assertTrue(acct.isAuditReady(genius, idiot));
    }

    function test_isAuditReady_falseForNewPair() public {
        assertFalse(acct.isAuditReady(genius, idiot));
    }

    // ─── Tests: Start new cycle resets state
    // ─────────────────────────────

    function test_startNewCycle_resetsState() public {
        for (uint256 i = 1; i <= 10; i++) {
            _recordPurchase(i);
        }

        assertEq(acct.getCurrentCycle(genius, idiot), 0);

        vm.prank(authorizedCaller);
        acct.setSettled(genius, idiot, true);
        vm.prank(authorizedCaller);
        acct.startNewCycle(genius, idiot);

        assertEq(acct.getCurrentCycle(genius, idiot), 1);
        assertEq(acct.getSignalCount(genius, idiot), 0);
        uint256[] memory ids = acct.getPurchaseIds(genius, idiot);
        assertEq(ids.length, 0);
        assertFalse(acct.isAuditReady(genius, idiot));
    }

    function test_startNewCycle_emitsEvent() public {
        vm.prank(authorizedCaller);
        acct.setSettled(genius, idiot, true);

        vm.expectEmit(true, true, false, true);
        emit DjinnAccount.NewCycleStarted(genius, idiot, 1);

        vm.prank(authorizedCaller);
        acct.startNewCycle(genius, idiot);
    }

    function test_startNewCycle_allowsNewPurchases() public {
        for (uint256 i = 1; i <= 10; i++) {
            _recordPurchase(i);
        }

        vm.prank(authorizedCaller);
        acct.setSettled(genius, idiot, true);
        vm.prank(authorizedCaller);
        acct.startNewCycle(genius, idiot);

        // Can now record purchases in the new cycle
        for (uint256 i = 100; i <= 109; i++) {
            _recordPurchase(i);
        }

        assertEq(acct.getSignalCount(genius, idiot), 10);
        assertTrue(acct.isAuditReady(genius, idiot));
    }

    function test_startNewCycle_revertIfNotSettled() public {
        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.CycleNotSettled.selector, genius, idiot, 0));
        vm.prank(authorizedCaller);
        acct.startNewCycle(genius, idiot);
    }

    // ─── Tests: Revert duplicate purchase recording
    // ──────────────────────

    function test_recordPurchase_revertDuplicate() public {
        _recordPurchase(42);

        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.PurchaseAlreadyRecorded.selector, genius, idiot, 42));
        _recordPurchase(42);
    }

    // ─── Tests: Revert outcome for non-existent purchase ─────────────────

    function test_recordOutcome_revertForNonExistentPurchase() public {
        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.PurchaseNotFound.selector, genius, idiot, 999));
        vm.prank(authorizedCaller);
        acct.recordOutcome(genius, idiot, 999, Outcome.Favorable);
    }

    // ─── Tests: Authorization
    // ────────────────────────────────────────────

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

    function test_startNewCycle_revertByUnauthorized() public {
        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.CallerNotAuthorized.selector, unauthorizedCaller));
        vm.prank(unauthorizedCaller);
        acct.startNewCycle(genius, idiot);
    }

    // ─── Tests: Address validation
    // ───────────────────────────────────────

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

    function test_recordPurchase_selfPurchaseRejected() public {
        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.GeniusEqualsIdiot.selector, genius));
        vm.prank(authorizedCaller);
        acct.recordPurchase(genius, genius, 1);
    }

    // ─── Tests: View functions
    // ───────────────────────────────────────────

    function test_getAccount_defaultValues() public view {
        AccountState memory state = acct.getAccountState(genius, idiot);
        assertEq(state.currentCycle, 0);
        assertEq(state.signalCount, 0);
        assertEq(state.outcomeBalance, 0);
        assertEq(state.purchaseIds.length, 0);
        assertFalse(state.settled);
    }

    function test_getAccountState_aliasWorks() public {
        _recordPurchase(1);

        AccountState memory stateA = acct.getAccountState(genius, idiot);
        AccountState memory stateB = acct.getAccountState(genius, idiot);

        assertEq(stateA.signalCount, stateB.signalCount);
        assertEq(stateA.currentCycle, stateB.currentCycle);
    }

    function test_getCurrentCycle_incrementsAfterNewCycle() public {
        assertEq(acct.getCurrentCycle(genius, idiot), 0);

        vm.prank(authorizedCaller);
        acct.setSettled(genius, idiot, true);
        vm.prank(authorizedCaller);
        acct.startNewCycle(genius, idiot);
        assertEq(acct.getCurrentCycle(genius, idiot), 1);

        vm.prank(authorizedCaller);
        acct.setSettled(genius, idiot, true);
        vm.prank(authorizedCaller);
        acct.startNewCycle(genius, idiot);
        assertEq(acct.getCurrentCycle(genius, idiot), 2);
    }

    // ─── Tests: settleAudit
    // ──────────────────────────────────────────────

    function test_settleAudit_marksSettledAndStartsNewCycle() public {
        for (uint256 i = 1; i <= 10; i++) {
            _recordPurchase(i);
        }

        vm.prank(authorizedCaller);
        acct.settleAudit(genius, idiot);

        // After settleAudit, a new cycle has started
        assertEq(acct.getCurrentCycle(genius, idiot), 1);
        assertEq(acct.getSignalCount(genius, idiot), 0);
        assertFalse(acct.isAuditReady(genius, idiot));
    }

    // ─── Tests: setSettled
    // ───────────────────────────────────────────────

    function test_setSettled_works() public {
        vm.prank(authorizedCaller);
        acct.setSettled(genius, idiot, true);

        AccountState memory state = acct.getAccountState(genius, idiot);
        assertTrue(state.settled);

        vm.prank(authorizedCaller);
        acct.setSettled(genius, idiot, false);

        state = acct.getAccountState(genius, idiot);
        assertFalse(state.settled);
    }
}
