// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Purchase, Outcome, AccountState} from "./interfaces/IDjinn.sol";
import {IEscrow, ICollateral, ICreditLedger, IAccount, ISignalCommitment} from "./interfaces/IProtocol.sol";

/// @notice Result of an audit settlement
struct AuditResult {
    int256 qualityScore;
    uint256 trancheA;
    uint256 trancheB;
    uint256 protocolFee;
    uint256 timestamp;
}

/// @title Audit (v2 — Batch-based settlement)
/// @notice Handles settlement for batches of resolved purchases between a Genius-Idiot pair.
///         Validators identify 10+ resolved unaudited purchases, compute the Quality Score
///         off-chain via MPC, vote on the aggregate, and settlement fires on quorum.
///         The pair is never blocked from trading.
contract Audit is Initializable, OwnableUpgradeable, PausableUpgradeable, ReentrancyGuardTransient, UUPSUpgradeable {
    // ─── Constants ──────────────────────────────────────────────

    /// @notice Protocol fee in basis points (0.5% = 50 bps)
    uint256 public constant PROTOCOL_FEE_BPS = 50;

    /// @notice Basis points denominator
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Odds precision: 6-decimal fixed point (1.91 = 1_910_000)
    uint256 public constant ODDS_PRECISION = 1e6;

    /// @notice Maximum absolute quality score (1 billion USDC, 6 decimals)
    int256 public constant MAX_QUALITY_SCORE = 1_000_000_000e6;

    /// @notice Maximum total notional per batch (20 signals * 1M USDC max per signal)
    uint256 public constant MAX_BATCH_NOTIONAL = 20e12;

    /// @notice Minimum purchases in a standard audit batch
    uint256 public constant MIN_BATCH_SIZE = 10;

    /// @notice Maximum purchases in an audit batch (gas bound)
    uint256 public constant MAX_BATCH_SIZE = 20;

    // ─── Legacy State (v1, preserved for UUPS layout) ───────────

    IEscrow public escrow;
    ICollateral public collateral;
    ICreditLedger public creditLedger;
    IAccount public account;
    ISignalCommitment public signalCommitment;
    address public protocolTreasury;
    address public outcomeVoting;

    /// @notice Stored audit results: genius -> idiot -> batchId -> AuditResult
    /// @dev In v1 this was keyed by cycle. In v2, keyed by batchId from Account.markBatchAudited.
    mapping(address => mapping(address => mapping(uint256 => AuditResult))) public auditResults;

    address public pauser;

    // ─── Events ─────────────────────────────────────────────────

    event AuditSettled(
        address indexed genius,
        address indexed idiot,
        uint256 batchId,
        int256 qualityScore,
        uint256 trancheA,
        uint256 trancheB,
        uint256 protocolFee
    );

    event EarlyExitSettled(
        address indexed genius, address indexed idiot, uint256 batchId, int256 qualityScore, uint256 creditsAwarded
    );

    event ContractAddressUpdated(string name, address addr);
    event TreasuryUpdated(address newTreasury);
    event PauserUpdated(address indexed newPauser);
    event ProtocolFeeShortfall(address indexed genius, uint256 intended, uint256 actual);
    event ForceSettlement(address indexed genius, address indexed idiot, uint256 batchId, int256 qualityScore);

    // ─── Errors ─────────────────────────────────────────────────

    error AlreadySettled(address genius, address idiot, uint256 batchId);
    error ZeroAddress();
    error ContractNotSet(string name);
    error NotPartyToAudit(address caller, address genius, address idiot);
    error NoPurchasesInBatch();
    error OutcomesNotFinalized(address genius, address idiot);
    error CallerNotOutcomeVoting(address caller);
    error QualityScoreOutOfBounds(int256 score, int256 maxAbsolute);
    error NotPauserOrOwner(address caller);
    error TotalNotionalOutOfBounds(uint256 totalNotional, uint256 maxAllowed);
    error BatchTooSmall(uint256 provided, uint256 minimum);
    error BatchTooLarge(uint256 provided, uint256 maximum);

    // ─── Constructor ────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _owner) public initializer {
        __Ownable_init(_owner);
        __Pausable_init();
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setEscrow(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        escrow = IEscrow(_addr);
        emit ContractAddressUpdated("Escrow", _addr);
    }

    function setCollateral(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        collateral = ICollateral(_addr);
        emit ContractAddressUpdated("Collateral", _addr);
    }

    function setCreditLedger(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        creditLedger = ICreditLedger(_addr);
        emit ContractAddressUpdated("CreditLedger", _addr);
    }

    function setAccount(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        account = IAccount(_addr);
        emit ContractAddressUpdated("Account", _addr);
    }

    function setSignalCommitment(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        signalCommitment = ISignalCommitment(_addr);
        emit ContractAddressUpdated("SignalCommitment", _addr);
    }

    function setProtocolTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        protocolTreasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function setOutcomeVoting(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        outcomeVoting = _addr;
        emit ContractAddressUpdated("OutcomeVoting", _addr);
    }

    // ─── Core: Permissionless settlement ────────────────────────

    /// @notice Settle a batch of resolved purchases. Permissionless: anyone can call.
    ///         All outcomes must be recorded on-chain (non-voted path).
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    /// @param purchaseIds The purchases to settle (must be 10-20, all resolved, all unaudited)
    function settle(
        address genius,
        address idiot,
        uint256[] calldata purchaseIds
    ) external whenNotPaused nonReentrant {
        _validateDependencies();
        _validateBatchSize(purchaseIds.length, MIN_BATCH_SIZE);
        _verifyAllOutcomesFinalized(genius, idiot, purchaseIds);

        int256 score = _computeScore(genius, idiot, purchaseIds);
        (uint256 totalNotional, uint256 totalUsdcFeesPaid) = _aggregatePurchases(genius, idiot, purchaseIds);

        uint256 batchId = account.markBatchAudited(genius, idiot, purchaseIds);
        _settleCommon(genius, idiot, batchId, score, false, totalNotional, totalUsdcFeesPaid, purchaseIds);
    }

    /// @notice Either party can trigger early exit for fewer than 10 resolved purchases.
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    /// @param purchaseIds The purchases to settle (1-9, all resolved, all unaudited)
    function earlyExit(
        address genius,
        address idiot,
        uint256[] calldata purchaseIds
    ) external whenNotPaused nonReentrant {
        _validateDependencies();
        if (msg.sender != genius && msg.sender != idiot) {
            revert NotPartyToAudit(msg.sender, genius, idiot);
        }
        if (purchaseIds.length == 0) revert NoPurchasesInBatch();
        if (purchaseIds.length > MAX_BATCH_SIZE) revert BatchTooLarge(purchaseIds.length, MAX_BATCH_SIZE);
        _verifyAllOutcomesFinalized(genius, idiot, purchaseIds);

        int256 score = _computeScore(genius, idiot, purchaseIds);
        (uint256 totalNotional, uint256 totalUsdcFeesPaid) = _aggregatePurchases(genius, idiot, purchaseIds);

        uint256 batchId = account.markBatchAudited(genius, idiot, purchaseIds);
        _settleCommon(genius, idiot, batchId, score, true, totalNotional, totalUsdcFeesPaid, purchaseIds);
    }

    // ─── Voted settlement (called by OutcomeVoting) ─────────────

    /// @notice Settle a full batch using a validator-voted quality score.
    function settleByVote(
        address genius,
        address idiot,
        uint256[] calldata purchaseIds,
        int256 qualityScore,
        uint256 totalNotional
    ) external whenNotPaused nonReentrant {
        if (msg.sender != outcomeVoting) revert CallerNotOutcomeVoting(msg.sender);
        _validateScoreAndNotional(qualityScore, totalNotional);
        _validateDependencies();
        _validateBatchSize(purchaseIds.length, MIN_BATCH_SIZE);

        // Mark as audited in Account (validates purchases are valid)
        uint256 batchId = account.markBatchAudited(genius, idiot, purchaseIds);

        // Compute USDC fees from on-chain records for damage cap
        uint256 totalUsdcFeesPaid;
        uint256 onChainNotional;
        for (uint256 i; i < purchaseIds.length; ++i) {
            Purchase memory p = escrow.getPurchase(purchaseIds[i]);
            totalUsdcFeesPaid += p.usdcPaid;
            onChainNotional += p.notional;
        }
        if (totalNotional > onChainNotional) {
            revert TotalNotionalOutOfBounds(totalNotional, onChainNotional);
        }

        _settleCommon(genius, idiot, batchId, qualityScore, false, totalNotional, totalUsdcFeesPaid, purchaseIds);
    }

    /// @notice Settle an early exit batch using a validator-voted quality score.
    function earlyExitByVote(
        address genius,
        address idiot,
        uint256[] calldata purchaseIds,
        int256 qualityScore,
        uint256 totalNotional
    ) external whenNotPaused nonReentrant {
        if (msg.sender != outcomeVoting) revert CallerNotOutcomeVoting(msg.sender);
        _validateScoreAndNotional(qualityScore, totalNotional);
        _validateDependencies();
        if (purchaseIds.length == 0) revert NoPurchasesInBatch();
        if (purchaseIds.length > MAX_BATCH_SIZE) revert BatchTooLarge(purchaseIds.length, MAX_BATCH_SIZE);

        uint256 batchId = account.markBatchAudited(genius, idiot, purchaseIds);

        uint256 totalUsdcFeesPaid;
        uint256 onChainNotional;
        for (uint256 i; i < purchaseIds.length; ++i) {
            Purchase memory p = escrow.getPurchase(purchaseIds[i]);
            totalUsdcFeesPaid += p.usdcPaid;
            onChainNotional += p.notional;
        }
        if (totalNotional > onChainNotional) {
            revert TotalNotionalOutOfBounds(totalNotional, onChainNotional);
        }

        _settleCommon(genius, idiot, batchId, qualityScore, true, totalNotional, totalUsdcFeesPaid, purchaseIds);
    }

    // ─── Owner-only emergency settlement ────────────────────────

    /// @notice Emergency settlement for stuck batches. Owner specifies quality score.
    function forceSettle(
        address genius,
        address idiot,
        uint256[] calldata purchaseIds,
        int256 qualityScore
    ) external onlyOwner whenNotPaused nonReentrant {
        _validateScoreAndNotional(qualityScore, 0);
        _validateDependencies();
        if (purchaseIds.length == 0) revert NoPurchasesInBatch();
        if (purchaseIds.length > MAX_BATCH_SIZE) revert BatchTooLarge(purchaseIds.length, MAX_BATCH_SIZE);

        uint256 batchId = account.markBatchAudited(genius, idiot, purchaseIds);

        (uint256 totalNotional, uint256 totalUsdcFeesPaid) = _aggregatePurchases(genius, idiot, purchaseIds);

        bool isEarlyExit = purchaseIds.length < MIN_BATCH_SIZE;
        emit ForceSettlement(genius, idiot, batchId, qualityScore);
        _settleCommon(genius, idiot, batchId, qualityScore, isEarlyExit, totalNotional, totalUsdcFeesPaid, purchaseIds);
    }

    // ─── Score computation ──────────────────────────────────────

    /// @notice Compute the Quality Score for a batch of purchases (on-chain outcomes).
    function computeScore(
        address genius,
        address idiot,
        uint256[] calldata purchaseIds
    ) external view returns (int256) {
        _validateDependenciesView();
        return _computeScore(genius, idiot, purchaseIds);
    }

    // ─── Internal ───────────────────────────────────────────────

    function _computeScore(
        address genius,
        address idiot,
        uint256[] calldata purchaseIds
    ) internal view returns (int256 score) {
        if (purchaseIds.length == 0) revert NoPurchasesInBatch();

        for (uint256 i; i < purchaseIds.length; ++i) {
            Purchase memory p = escrow.getPurchase(purchaseIds[i]);
            Outcome outcome = account.getOutcome(genius, idiot, purchaseIds[i]);

            if (outcome == Outcome.Favorable) {
                int256 gain = int256(p.notional) * (int256(p.odds) - int256(ODDS_PRECISION)) / int256(ODDS_PRECISION);
                score += gain;
            } else if (outcome == Outcome.Unfavorable) {
                uint256 slaBps = signalCommitment.getSignalSlaMultiplierBps(p.signalId);
                int256 loss = int256(p.notional) * int256(slaBps) / int256(BPS_DENOMINATOR);
                score -= loss;
            }

            if (score > MAX_QUALITY_SCORE || score < -MAX_QUALITY_SCORE) {
                revert QualityScoreOutOfBounds(score, MAX_QUALITY_SCORE);
            }
        }
    }

    function _aggregatePurchases(
        address genius,
        address idiot,
        uint256[] calldata purchaseIds
    ) internal view returns (uint256 totalNotional, uint256 totalUsdcFeesPaid) {
        for (uint256 i; i < purchaseIds.length; ++i) {
            Purchase memory p = escrow.getPurchase(purchaseIds[i]);
            Outcome outcome = account.getOutcome(genius, idiot, purchaseIds[i]);
            if (outcome != Outcome.Void) {
                totalNotional += p.notional;
            }
            totalUsdcFeesPaid += p.usdcPaid;
        }
    }

    function _verifyAllOutcomesFinalized(
        address genius,
        address idiot,
        uint256[] calldata purchaseIds
    ) internal view {
        for (uint256 i; i < purchaseIds.length; ++i) {
            Outcome outcome = account.getOutcome(genius, idiot, purchaseIds[i]);
            if (outcome == Outcome.Pending) {
                revert OutcomesNotFinalized(genius, idiot);
            }
        }
    }

    function _distributeDamages(
        address genius,
        address idiot,
        uint256 totalDamages,
        uint256 totalUsdcFeesPaid
    ) internal returns (uint256 trancheA, uint256 trancheB) {
        trancheA = totalDamages < totalUsdcFeesPaid ? totalDamages : totalUsdcFeesPaid;
        if (totalDamages > trancheA) {
            trancheB = totalDamages - trancheA;
        }

        if (trancheA > 0) {
            try collateral.slash(genius, trancheA, idiot) returns (uint256 actualSlash) {
                if (actualSlash < trancheA) {
                    uint256 shortfall = trancheA - actualSlash;
                    trancheB += shortfall;
                    trancheA = actualSlash;
                }
            } catch {
                trancheB += trancheA;
                trancheA = 0;
            }
        }

        if (trancheB > 0) {
            creditLedger.mint(idiot, trancheB);
        }
    }

    function _releaseSignalLocks(address genius, uint256[] memory purchaseIds) internal {
        for (uint256 i; i < purchaseIds.length; ++i) {
            Purchase memory p = escrow.getPurchase(purchaseIds[i]);
            uint256 slaBps = signalCommitment.getSignalSlaMultiplierBps(p.signalId);
            uint256 slaLock = (p.notional * slaBps) / BPS_DENOMINATOR;
            uint256 protocolFeeLock = (p.notional * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
            uint256 expectedLock = slaLock + protocolFeeLock;
            uint256 actualLock = collateral.getSignalLock(genius, p.signalId);
            uint256 releaseAmount = expectedLock < actualLock ? expectedLock : actualLock;
            if (releaseAmount > 0) {
                collateral.release(p.signalId, genius, releaseAmount);
            }
        }
    }

    function _settleCommon(
        address genius,
        address idiot,
        uint256 batchId,
        int256 score,
        bool isEarlyExit,
        uint256 totalNotional,
        uint256 totalUsdcFeesPaid,
        uint256[] memory purchaseIds
    ) internal {
        collateral.freezeWithdrawals(genius);

        uint256 protocolFee = (totalNotional * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;

        _releaseSignalLocks(genius, purchaseIds);

        uint256 trancheA;
        uint256 trancheB;

        if (isEarlyExit) {
            if (score < 0) {
                trancheB = uint256(-score);
                creditLedger.mint(idiot, trancheB);
            }
        } else if (score < 0) {
            (trancheA, trancheB) = _distributeDamages(genius, idiot, uint256(-score), totalUsdcFeesPaid);
        }

        // Compute net claimable fees and record in Escrow (replaces feePool)
        uint256 netClaimable = totalUsdcFeesPaid > trancheA ? totalUsdcFeesPaid - trancheA : 0;
        if (netClaimable > 0) {
            escrow.recordBatchClaimable(genius, idiot, batchId, netClaimable);
        }

        if (protocolFee > 0) {
            uint256 intendedFee = protocolFee;
            protocolFee = collateral.slash(genius, protocolFee, protocolTreasury);
            if (protocolFee < intendedFee) {
                emit ProtocolFeeShortfall(genius, intendedFee, protocolFee);
            }
        }

        auditResults[genius][idiot][batchId] = AuditResult({
            qualityScore: score,
            trancheA: trancheA,
            trancheB: trancheB,
            protocolFee: protocolFee,
            timestamp: block.timestamp
        });

        collateral.unfreezeWithdrawals(genius);

        if (isEarlyExit) {
            emit EarlyExitSettled(genius, idiot, batchId, score, trancheB);
        } else {
            emit AuditSettled(genius, idiot, batchId, score, trancheA, trancheB, protocolFee);
        }
    }

    // ─── View ───────────────────────────────────────────────────

    function getAuditResult(address genius, address idiot, uint256 batchId)
        external view returns (AuditResult memory)
    {
        return auditResults[genius][idiot][batchId];
    }

    // ─── Validation helpers ─────────────────────────────────────

    function _validateBatchSize(uint256 size, uint256 minimum) internal pure {
        if (size < minimum) revert BatchTooSmall(size, minimum);
        if (size > MAX_BATCH_SIZE) revert BatchTooLarge(size, MAX_BATCH_SIZE);
    }

    function _validateScoreAndNotional(int256 score, uint256 notional) internal pure {
        if (score > MAX_QUALITY_SCORE || score < -MAX_QUALITY_SCORE) {
            revert QualityScoreOutOfBounds(score, MAX_QUALITY_SCORE);
        }
        if (notional > MAX_BATCH_NOTIONAL) {
            revert TotalNotionalOutOfBounds(notional, MAX_BATCH_NOTIONAL);
        }
    }

    function _validateDependencies() internal view {
        if (address(escrow) == address(0)) revert ContractNotSet("Escrow");
        if (address(collateral) == address(0)) revert ContractNotSet("Collateral");
        if (address(creditLedger) == address(0)) revert ContractNotSet("CreditLedger");
        if (address(account) == address(0)) revert ContractNotSet("Account");
        if (address(signalCommitment) == address(0)) revert ContractNotSet("SignalCommitment");
        if (protocolTreasury == address(0)) revert ContractNotSet("ProtocolTreasury");
    }

    function _validateDependenciesView() internal view {
        if (address(escrow) == address(0)) revert ContractNotSet("Escrow");
        if (address(account) == address(0)) revert ContractNotSet("Account");
        if (address(signalCommitment) == address(0)) revert ContractNotSet("SignalCommitment");
    }

    // ─── Emergency pause ────────────────────────────────────────

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

    /// @dev Reserved storage gap for future upgrades.
    uint256[41] private __gap;
}
