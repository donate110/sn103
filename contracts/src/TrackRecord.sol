// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IZKVerifier} from "./interfaces/IProtocol.sol";

/// @notice On-chain record of a verified track record proof
struct VerifiedRecord {
    address genius;
    uint256 signalCount;
    uint256 totalGain;
    uint256 totalLoss;
    uint256 favCount;
    uint256 unfavCount;
    uint256 voidCount;
    bytes32 proofHash;
    uint256 submittedAt;
    uint256 blockNumber;
}

/// @title TrackRecord
/// @notice Stores on-chain verified ZK track record proofs submitted by Geniuses.
///         Each proof demonstrates aggregate performance statistics (wins, losses,
///         gains) without revealing individual signal details.
contract TrackRecord is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice ZKVerifier contract used for proof verification
    IZKVerifier public zkVerifier;

    /// @notice All verified records, indexed by recordId
    mapping(uint256 => VerifiedRecord) public records;

    /// @notice Total number of submitted records
    uint256 public recordCount;

    /// @notice Record IDs per genius address
    mapping(address => uint256[]) public geniusRecordIds;

    /// @notice Tracks proof hashes to prevent duplicate submissions
    mapping(bytes32 => bool) public usedProofHashes;

    /// @notice Commit-reveal: genius -> proof commitment hash -> block number
    ///         Prevents front-running by requiring the genius to commit
    ///         a hash of their proof in an earlier block before revealing.
    mapping(address => mapping(bytes32 => uint256)) public proofCommitments;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted when a track record proof is verified and stored
    event TrackRecordSubmitted(
        uint256 indexed recordId,
        address indexed genius,
        uint256 signalCount,
        uint256 totalGain,
        uint256 totalLoss,
        uint256 favCount,
        uint256 unfavCount,
        uint256 voidCount,
        bytes32 proofHash
    );

    /// @notice Emitted when a genius commits a proof hash for future submission
    event ProofCommitted(address indexed genius, bytes32 commitHash, uint256 blockNumber);

    event ZKVerifierUpdated(address indexed verifier);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error VerifierNotSet();
    error ProofVerificationFailed();
    error DuplicateProof();
    error InvalidSignalCount(uint256 count);
    error ProofNotCommitted();
    error CommitTooRecent(uint256 commitBlock, uint256 currentBlock);
    error CommitExpired(uint256 commitBlock, uint256 currentBlock);

    /// @notice Maximum blocks between commit and submit (~96s on Base at 3s blocks)
    uint256 public constant COMMIT_EXPIRY_BLOCKS = 32;

    // -------------------------------------------------------------------------
    // Constructor / Initializer
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param _owner Address that will own this contract
    function initialize(address _owner) public initializer {
        __Ownable_init(_owner);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @notice Set the ZKVerifier contract address
    /// @param _zkVerifier Address of the deployed ZKVerifier
    function setZKVerifier(address _zkVerifier) external onlyOwner {
        if (_zkVerifier == address(0)) revert ZeroAddress();
        zkVerifier = IZKVerifier(_zkVerifier);
        emit ZKVerifierUpdated(_zkVerifier);
    }

    // -------------------------------------------------------------------------
    // Core
    // -------------------------------------------------------------------------

    /// @notice Commit a proof hash before submission (commit-reveal anti-front-running)
    /// @dev The genius must call this at least 1 block before submit().
    ///      commitHash = keccak256(abi.encodePacked(_pA, _pB, _pC, _pubSignals))
    /// @param commitHash Hash of the proof to be submitted
    function commitProof(bytes32 commitHash) external {
        proofCommitments[msg.sender][commitHash] = block.number;
        emit ProofCommitted(msg.sender, commitHash, block.number);
    }

    /// @notice Submit a verified track record proof on-chain
    ///
    /// @dev DESIGN NOTE (CF-08): The ZK public signals bind to committed signal hashes
    ///      (Poseidon of preimage+index), not to the submitter's wallet address. Adding
    ///      the genius address as a public signal would require a circuit redesign (the
    ///      Groth16 circuit is compiled with a fixed number of public inputs). Identity
    ///      binding is enforced through the commit-reveal pattern instead: only the address
    ///      that called commitProof() can submit within the COMMIT_EXPIRY_BLOCKS window,
    ///      and the proofHash deduplication prevents reuse. A circuit-level identity binding
    ///      is planned for the next circuit version.
    ///
    /// @dev Public signals layout (106 elements):
    ///      [0..19]   commitHash   — Poseidon hashes of (preimage, index) for each signal
    ///      [20..39]  outcome      — 1=Favorable, 2=Unfavorable, 3=Void
    ///      [40..59]  notional     — Bet amounts
    ///      [60..79]  odds         — 6-decimal fixed point (1.91 = 1,910,000)
    ///      [80..99]  slaBps       — SLA basis points
    ///      [100]     signalCount  — Number of active signals (1..20)
    ///      [101]     totalGain    — Sum of favorable gains
    ///      [102]     totalLoss    — Sum of unfavorable losses
    ///      [103]     favCount     — Count of favorable outcomes
    ///      [104]     unfavCount   — Count of unfavorable outcomes
    ///      [105]     voidCount    — Count of void outcomes
    /// @param _pA Groth16 proof element A
    /// @param _pB Groth16 proof element B
    /// @param _pC Groth16 proof element C
    /// @param _pubSignals Public signals array (106 elements)
    /// @return recordId The ID of the newly created record
    function submit(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[106] calldata _pubSignals
    ) external returns (uint256 recordId) {
        if (address(zkVerifier) == address(0)) revert VerifierNotSet();

        // Compute proof hash for deduplication
        bytes32 proofHash = keccak256(abi.encodePacked(_pA, _pB, _pC, _pubSignals));
        if (usedProofHashes[proofHash]) revert DuplicateProof();

        // Commit-reveal: submitter must have committed this proof in an earlier block
        uint256 commitBlock = proofCommitments[msg.sender][proofHash];
        if (commitBlock == 0) revert ProofNotCommitted();
        if (commitBlock >= block.number) revert CommitTooRecent(commitBlock, block.number);
        if (block.number - commitBlock > COMMIT_EXPIRY_BLOCKS) revert CommitExpired(commitBlock, block.number);

        // Clear commitment to prevent reuse
        delete proofCommitments[msg.sender][proofHash];

        // Validate signalCount is within circuit bounds (1..20)
        uint256 sc = _pubSignals[100];
        if (sc == 0 || sc > 20) revert InvalidSignalCount(sc);

        // Verify the Groth16 proof on-chain
        if (!zkVerifier.verifyTrackRecordProof(_pA, _pB, _pC, _pubSignals)) {
            revert ProofVerificationFailed();
        }

        // Store the record — read public signals directly to avoid stack depth
        recordId = recordCount++;
        VerifiedRecord storage rec = records[recordId];
        rec.genius = msg.sender;
        rec.signalCount = _pubSignals[100];
        rec.totalGain = _pubSignals[101];
        rec.totalLoss = _pubSignals[102];
        rec.favCount = _pubSignals[103];
        rec.unfavCount = _pubSignals[104];
        rec.voidCount = _pubSignals[105];
        rec.proofHash = proofHash;
        rec.submittedAt = block.timestamp;
        rec.blockNumber = block.number;

        usedProofHashes[proofHash] = true;
        geniusRecordIds[msg.sender].push(recordId);

        emit TrackRecordSubmitted(
            recordId,
            msg.sender,
            rec.signalCount,
            rec.totalGain,
            rec.totalLoss,
            rec.favCount,
            rec.unfavCount,
            rec.voidCount,
            proofHash
        );
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Get the number of verified records for a genius
    /// @param genius Address of the genius
    /// @return count Number of verified records
    function getRecordCount(address genius) external view returns (uint256 count) {
        return geniusRecordIds[genius].length;
    }

    /// @notice Get all record IDs for a genius
    /// @param genius Address of the genius
    /// @return ids Array of record IDs
    function getRecordIds(address genius) external view returns (uint256[] memory ids) {
        return geniusRecordIds[genius];
    }

    /// @notice Get a paginated slice of record IDs for a genius
    /// @param genius Address of the genius
    /// @param offset Starting index
    /// @param limit Maximum number of IDs to return
    /// @return ids Array of record IDs in the requested range
    function getRecordIdsPaginated(address genius, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids)
    {
        uint256[] storage allIds = geniusRecordIds[genius];
        if (offset >= allIds.length) return new uint256[](0);
        uint256 end = offset + limit;
        if (end > allIds.length) end = allIds.length;
        ids = new uint256[](end - offset);
        for (uint256 i = offset; i < end;) {
            ids[i - offset] = allIds[i];
            unchecked { ++i; }
        }
    }

    /// @notice Get a specific verified record
    /// @param recordId The record ID
    /// @return record The verified record data
    function getRecord(uint256 recordId) external view returns (VerifiedRecord memory record) {
        return records[recordId];
    }

    /// @dev Only the owner (TimelockController) can authorize upgrades.
    ///      TrackRecord holds no USDC — no balance guard needed.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @dev Reserved storage gap for future upgrades.
    uint256[44] private __gap;
}
