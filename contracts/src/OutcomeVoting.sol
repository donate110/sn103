// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IAudit, IAccount} from "./interfaces/IProtocol.sol";

/// @title OutcomeVoting
/// @notice On-chain aggregate voting for signal outcomes.
///         Validators independently compute quality scores off-chain via MPC,
///         then vote on the aggregate result. When 2/3+ validators agree on the
///         same quality score, settlement is triggered automatically.
///
///         Individual purchase outcomes NEVER go on-chain. Only the aggregate
///         quality score (in USDC) reaches the chain, preventing retroactive
///         identification of real picks from on-chain data.
///
/// @dev Validator set is managed via consensus-based sync from the Bittensor
///      metagraph. Validators propose the full set via proposeSync(); when 2/3+
///      agree on the same set, it atomically replaces the current one. Owner
///      retains addValidator/removeValidator for bootstrap and emergencies.
///      Votes are per (genius, idiot, cycle) tuple. Each validator can vote
///      once per cycle. Finalization is automatic when quorum is reached.
contract OutcomeVoting is Initializable, OwnableUpgradeable, PausableUpgradeable, ReentrancyGuardTransient, UUPSUpgradeable {
    // ─── Constants ──────────────────────────────────────────────

    /// @notice Quorum requirement: 2/3 of validators must agree
    uint256 public constant QUORUM_NUMERATOR = 2;
    uint256 public constant QUORUM_DENOMINATOR = 3;

    /// @notice Minimum number of validators required
    uint256 public constant MIN_VALIDATORS = 3;

    /// @notice Maximum number of validators to prevent gas limit issues in loops
    uint256 public constant MAX_VALIDATORS = 100;

    // ─── State ──────────────────────────────────────────────────

    /// @notice Audit contract reference
    IAudit public audit;

    /// @notice Account contract reference
    IAccount public account;

    /// @notice Set of registered validators
    mapping(address => bool) public isValidator;

    /// @notice Ordered list of validator addresses (for enumeration)
    address[] public validators;

    /// @notice Index+1 of each validator in the array (0 = not present)
    mapping(address => uint256) private _validatorIndex;

    /// @notice Whether a validator has voted on a specific cycle
    /// @dev Key: keccak256(genius, idiot, cycle)
    mapping(bytes32 => mapping(address => bool)) public hasVoted;

    /// @notice The quality score each validator voted for
    mapping(bytes32 => mapping(address => int256)) public votedScore;

    /// @notice Count of votes for each unique score value per cycle
    /// @dev cycleKey => scoreHash => vote count
    mapping(bytes32 => mapping(bytes32 => uint256)) public voteCounts;

    /// @notice Whether a cycle has been finalized (settlement triggered)
    mapping(bytes32 => bool) public finalized;

    /// @notice Validator count snapshot when first vote is cast per cycle.
    /// @dev Prevents quorum manipulation by adding/removing validators mid-vote.
    mapping(bytes32 => uint256) public cycleValidatorSnapshot;

    /// @notice Pending early exit requests: cycleKey => requested
    mapping(bytes32 => bool) public earlyExitRequested;

    /// @notice Who requested the early exit
    mapping(bytes32 => address) public earlyExitRequestedBy;

    /// @notice Nonce incremented on every validator set change (add/remove/sync).
    ///         Used by proposeSync to prevent stale or replayed proposals.
    uint256 public syncNonce;

    /// @notice Vote count for each proposed set hash at a given nonce
    /// @dev nonce => proposalHash => vote count
    mapping(uint256 => mapping(bytes32 => uint256)) public syncProposalVotes;

    /// @notice Whether a validator has voted for a sync proposal at a given nonce
    /// @dev nonce => validator => voted
    mapping(uint256 => mapping(address => bool)) public hasSyncVoted;

    /// @notice Address authorized to pause this contract in emergencies
    address public pauser;

    /// @notice Sync nonce snapshot when first vote is cast per cycle.
    /// @dev Prevents validators added after first vote from voting on the cycle.
    mapping(bytes32 => uint256) public cycleSyncNonce;

    // ─── Events ─────────────────────────────────────────────────

    /// @notice Emitted when a validator submits their vote
    event VoteSubmitted(
        address indexed genius,
        address indexed idiot,
        uint256 cycle,
        address indexed validator,
        int256 qualityScore
    );

    /// @notice Emitted when quorum is reached and settlement is triggered
    event QuorumReached(
        address indexed genius,
        address indexed idiot,
        uint256 cycle,
        int256 qualityScore,
        uint256 votesFor,
        uint256 totalValidators
    );

    /// @notice Emitted when a validator is added or removed
    event ValidatorUpdated(address indexed validator, bool added);

    /// @notice Emitted when a validator proposes a sync
    event SyncProposed(address indexed proposer, uint256 nonce, address[] proposed);

    /// @notice Emitted when quorum is reached on a sync proposal and the set is replaced
    event SyncApplied(uint256 nonce, uint256 newCount);

    /// @notice Emitted when an early exit is requested
    event EarlyExitRequested(
        address indexed genius,
        address indexed idiot,
        uint256 cycle,
        address indexed requestedBy
    );

    /// @notice Emitted when the pauser address is updated
    event PauserUpdated(address indexed newPauser);

    /// @notice Emitted when a stuck cycle is reset by the owner
    event CycleReset(address indexed genius, address indexed idiot, uint256 cycle);

    // ─── Errors ─────────────────────────────────────────────────

    /// @notice Caller is not a registered validator
    error NotValidator(address caller);

    /// @notice Validator has already voted on this cycle
    error AlreadyVoted(address validator, bytes32 cycleKey);

    /// @notice Cycle has already been finalized
    error CycleAlreadyFinalized(bytes32 cycleKey);

    /// @notice Validator address is zero
    error ZeroAddress();

    /// @notice Validator already registered
    error ValidatorAlreadyRegistered(address validator);

    /// @notice Validator not registered
    error ValidatorNotRegistered(address validator);

    /// @notice Contract address not set
    error ContractNotSet(string name);

    /// @notice Not a party to the audit (for early exit requests)
    error NotPartyToAudit(address caller, address genius, address idiot);

    /// @notice Early exit already requested for this cycle
    error EarlyExitAlreadyRequested(bytes32 cycleKey);

    /// @notice No purchases in cycle
    error NoPurchases(address genius, address idiot);

    /// @notice Sync nonce mismatch (stale or replayed proposal)
    error StaleNonce(uint256 expected, uint256 provided);

    /// @notice Validator already voted on this sync proposal
    error AlreadySyncVoted(address validator, uint256 nonce);

    /// @notice Proposed validator set is empty
    error EmptyValidatorSet();

    /// @notice Proposed validator array is not sorted or contains duplicates
    error UnsortedOrDuplicateValidators();

    /// @notice Caller is not the pauser or the owner
    error NotPauserOrOwner(address caller);

    /// @notice Validator set changed after first vote was cast for this cycle
    error ValidatorSetChanged(bytes32 cycleKey, uint256 snapshotNonce, uint256 currentNonce);

    /// @notice Validator count is below the minimum required
    error BelowMinValidators(uint256 current, uint256 minimum);

    /// @notice Validator count exceeds maximum
    error AboveMaxValidators(uint256 current, uint256 maximum);

    // ─── Constructor / Initializer ──────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param _owner Contract owner (manages validator set)
    function initialize(address _owner) public initializer {
        __Ownable_init(_owner);
        __Pausable_init();
    }

    // ─── Admin ──────────────────────────────────────────────────

    /// @notice Set the Audit contract reference
    /// @param _audit Audit contract address
    function setAudit(address _audit) external onlyOwner {
        if (_audit == address(0)) revert ZeroAddress();
        audit = IAudit(_audit);
    }

    /// @notice Set the Account contract reference
    /// @param _account Account contract address
    function setAccount(address _account) external onlyOwner {
        if (_account == address(0)) revert ZeroAddress();
        account = IAccount(_account);
    }

    /// @notice Register a new validator (owner-only, for bootstrap/emergencies)
    /// @param validator Address to register
    function addValidator(address validator) external onlyOwner {
        if (validator == address(0)) revert ZeroAddress();
        if (isValidator[validator]) revert ValidatorAlreadyRegistered(validator);
        if (validators.length >= MAX_VALIDATORS) revert AboveMaxValidators(validators.length, MAX_VALIDATORS);

        isValidator[validator] = true;
        validators.push(validator);
        _validatorIndex[validator] = validators.length; // 1-indexed
        syncNonce++;

        emit ValidatorUpdated(validator, true);
    }

    /// @notice Remove a validator (owner-only, for bootstrap/emergencies)
    /// @param validator Address to remove
    function removeValidator(address validator) external onlyOwner {
        if (!isValidator[validator]) revert ValidatorNotRegistered(validator);
        if (validators.length - 1 < MIN_VALIDATORS) revert BelowMinValidators(validators.length - 1, MIN_VALIDATORS);

        isValidator[validator] = false;

        // Swap-and-pop removal from array
        uint256 idx = _validatorIndex[validator] - 1; // Convert to 0-indexed
        uint256 lastIdx = validators.length - 1;

        if (idx != lastIdx) {
            address lastValidator = validators[lastIdx];
            validators[idx] = lastValidator;
            _validatorIndex[lastValidator] = idx + 1;
        }

        validators.pop();
        delete _validatorIndex[validator];
        syncNonce++;

        emit ValidatorUpdated(validator, false);
    }

    // ─── Early Exit Requests ────────────────────────────────────

    /// @notice Request early exit for a Genius-Idiot pair.
    ///         Either party can request. In v2 (queue model), early exit is triggered
    ///         directly via Audit.earlyExit() with the specific purchaseIds.
    ///         This function records the intent for off-chain validator coordination.
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    /// @param purchaseIds The specific purchases to request early exit for
    function requestEarlyExit(address genius, address idiot, uint256[] calldata purchaseIds) external whenNotPaused {
        if (msg.sender != genius && msg.sender != idiot) {
            revert NotPartyToAudit(msg.sender, genius, idiot);
        }
        if (purchaseIds.length == 0) revert NoPurchases(genius, idiot);

        bytes32 batchKey = keccak256(abi.encode(genius, idiot, keccak256(abi.encode(purchaseIds))));

        if (finalized[batchKey]) revert CycleAlreadyFinalized(batchKey);
        if (earlyExitRequested[batchKey]) revert EarlyExitAlreadyRequested(batchKey);

        earlyExitRequested[batchKey] = true;
        earlyExitRequestedBy[batchKey] = msg.sender;

        uint256 batchCount = 0;
        if (address(account) != address(0)) {
            batchCount = account.getAuditBatchCount(genius, idiot);
        }
        emit EarlyExitRequested(genius, idiot, batchCount, msg.sender);
    }

    // ─── Validator Set Sync ─────────────────────────────────────

    /// @notice Propose a new validator set. When 2/3+ of current validators
    ///         propose the same set (same sorted addresses at the same nonce),
    ///         the set is atomically replaced.
    /// @param newValidators Sorted array of new validator addresses (no duplicates, no zero)
    /// @param nonce Must equal current syncNonce to prevent stale proposals
    function proposeSync(address[] calldata newValidators, uint256 nonce) external whenNotPaused {
        if (!isValidator[msg.sender]) revert NotValidator(msg.sender);
        if (nonce != syncNonce) revert StaleNonce(syncNonce, nonce);
        if (newValidators.length == 0) revert EmptyValidatorSet();
        if (hasSyncVoted[nonce][msg.sender]) revert AlreadySyncVoted(msg.sender, nonce);

        // Validate sorted + no duplicates + no zero addresses
        for (uint256 i = 0; i < newValidators.length; i++) {
            if (newValidators[i] == address(0)) revert ZeroAddress();
            if (i > 0 && newValidators[i] <= newValidators[i - 1]) {
                revert UnsortedOrDuplicateValidators();
            }
        }

        bytes32 proposalHash = keccak256(abi.encode(newValidators));
        hasSyncVoted[nonce][msg.sender] = true;
        uint256 newCount = syncProposalVotes[nonce][proposalHash] + 1;
        syncProposalVotes[nonce][proposalHash] = newCount;

        emit SyncProposed(msg.sender, nonce, newValidators);

        // Check quorum: 2/3 of current validator set
        uint256 total = validators.length;
        uint256 threshold = (total * QUORUM_NUMERATOR + QUORUM_DENOMINATOR - 1)
            / QUORUM_DENOMINATOR;

        if (newCount >= threshold) {
            _applySync(newValidators);
            emit SyncApplied(nonce, newValidators.length);
        }
    }

    /// @dev Atomically replace the entire validator set and increment nonce
    function _applySync(address[] calldata newValidators) internal {
        if (newValidators.length < MIN_VALIDATORS) revert BelowMinValidators(newValidators.length, MIN_VALIDATORS);
        if (newValidators.length > MAX_VALIDATORS) revert AboveMaxValidators(newValidators.length, MAX_VALIDATORS);

        // Clear old set
        for (uint256 i = 0; i < validators.length; i++) {
            address old = validators[i];
            isValidator[old] = false;
            delete _validatorIndex[old];
        }
        delete validators;

        // Populate new set
        for (uint256 i = 0; i < newValidators.length; i++) {
            address v = newValidators[i];
            isValidator[v] = true;
            validators.push(v);
            _validatorIndex[v] = i + 1; // 1-indexed
        }

        syncNonce++;
    }

    // ─── Voting ─────────────────────────────────────────────────

    /// @notice Submit a vote for the aggregate quality score of a batch of purchases.
    ///         Validators compute the score off-chain using MPC and submit their result
    ///         along with the specific purchaseIds they're voting on.
    ///         When 2/3+ validators agree on the same batch + score, settlement fires.
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    /// @param purchaseIds The specific purchases being audited (deterministic: oldest resolved unaudited)
    /// @param qualityScore The USDC-denominated quality score (6 decimals, can be negative)
    /// @param totalNotional The non-void notional for the batch (USDC, 6 decimals)
    /// @param isEarlyExit Whether this is an early exit (< 10 purchases, Credits-only damages)
    function submitVote(
        address genius,
        address idiot,
        uint256[] calldata purchaseIds,
        int256 qualityScore,
        uint256 totalNotional,
        bool isEarlyExit
    ) external whenNotPaused nonReentrant {
        if (!isValidator[msg.sender]) revert NotValidator(msg.sender);
        if (address(audit) == address(0)) revert ContractNotSet("Audit");

        // Batch key is derived from the hash of purchaseIds. Validators voting on
        // different sets of purchases naturally go to different keys.
        bytes32 batchKey = keccak256(abi.encode(genius, idiot, keccak256(abi.encode(purchaseIds))));

        if (finalized[batchKey]) revert CycleAlreadyFinalized(batchKey);
        if (hasVoted[batchKey][msg.sender]) revert AlreadyVoted(msg.sender, batchKey);

        // If validator set changed since snapshot, reset for re-voting.
        if (cycleSyncNonce[batchKey] != 0 && syncNonce != cycleSyncNonce[batchKey]) {
            for (uint256 i = 0; i < validators.length; i++) {
                delete hasVoted[batchKey][validators[i]];
                delete votedScore[batchKey][validators[i]];
            }
            cycleValidatorSnapshot[batchKey] = 0;
            cycleSyncNonce[batchKey] = 0;
        }

        // Snapshot validator count on first vote for this batch
        if (cycleValidatorSnapshot[batchKey] == 0) {
            if (validators.length == 0) revert EmptyValidatorSet();
            cycleValidatorSnapshot[batchKey] = validators.length;
            cycleSyncNonce[batchKey] = syncNonce;
        }

        hasVoted[batchKey][msg.sender] = true;
        votedScore[batchKey][msg.sender] = qualityScore;

        bytes32 scoreHash = keccak256(abi.encode(qualityScore, totalNotional, isEarlyExit, cycleSyncNonce[batchKey]));
        uint256 newCount = voteCounts[batchKey][scoreHash] + 1;
        voteCounts[batchKey][scoreHash] = newCount;

        // Use batch count as a cycle-equivalent for the event
        uint256 batchCount = 0;
        if (address(account) != address(0)) {
            batchCount = account.getAuditBatchCount(genius, idiot);
        }
        emit VoteSubmitted(genius, idiot, batchCount, msg.sender, qualityScore);

        uint256 totalValidators = cycleValidatorSnapshot[batchKey];
        uint256 threshold = (totalValidators * QUORUM_NUMERATOR + QUORUM_DENOMINATOR - 1)
            / QUORUM_DENOMINATOR;

        if (newCount >= threshold) {
            finalized[batchKey] = true;

            emit QuorumReached(genius, idiot, batchCount, qualityScore, newCount, totalValidators);

            if (isEarlyExit) {
                audit.earlyExitByVote(genius, idiot, purchaseIds, qualityScore, totalNotional);
            } else {
                audit.settleByVote(genius, idiot, purchaseIds, qualityScore, totalNotional);
            }
        }
    }

    // ─── View Functions ─────────────────────────────────────────

    /// @notice Get the number of registered validators
    /// @return count Number of active validators
    function validatorCount() external view returns (uint256 count) {
        return validators.length;
    }

    /// @notice Get the quorum threshold for the current validator set.
    /// @dev For active cycles, the actual threshold uses the snapshot from when the
    ///      first vote was cast. Use cycleValidatorSnapshot(cycleKey) for the actual value.
    /// @return threshold Number of matching votes needed to finalize (based on current set)
    function quorumThreshold() external view returns (uint256 threshold) {
        return (validators.length * QUORUM_NUMERATOR + QUORUM_DENOMINATOR - 1)
            / QUORUM_DENOMINATOR;
    }

    /// @notice Get the quorum threshold for a specific batch (using snapshot)
    /// @param batchKey The batch key (hash of genius, idiot, purchaseIds hash)
    /// @return threshold Number of matching votes needed (0 if no votes cast yet)
    function batchQuorumThreshold(bytes32 batchKey)
        external
        view
        returns (uint256 threshold)
    {
        uint256 snapshot = cycleValidatorSnapshot[batchKey];
        if (snapshot == 0) return 0;
        return (snapshot * QUORUM_NUMERATOR + QUORUM_DENOMINATOR - 1) / QUORUM_DENOMINATOR;
    }

    /// @notice Check if a batch has been finalized
    /// @param batchKey The batch key
    /// @return True if finalized
    function isBatchFinalized(bytes32 batchKey)
        external
        view
        returns (bool)
    {
        return finalized[batchKey];
    }

    /// @notice Legacy: check if a cycle has been finalized (kept for backwards compat)
    function isCycleFinalized(address genius, address idiot, uint256 cycle)
        external
        view
        returns (bool)
    {
        return finalized[_cycleKey(genius, idiot, cycle)];
    }

    /// @notice Compute the batch key for a set of purchaseIds
    function computeBatchKey(address genius, address idiot, uint256[] calldata purchaseIds)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(genius, idiot, keccak256(abi.encode(purchaseIds))));
    }

    /// @notice Get the full list of registered validators
    /// @return The array of validator addresses
    function getValidators() external view returns (address[] memory) {
        return validators;
    }

    // ─── Internal ───────────────────────────────────────────────

    /// @dev Compute the unique key for a Genius-Idiot-Cycle tuple
    function _cycleKey(address genius, address idiot, uint256 cycle)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(genius, idiot, cycle));
    }

    // ─── Stuck Cycle Recovery ────────────────────────────────────

    /// @notice Reset a stuck voting batch. Owner-only for recovery.
    /// @param batchKey The batch key to reset
    function resetBatch(bytes32 batchKey) external onlyOwner {
        if (finalized[batchKey]) revert CycleAlreadyFinalized(batchKey);

        cycleValidatorSnapshot[batchKey] = 0;
        cycleSyncNonce[batchKey] = 0;

        for (uint256 i = 0; i < validators.length; i++) {
            delete hasVoted[batchKey][validators[i]];
            delete votedScore[batchKey][validators[i]];
        }

        delete earlyExitRequested[batchKey];
        delete earlyExitRequestedBy[batchKey];

        // Emit with zero addresses since we only have the batch key
        emit CycleReset(address(0), address(0), 0);
    }

    /// @notice Legacy: reset by cycle number (kept for backwards compat)
    function resetCycle(address genius, address idiot, uint256 cycle) external onlyOwner {
        bytes32 cycleKey = _cycleKey(genius, idiot, cycle);
        if (finalized[cycleKey]) revert CycleAlreadyFinalized(cycleKey);

        cycleValidatorSnapshot[cycleKey] = 0;
        cycleSyncNonce[cycleKey] = 0;

        for (uint256 i = 0; i < validators.length; i++) {
            delete hasVoted[cycleKey][validators[i]];
            delete votedScore[cycleKey][validators[i]];
        }

        delete earlyExitRequested[cycleKey];
        delete earlyExitRequestedBy[cycleKey];

        emit CycleReset(genius, idiot, cycle);
    }

    // ─── Emergency Pause ────────────────────────────────────────

    /// @notice Set the emergency pauser address
    /// @param _pauser New pauser address (address(0) to disable)
    function setPauser(address _pauser) external onlyOwner {
        pauser = _pauser;
        emit PauserUpdated(_pauser);
    }

    /// @notice Pause voting
    function pause() external {
        if (msg.sender != pauser && msg.sender != owner()) revert NotPauserOrOwner(msg.sender);
        _pause();
    }

    /// @notice Unpause voting
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Owner can authorize upgrades only when paused for consistency
    ///      with other protocol contracts. OutcomeVoting holds no USDC but
    ///      pausing prevents vote state changes during upgrade.
    function _authorizeUpgrade(address) internal override onlyOwner whenPaused {}

    /// @dev Disabled to prevent accidental permanent bricking of upgradeable proxy.
    function renounceOwnership() public pure override {
        revert("disabled");
    }

    /// @dev Reserved storage gap for future upgrades.
    uint256[33] private __gap;
}
