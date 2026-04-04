// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Outcome of a signal after game completion
enum Outcome {
    Pending,
    Favorable,
    Unfavorable,
    Void
}

/// @notice Status of a signal
enum SignalStatus {
    Active,
    Cancelled,
    Settled
}

/// @notice Data for a committed signal
struct Signal {
    address genius;
    bytes encryptedBlob;
    bytes32 commitHash;
    string sport;
    uint256 maxPriceBps;
    uint256 slaMultiplierBps;
    uint256 maxNotional;
    uint256 minNotional;
    uint256 expiresAt;
    string[] decoyLines;
    string[] availableSportsbooks;
    SignalStatus status;
    uint256 createdAt;
}

/// @notice Data for a purchase of a signal
struct Purchase {
    address idiot;
    uint256 signalId;
    uint256 notional;
    uint256 feePaid;
    uint256 creditUsed;
    uint256 usdcPaid;
    uint256 odds;
    Outcome outcome;
    uint256 purchasedAt;
}

/// @notice State of a Genius-Idiot account pair (legacy, kept for UUPS storage compatibility)
struct AccountState {
    uint256 currentCycle;
    uint256 signalCount;
    int256 outcomeBalance;
    uint256[] purchaseIds;
    bool settled;
}

/// @notice Summary of a Genius-Idiot pair's queue state
struct PairQueueState {
    uint256 totalPurchases;
    uint256 resolvedCount;
    uint256 auditedCount;
    uint256 auditBatchCount;
}
