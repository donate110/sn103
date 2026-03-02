// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccountState, Outcome} from "./interfaces/IDjinn.sol";

/// @title Account
/// @notice Tracks the relationship state between a Genius-Idiot pair across audit cycles.
///         Per the whitepaper, after 10 signals between a pair an audit occurs.
///         This contract records signal counts, purchase IDs, outcomes, and cycle progression.
/// @dev The (genius, idiot) pair is the primary key. Each pair progresses through independent
///      audit cycles of 10 signals each.
contract Account is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    // ─── Constants
    // ──────────────────────────────────────────────────────

    /// @notice Number of signals required before an audit can be triggered
    uint256 public constant SIGNALS_PER_CYCLE = 10;

    // ─── Storage
    // ────────────────────────────────────────────────────────

    /// @dev keccak256(genius, idiot) => AccountState
    mapping(bytes32 => AccountState) private _accounts;

    /// @dev keccak256(genius, idiot) => whether the account has been initialized
    mapping(bytes32 => bool) private _initialized;

    /// @dev keccak256(genius, idiot) => purchaseId => Outcome
    mapping(bytes32 => mapping(uint256 => Outcome)) private _outcomes;

    /// @dev keccak256(genius, idiot) => purchaseId => whether recorded in current cycle
    mapping(bytes32 => mapping(uint256 => bool)) private _purchaseRecorded;

    /// @dev address => whether it can call mutating functions
    mapping(address => bool) public authorizedCallers;

    /// @notice Count of genius-idiot pairs with an active (unsettled) audit cycle
    /// @dev Incremented when signalCount goes 0→1; decremented on settleAudit/startNewCycle
    uint256 public activePairCount;

    // ─── Events
    // ─────────────────────────────────────────────────────────

    /// @notice Emitted when a purchase is recorded for a Genius-Idiot pair
    event PurchaseRecorded(address indexed genius, address indexed idiot, uint256 purchaseId, uint256 signalCount);

    /// @notice Emitted when an outcome is recorded for a purchase
    event OutcomeRecorded(address indexed genius, address indexed idiot, uint256 purchaseId, Outcome outcome);

    /// @notice Emitted when a new audit cycle begins for a pair
    event NewCycleStarted(address indexed genius, address indexed idiot, uint256 newCycle);

    /// @notice Emitted when the settled flag is changed for a pair
    event SettledChanged(address indexed genius, address indexed idiot, bool settled);

    /// @notice Emitted when an authorized caller is added or removed
    event AuthorizedCallerSet(address indexed caller, bool authorized);

    // ─── Errors
    // ─────────────────────────────────────────────────────────

    /// @notice Caller is not authorized to call this function
    error CallerNotAuthorized(address caller);

    /// @notice Genius address must not be zero
    error ZeroGeniusAddress();

    /// @notice Idiot address must not be zero
    error ZeroIdiotAddress();

    /// @notice Genius and Idiot addresses must be different
    error GeniusEqualsIdiot(address addr);

    /// @notice Signal count for this cycle has already reached the maximum
    error CycleSignalLimitReached(address genius, address idiot, uint256 limit);

    /// @notice Purchase ID has already been recorded for this pair
    error PurchaseAlreadyRecorded(address genius, address idiot, uint256 purchaseId);

    /// @notice Purchase ID was not recorded in this account
    error PurchaseNotFound(address genius, address idiot, uint256 purchaseId);

    /// @notice Outcome has already been recorded for this purchase
    error OutcomeAlreadyRecorded(address genius, address idiot, uint256 purchaseId);

    /// @notice Cannot record Pending as an outcome
    error InvalidOutcome();

    /// @notice Address must not be zero
    error ZeroAddress();

    // ─── Modifiers
    // ──────────────────────────────────────────────────────

    /// @dev Reverts if the caller is not an authorized contract
    modifier onlyAuthorized() {
        if (!authorizedCallers[msg.sender]) {
            revert CallerNotAuthorized(msg.sender);
        }
        _;
    }

    // ─── Constructor / Initializer
    // ────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the Account contract (replaces constructor for proxy pattern)
    /// @param initialOwner Address that will own this contract and manage authorized callers
    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
    }

    // ─── External Functions
    // ─────────────────────────────────────────────

    /// @notice Record a purchase for a Genius-Idiot pair
    /// @param genius The Genius address
    /// @param idiot The Idiot (buyer) address
    /// @param purchaseId The unique purchase identifier
    function recordPurchase(address genius, address idiot, uint256 purchaseId) external onlyAuthorized {
        _validatePair(genius, idiot);

        bytes32 key = _accountKey(genius, idiot);
        AccountState storage acct = _accounts[key];

        if (!_initialized[key]) {
            _initialized[key] = true;
        }

        if (acct.signalCount >= SIGNALS_PER_CYCLE) {
            revert CycleSignalLimitReached(genius, idiot, SIGNALS_PER_CYCLE);
        }

        if (_purchaseRecorded[key][purchaseId]) {
            revert PurchaseAlreadyRecorded(genius, idiot, purchaseId);
        }

        // Track new active pair (first purchase in this cycle)
        if (acct.signalCount == 0) {
            activePairCount++;
        }

        _purchaseRecorded[key][purchaseId] = true;
        unchecked {
            acct.signalCount++;
        }
        acct.purchaseIds.push(purchaseId);

        emit PurchaseRecorded(genius, idiot, purchaseId, acct.signalCount);
    }

    /// @notice Record the outcome of a specific purchase within an account
    /// @param genius The Genius address
    /// @param idiot The Idiot (buyer) address
    /// @param purchaseId The purchase to record an outcome for
    /// @param outcome The outcome (Favorable, Unfavorable, or Void — not Pending)
    function recordOutcome(address genius, address idiot, uint256 purchaseId, Outcome outcome) external onlyAuthorized {
        _validatePair(genius, idiot);
        if (outcome == Outcome.Pending) revert InvalidOutcome();

        bytes32 key = _accountKey(genius, idiot);

        if (!_purchaseRecorded[key][purchaseId]) {
            revert PurchaseNotFound(genius, idiot, purchaseId);
        }

        if (_outcomes[key][purchaseId] != Outcome.Pending) {
            revert OutcomeAlreadyRecorded(genius, idiot, purchaseId);
        }

        _outcomes[key][purchaseId] = outcome;

        // Update quality score: +1 for Favorable, -1 for Unfavorable, 0 for Void
        if (outcome == Outcome.Favorable) {
            _accounts[key].qualityScore++;
        } else if (outcome == Outcome.Unfavorable) {
            _accounts[key].qualityScore--;
        }

        emit OutcomeRecorded(genius, idiot, purchaseId, outcome);
    }

    /// @notice Start a new audit cycle for a Genius-Idiot pair
    /// @param genius The Genius address
    /// @param idiot The Idiot (buyer) address
    function startNewCycle(address genius, address idiot) external onlyAuthorized {
        _validatePair(genius, idiot);

        bytes32 key = _accountKey(genius, idiot);
        AccountState storage acct = _accounts[key];

        // Decrement active pair count before resetting
        if (acct.signalCount > 0) {
            activePairCount--;
        }

        // Clear purchase recorded flags for the current cycle
        uint256 len = acct.purchaseIds.length;
        for (uint256 i; i < len;) {
            delete _purchaseRecorded[key][acct.purchaseIds[i]];
            unchecked {
                ++i;
            }
        }

        unchecked {
            acct.currentCycle++;
        }
        acct.signalCount = 0;
        acct.qualityScore = 0;
        delete acct.purchaseIds;
        acct.settled = false;

        emit NewCycleStarted(genius, idiot, acct.currentCycle);
    }

    /// @notice Set the settled flag for a Genius-Idiot pair
    /// @param genius The Genius address
    /// @param idiot The Idiot (buyer) address
    /// @param settled Whether the current cycle has been settled
    function setSettled(address genius, address idiot, bool settled) external onlyAuthorized {
        _validatePair(genius, idiot);

        bytes32 key = _accountKey(genius, idiot);
        _accounts[key].settled = settled;

        emit SettledChanged(genius, idiot, settled);
    }

    /// @notice Settle an audit for a Genius-Idiot pair: marks as settled and starts a new cycle
    /// @param genius The Genius address
    /// @param idiot The Idiot (buyer) address
    function settleAudit(address genius, address idiot) external onlyAuthorized {
        _validatePair(genius, idiot);

        bytes32 key = _accountKey(genius, idiot);
        AccountState storage acct = _accounts[key];

        // Decrement active pair count before resetting
        if (acct.signalCount > 0) {
            activePairCount--;
        }

        // Mark current cycle as settled
        acct.settled = true;
        emit SettledChanged(genius, idiot, true);

        // Clear purchase recorded flags for the current cycle
        uint256 len = acct.purchaseIds.length;
        for (uint256 i; i < len;) {
            delete _purchaseRecorded[key][acct.purchaseIds[i]];
            unchecked {
                ++i;
            }
        }

        // Start new cycle
        unchecked {
            acct.currentCycle++;
        }
        acct.signalCount = 0;
        acct.qualityScore = 0;
        delete acct.purchaseIds;
        acct.settled = false;

        emit NewCycleStarted(genius, idiot, acct.currentCycle);
    }

    /// @notice Authorize or deauthorize a contract to call mutating functions
    /// @param caller The address to authorize or deauthorize
    /// @param authorized Whether the address should be authorized
    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = authorized;

        emit AuthorizedCallerSet(caller, authorized);
    }

    // ─── View Functions
    // ─────────────────────────────────────────────────

    /// @notice Returns the full account state for a Genius-Idiot pair
    /// @param genius The Genius address
    /// @param idiot The Idiot (buyer) address
    /// @return state The AccountState struct for this pair
    function getAccountState(address genius, address idiot) external view returns (AccountState memory state) {
        return _accounts[_accountKey(genius, idiot)];
    }

    /// @notice Returns the current audit cycle for a Genius-Idiot pair
    /// @param genius The Genius address
    /// @param idiot The Idiot (buyer) address
    /// @return cycle The current cycle number
    function getCurrentCycle(address genius, address idiot) external view returns (uint256 cycle) {
        return _accounts[_accountKey(genius, idiot)].currentCycle;
    }

    /// @notice Check whether a Genius-Idiot pair is ready for an audit
    /// @param genius The Genius address
    /// @param idiot The Idiot (buyer) address
    /// @return ready True if signalCount >= SIGNALS_PER_CYCLE for the current cycle
    function isAuditReady(address genius, address idiot) external view returns (bool ready) {
        return _accounts[_accountKey(genius, idiot)].signalCount >= SIGNALS_PER_CYCLE;
    }

    /// @notice Returns the signal count for the current cycle of a Genius-Idiot pair
    /// @param genius The Genius address
    /// @param idiot The Idiot (buyer) address
    /// @return count The number of signals recorded in the current cycle
    function getSignalCount(address genius, address idiot) external view returns (uint256 count) {
        return _accounts[_accountKey(genius, idiot)].signalCount;
    }

    /// @notice Returns the purchase IDs for the current cycle of a Genius-Idiot pair
    /// @param genius The Genius address
    /// @param idiot The Idiot (buyer) address
    /// @return ids Array of purchase IDs in the current cycle
    function getPurchaseIds(address genius, address idiot) external view returns (uint256[] memory ids) {
        return _accounts[_accountKey(genius, idiot)].purchaseIds;
    }

    /// @notice Returns the recorded outcome for a specific purchase within a pair
    /// @param genius The Genius address
    /// @param idiot The Idiot (buyer) address
    /// @param purchaseId The purchase to look up
    /// @return outcome The outcome recorded for this purchase
    function getOutcome(address genius, address idiot, uint256 purchaseId) external view returns (Outcome outcome) {
        return _outcomes[_accountKey(genius, idiot)][purchaseId];
    }

    // ─── Internal Functions
    // ─────────────────────────────────────────────

    /// @dev Computes the storage key for a Genius-Idiot pair
    function _accountKey(address genius, address idiot) internal pure returns (bytes32 key) {
        return keccak256(abi.encode(genius, idiot));
    }

    /// @dev Validates that genius and idiot addresses are non-zero
    function _validatePair(address genius, address idiot) internal pure {
        if (genius == address(0)) revert ZeroGeniusAddress();
        if (idiot == address(0)) revert ZeroIdiotAddress();
    }

    /// @dev Only the owner can authorize contract upgrades
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
