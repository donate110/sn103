// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccountState, PairQueueState, Outcome} from "./interfaces/IDjinn.sol";

/// @title Account (v2 — Queue-based audits)
/// @notice Tracks all purchases between a Genius-Idiot pair in an append-only queue.
///         Purchases accumulate without limit. When 10+ have resolved outcomes,
///         validators can audit any batch of 10. The pair is never blocked from trading.
/// @dev UUPS upgrade from v1 (cycle-based). All v1 storage slots are preserved in place;
///      new queue-based storage is appended after the __gap.
contract Account is Initializable, OwnableUpgradeable, PausableUpgradeable, UUPSUpgradeable {
    // ─── Legacy Storage (v1, preserved for UUPS layout compatibility) ───
    // DO NOT reorder, remove, or insert above these. New storage goes after __gap.

    /// @dev v1: keccak256(genius, idiot) => AccountState (no longer written to)
    mapping(bytes32 => AccountState) private _accounts;

    /// @dev v1: keccak256(genius, idiot) => whether the account has been initialized
    mapping(bytes32 => bool) private _initialized;

    /// @dev keccak256(genius, idiot) => purchaseId => Outcome (STILL USED in v2)
    mapping(bytes32 => mapping(uint256 => Outcome)) private _outcomes;

    /// @dev keccak256(genius, idiot) => purchaseId => whether recorded (STILL USED in v2)
    mapping(bytes32 => mapping(uint256 => bool)) private _purchaseRecorded;

    /// @dev address => whether it can call mutating functions (STILL USED in v2)
    mapping(address => bool) public authorizedCallers;

    /// @notice Count of genius-idiot pairs with unaudited purchases
    uint256 public activePairCount;

    /// @dev Tracks whether a pair is currently counted in activePairCount
    mapping(bytes32 => bool) private _pairIsActive;

    /// @notice Address authorized to pause this contract in emergencies
    address public pauser;

    // ─── Legacy storage gap (v1 used uint256[43]) ───────────────────
    // We consume slots from __gap for new v2 storage. Original gap was 43 slots.
    // New v2 storage uses 6 slots, leaving 37 in the gap.

    // ─── Queue-based Storage (v2) ───────────────────────────────────

    /// @notice All purchase IDs for a (genius, idiot) pair, in order of recording
    mapping(bytes32 => uint256[]) private _pairPurchaseIds;

    /// @notice Whether a purchase has been included in a completed audit batch
    mapping(uint256 => bool) private _purchaseAudited;

    /// @notice Number of resolved (non-Pending) outcomes per pair
    mapping(bytes32 => uint256) private _resolvedCount;

    /// @notice Number of audited purchases per pair
    mapping(bytes32 => uint256) private _auditedCount;

    /// @notice Number of completed audit batches per pair
    mapping(bytes32 => uint256) private _auditBatchCount;

    /// @notice Purchase IDs for each completed audit batch
    /// @dev pairKey => batchId => purchaseIds
    mapping(bytes32 => mapping(uint256 => uint256[])) private _auditBatches;

    /// @notice Whether v1 cycle data has been migrated into the v2 queue for a pair
    /// @dev Set to true after lazy migration copies _accounts[key].purchaseIds into _pairPurchaseIds
    mapping(bytes32 => bool) private _v1Migrated;

    /// @dev Reduced gap: 43 original - 7 new mappings = 36
    uint256[36] private __gap;

    // ─── Events ─────────────────────────────────────────────────────

    /// @notice Emitted when a purchase is recorded for a Genius-Idiot pair
    event PurchaseRecorded(address indexed genius, address indexed idiot, uint256 purchaseId, uint256 totalPurchases);

    /// @notice Emitted when an outcome is recorded for a purchase
    event OutcomeRecorded(address indexed genius, address indexed idiot, uint256 purchaseId, Outcome outcome);

    /// @notice Emitted when an audit batch is completed
    event AuditBatchCompleted(address indexed genius, address indexed idiot, uint256 batchId, uint256 purchaseCount);

    /// @notice Emitted when an authorized caller is added or removed
    event AuthorizedCallerSet(address indexed caller, bool authorized);

    /// @notice Emitted when v1 cycle data is lazily migrated into the v2 queue
    event V1PairMigrated(address indexed genius, address indexed idiot, uint256 purchaseCount, uint256 resolvedCount);

    /// @notice Emitted when the pauser address is updated
    event PauserUpdated(address indexed newPauser);

    // ─── Errors ─────────────────────────────────────────────────────

    error CallerNotAuthorized(address caller);
    error ZeroGeniusAddress();
    error ZeroIdiotAddress();
    error SelfPurchase();

    error PurchaseAlreadyRecorded(address genius, address idiot, uint256 purchaseId);
    error PurchaseNotFound(address genius, address idiot, uint256 purchaseId);
    error OutcomeAlreadyRecorded(address genius, address idiot, uint256 purchaseId);
    error InvalidOutcome();
    error ZeroAddress();
    error NotPauserOrOwner(address caller);
    error PurchaseAlreadyAudited(uint256 purchaseId);
    error PurchaseNotResolved(uint256 purchaseId);
    error PurchaseNotInPair(uint256 purchaseId);
    error EmptyBatch();

    // ─── Modifiers ──────────────────────────────────────────────────

    modifier onlyAuthorized() {
        if (!authorizedCallers[msg.sender]) {
            revert CallerNotAuthorized(msg.sender);
        }
        _;
    }

    // ─── Constructor / Initializer ──────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the Account contract (replaces constructor for proxy pattern)
    /// @param initialOwner Address that will own this contract and manage authorized callers
    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __Pausable_init();
    }

    // ─── External Functions ─────────────────────────────────────────

    /// @notice Record a purchase for a Genius-Idiot pair. No limit on purchases.
    /// @param genius The Genius address
    /// @param idiot The Idiot (buyer) address
    /// @param purchaseId The unique purchase identifier
    function recordPurchase(address genius, address idiot, uint256 purchaseId) external onlyAuthorized whenNotPaused {
        _validatePair(genius, idiot);

        bytes32 key = _pairKey(genius, idiot);
        _ensureMigrated(key, genius, idiot);

        if (_purchaseRecorded[key][purchaseId]) {
            revert PurchaseAlreadyRecorded(genius, idiot, purchaseId);
        }

        // Track active pair (has unaudited purchases)
        if (!_pairIsActive[key]) {
            _pairIsActive[key] = true;
            activePairCount++;
        }

        _purchaseRecorded[key][purchaseId] = true;
        _pairPurchaseIds[key].push(purchaseId);

        emit PurchaseRecorded(genius, idiot, purchaseId, _pairPurchaseIds[key].length);
    }

    /// @notice Record the outcome of a specific purchase
    /// @param genius The Genius address
    /// @param idiot The Idiot (buyer) address
    /// @param purchaseId The purchase to record an outcome for
    /// @param outcome The outcome (Favorable, Unfavorable, or Void)
    function recordOutcome(address genius, address idiot, uint256 purchaseId, Outcome outcome) external onlyAuthorized whenNotPaused {
        _validatePair(genius, idiot);
        if (outcome == Outcome.Pending) revert InvalidOutcome();

        bytes32 key = _pairKey(genius, idiot);
        _ensureMigrated(key, genius, idiot);

        if (!_purchaseRecorded[key][purchaseId]) {
            revert PurchaseNotFound(genius, idiot, purchaseId);
        }

        if (_outcomes[key][purchaseId] != Outcome.Pending) {
            revert OutcomeAlreadyRecorded(genius, idiot, purchaseId);
        }

        _outcomes[key][purchaseId] = outcome;
        _resolvedCount[key]++;

        emit OutcomeRecorded(genius, idiot, purchaseId, outcome);
    }

    /// @notice Mark a batch of purchases as audited. Called by the Audit contract
    ///         after settlement completes. Validates all purchases belong to the pair,
    ///         are resolved, and haven't been audited before.
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    /// @param purchaseIds The purchases to mark as audited
    /// @return batchId The assigned audit batch ID
    function markBatchAudited(
        address genius,
        address idiot,
        uint256[] calldata purchaseIds
    ) external onlyAuthorized whenNotPaused returns (uint256 batchId) {
        _validatePair(genius, idiot);
        if (purchaseIds.length == 0) revert EmptyBatch();

        bytes32 key = _pairKey(genius, idiot);
        _ensureMigrated(key, genius, idiot);

        for (uint256 i; i < purchaseIds.length; ++i) {
            uint256 pid = purchaseIds[i];
            if (!_purchaseRecorded[key][pid]) revert PurchaseNotInPair(pid);
            if (_outcomes[key][pid] == Outcome.Pending) revert PurchaseNotResolved(pid);
            if (_purchaseAudited[pid]) revert PurchaseAlreadyAudited(pid);

            _purchaseAudited[pid] = true;
        }

        _auditedCount[key] += purchaseIds.length;

        batchId = _auditBatchCount[key];
        _auditBatches[key][batchId] = purchaseIds;
        _auditBatchCount[key] = batchId + 1;

        // If all purchases are now audited, pair is no longer active
        if (_auditedCount[key] == _pairPurchaseIds[key].length && _pairIsActive[key]) {
            _pairIsActive[key] = false;
            activePairCount--;
        }

        emit AuditBatchCompleted(genius, idiot, batchId, purchaseIds.length);
    }

    /// @notice Authorize or deauthorize a contract to call mutating functions
    /// @param caller The address to authorize or deauthorize
    /// @param authorized Whether the address should be authorized
    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = authorized;
        emit AuthorizedCallerSet(caller, authorized);
    }

    // ─── View Functions (v2 Queue API) ──────────────────────────────
    // All views account for unmigrated v1 data by checking both storages.

    /// @notice Returns the queue state summary for a Genius-Idiot pair
    function getQueueState(address genius, address idiot) external view returns (PairQueueState memory) {
        bytes32 key = _pairKey(genius, idiot);
        (uint256 total, uint256 resolved) = _effectiveCounts(key);
        return PairQueueState({
            totalPurchases: total,
            resolvedCount: resolved,
            auditedCount: _auditedCount[key],
            auditBatchCount: _auditBatchCount[key]
        });
    }

    /// @notice Returns all purchase IDs for a pair (includes unmigrated v1 data)
    function getPairPurchaseIds(address genius, address idiot) external view returns (uint256[] memory) {
        bytes32 key = _pairKey(genius, idiot);
        if (_v1Migrated[key] || _accounts[key].purchaseIds.length == 0) {
            return _pairPurchaseIds[key];
        }
        // Merge: v1 data first, then any v2 data
        uint256[] memory v1 = _accounts[key].purchaseIds;
        uint256[] memory v2 = _pairPurchaseIds[key];
        uint256[] memory merged = new uint256[](v1.length + v2.length);
        for (uint256 i; i < v1.length; ++i) merged[i] = v1[i];
        for (uint256 i; i < v2.length; ++i) merged[v1.length + i] = v2[i];
        return merged;
    }

    /// @notice Returns the outcome for a specific purchase
    function getOutcome(address genius, address idiot, uint256 purchaseId) external view returns (Outcome) {
        return _outcomes[_pairKey(genius, idiot)][purchaseId];
    }

    /// @notice Whether a purchase has been recorded for this pair
    function isPurchaseRecorded(address genius, address idiot, uint256 purchaseId) external view returns (bool) {
        return _purchaseRecorded[_pairKey(genius, idiot)][purchaseId];
    }

    /// @notice Whether a purchase has been audited
    function isPurchaseAudited(uint256 purchaseId) external view returns (bool) {
        return _purchaseAudited[purchaseId];
    }

    /// @notice Returns the purchase IDs for a specific audit batch
    function getAuditBatch(address genius, address idiot, uint256 batchId) external view returns (uint256[] memory) {
        return _auditBatches[_pairKey(genius, idiot)][batchId];
    }

    /// @notice Returns the number of completed audit batches for a pair
    function getAuditBatchCount(address genius, address idiot) external view returns (uint256) {
        return _auditBatchCount[_pairKey(genius, idiot)];
    }

    // ─── Legacy View Functions (backwards compatibility) ────────────

    function getCurrentCycle(address genius, address idiot) external view returns (uint256) {
        return _auditBatchCount[_pairKey(genius, idiot)];
    }

    function isAuditReady(address genius, address idiot) external view returns (bool) {
        bytes32 key = _pairKey(genius, idiot);
        (uint256 total, uint256 resolved) = _effectiveCounts(key);
        uint256 unauditedResolved = resolved - _auditedCount[key];
        return total > 0 && unauditedResolved >= 10;
    }

    function getAccountState(address genius, address idiot) external view returns (AccountState memory) {
        bytes32 key = _pairKey(genius, idiot);
        (uint256 total,) = _effectiveCounts(key);
        uint256[] memory ids = this.getPairPurchaseIds(genius, idiot);
        return AccountState({
            currentCycle: _auditBatchCount[key],
            signalCount: total - _auditedCount[key],
            outcomeBalance: 0,
            purchaseIds: ids,
            settled: false
        });
    }

    function getSignalCount(address genius, address idiot) external view returns (uint256) {
        bytes32 key = _pairKey(genius, idiot);
        (uint256 total,) = _effectiveCounts(key);
        return total - _auditedCount[key];
    }

    /// @dev Returns (totalPurchases, resolvedCount) accounting for unmigrated v1 data.
    function _effectiveCounts(bytes32 key) internal view returns (uint256 total, uint256 resolved) {
        total = _pairPurchaseIds[key].length;
        resolved = _resolvedCount[key];

        if (!_v1Migrated[key]) {
            uint256 v1Len = _accounts[key].purchaseIds.length;
            if (v1Len > 0) {
                total += v1Len;
                for (uint256 i; i < v1Len; ++i) {
                    if (_outcomes[key][_accounts[key].purchaseIds[i]] != Outcome.Pending) {
                        resolved++;
                    }
                }
            }
        }
    }

    // ─── Internal Functions ─────────────────────────────────────────

    /// @dev Lazily migrates v1 cycle data into the v2 queue on first access.
    ///      Copies purchaseIds from _accounts[key] to _pairPurchaseIds[key],
    ///      counts resolved outcomes, and marks the pair as active.
    ///      Costs gas on first interaction per pair; subsequent calls are a no-op.
    function _ensureMigrated(bytes32 key, address genius, address idiot) internal {
        if (_v1Migrated[key]) return;
        _v1Migrated[key] = true;

        AccountState storage oldAcct = _accounts[key];
        uint256 len = oldAcct.purchaseIds.length;
        if (len == 0) return;

        uint256 resolved;
        for (uint256 i; i < len; ++i) {
            uint256 pid = oldAcct.purchaseIds[i];
            _pairPurchaseIds[key].push(pid);
            if (_outcomes[key][pid] != Outcome.Pending) {
                resolved++;
            }
        }
        _resolvedCount[key] += resolved;

        if (!_pairIsActive[key]) {
            _pairIsActive[key] = true;
            activePairCount++;
        }

        emit V1PairMigrated(genius, idiot, len, resolved);
    }

    /// @dev Computes the storage key for a Genius-Idiot pair
    function _pairKey(address genius, address idiot) internal pure returns (bytes32) {
        return keccak256(abi.encode(genius, idiot));
    }

    /// @dev Validates that genius and idiot addresses are non-zero and distinct
    function _validatePair(address genius, address idiot) internal pure {
        if (genius == address(0)) revert ZeroGeniusAddress();
        if (idiot == address(0)) revert ZeroIdiotAddress();
        if (genius == idiot) revert SelfPurchase();
    }

    // ─── Emergency Pause ────────────────────────────────────────────

    function setPauser(address _pauser) external onlyOwner {
        pauser = _pauser;
        emit PauserUpdated(_pauser);
    }

    function pause() external {
        if (msg.sender != pauser && msg.sender != owner()) revert NotPauserOrOwner(msg.sender);
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _authorizeUpgrade(address) internal override onlyOwner whenPaused {}

    function renounceOwnership() public pure override {
        revert("disabled");
    }
}
