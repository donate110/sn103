// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Outcome, Purchase, Signal, SignalStatus, AccountState, PairQueueState} from "./IDjinn.sol";

// -------------------------------------------------------------------------
// Cross-contract interfaces for the Djinn Protocol.
// Each contract imports only what it needs from this single file.
// -------------------------------------------------------------------------

/// @notice SignalCommitment — used by Escrow and Audit
interface ISignalCommitment {
    function getSignal(uint256 signalId) external view returns (Signal memory);
    function getSignalSlaMultiplierBps(uint256 signalId) external view returns (uint256);
    function updateStatus(uint256 signalId, SignalStatus status) external;
}

/// @notice Collateral — used by Escrow (lock only) and Audit (slash/release/query)
interface ICollateral {
    function lock(uint256 signalId, address genius, uint256 amount) external;
    function slash(address genius, uint256 amount, address recipient) external returns (uint256 slashAmount);
    function release(uint256 signalId, address genius, uint256 amount) external;
    function getSignalLock(address genius, uint256 signalId) external view returns (uint256);
    function getAvailable(address genius) external view returns (uint256);
    function freezeWithdrawals(address genius) external;
    function unfreezeWithdrawals(address genius) external;
}

/// @notice CreditLedger — used by Escrow (balance/burn) and Audit (mint)
interface ICreditLedger {
    function balanceOf(address account) external view returns (uint256);
    function burn(address account, uint256 amount) external;
    function mint(address to, uint256 amount) external;
}

/// @notice Account — used by Escrow, Audit, and OutcomeVoting
interface IAccount {
    // ─── Queue-based API (v2) ────────────────────────
    function recordPurchase(address genius, address idiot, uint256 purchaseId) external;
    function recordOutcome(address genius, address idiot, uint256 purchaseId, Outcome outcome) external;
    function markBatchAudited(address genius, address idiot, uint256[] calldata purchaseIds) external returns (uint256 batchId);
    function getOutcome(address genius, address idiot, uint256 purchaseId) external view returns (Outcome);
    function isPurchaseRecorded(address genius, address idiot, uint256 purchaseId) external view returns (bool);
    function isPurchaseAudited(uint256 purchaseId) external view returns (bool);
    function getPairPurchaseIds(address genius, address idiot) external view returns (uint256[] memory);
    function getQueueState(address genius, address idiot) external view returns (PairQueueState memory);
    function getAuditBatch(address genius, address idiot, uint256 batchId) external view returns (uint256[] memory);
    function getAuditBatchCount(address genius, address idiot) external view returns (uint256);
    function activePairCount() external view returns (uint256);
    // ─── Legacy API (kept for backwards compatibility) ────
    function getCurrentCycle(address genius, address idiot) external view returns (uint256);
    function isAuditReady(address genius, address idiot) external view returns (bool);
    function getAccountState(address genius, address idiot) external view returns (AccountState memory);
    function getSignalCount(address genius, address idiot) external view returns (uint256);
}

/// @notice Escrow — used by Audit
interface IEscrow {
    function getPurchase(uint256 purchaseId) external view returns (Purchase memory);
    function recordBatchClaimable(address genius, address idiot, uint256 batchId, uint256 amount) external;
    // Legacy (kept for storage reads, not written to in v2)
    function feePool(address genius, address idiot, uint256 cycle) external view returns (uint256);
}

/// @notice Audit — used by Escrow (fee claim check) and OutcomeVoting (voted settlement)
interface IAudit {
    function auditResults(address genius, address idiot, uint256 batchId) external view
        returns (int256 qualityScore, uint256 trancheA, uint256 trancheB, uint256 protocolFee, uint256 timestamp);
    function settleByVote(
        address genius, address idiot, uint256[] calldata purchaseIds,
        int256 qualityScore, uint256 totalNotional
    ) external;
    function earlyExitByVote(
        address genius, address idiot, uint256[] calldata purchaseIds,
        int256 qualityScore, uint256 totalNotional
    ) external;
}

