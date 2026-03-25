// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Signal, SignalStatus} from "./interfaces/IDjinn.sol";

/// @title SignalCommitment
/// @notice Stores encrypted signal commitments for the Djinn Protocol.
///         A Genius commits an encrypted signal with 10 decoy lines (9 decoys + 1 real).
///         The real signal content remains hidden inside the AES-256-GCM encrypted blob.
/// @dev Signal IDs are externally generated and must be globally unique.
///
///      DESIGN NOTE (CF-14): Signal IDs are generated client-side rather than using an
///      on-chain auto-incrementing counter. This is intentional: sequential on-chain IDs
///      would leak signal ordering and reveal genius activity patterns, breaking the privacy
///      model. Client-generated IDs use sufficient entropy (UUID v4 mapped to uint256) to
///      make collisions negligible (p < 2^-122). The SignalAlreadyExists check provides an
///      on-chain safety net if a collision ever occurs. Front-running with the same ID would
///      require knowing the ID before the genius's transaction lands, which is impractical
///      with random 256-bit IDs.
contract SignalCommitment is Initializable, OwnableUpgradeable, PausableUpgradeable, UUPSUpgradeable {
    // ─── Types
    // ──────────────────────────────────────────────────────────

    /// @notice Parameters for committing a new signal, packed to avoid stack-too-deep
    struct CommitParams {
        uint256 signalId;
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
    }

    // ─── Storage
    // ────────────────────────────────────────────────────────

    /// @dev signalId => Signal struct
    mapping(uint256 => Signal) private _signals;

    /// @dev signalId => whether it exists
    mapping(uint256 => bool) private _exists;

    /// @dev address => whether it can call updateStatus
    mapping(address => bool) public authorizedCallers;

    /// @notice Address authorized to pause this contract in emergencies
    address public pauser;

    /// @notice Collateral contract for checking genius deposit availability.
    ///         When set, commit() requires sufficient free collateral to cover
    ///         maxNotional * slaMultiplierBps / 10000. When zero (pre-upgrade
    ///         state), the check is skipped for backwards compatibility.
    address public collateral;

    // ─── Events
    // ─────────────────────────────────────────────────────────

    /// @notice Emitted when a Genius commits a new signal
    event SignalCommitted(
        uint256 indexed signalId,
        address indexed genius,
        string sport,
        uint256 maxPriceBps,
        uint256 slaMultiplierBps,
        uint256 maxNotional,
        uint256 expiresAt
    );

    /// @notice Emitted when a Genius cancels their own signal
    event SignalCancelled(uint256 indexed signalId, address indexed genius);

    /// @notice Emitted when an authorized contract updates signal status
    event SignalStatusUpdated(uint256 indexed signalId, SignalStatus newStatus);

    /// @notice Emitted when an authorized caller is added or removed
    event AuthorizedCallerSet(address indexed caller, bool authorized);

    /// @notice Emitted when the pauser address is updated
    event PauserUpdated(address indexed newPauser);

    /// @notice Emitted when the collateral contract address is updated
    event CollateralUpdated(address indexed newCollateral);

    // ─── Errors
    // ─────────────────────────────────────────────────────────

    /// @notice Signal ID already exists
    error SignalAlreadyExists(uint256 signalId);

    /// @notice Signal ID does not exist
    error SignalNotFound(uint256 signalId);

    /// @notice decoyLines must contain exactly 10 entries
    error InvalidDecoyLinesLength(uint256 provided);

    /// @notice slaMultiplierBps must be >= 10000 (100%)
    error SlaMultiplierTooLow(uint256 provided);
    error SlaMultiplierTooHigh(uint256 provided);

    /// @notice maxPriceBps must be > 0 and <= 5000 (50%)
    error InvalidMaxPriceBps(uint256 provided);

    /// @notice expiresAt must be in the future
    error ExpirationInPast(uint256 expiresAt, uint256 currentTime);

    /// @notice Only the Genius who committed the signal can call this
    error NotSignalGenius(address caller, address genius);

    /// @notice Signal cannot be cancelled from its current status
    error SignalNotCancellable(uint256 signalId, SignalStatus currentStatus);

    /// @notice Address must not be zero
    error ZeroAddress();

    /// @notice Caller is not authorized to update signal status
    error CallerNotAuthorized(address caller);

    /// @notice Invalid state transition
    error InvalidStatusTransition(uint256 signalId, SignalStatus current, SignalStatus requested);

    /// @notice Encrypted blob must not be empty
    error EmptyEncryptedBlob();

    /// @notice Encrypted blob exceeds maximum allowed size
    error BlobTooLarge(uint256 size, uint256 maxSize);

    /// @notice Too many sportsbooks provided
    error TooManySportsbooks(uint256 provided, uint256 max);

    /// @notice Commit hash must not be zero
    error ZeroCommitHash();

    /// @notice A string field exceeds its maximum allowed length
    error StringTooLong(string field, uint256 length, uint256 max);

    /// @notice minNotional must be <= maxNotional when maxNotional is set
    error InvalidNotionalRange(uint256 minNotional, uint256 maxNotional);

    /// @notice Caller is not the pauser or the owner
    error NotPauserOrOwner(address caller);

    /// @notice Genius does not have enough free collateral for this signal
    error InsufficientCollateral(address genius, uint256 available, uint256 required);

    /// @notice Maximum encrypted blob size (64 KB)
    uint256 public constant MAX_BLOB_SIZE = 65536;

    /// @notice Maximum number of sportsbooks per signal
    uint256 public constant MAX_SPORTSBOOKS = 50;

    /// @notice Maximum length per decoy line (1 KB)
    uint256 public constant MAX_DECOY_LINE_LENGTH = 1024;

    /// @notice Maximum length for sport string (256 bytes)
    uint256 public constant MAX_SPORT_LENGTH = 256;

    /// @notice Maximum length per sportsbook name (256 bytes)
    uint256 public constant MAX_SPORTSBOOK_LENGTH = 256;

    // ─── Modifiers
    // ──────────────────────────────────────────────────────

    /// @dev Reverts if the caller is not an authorized contract
    modifier onlyAuthorized() {
        _checkAuthorized();
        _;
    }

    // ─── Internal
    // ────────────────────────────────────────────────────────

    function _checkAuthorized() internal view {
        if (!authorizedCallers[msg.sender]) {
            revert CallerNotAuthorized(msg.sender);
        }
    }

    // ─── Constructor / Initializer
    // ────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the SignalCommitment contract
    /// @param initialOwner Address that will own this contract and manage authorized callers
    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __Pausable_init();
    }

    // ─── External Functions
    // ─────────────────────────────────────────────

    /// @notice Commit a new encrypted signal on-chain
    /// @dev The encrypted blob contains the real signal encrypted with AES-256-GCM.
    ///      The 10 decoy lines obscure which line is the real signal.
    ///      Uses a struct parameter to avoid stack-too-deep with 9 inputs.
    /// @param p CommitParams struct containing all signal data
    function commit(CommitParams calldata p) external whenNotPaused {
        if (_exists[p.signalId]) revert SignalAlreadyExists(p.signalId);
        if (p.encryptedBlob.length == 0) revert EmptyEncryptedBlob();
        if (p.encryptedBlob.length > MAX_BLOB_SIZE) revert BlobTooLarge(p.encryptedBlob.length, MAX_BLOB_SIZE);
        if (p.availableSportsbooks.length > MAX_SPORTSBOOKS) revert TooManySportsbooks(p.availableSportsbooks.length, MAX_SPORTSBOOKS);
        if (p.commitHash == bytes32(0)) revert ZeroCommitHash();
        if (p.decoyLines.length != 10) revert InvalidDecoyLinesLength(p.decoyLines.length);
        if (bytes(p.sport).length > MAX_SPORT_LENGTH) revert StringTooLong("sport", bytes(p.sport).length, MAX_SPORT_LENGTH);
        if (p.slaMultiplierBps < 10_000) revert SlaMultiplierTooLow(p.slaMultiplierBps);
        if (p.slaMultiplierBps > 30_000) revert SlaMultiplierTooHigh(p.slaMultiplierBps);
        if (p.maxPriceBps == 0 || p.maxPriceBps > 5000) revert InvalidMaxPriceBps(p.maxPriceBps);
        if (p.expiresAt <= block.timestamp) revert ExpirationInPast(p.expiresAt, block.timestamp);
        // maxNotional = 0 means unlimited notional capacity per signal.
        // Each purchase is still bounded by Escrow.MAX_NOTIONAL (1M USDC) and
        // requires sufficient genius collateral, providing natural limits.
        if (p.maxNotional > 0 && p.minNotional > p.maxNotional) {
            revert InvalidNotionalRange(p.minNotional, p.maxNotional);
        }

        // Collateral gate: genius must have enough free collateral to cover
        // the worst-case SLA payout for this signal's full notional capacity.
        // Skipped when collateral is not set (pre-upgrade backwards compat).
        if (collateral != address(0) && p.maxNotional > 0) {
            uint256 requiredLock = (p.maxNotional * p.slaMultiplierBps) / 10_000;
            uint256 available;
            // Use low-level call to avoid import dependency on Collateral
            (bool ok, bytes memory ret) = collateral.staticcall(
                abi.encodeWithSignature("getAvailable(address)", msg.sender)
            );
            if (ok && ret.length >= 32) {
                available = abi.decode(ret, (uint256));
            }
            if (available < requiredLock) {
                revert InsufficientCollateral(msg.sender, available, requiredLock);
            }
        }

        _exists[p.signalId] = true;

        Signal storage s = _signals[p.signalId];
        s.genius = msg.sender;
        s.encryptedBlob = p.encryptedBlob;
        s.commitHash = p.commitHash;
        s.sport = p.sport;
        s.maxPriceBps = p.maxPriceBps;
        s.slaMultiplierBps = p.slaMultiplierBps;
        s.maxNotional = p.maxNotional;
        s.minNotional = p.minNotional;
        s.expiresAt = p.expiresAt;
        s.status = SignalStatus.Active;
        s.createdAt = block.timestamp;

        uint256 len = p.decoyLines.length;
        for (uint256 i; i < len; ++i) {
            if (bytes(p.decoyLines[i]).length > MAX_DECOY_LINE_LENGTH) {
                revert StringTooLong("decoyLine", bytes(p.decoyLines[i]).length, MAX_DECOY_LINE_LENGTH);
            }
            s.decoyLines.push(p.decoyLines[i]);
        }

        len = p.availableSportsbooks.length;
        for (uint256 i; i < len; ++i) {
            if (bytes(p.availableSportsbooks[i]).length > MAX_SPORTSBOOK_LENGTH) {
                revert StringTooLong("sportsbook", bytes(p.availableSportsbooks[i]).length, MAX_SPORTSBOOK_LENGTH);
            }
            s.availableSportsbooks.push(p.availableSportsbooks[i]);
        }

        emit SignalCommitted(p.signalId, msg.sender, p.sport, p.maxPriceBps, p.slaMultiplierBps, p.maxNotional, p.expiresAt);
    }

    /// @notice Cancel a signal, preventing further purchases
    /// @dev Only the Genius who created the signal can cancel it.
    ///      Cancellation is irreversible and only allowed while status is Active.
    ///      Existing purchases on a partially-filled signal still settle normally.
    /// @param signalId The signal to cancel
    function cancelSignal(uint256 signalId) external {
        if (!_exists[signalId]) revert SignalNotFound(signalId);

        Signal storage s = _signals[signalId];
        if (s.genius != msg.sender) revert NotSignalGenius(msg.sender, s.genius);
        if (s.status != SignalStatus.Active) revert SignalNotCancellable(signalId, s.status);

        s.status = SignalStatus.Cancelled;

        emit SignalCancelled(signalId, msg.sender);
    }

    /// @notice Update the status of a signal
    /// @dev Only callable by contracts authorized by the owner (e.g. Audit).
    ///      Enforces a state transition matrix:
    ///        Active    → Cancelled, Settled
    ///        Cancelled → Settled (existing purchases still settle)
    ///        Settled   → (terminal, no transitions)
    /// @param signalId The signal to update
    /// @param newStatus The new status to set
    function updateStatus(uint256 signalId, SignalStatus newStatus) external onlyAuthorized {
        if (!_exists[signalId]) revert SignalNotFound(signalId);

        SignalStatus current = _signals[signalId].status;

        if (current == SignalStatus.Active) {
            if (newStatus != SignalStatus.Settled && newStatus != SignalStatus.Cancelled) {
                revert InvalidStatusTransition(signalId, current, newStatus);
            }
        } else if (current == SignalStatus.Cancelled) {
            // Cancelled signals can transition to Settled (existing purchases settle)
            if (newStatus != SignalStatus.Settled) {
                revert InvalidStatusTransition(signalId, current, newStatus);
            }
        } else {
            // Settled is terminal
            revert InvalidStatusTransition(signalId, current, newStatus);
        }

        _signals[signalId].status = newStatus;

        emit SignalStatusUpdated(signalId, newStatus);
    }

    /// @notice Authorize or deauthorize a contract to call updateStatus
    /// @dev Only the contract owner can manage authorized callers.
    /// @param caller The address to authorize or deauthorize
    /// @param authorized Whether the address should be authorized
    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = authorized;

        emit AuthorizedCallerSet(caller, authorized);
    }

    // ─── View Functions
    // ─────────────────────────────────────────────────

    /// @notice Retrieve the full Signal struct for a given signal ID
    /// @param signalId The signal to look up
    /// @return The complete Signal struct
    function getSignal(uint256 signalId) external view returns (Signal memory) {
        if (!_exists[signalId]) revert SignalNotFound(signalId);
        return _signals[signalId];
    }

    /// @notice Retrieve the Genius address that committed a signal
    /// @param signalId The signal to look up
    /// @return The address of the Genius who committed the signal
    function getSignalGenius(uint256 signalId) external view returns (address) {
        if (!_exists[signalId]) revert SignalNotFound(signalId);
        return _signals[signalId].genius;
    }

    /// @notice Check whether a signal is currently active (not expired, not cancelled/settled)
    /// @param signalId The signal to check
    /// @return True if the signal exists, has Active status, and has not expired
    function isActive(uint256 signalId) external view returns (bool) {
        if (!_exists[signalId]) return false;

        Signal storage s = _signals[signalId];
        return s.status == SignalStatus.Active && block.timestamp < s.expiresAt;
    }

    /// @notice Get only the SLA multiplier for a signal (gas-efficient for settlement)
    /// @dev Avoids loading the full Signal struct (which includes the encrypted blob)
    /// @param signalId The signal to look up
    /// @return slaMultiplierBps The SLA multiplier in basis points
    function getSignalSlaMultiplierBps(uint256 signalId) external view returns (uint256) {
        if (!_exists[signalId]) revert SignalNotFound(signalId);
        return _signals[signalId].slaMultiplierBps;
    }

    /// @notice Check whether a signal ID has been used
    /// @param signalId The signal ID to check
    /// @return True if a signal with this ID has been committed
    function signalExists(uint256 signalId) external view returns (bool) {
        return _exists[signalId];
    }

    // ─── Emergency pause
    // ─────────────────────────────────────────────

    /// @notice Set the emergency pauser address
    /// @param _pauser New pauser address (address(0) to disable)
    function setPauser(address _pauser) external onlyOwner {
        pauser = _pauser;
        emit PauserUpdated(_pauser);
    }

    /// @notice Set the collateral contract for commit-time collateral checks
    /// @param _collateral Collateral contract address (address(0) to disable check)
    function setCollateral(address _collateral) external onlyOwner {
        collateral = _collateral;
        emit CollateralUpdated(_collateral);
    }

    /// @notice Pause signal commitment
    function pause() external {
        if (msg.sender != pauser && msg.sender != owner()) revert NotPauserOrOwner(msg.sender);
        _pause();
    }

    /// @notice Unpause signal commitment
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Only the owner (TimelockController) can authorize upgrades.
    ///      SignalCommitment holds no USDC — no balance guard needed.
    function _authorizeUpgrade(address) internal override onlyOwner whenPaused {}

    /// @dev Reserved storage gap for future upgrades.
    uint256[45] private __gap;
}
