// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {Account as DjinnAccount} from "../src/Account.sol";
import {Outcome, PairQueueState} from "../src/interfaces/IDjinn.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

/// @title AccountHandler
/// @notice Target contract for invariant testing. Foundry calls random sequences
///         of these functions and we assert invariants hold after each call.
contract AccountHandler is Test {
    DjinnAccount public acct;
    address public authorized;
    address public genius = address(0xB1);
    address public idiot = address(0xB2);

    uint256 public nextPurchaseId = 1;
    uint256 public recordedCount;
    uint256 public resolvedCount;
    uint256 public auditedCount;

    // Track which purchase IDs are resolved for batch creation
    uint256[] public resolvedIds;

    constructor(DjinnAccount _acct, address _authorized) {
        acct = _acct;
        authorized = _authorized;
    }

    function recordPurchase() external {
        uint256 pid = nextPurchaseId++;
        vm.prank(authorized);
        acct.recordPurchase(genius, idiot, pid);
        recordedCount++;
    }

    function recordOutcome(uint8 outcomeType) external {
        // Find the next unresolved purchase
        if (resolvedCount >= recordedCount) return; // nothing to resolve

        uint256 pid = resolvedCount + 1; // purchaseIds are 1-indexed
        Outcome outcome;
        uint256 mod = outcomeType % 3;
        if (mod == 0) outcome = Outcome.Favorable;
        else if (mod == 1) outcome = Outcome.Unfavorable;
        else outcome = Outcome.Void;

        vm.prank(authorized);
        acct.recordOutcome(genius, idiot, pid, outcome);
        resolvedCount++;
        resolvedIds.push(pid);
    }

    function markBatchAudited(uint8 batchSize) external {
        uint256 available = resolvedCount - auditedCount;
        if (available == 0) return;

        uint256 size = uint256(batchSize) % 20 + 1; // 1-20
        if (size > available) size = available;

        uint256[] memory batch = new uint256[](size);
        for (uint256 i = 0; i < size; i++) {
            batch[i] = auditedCount + i + 1; // next unaudited resolved IDs
        }

        vm.prank(authorized);
        acct.markBatchAudited(genius, idiot, batch);
        auditedCount += size;
    }
}

/// @title InvariantTest
/// @notice Tests that key invariants hold across random call sequences.
contract InvariantTest is Test {
    DjinnAccount public acct;
    AccountHandler public handler;

    address public owner = address(this);
    address public authorized = address(0xA1);
    address public genius = address(0xB1);
    address public idiot = address(0xB2);

    function setUp() public {
        acct = DjinnAccount(
            _deployProxy(address(new DjinnAccount()), abi.encodeCall(DjinnAccount.initialize, (owner)))
        );
        acct.setAuthorizedCaller(authorized, true);

        handler = new AccountHandler(acct, authorized);

        // Only target the handler
        targetContract(address(handler));
    }

    /// @notice auditedCount <= resolvedCount <= totalPurchases
    function invariant_countOrdering() public view {
        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        assertLe(qs.auditedCount, qs.resolvedCount, "audited > resolved");
        assertLe(qs.resolvedCount, qs.totalPurchases, "resolved > total");
    }

    /// @notice isAuditReady iff (resolved - audited) >= 10
    function invariant_auditReadyConsistency() public view {
        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        bool ready = acct.isAuditReady(genius, idiot);
        uint256 unauditedResolved = qs.resolvedCount - qs.auditedCount;
        if (ready) {
            assertGe(unauditedResolved, 10, "audit ready but < 10 unaudited resolved");
        } else {
            assertLt(unauditedResolved, 10, "not audit ready but >= 10 unaudited resolved");
        }
    }

    /// @notice Handler's tracking matches on-chain state
    function invariant_handlerMatchesOnChain() public view {
        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        assertEq(qs.totalPurchases, handler.recordedCount(), "recorded mismatch");
        assertEq(qs.resolvedCount, handler.resolvedCount(), "resolved mismatch");
        assertEq(qs.auditedCount, handler.auditedCount(), "audited mismatch");
    }

    /// @notice All purchase IDs in the queue are unique and sequential
    function invariant_purchaseIdsSequential() public view {
        uint256[] memory ids = acct.getPairPurchaseIds(genius, idiot);
        for (uint256 i = 0; i < ids.length; i++) {
            assertEq(ids[i], i + 1, "purchase IDs not sequential");
        }
    }

    /// @notice Legacy getSignalCount = totalPurchases - auditedCount
    function invariant_legacySignalCount() public view {
        PairQueueState memory qs = acct.getQueueState(genius, idiot);
        uint256 legacy = acct.getSignalCount(genius, idiot);
        assertEq(legacy, qs.totalPurchases - qs.auditedCount, "legacy signalCount mismatch");
    }

    /// @notice Audited purchases return true from isPurchaseAudited
    function invariant_auditedFlagConsistency() public view {
        uint256 audited = handler.auditedCount();
        for (uint256 i = 1; i <= audited; i++) {
            assertTrue(acct.isPurchaseAudited(i), "purchase should be audited");
        }
        // Purchases beyond audited count should NOT be audited
        uint256 total = handler.recordedCount();
        for (uint256 i = audited + 1; i <= total; i++) {
            assertFalse(acct.isPurchaseAudited(i), "purchase should not be audited");
        }
    }
}
