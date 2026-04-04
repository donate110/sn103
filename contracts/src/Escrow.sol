// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Outcome, Purchase, Signal, SignalStatus} from "./interfaces/IDjinn.sol";
import {ISignalCommitment, ICollateral, ICreditLedger, IAccount, IAudit} from "./interfaces/IProtocol.sol";

/// @title Escrow
/// @notice Holds Idiot USDC deposits and processes signal purchases in the Djinn Protocol.
///         Buyers deposit USDC ahead of time for instant purchases. Fees are split between
///         escrowed USDC and Djinn Credits (credits used first). A fee pool tracks collections
///         per genius-idiot-cycle for audit-time refunds.
contract Escrow is Initializable, OwnableUpgradeable, PausableUpgradeable, ReentrancyGuardTransient, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice USDC token (6 decimals)
    IERC20 public usdc;

    /// @notice Protocol contract references
    ISignalCommitment public signalCommitment;
    ICollateral public collateral;
    ICreditLedger public creditLedger;
    IAccount public account;

    /// @notice Address authorised to call refund() (the Audit contract)
    address public auditContract;

    /// @notice Addresses authorised to call setOutcome() (e.g. Account contract or oracle)
    mapping(address => bool) public authorizedCallers;

    /// @notice Auto-incrementing purchase counter (next ID to assign)
    uint256 public nextPurchaseId;

    /// @notice Per-user escrowed USDC balance
    mapping(address => uint256) public balances;

    /// @notice Purchase records keyed by purchaseId
    mapping(uint256 => Purchase) internal _purchases;

    /// @notice Mapping from signalId to the list of purchaseIds for that signal
    mapping(uint256 => uint256[]) internal _purchasesBySignal;

    /// @notice Fee pool: genius -> idiot -> cycle -> total USDC fees collected.
    /// @dev SC-03: The fee pool IS reduced by Tranche A (USDC refund) during negative
    ///      settlement. When damages slash genius collateral to refund the idiot, the
    ///      genius should not also claim those same fees. The Audit contract calls
    ///      reduceFeePool() after distributing Tranche A damages. The genius can claim
    ///      any remaining fees after settlement + 48h dispute window.
    mapping(address => mapping(address => mapping(uint256 => uint256))) public feePool;

    /// @notice Cumulative notional purchased per signal
    mapping(uint256 => uint256) public signalNotionalFilled;

    /// @notice Tracks whether an Idiot has already purchased a given signal (one purchase per Idiot per signal)
    mapping(uint256 => mapping(address => bool)) public hasPurchased;



    /// @notice Address authorized to pause this contract in emergencies
    address public pauser;

    // ─── v2 Storage (appended for UUPS compatibility) ───────────

    /// @notice Claimable fees per audit batch: genius -> idiot -> batchId -> amount
    /// @dev Written by Audit contract at settlement time. Replaces feePool for v2 batches.
    mapping(address => mapping(address => mapping(uint256 => uint256))) public batchClaimable;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted when an Idiot deposits USDC into escrow
    event Deposited(address indexed user, uint256 amount);

    /// @notice Emitted when an Idiot withdraws USDC from escrow
    event Withdrawn(address indexed user, uint256 amount);

    /// @notice Emitted when a signal is purchased
    event SignalPurchased(
        uint256 indexed signalId,
        address indexed buyer,
        uint256 purchaseId,
        uint256 notional,
        uint256 feePaid,
        uint256 creditUsed,
        uint256 usdcPaid
    );

    /// @notice Emitted when a Genius claims earned fees from a settled cycle
    event FeesClaimed(address indexed genius, address indexed idiot, uint256 cycle, uint256 amount);

    /// @notice Emitted when a purchase outcome is updated
    event OutcomeUpdated(uint256 indexed purchaseId, Outcome outcome);

    /// @notice Emitted when a protocol contract address is updated
    event ContractAddressUpdated(string name, address addr);

    /// @notice Emitted when an authorized caller is set
    event AuthorizedCallerSet(address indexed caller, bool authorized);

    /// @notice Emitted when the pauser address is updated
    event PauserUpdated(address indexed newPauser);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAmount();
    error InsufficientBalance(uint256 available, uint256 requested);
    error SignalNotActive(uint256 signalId);
    error SignalExpired(uint256 signalId);
    error InsufficientCollateral(uint256 signalId);
    error ContractNotSet(string name);
    error Unauthorized();
    error ZeroAddress();
    error NotionalTooSmall(uint256 provided, uint256 min);
    error NotionalTooLarge(uint256 provided, uint256 max);
    error OddsOutOfRange(uint256 odds);
    error NotionalExceedsSignalMax(uint256 notional, uint256 maxNotional);
    error CycleNotSettled(address genius, address idiot, uint256 cycle);
    error NoFeesToClaim(address genius, address idiot, uint256 cycle);
    error ClaimTooEarly(address genius, address idiot, uint256 cycle, uint256 claimableAt);
    error AlreadyPurchased(uint256 signalId, address idiot);
    error PurchaseNotFound(uint256 purchaseId);
    error OutcomeAlreadySet(uint256 purchaseId, Outcome current);
    error InvalidOutcome(Outcome outcome);
    error NotPauserOrOwner(address caller);
    error LengthMismatch();
    error BatchTooLarge(uint256 provided, uint256 max);
    error CannotRescueUsdc();
    /// @notice Minimum notional per purchase (1 USDC in 6 decimals — prevents dust griefing)
    uint256 public constant MIN_NOTIONAL = 1e6;

    /// @notice Maximum notional per purchase (1 million USDC in 6 decimals)
    uint256 public constant MAX_NOTIONAL = 1e12;

    /// @notice Odds precision: 1e6 = 1.0x decimal
    uint256 public constant ODDS_PRECISION = 1e6;

    /// @notice Minimum odds: 1.01x (prevents sub-1.0 odds that break circuit math)
    uint256 public constant MIN_ODDS = 1_010_000;

    /// @notice Maximum odds: 1000x (prevents unreasonable values)
    uint256 public constant MAX_ODDS = 1_000_000_000;

    /// @notice Delay before genius can claim fees after settlement (48 hours).
    /// @dev This is a monitoring delay, not an on-chain dispute mechanism. It gives
    ///      the protocol team time to detect and respond to incorrect settlements
    ///      via forceSettle through the TimelockController before fees are released.
    uint256 public constant FEE_CLAIM_DELAY = 48 hours;

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the Escrow contract (replaces constructor for proxy pattern)
    /// @param _usdc Address of the USDC token on Base
    /// @param _owner Initial owner of the contract
    function initialize(address _usdc, address _owner) public initializer {
        if (_usdc == address(0)) revert ZeroAddress();
        __Ownable_init(_owner);
        __Pausable_init();
        usdc = IERC20(_usdc);
    }

    // -------------------------------------------------------------------------
    // Admin — set protocol contract addresses
    // -------------------------------------------------------------------------

    /// @notice Set the SignalCommitment contract address
    /// @param _addr SignalCommitment contract address
    function setSignalCommitment(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        signalCommitment = ISignalCommitment(_addr);
        emit ContractAddressUpdated("SignalCommitment", _addr);
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

    /// @notice Set the Audit contract address (authorised to call refund)
    /// @param _addr Audit contract address
    function setAuditContract(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        auditContract = _addr;
        emit ContractAddressUpdated("Audit", _addr);
    }

    /// @notice Authorize or deauthorize a caller for setOutcome
    /// @dev DESIGN NOTE (CF-12): This mapping is intentionally NOT populated in Deploy.s.sol.
    ///      Authorized callers for setOutcome are external services (oracle adapters, validator
    ///      bridges) whose addresses are not known at deploy time. They are configured
    ///      post-deployment via TimelockController governance proposals. The voted settlement
    ///      path (OutcomeVoting -> Audit) does not use setOutcome and works immediately.
    /// @param caller The address to authorize or deauthorize
    /// @param _authorized Whether the address should be authorized
    function setAuthorizedCaller(address caller, bool _authorized) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = _authorized;
        emit AuthorizedCallerSet(caller, _authorized);
    }

    /// @notice Update the outcome of a purchase. Called by authorized contracts (e.g. oracle/validator).
    ///         Writes to both Escrow and Account to maintain a single source of truth.
    /// @param purchaseId The purchase to update
    /// @param outcome The new outcome (must not be Pending)
    function setOutcome(uint256 purchaseId, Outcome outcome) external whenNotPaused nonReentrant {
        if (!authorizedCallers[msg.sender]) revert Unauthorized();
        if (outcome == Outcome.Pending) revert InvalidOutcome(outcome);
        if (purchaseId >= nextPurchaseId) revert PurchaseNotFound(purchaseId);
        Outcome current = _purchases[purchaseId].outcome;
        if (current != Outcome.Pending) revert OutcomeAlreadySet(purchaseId, current);
        _purchases[purchaseId].outcome = outcome;

        // Sync to Account (canonical source for settlement reads) if not already recorded
        if (address(account) != address(0) && address(signalCommitment) != address(0)) {
            Purchase memory p = _purchases[purchaseId];
            Signal memory sig = signalCommitment.getSignal(p.signalId);
            Outcome acctOutcome = account.getOutcome(sig.genius, p.idiot, purchaseId);
            if (acctOutcome == Outcome.Pending) {
                account.recordOutcome(sig.genius, p.idiot, purchaseId, outcome);
            }
        }

        emit OutcomeUpdated(purchaseId, outcome);
    }

    // -------------------------------------------------------------------------
    // Idiot operations
    // -------------------------------------------------------------------------

    /// @notice Deposit USDC into escrow. Caller must have approved this contract.
    /// @param amount Amount of USDC to deposit (6 decimals)
    function deposit(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        balances[msg.sender] += amount;

        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw unused USDC from escrow
    /// @param amount Amount of USDC to withdraw (6 decimals)
    function withdraw(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balances[msg.sender];
        if (bal < amount) revert InsufficientBalance(bal, amount);

        balances[msg.sender] = bal - amount;
        usdc.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Purchase a signal. Credits offset the fee first; remainder is paid from
    ///         the buyer's escrowed USDC balance. Locks Genius collateral and records the
    ///         purchase across all protocol contracts.
    ///
    /// @dev DESIGN NOTE (CF-07): Odds are buyer-chosen, not genius-specified. This is
    ///      intentional per the whitepaper's unbundling model: the buyer executes at their
    ///      own sportsbook where the available odds may differ from the genius's quoted
    ///      line. The Quality Score formula (Section 6) is asymmetric by design: favorable
    ///      outcomes credit +notional*(odds-1) reflecting actual value delivered, while
    ///      unfavorable outcomes debit -notional*SLA% as a fixed penalty independent of
    ///      odds. Self-purchase prevention (genius != buyer), bounded odds range
    ///      (1.01x-1000x), one-purchase-per-idiot-per-signal, and collateral requirements
    ///      all limit manipulation. The SLA multiplier, set by the genius, controls downside
    ///      exposure regardless of buyer-chosen odds.
    ///
    /// @param signalId On-chain signal identifier
    /// @param notional Reference amount chosen by the buyer (6-decimal USDC scale)
    /// @param odds Decimal odds scaled by 1e6 (e.g. 1_910_000 = 1.91x = -110 American)
    /// @return purchaseId The auto-incremented purchase identifier
    function purchase(uint256 signalId, uint256 notional, uint256 odds)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 purchaseId)
    {
        // --- Validate inputs ---
        if (notional == 0) revert ZeroAmount();
        if (notional < MIN_NOTIONAL) revert NotionalTooSmall(notional, MIN_NOTIONAL);
        if (notional > MAX_NOTIONAL) revert NotionalTooLarge(notional, MAX_NOTIONAL);
        if (odds < MIN_ODDS || odds > MAX_ODDS) revert OddsOutOfRange(odds);

        // --- Validate dependencies are wired up ---
        if (address(signalCommitment) == address(0)) revert ContractNotSet("SignalCommitment");
        if (address(collateral) == address(0)) revert ContractNotSet("Collateral");
        if (address(creditLedger) == address(0)) revert ContractNotSet("CreditLedger");
        if (address(account) == address(0)) revert ContractNotSet("Account");

        // --- Load & validate signal ---
        Signal memory sig = signalCommitment.getSignal(signalId);
        if (sig.status != SignalStatus.Active) revert SignalNotActive(signalId);
        if (block.timestamp >= sig.expiresAt) revert SignalExpired(signalId);
        if (hasPurchased[signalId][msg.sender]) revert AlreadyPurchased(signalId, msg.sender);
        if (sig.minNotional > 0 && notional < sig.minNotional) {
            revert NotionalTooSmall(notional, sig.minNotional);
        }
        if (sig.maxNotional > 0) {
            uint256 remaining = sig.maxNotional > signalNotionalFilled[signalId]
                ? sig.maxNotional - signalNotionalFilled[signalId]
                : 0;
            if (notional > remaining) {
                revert NotionalExceedsSignalMax(notional, remaining);
            }
        }

        // --- Calculate fee ---
        // fee = notional * maxPriceBps / 10_000
        uint256 fee = (notional * sig.maxPriceBps) / 10_000;

        // --- Credit / USDC split ---
        uint256 creditBalance = creditLedger.balanceOf(msg.sender);
        uint256 creditUsed = fee < creditBalance ? fee : creditBalance;
        uint256 usdcPaid = fee - creditUsed;

        // --- Check buyer's escrowed USDC before any state changes ---
        uint256 buyerBal = balances[msg.sender];
        if (buyerBal < usdcPaid) revert InsufficientBalance(buyerBal, usdcPaid);

        // --- Effects: all state changes first (CEI pattern) ---
        signalNotionalFilled[signalId] += notional;
        balances[msg.sender] = buyerBal - usdcPaid;

        purchaseId = nextPurchaseId;
        nextPurchaseId += 1;
        _purchases[purchaseId] = Purchase({
            idiot: msg.sender,
            signalId: signalId,
            notional: notional,
            feePaid: fee,
            creditUsed: creditUsed,
            usdcPaid: usdcPaid,
            odds: odds,
            outcome: Outcome(0), // Pending
            purchasedAt: block.timestamp
        });

        _purchasesBySignal[signalId].push(purchaseId);
        hasPurchased[signalId][msg.sender] = true;

        // v2: No feePool write. Fees are computed at settlement time from Purchase records.
        // The feePool mapping is kept for storage compatibility but no longer written to.

        // --- Interactions: external calls after state is finalized ---
        if (creditUsed > 0) {
            creditLedger.burn(msg.sender, creditUsed);
        }

        uint256 protocolFeeLock = (notional * 50) / 10_000; // 0.5% protocol fee
        uint256 lockAmount = (notional * sig.slaMultiplierBps) / 10_000 + protocolFeeLock;
        collateral.lock(signalId, sig.genius, lockAmount);

        account.recordPurchase(sig.genius, msg.sender, purchaseId);

        emit SignalPurchased(signalId, msg.sender, purchaseId, notional, fee, creditUsed, usdcPaid);
    }

    // -------------------------------------------------------------------------
    // Genius fee claim
    // -------------------------------------------------------------------------

    /// @notice Record claimable fees for a settled audit batch. Called by Audit contract.
    /// @param genius The Genius address
    /// @param idiot The Idiot address
    /// @param batchId The audit batch ID
    /// @param amount The net claimable amount (total fees minus Tranche A damages)
    function recordBatchClaimable(address genius, address idiot, uint256 batchId, uint256 amount) external whenNotPaused {
        if (msg.sender != auditContract) revert Unauthorized();
        batchClaimable[genius][idiot][batchId] = amount;
    }

    /// @notice Claim earned fees from a settled audit batch. Only the Genius can claim.
    /// @param idiot The Idiot address for the pair
    /// @param batchId The settled audit batch to claim from
    function claimFees(address idiot, uint256 batchId) external whenNotPaused nonReentrant {
        if (auditContract == address(0)) revert ContractNotSet("Audit");

        (, , , , uint256 settledAt) = IAudit(auditContract).auditResults(msg.sender, idiot, batchId);
        if (settledAt == 0) revert CycleNotSettled(msg.sender, idiot, batchId);

        uint256 claimableAt = settledAt + FEE_CLAIM_DELAY;
        if (block.timestamp < claimableAt) {
            revert ClaimTooEarly(msg.sender, idiot, batchId, claimableAt);
        }

        uint256 amount = batchClaimable[msg.sender][idiot][batchId];
        if (amount == 0) revert NoFeesToClaim(msg.sender, idiot, batchId);

        batchClaimable[msg.sender][idiot][batchId] = 0;
        usdc.safeTransfer(msg.sender, amount);

        emit FeesClaimed(msg.sender, idiot, batchId, amount);
    }

    /// @notice Batch claim fees from multiple settled idiot-batch pairs.
    /// @param idiots Array of Idiot addresses
    /// @param batchIds Array of batch IDs (must match idiots length)
    function claimFeesBatch(address[] calldata idiots, uint256[] calldata batchIds) external whenNotPaused nonReentrant {
        if (idiots.length > 100) revert BatchTooLarge(idiots.length, 100);
        if (auditContract == address(0)) revert ContractNotSet("Audit");
        if (idiots.length != batchIds.length) revert LengthMismatch();

        uint256 total;
        for (uint256 i; i < idiots.length; ++i) {
            (, , , , uint256 settledAt) = IAudit(auditContract).auditResults(msg.sender, idiots[i], batchIds[i]);
            if (settledAt == 0) revert CycleNotSettled(msg.sender, idiots[i], batchIds[i]);

            uint256 claimableAt = settledAt + FEE_CLAIM_DELAY;
            if (block.timestamp < claimableAt) {
                revert ClaimTooEarly(msg.sender, idiots[i], batchIds[i], claimableAt);
            }

            uint256 amount = batchClaimable[msg.sender][idiots[i]][batchIds[i]];
            if (amount > 0) {
                batchClaimable[msg.sender][idiots[i]][batchIds[i]] = 0;
                total += amount;
                emit FeesClaimed(msg.sender, idiots[i], batchIds[i], amount);
            }
        }

        if (total == 0) revert ZeroAmount();
        usdc.safeTransfer(msg.sender, total);
    }

    // -------------------------------------------------------------------------
    // View functions
    // -------------------------------------------------------------------------

    /// @notice Returns the escrowed USDC balance for a user
    /// @param user Address to query
    /// @return balance The user's escrowed USDC balance
    function getBalance(address user) external view returns (uint256) {
        return balances[user];
    }

    /// @notice Returns a Purchase record by its ID
    /// @param purchaseId The purchase identifier
    /// @return The Purchase struct
    function getPurchase(uint256 purchaseId) external view returns (Purchase memory) {
        return _purchases[purchaseId];
    }

    /// @notice Returns all purchase IDs associated with a signal
    /// @param signalId The signal identifier
    /// @return Array of purchaseIds for this signal
    function getPurchasesBySignal(uint256 signalId) external view returns (uint256[] memory) {
        return _purchasesBySignal[signalId];
    }

    /// @notice Returns the cumulative notional purchased for a signal
    /// @param signalId The signal identifier
    /// @return The total notional amount filled so far
    function getSignalNotionalFilled(uint256 signalId) external view returns (uint256) {
        return signalNotionalFilled[signalId];
    }

    /// @notice Check if a signal can be purchased (sufficient collateral available)
    /// @param signalId The signal to check
    /// @param notional The intended notional amount
    /// @return canBuy True if the Genius has sufficient free collateral
    /// @return reason Human-readable reason if canBuy is false
    function canPurchase(uint256 signalId, uint256 notional) external view returns (bool canBuy, string memory reason) {
        if (address(signalCommitment) == address(0)) return (false, "SignalCommitment not set");
        Signal memory sig = signalCommitment.getSignal(signalId);
        if (sig.status != SignalStatus.Active) return (false, "Signal not active");
        if (block.timestamp >= sig.expiresAt) return (false, "Signal expired");
        if (sig.minNotional > 0 && notional < sig.minNotional) return (false, "Below minimum notional");
        if (sig.maxNotional > 0) {
            uint256 remaining = sig.maxNotional > signalNotionalFilled[signalId]
                ? sig.maxNotional - signalNotionalFilled[signalId]
                : 0;
            if (notional > remaining) return (false, "Notional exceeds remaining capacity");
        }
        if (notional < MIN_NOTIONAL) return (false, "Notional too small");
        if (notional > MAX_NOTIONAL) return (false, "Notional too large");
        // Check genius has enough free collateral for SLA lock + protocol fee lock
        if (address(collateral) != address(0)) {
            uint256 slaLock = (notional * sig.slaMultiplierBps) / 10_000;
            uint256 protocolFeeLock = (notional * 50) / 10_000;
            uint256 lockNeeded = slaLock + protocolFeeLock;
            uint256 available = collateral.getAvailable(sig.genius);
            if (available < lockNeeded) return (false, "Insufficient genius collateral");
        }
        return (true, "");
    }

    // -------------------------------------------------------------------------
    // Token rescue
    // -------------------------------------------------------------------------

    /// @notice Rescue tokens accidentally sent to this contract. Cannot rescue USDC.
    /// @param token Address of the ERC20 token to rescue
    /// @param amount Amount of tokens to rescue
    function rescueToken(address token, uint256 amount) external onlyOwner {
        if (token == address(usdc)) revert CannotRescueUsdc();
        IERC20(token).safeTransfer(owner(), amount);
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

    /// @notice Pause deposits, withdrawals, and purchases
    function pause() external {
        if (msg.sender != pauser && msg.sender != owner()) revert NotPauserOrOwner(msg.sender);
        _pause();
    }

    /// @notice Unpause deposits, withdrawals, and purchases
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Owner can authorize upgrades only when paused (active USDC may be held)
    function _authorizeUpgrade(address) internal override onlyOwner whenPaused {}

    /// @dev Disabled to prevent accidental permanent bricking of upgradeable proxy.
    function renounceOwnership() public pure override {
        revert("disabled");
    }

    /// @dev Reserved storage gap for future upgrades. (was 35, -1 for batchClaimable = 34)
    uint256[34] private __gap;
}
