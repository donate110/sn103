// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title Collateral
/// @notice Holds Genius USDC collateral to cover worst-case damages on active signals.
/// Required collateral = sum of (notional * slaMultiplierBps / 10000) for all active signal purchases.
/// If a Genius's collateral drops below the locked minimum, open signals can be auto-cancelled.
contract Collateral is Initializable, OwnableUpgradeable, PausableUpgradeable, ReentrancyGuardTransient, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    /// @notice USDC token (6 decimals)
    IERC20 public usdc;

    /// @notice Total deposited collateral per Genius
    mapping(address genius => uint256) public deposits;

    /// @notice Total locked collateral across all active signals per Genius
    mapping(address genius => uint256) public locked;

    /// @notice Locked collateral per signal per Genius
    mapping(address genius => mapping(uint256 signalId => uint256)) public signalLocks;

    /// @notice Authorized callers (Escrow, Audit contracts)
    mapping(address caller => bool) public authorized;

    /// @notice Address authorized to pause this contract in emergencies
    address public pauser;

    /// @notice Withdrawal freeze counter per genius. Withdrawals are blocked when > 0.
    /// @dev Uses a counter instead of a boolean to safely handle concurrent settlements
    ///      for the same genius with different idiots (CF-07).
    mapping(address genius => uint256) public withdrawalFreezeCount;

    /// @dev Emitted when a Genius deposits collateral
    event Deposited(address indexed genius, uint256 amount);

    /// @dev Emitted when a Genius withdraws excess collateral
    event Withdrawn(address indexed genius, uint256 amount);

    /// @dev Emitted when collateral is locked for a signal purchase
    event Locked(uint256 indexed signalId, address indexed genius, uint256 amount);

    /// @dev Emitted when collateral is released after settlement or voiding
    event Released(uint256 indexed signalId, address indexed genius, uint256 amount);

    /// @dev Emitted when collateral is slashed due to negative Quality Score
    event Slashed(address indexed genius, uint256 amount, address indexed recipient);

    /// @dev Emitted when an authorized caller is added or removed
    event AuthorizedUpdated(address indexed caller, bool status);

    /// @notice Emitted when the pauser address is updated
    event PauserUpdated(address indexed newPauser);

    /// @notice Emitted when withdrawal freeze status changes
    event WithdrawalFreezeUpdated(address indexed genius, bool frozen);

    /// @dev Emitted when release() clamps locked to prevent underflow (accounting drift after slash)
    event LockedClampedOnRelease(address indexed genius, uint256 signalId, uint256 releaseAmount, uint256 lockedBefore);

    error Unauthorized();
    error WithdrawalsFrozen(address genius);
    error NotPauserOrOwner(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientFreeCollateral(uint256 available, uint256 required);
    error InsufficientSignalLock(uint256 locked, uint256 requested);
    error WithdrawalExceedsAvailable(uint256 available, uint256 requested);
    error CannotRescueUsdc();

    modifier onlyAuthorized() {
        if (!authorized[msg.sender]) revert Unauthorized();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the Collateral contract (replaces constructor for proxy pattern)
    /// @param _usdc Address of the USDC token contract
    /// @param _owner Address that will own this contract and manage authorized callers
    function initialize(address _usdc, address _owner) public initializer {
        if (_usdc == address(0)) revert ZeroAddress();
        __Ownable_init(_owner);
        __Pausable_init();
        usdc = IERC20(_usdc);
    }

    /// @notice Add or remove an authorized caller (Escrow or Audit contract)
    /// @param caller The address to authorize or deauthorize
    /// @param status True to authorize, false to revoke
    function setAuthorized(address caller, bool status) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorized[caller] = status;
        emit AuthorizedUpdated(caller, status);
    }

    /// @notice Deposit USDC collateral. Caller must have approved this contract.
    /// @param amount Amount of USDC to deposit (6 decimals)
    function deposit(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        deposits[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw excess collateral not currently locked
    /// @param amount Amount of USDC to withdraw (6 decimals)
    function withdraw(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (withdrawalFreezeCount[msg.sender] > 0) revert WithdrawalsFrozen(msg.sender);
        uint256 dep = deposits[msg.sender];
        uint256 lck = locked[msg.sender];
        uint256 available = dep > lck ? dep - lck : 0;
        if (amount > available) {
            revert WithdrawalExceedsAvailable(available, amount);
        }
        deposits[msg.sender] -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Lock collateral for a signal purchase. Called by Escrow.
    /// @param signalId The signal being purchased
    /// @param genius The Genius whose collateral is being locked
    /// @param amount Amount of USDC to lock (6 decimals)
    function lock(uint256 signalId, address genius, uint256 amount) external onlyAuthorized {
        if (amount == 0) revert ZeroAmount();
        uint256 dep = deposits[genius];
        uint256 lck = locked[genius];
        uint256 available = dep > lck ? dep - lck : 0;
        if (amount > available) {
            revert InsufficientFreeCollateral(available, amount);
        }
        locked[genius] += amount;
        signalLocks[genius][signalId] += amount;
        emit Locked(signalId, genius, amount);
    }

    /// @notice Release locked collateral after settlement or voiding. Called by Escrow/Audit.
    /// @param signalId The signal whose lock is being released
    /// @param genius The Genius whose collateral is being released
    /// @param amount Amount of USDC to release (6 decimals)
    function release(uint256 signalId, address genius, uint256 amount) external onlyAuthorized {
        if (amount == 0) revert ZeroAmount();
        uint256 signalLock = signalLocks[genius][signalId];
        if (amount > signalLock) {
            revert InsufficientSignalLock(signalLock, amount);
        }
        signalLocks[genius][signalId] -= amount;
        if (amount > locked[genius]) {
            emit LockedClampedOnRelease(genius, signalId, amount, locked[genius]);
            locked[genius] = 0;
        } else {
            locked[genius] -= amount;
        }
        emit Released(signalId, genius, amount);
    }

    /// @notice Slash a Genius's collateral and transfer to a recipient. Called by Audit.
    /// @dev Signal locks must be released BEFORE calling slash() to maintain accounting
    ///      invariants. The Audit contract enforces this ordering in _settleCommon().
    ///      Individual signalLocks entries are NOT adjusted here; they become stale after
    ///      slash if not released first. This is by design since settlement always releases
    ///      locks before slashing (see CF-02/CF-04).
    /// @param genius The Genius being slashed
    /// @param amount Amount of USDC to slash (6 decimals)
    /// @param recipient Address to receive the slashed USDC
    /// @return slashAmount The actual amount slashed (may be less if deposits insufficient)
    function slash(address genius, uint256 amount, address recipient) external onlyAuthorized nonReentrant returns (uint256 slashAmount) {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        uint256 available = deposits[genius];
        slashAmount = amount > available ? available : amount;
        deposits[genius] -= slashAmount;
        // CF-03: Maintain deposits >= locked invariant after slash.
        // If slash reduced deposits below locked, clamp locked down to prevent
        // getAvailable() returning 0 and blocking subsequent lock/withdraw operations.
        if (locked[genius] > deposits[genius]) {
            locked[genius] = deposits[genius];
        }
        usdc.safeTransfer(recipient, slashAmount);
        emit Slashed(genius, slashAmount, recipient);
    }

    /// @notice Get total deposited collateral for a Genius
    function getDeposit(address genius) external view returns (uint256) {
        return deposits[genius];
    }

    /// @notice Get total locked collateral for a Genius
    function getLocked(address genius) external view returns (uint256) {
        return locked[genius];
    }

    /// @notice Get available (free) collateral for a Genius
    function getAvailable(address genius) external view returns (uint256) {
        uint256 dep = deposits[genius];
        uint256 lck = locked[genius];
        return dep > lck ? dep - lck : 0;
    }

    /// @notice Get collateral locked for a specific signal
    function getSignalLock(address genius, uint256 signalId) external view returns (uint256) {
        return signalLocks[genius][signalId];
    }

    /// @notice Freeze withdrawals for a genius (e.g. during pending audit settlement)
    /// @param genius The genius whose withdrawals to freeze
    function freezeWithdrawals(address genius) external onlyAuthorized {
        withdrawalFreezeCount[genius]++;
        emit WithdrawalFreezeUpdated(genius, true);
    }

    /// @notice Unfreeze withdrawals for a genius
    /// @param genius The genius whose withdrawals to unfreeze
    function unfreezeWithdrawals(address genius) external onlyAuthorized {
        if (withdrawalFreezeCount[genius] > 0) {
            withdrawalFreezeCount[genius]--;
        }
        emit WithdrawalFreezeUpdated(genius, withdrawalFreezeCount[genius] == 0);
    }

    /// @notice Emergency reset of freeze counter. Owner-only for recovery scenarios.
    /// @param genius The genius whose freeze counter to reset
    function emergencyUnfreeze(address genius) external onlyOwner {
        withdrawalFreezeCount[genius] = 0;
        emit WithdrawalFreezeUpdated(genius, false);
    }

    /// @notice Rescue tokens accidentally sent to this contract. Cannot rescue USDC.
    /// @param token Address of the ERC20 token to rescue
    /// @param amount Amount of tokens to rescue
    function rescueToken(address token, uint256 amount) external onlyOwner {
        if (token == address(usdc)) revert CannotRescueUsdc();
        IERC20(token).safeTransfer(owner(), amount);
    }

    /// @notice Set the emergency pauser address
    /// @param _pauser New pauser address (address(0) to disable)
    function setPauser(address _pauser) external onlyOwner {
        pauser = _pauser;
        emit PauserUpdated(_pauser);
    }

    /// @notice Pause deposits and withdrawals
    function pause() external {
        if (msg.sender != pauser && msg.sender != owner()) revert NotPauserOrOwner(msg.sender);
        _pause();
    }

    /// @notice Unpause deposits and withdrawals
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Owner can authorize upgrades only when paused (active USDC may be locked)
    function _authorizeUpgrade(address) internal override onlyOwner whenPaused {}

    /// @dev Disabled to prevent accidental permanent bricking of upgradeable proxy.
    function renounceOwnership() public pure override {
        revert("disabled");
    }

    /// @dev Reserved storage gap for future upgrades.
    uint256[43] private __gap;
}
