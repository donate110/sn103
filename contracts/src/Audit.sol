// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Purchase, Outcome, Signal, AccountState} from "./interfaces/IDjinn.sol";
import {IEscrow, ICollateral, ICreditLedger, IAccount, ISignalCommitment} from "./interfaces/IProtocol.sol";

/// @notice Result of an audit settlement
struct AuditResult {
    int256 qualityScore;
    uint256 trancheA;
    uint256 trancheB;
    uint256 protocolFee;
    uint256 timestamp;
}

/// @title Audit
/// @notice Handles settlement after 10 signals between a Genius-Idiot pair.
///         Computes the Quality Score per the whitepaper formula, distributes damages
///         across Tranche A (USDC refund) and Tranche B (Credits), collects a 0.5%
///         protocol fee on total notional, and releases remaining collateral locks.
contract Audit is Initializable, OwnableUpgradeable, PausableUpgradeable, ReentrancyGuard, UUPSUpgradeable {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @notice Protocol fee in basis points (0.5% = 50 bps)
    uint256 public constant PROTOCOL_FEE_BPS = 50;

    /// @notice Basis points denominator
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Odds precision: 6-decimal fixed point (1.91 = 1_910_000)
    uint256 public constant ODDS_PRECISION = 1e6;

    /// @notice Maximum absolute quality score (1 billion USDC, 6 decimals)
    /// @dev Prevents int256 overflow when converting negative scores to uint256.
    ///      No realistic cycle can produce a score exceeding this bound.
    int256 public constant MAX_QUALITY_SCORE = 1_000_000_000e6;

    /// @notice Maximum total notional per cycle (10 signals * 1M USDC max per signal)
    /// @dev Bounds validator-attested totalNotional in voted settlement paths.
    ///      SIGNALS_PER_CYCLE (10) * Escrow.MAX_NOTIONAL (1e12) = 1e13.
    uint256 public constant MAX_CYCLE_NOTIONAL = 10e12;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice Protocol contract references
    IEscrow public escrow;
    ICollateral public collateral;
    ICreditLedger public creditLedger;
    IAccount public account;
    ISignalCommitment public signalCommitment;

    /// @notice Protocol treasury address that receives the 0.5% fee
    address public protocolTreasury;

    /// @notice OutcomeVoting contract address (sole caller for voted settlements)
    address public outcomeVoting;

    /// @notice Stored audit results: genius -> idiot -> cycle -> AuditResult
    mapping(address => mapping(address => mapping(uint256 => AuditResult))) public auditResults;

    /// @notice Address authorized to pause this contract in emergencies
    address public pauser;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted when an audit is triggered
    event AuditTriggered(address indexed genius, address indexed idiot, uint256 cycle);

    /// @notice Emitted when an audit is settled
    event AuditSettled(
        address indexed genius,
        address indexed idiot,
        uint256 cycle,
        int256 qualityScore,
        uint256 trancheA,
        uint256 trancheB,
        uint256 protocolFee
    );

    /// @notice Emitted when an early exit is executed
    event EarlyExitSettled(
        address indexed genius, address indexed idiot, uint256 cycle, int256 qualityScore, uint256 creditsAwarded
    );

    /// @notice Emitted when a contract address is updated
    event ContractAddressUpdated(string name, address addr);

    /// @notice Emitted when the protocol treasury address is updated
    event TreasuryUpdated(address newTreasury);

    /// @notice Emitted when the pauser address is updated
    event PauserUpdated(address indexed newPauser);

    /// @notice Emitted when protocol fee slash returns less than intended
    event ProtocolFeeShortfall(address indexed genius, uint256 intended, uint256 actual);

    /// @notice Emitted during forceSettle for off-chain monitoring
    event ForceSettlement(address indexed genius, address indexed idiot, uint256 cycle, int256 qualityScore);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NotAuditReady(address genius, address idiot);
    error AlreadySettled(address genius, address idiot, uint256 cycle);
    error ZeroAddress();
    error ContractNotSet(string name);
    error NotPartyToAudit(address caller, address genius, address idiot);
    error NoPurchasesInCycle(address genius, address idiot, uint256 cycle);
    error AuditAlreadyReady(address genius, address idiot);
    error OutcomesNotFinalized(address genius, address idiot);
    error CallerNotOutcomeVoting(address caller);
    error QualityScoreOutOfBounds(int256 score, int256 maxAbsolute);
    error NotPauserOrOwner(address caller);
    error TotalNotionalOutOfBounds(uint256 totalNotional, uint256 maxAllowed);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the Audit contract (replaces constructor for proxy pattern)
    /// @dev DESIGN NOTE (CF-10): __UUPSUpgradeable_init() is not called because it does
    ///      not exist in OpenZeppelin v5.5.0. The UUPSUpgradeable contract in OZ v5 has no
    ///      initializer function and requires no initialization. All UUPS proxy behavior is
    ///      handled by the constructor (_disableInitializers) and _authorizeUpgrade override.
    ///      This applies to all contracts in the protocol: Account, Collateral, Escrow,
    ///      OutcomeVoting, SignalCommitment, and TrackRecord.
    /// @param _owner Address that will own this contract
    function initialize(address _owner) public initializer {
        __Ownable_init(_owner);
        __Pausable_init();
    }

    // -------------------------------------------------------------------------
    // Admin -- set protocol contract addresses
    // -------------------------------------------------------------------------

    /// @notice Set the Escrow contract address
    /// @param _addr Escrow contract address
    function setEscrow(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        escrow = IEscrow(_addr);
        emit ContractAddressUpdated("Escrow", _addr);
    }

    /// @notice Set the Collateral contract address
    /// @param _addr Collateral contract address
    function setCollateral(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        collateral = ICollateral(_addr);
        emit ContractAddressUpdated("Collateral", _addr);
    }

    /// @notice Set the CreditLedger contract address
    /// @param _addr CreditLedger contract address
    function setCreditLedger(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        creditLedger = ICreditLedger(_addr);
        emit ContractAddressUpdated("CreditLedger", _addr);
    }

    /// @notice Set the Account contract address
    /// @param _addr Account contract address
    function setAccount(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        account = IAccount(_addr);
        emit ContractAddressUpdated("Account", _addr);
    }

    /// @notice Set the SignalCommitment contract address
    /// @param _addr SignalCommitment contract address
    function setSignalCommitment(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        signalCommitment = ISignalCommitment(_addr);
        emit ContractAddressUpdated("SignalCommitment", _addr);
    }

    /// @notice Set the protocol treasury address
    /// @param _treasury Address that receives the 0.5% protocol fee
    function setProtocolTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        protocolTreasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    /// @notice Set the OutcomeVoting contract address
    /// @param _addr OutcomeVoting contract address
    function setOutcomeVoting(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        outcomeVoting = _addr;
        emit ContractAddressUpdated("OutcomeVoting", _addr);
    }

    // -------------------------------------------------------------------------
    // Core functions
    // -------------------------------------------------------------------------

    /// @notice Trigger an audit for a Genius-Idiot pair.
    /// @dev Alias for settle(). Kept for backwards compatibility.
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    function trigger(address genius, address idiot) external whenNotPaused nonReentrant {
        _settleInternal(genius, idiot);
    }

    /// @notice Compute the Quality Score for a Genius-Idiot pair in the current cycle.
    /// @dev For each purchase:
    ///      - Favorable: +notional * (odds - 1e6) / 1e6
    ///      - Unfavorable: -notional * slaMultiplierBps / 10000
    ///      - Void/Pending: skip
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    /// @return score The computed Quality Score (can be negative)
    function computeScore(address genius, address idiot) public view returns (int256 score) {
        _validateDependenciesView();

        AccountState memory state = account.getAccountState(genius, idiot);
        uint256[] memory purchaseIds = state.purchaseIds;

        if (purchaseIds.length == 0) {
            revert NoPurchasesInCycle(genius, idiot, state.currentCycle);
        }

        // Verify all outcomes are finalized before computing score
        for (uint256 i; i < purchaseIds.length; ++i) {
            Outcome outcome = account.getOutcome(genius, idiot, purchaseIds[i]);
            if (outcome == Outcome.Pending) {
                revert OutcomesNotFinalized(genius, idiot);
            }
        }

        score = 0;

        for (uint256 i; i < purchaseIds.length; ++i) {
            Purchase memory p = escrow.getPurchase(purchaseIds[i]);
            Signal memory sig = signalCommitment.getSignal(p.signalId);
            Outcome outcome = account.getOutcome(genius, idiot, purchaseIds[i]);

            if (outcome == Outcome.Favorable) {
                // +notional * (odds - 1e6) / 1e6
                // odds is 6-decimal fixed point, e.g., 1.91 = 1_910_000
                int256 gain = int256(p.notional) * (int256(p.odds) - int256(ODDS_PRECISION)) / int256(ODDS_PRECISION);
                score += gain;
            } else if (outcome == Outcome.Unfavorable) {
                // -notional * slaMultiplierBps / 10000
                int256 loss = int256(p.notional) * int256(sig.slaMultiplierBps) / int256(BPS_DENOMINATOR);
                score -= loss;
            }
            // Void and Pending: skip

            // Bounds check per iteration to catch overflow before it compounds
            if (score > MAX_QUALITY_SCORE || score < -MAX_QUALITY_SCORE) {
                revert QualityScoreOutOfBounds(score, MAX_QUALITY_SCORE);
            }
        }
    }

    /// @notice Execute settlement for a Genius-Idiot pair.
    ///         Handles Tranche A (USDC), Tranche B (Credits),
    ///         protocol fee, collateral release, and cycle advancement.
    ///         Permissionless by design: any address can call once the pair is audit-ready.
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    function settle(address genius, address idiot) external whenNotPaused nonReentrant {
        _settleInternal(genius, idiot);
    }

    /// @dev Shared settlement logic for trigger() and settle().
    function _settleInternal(address genius, address idiot) internal {
        _validateDependencies();
        if (!account.isAuditReady(genius, idiot)) {
            revert NotAuditReady(genius, idiot);
        }

        uint256 cycle = account.getCurrentCycle(genius, idiot);
        if (auditResults[genius][idiot][cycle].timestamp != 0) {
            revert AlreadySettled(genius, idiot, cycle);
        }

        // All outcomes must be finalized before settlement
        AccountState memory state = account.getAccountState(genius, idiot);
        for (uint256 i; i < state.purchaseIds.length; ++i) {
            Outcome outcome = account.getOutcome(genius, idiot, state.purchaseIds[i]);
            if (outcome == Outcome.Pending) {
                revert OutcomesNotFinalized(genius, idiot);
            }
        }

        int256 score = computeScore(genius, idiot);
        _settle(genius, idiot, cycle, score, false);
    }

    /// @notice Either party can trigger early exit before 10 signals.
    ///         Settlement uses the current Quality Score. Damages to Idiot are paid
    ///         in Credits only (insufficient sample for USDC movement), but the 0.5%
    ///         protocol fee is still charged to Genius collateral to prevent fee dodging.
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    function earlyExit(address genius, address idiot) external whenNotPaused nonReentrant {
        _validateDependencies();

        // Only the genius or idiot can trigger early exit
        if (msg.sender != genius && msg.sender != idiot) {
            revert NotPartyToAudit(msg.sender, genius, idiot);
        }

        // Must NOT be audit-ready (i.e., fewer than 10 signals)
        if (account.isAuditReady(genius, idiot)) {
            revert AuditAlreadyReady(genius, idiot);
        }

        uint256 cycle = account.getCurrentCycle(genius, idiot);
        if (auditResults[genius][idiot][cycle].timestamp != 0) {
            revert AlreadySettled(genius, idiot, cycle);
        }

        AccountState memory state = account.getAccountState(genius, idiot);
        if (state.purchaseIds.length == 0) {
            revert NoPurchasesInCycle(genius, idiot, cycle);
        }

        // All outcomes must be finalized before early exit to prevent timing manipulation
        for (uint256 i; i < state.purchaseIds.length; ++i) {
            Outcome outcome = account.getOutcome(genius, idiot, state.purchaseIds[i]);
            if (outcome == Outcome.Pending) {
                revert OutcomesNotFinalized(genius, idiot);
            }
        }

        int256 score = computeScore(genius, idiot);
        _settle(genius, idiot, cycle, score, true);
    }

    // -------------------------------------------------------------------------
    // Voted settlement (called by OutcomeVoting after 2/3+ quorum)
    // -------------------------------------------------------------------------

    /// @notice Settle a full audit cycle using a validator-voted quality score.
    ///         Called by OutcomeVoting when 2/3+ validators agree on the aggregate
    ///         quality score. Individual purchase outcomes are computed off-chain via
    ///         MPC and never written on-chain (privacy preservation).
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    /// @param qualityScore The voted aggregate quality score (USDC, 6 decimals, can be negative)
    function settleByVote(address genius, address idiot, int256 qualityScore, uint256 totalNotional)
        external
        whenNotPaused
        nonReentrant
    {
        if (msg.sender != outcomeVoting) revert CallerNotOutcomeVoting(msg.sender);
        if (qualityScore > MAX_QUALITY_SCORE || qualityScore < -MAX_QUALITY_SCORE) {
            revert QualityScoreOutOfBounds(qualityScore, MAX_QUALITY_SCORE);
        }
        if (totalNotional > MAX_CYCLE_NOTIONAL) {
            revert TotalNotionalOutOfBounds(totalNotional, MAX_CYCLE_NOTIONAL);
        }
        _validateDependencies();

        // Full settlement requires 10 signals (audit-ready). For fewer signals,
        // parties must use earlyExitByVote which pays damages as Credits only.
        if (!account.isAuditReady(genius, idiot)) {
            revert NotAuditReady(genius, idiot);
        }

        uint256 cycle = account.getCurrentCycle(genius, idiot);
        if (auditResults[genius][idiot][cycle].timestamp != 0) {
            revert AlreadySettled(genius, idiot, cycle);
        }

        _settleVoted(genius, idiot, cycle, qualityScore, false, totalNotional);
    }

    /// @notice Settle an early exit using a validator-voted quality score.
    ///         Called by OutcomeVoting when 2/3+ validators agree and the cycle
    ///         had an early exit request. All damages are paid as Credits only.
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    /// @param qualityScore The voted aggregate quality score (USDC, 6 decimals, can be negative)
    function earlyExitByVote(address genius, address idiot, int256 qualityScore, uint256 totalNotional)
        external
        whenNotPaused
        nonReentrant
    {
        if (msg.sender != outcomeVoting) revert CallerNotOutcomeVoting(msg.sender);
        if (qualityScore > MAX_QUALITY_SCORE || qualityScore < -MAX_QUALITY_SCORE) {
            revert QualityScoreOutOfBounds(qualityScore, MAX_QUALITY_SCORE);
        }
        if (totalNotional > MAX_CYCLE_NOTIONAL) {
            revert TotalNotionalOutOfBounds(totalNotional, MAX_CYCLE_NOTIONAL);
        }
        _validateDependencies();

        // Defense-in-depth: ensure this is actually an early exit (< 10 signals)
        if (account.isAuditReady(genius, idiot)) {
            revert AuditAlreadyReady(genius, idiot);
        }

        uint256 cycle = account.getCurrentCycle(genius, idiot);
        if (auditResults[genius][idiot][cycle].timestamp != 0) {
            revert AlreadySettled(genius, idiot, cycle);
        }

        _settleVoted(genius, idiot, cycle, qualityScore, true, totalNotional);
    }

    // -------------------------------------------------------------------------
    // Owner-only emergency settlement
    // -------------------------------------------------------------------------

    /// @notice Owner-only emergency settlement for stuck/orphaned cycles.
    ///         Always settles as early exit (damages in Credits only, not USDC)
    ///         regardless of signal count. Use this when a cycle cannot reach
    ///         10 signals and needs to be cleaned up.
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    /// @param qualityScore The owner-determined quality score
    function forceSettle(address genius, address idiot, int256 qualityScore)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        if (qualityScore > MAX_QUALITY_SCORE || qualityScore < -MAX_QUALITY_SCORE) {
            revert QualityScoreOutOfBounds(qualityScore, MAX_QUALITY_SCORE);
        }
        _validateDependencies();

        uint256 cycle = account.getCurrentCycle(genius, idiot);
        if (auditResults[genius][idiot][cycle].timestamp != 0) {
            revert AlreadySettled(genius, idiot, cycle);
        }

        AccountState memory state = account.getAccountState(genius, idiot);
        uint256[] memory purchaseIds = state.purchaseIds;
        if (purchaseIds.length == 0) {
            revert NoPurchasesInCycle(genius, idiot, cycle);
        }

        // Aggregate purchases, filtering void outcomes when outcome data is available
        uint256 totalNotional;
        uint256 totalUsdcFeesPaid;
        for (uint256 i; i < purchaseIds.length; ++i) {
            Purchase memory p = escrow.getPurchase(purchaseIds[i]);
            Outcome outcome = account.getOutcome(genius, idiot, purchaseIds[i]);
            if (outcome != Outcome.Void) {
                totalNotional += p.notional;
            }
            totalUsdcFeesPaid += p.usdcPaid;
        }

        // CF-04: Bound quality score to actual cycle notional to prevent arbitrary values.
        // Even via timelock, the owner cannot set damages exceeding the cycle's notional.
        if (qualityScore > int256(totalNotional) || qualityScore < -int256(totalNotional)) {
            revert QualityScoreOutOfBounds(qualityScore, int256(totalNotional));
        }

        // Use full settlement (Tranche A USDC) when audit-ready, early exit otherwise
        bool isEarlyExit = !account.isAuditReady(genius, idiot);

        emit ForceSettlement(genius, idiot, cycle, qualityScore);

        _settleCommon(genius, idiot, cycle, qualityScore, isEarlyExit, totalNotional, totalUsdcFeesPaid, purchaseIds);
    }

    // -------------------------------------------------------------------------
    // Internal settlement logic
    // -------------------------------------------------------------------------

    /// @dev Aggregates totals across purchases in the current cycle
    /// @param genius The Genius address (needed to read outcomes from Account)
    /// @param idiot The Idiot address (needed to read outcomes from Account)
    /// @param purchaseIds Array of purchase IDs in the cycle
    /// @return totalNotional Sum of notional for non-void purchases
    /// @return totalUsdcFeesPaid Sum of USDC fees paid across all purchases
    function _aggregatePurchases(address genius, address idiot, uint256[] memory purchaseIds)
        internal
        view
        returns (uint256 totalNotional, uint256 totalUsdcFeesPaid)
    {
        for (uint256 i; i < purchaseIds.length; ++i) {
            Purchase memory p = escrow.getPurchase(purchaseIds[i]);
            Outcome outcome = account.getOutcome(genius, idiot, purchaseIds[i]);
            if (outcome != Outcome.Void) {
                totalNotional += p.notional;
            }
            totalUsdcFeesPaid += p.usdcPaid;
        }
    }

    /// @dev Distributes damages for a negative Quality Score in standard (non-early-exit) mode.
    ///      Tranche A: USDC slashed from Genius collateral, sent directly to Idiot wallet.
    ///      Tranche B: excess damages minted as Credits.
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    /// @param totalDamages Absolute value of the negative Quality Score
    /// @param totalUsdcFeesPaid Total USDC fees the Idiot paid this cycle
    /// @return trancheA USDC sent to the Idiot from Genius collateral
    /// @return trancheB Credits minted to the Idiot
    function _distributeDamages(
        address genius,
        address idiot,
        uint256 totalDamages,
        uint256 totalUsdcFeesPaid
    ) internal returns (uint256 trancheA, uint256 trancheB) {
        // Tranche A: USDC refund, capped at total USDC fees paid by this Idiot
        // Per Section 7: "You can never extract more USDC than you put in"
        trancheA = totalDamages < totalUsdcFeesPaid ? totalDamages : totalUsdcFeesPaid;

        // Tranche B: excess damages as Credits
        if (totalDamages > trancheA) {
            trancheB = totalDamages - trancheA;
        }

        // Slash Genius collateral — send USDC directly to the Idiot.
        // slash() returns the actual amount slashed (may be less if deposits insufficient).
        // Any shortfall moves from Tranche A to Tranche B (Credits instead of USDC).
        if (trancheA > 0) {
            uint256 actualSlash = collateral.slash(genius, trancheA, idiot);
            if (actualSlash < trancheA) {
                // Shortfall: Genius didn't have enough collateral
                uint256 shortfall = trancheA - actualSlash;
                trancheB += shortfall;
                trancheA = actualSlash;
            }
        }

        // Mint Credits for Tranche B
        if (trancheB > 0) {
            creditLedger.mint(idiot, trancheB);
        }
    }

    /// @dev Releases signal collateral locks for purchases in the cycle.
    ///      Releases the SLA lock + protocol fee lock for THIS purchase,
    ///      not the full signalLock, since multiple Idiots may share the same signal lock.
    /// @param genius The Genius address
    /// @param purchaseIds Array of purchase IDs in the cycle
    function _releaseSignalLocks(address genius, uint256[] memory purchaseIds) internal {
        for (uint256 i; i < purchaseIds.length; ++i) {
            Purchase memory p = escrow.getPurchase(purchaseIds[i]);
            Signal memory sig = signalCommitment.getSignal(p.signalId);
            uint256 slaLock = (p.notional * sig.slaMultiplierBps) / BPS_DENOMINATOR;
            uint256 protocolFeeLock = (p.notional * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
            uint256 expectedLock = slaLock + protocolFeeLock;
            // Cap at actual remaining lock to avoid revert if partially slashed
            uint256 actualLock = collateral.getSignalLock(genius, p.signalId);
            uint256 releaseAmount = expectedLock < actualLock ? expectedLock : actualLock;
            if (releaseAmount > 0) {
                collateral.release(p.signalId, genius, releaseAmount);
            }
        }
    }

    /// @dev On-chain settlement: uses _aggregatePurchases (filters voids) then shared logic.
    function _settle(address genius, address idiot, uint256 cycle, int256 score, bool isEarlyExit) internal {
        AccountState memory state = account.getAccountState(genius, idiot);
        uint256[] memory purchaseIds = state.purchaseIds;
        (uint256 totalNotional, uint256 totalUsdcFeesPaid) = _aggregatePurchases(genius, idiot, purchaseIds);
        _settleCommon(genius, idiot, cycle, score, isEarlyExit, totalNotional, totalUsdcFeesPaid, purchaseIds);
    }

    /// @dev Voted settlement: uses validator-attested totalNotional (excludes void outcomes)
    ///      instead of aggregating on-chain, since individual outcomes are never written
    ///      on-chain in the voted path (privacy preservation).
    function _settleVoted(address genius, address idiot, uint256 cycle, int256 score, bool isEarlyExit, uint256 votedNotional) internal {
        AccountState memory state = account.getAccountState(genius, idiot);
        uint256[] memory purchaseIds = state.purchaseIds;
        if (purchaseIds.length == 0) {
            revert NoPurchasesInCycle(genius, idiot, cycle);
        }
        // Use validator-attested totalNotional (excludes voids) for fee calculation.
        // Still need totalUsdcFeesPaid from on-chain records for damage cap computation.
        uint256 totalUsdcFeesPaid;
        for (uint256 i; i < purchaseIds.length; ++i) {
            Purchase memory p = escrow.getPurchase(purchaseIds[i]);
            totalUsdcFeesPaid += p.usdcPaid;
        }
        _settleCommon(genius, idiot, cycle, score, isEarlyExit, votedNotional, totalUsdcFeesPaid, purchaseIds);
    }

    /// @dev Core settlement logic shared by all settlement paths.
    ///      Releases collateral locks first, then distributes damages, charges protocol fee,
    ///      stores audit result, and advances the cycle.
    function _settleCommon(
        address genius,
        address idiot,
        uint256 cycle,
        int256 score,
        bool isEarlyExit,
        uint256 totalNotional,
        uint256 totalUsdcFeesPaid,
        uint256[] memory purchaseIds
    ) internal {
        // Freeze genius withdrawals during settlement to prevent front-running
        collateral.freezeWithdrawals(genius);

        // Protocol fee: 0.5% of total notional
        uint256 protocolFee = (totalNotional * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;

        // Release signal locks FIRST so freed collateral covers the slashes below.
        // This ensures slash() operates on accurate deposit/locked accounting.
        _releaseSignalLocks(genius, purchaseIds);

        uint256 trancheA;
        uint256 trancheB;

        if (isEarlyExit) {
            // Early exit: all damages as Credits, no USDC movement
            if (score < 0) {
                trancheB = uint256(-score);
                creditLedger.mint(idiot, trancheB);
            }
        } else if (score < 0) {
            // Standard settlement with negative score
            (trancheA, trancheB) = _distributeDamages(genius, idiot, uint256(-score), totalUsdcFeesPaid);
        }
        // If score >= 0 and not early exit: Genius keeps all fees, no damages

        // Protocol fee: slash from genius collateral to treasury.
        // DESIGN NOTE (CF-15): The protocol fee is charged on ALL settlements including
        // early exits. Per whitepaper Section 7: "The protocol charges a fee of 0.5% of
        // total notional at each audit." This covers real operational costs (gas, ZK
        // verification, infrastructure). Without this, a malicious idiot could grief the
        // protocol by forcing repeated single-purchase early exits to generate work without
        // revenue. The fee is included in the collateral lock calculation at purchase time
        // (see Escrow.purchase protocolFeeLock) so the genius is always covered.
        if (protocolFee > 0) {
            uint256 intendedFee = protocolFee;
            protocolFee = collateral.slash(genius, protocolFee, protocolTreasury);
            if (protocolFee < intendedFee) {
                emit ProtocolFeeShortfall(genius, intendedFee, protocolFee);
            }
        }

        // Store audit result
        auditResults[genius][idiot][cycle] = AuditResult({
            qualityScore: score,
            trancheA: trancheA,
            trancheB: trancheB,
            protocolFee: protocolFee,
            timestamp: block.timestamp
        });

        // Unfreeze genius withdrawals after settlement is complete
        collateral.unfreezeWithdrawals(genius);

        // Mark account as settled, start new cycle
        account.settleAudit(genius, idiot);

        if (isEarlyExit) {
            emit EarlyExitSettled(genius, idiot, cycle, score, trancheB);
        } else {
            emit AuditSettled(genius, idiot, cycle, score, trancheA, trancheB, protocolFee);
        }
    }

    // -------------------------------------------------------------------------
    // View functions
    // -------------------------------------------------------------------------

    /// @notice Get the audit result for a specific Genius-Idiot cycle
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    /// @param cycle The audit cycle number
    /// @return result The AuditResult struct
    function getAuditResult(address genius, address idiot, uint256 cycle)
        external
        view
        returns (AuditResult memory result)
    {
        return auditResults[genius][idiot][cycle];
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /// @dev Validates that all required contract references are set (state-changing)
    function _validateDependencies() internal view {
        if (address(escrow) == address(0)) revert ContractNotSet("Escrow");
        if (address(collateral) == address(0)) revert ContractNotSet("Collateral");
        if (address(creditLedger) == address(0)) revert ContractNotSet("CreditLedger");
        if (address(account) == address(0)) revert ContractNotSet("Account");
        if (address(signalCommitment) == address(0)) revert ContractNotSet("SignalCommitment");
        if (protocolTreasury == address(0)) revert ContractNotSet("ProtocolTreasury");
    }

    /// @dev Validates that all required contract references are set (view functions)
    function _validateDependenciesView() internal view {
        if (address(escrow) == address(0)) revert ContractNotSet("Escrow");
        if (address(account) == address(0)) revert ContractNotSet("Account");
        if (address(signalCommitment) == address(0)) revert ContractNotSet("SignalCommitment");
    }

    // -------------------------------------------------------------------------
    // Emergency pause
    // -------------------------------------------------------------------------

    /// @notice Set the emergency pauser address
    /// @param _pauser New pauser address (address(0) to disable)
    function setPauser(address _pauser) external onlyOwner {
        pauser = _pauser;
        emit PauserUpdated(_pauser);
    }

    /// @notice Pause audit trigger, settlement, and early exit
    function pause() external {
        if (msg.sender != pauser && msg.sender != owner()) revert NotPauserOrOwner(msg.sender);
        _pause();
    }

    /// @notice Unpause audit trigger, settlement, and early exit
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Owner can authorize upgrades only when paused
    function _authorizeUpgrade(address) internal override onlyOwner whenPaused {}

    /// @dev Reserved storage gap for future upgrades.
    uint256[41] private __gap;
}
