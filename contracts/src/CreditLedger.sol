// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title CreditLedger
/// @notice Non-transferable, non-cashable Djinn Credits used as discounts on future signal purchases.
///         Credits are minted as Tranche B during negative audit settlement (see whitepaper Section 7)
///         and burned by the Escrow contract when an Idiot uses them to offset a purchase fee.
/// @dev This is intentionally NOT an ERC20. Credits cannot be transferred, approved, or redeemed for cash.
contract CreditLedger is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    // ─── Storage
    // ────────────────────────────────────────────────────────

    /// @dev address => credit balance
    mapping(address => uint256) private _balances;

    /// @dev address => whether it can call mint/burn
    mapping(address => bool) public authorizedCallers;

    // ─── Events
    // ─────────────────────────────────────────────────────────

    /// @notice Emitted when credits are minted to an address
    event CreditsMinted(address indexed to, uint256 amount);

    /// @notice Emitted when credits are burned from an address
    event CreditsBurned(address indexed from, uint256 amount);

    /// @notice Emitted when an authorized caller is added or removed
    event AuthorizedCallerSet(address indexed caller, bool authorized);

    // ─── Errors
    // ─────────────────────────────────────────────────────────

    /// @notice Caller is not authorized to mint or burn credits
    error CallerNotAuthorized(address caller);

    /// @notice Cannot mint zero credits
    error MintAmountZero();

    /// @notice Cannot burn zero credits
    error BurnAmountZero();

    /// @notice Burn amount exceeds the address's credit balance
    error InsufficientCreditBalance(address from, uint256 balance, uint256 amount);

    /// @notice Cannot mint to the zero address
    error MintToZeroAddress();

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

    /// @notice Initializes the CreditLedger contract (replaces constructor for proxy pattern)
    /// @param initialOwner Address that will own this contract and manage authorized callers
    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
    }

    // ─── External Functions
    // ─────────────────────────────────────────────

    /// @notice Mint credits to an address
    /// @dev Only callable by authorized contracts (e.g. Audit during negative settlement).
    /// @param to The address receiving credits
    /// @param amount The number of credits to mint
    function mint(address to, uint256 amount) external onlyAuthorized {
        if (to == address(0)) revert MintToZeroAddress();
        if (amount == 0) revert MintAmountZero();

        _balances[to] += amount;

        emit CreditsMinted(to, amount);
    }

    /// @notice Burn credits from an address
    /// @dev Only callable by authorized contracts (e.g. Escrow when credits offset a purchase fee).
    /// @param from The address whose credits are being burned
    /// @param amount The number of credits to burn
    function burn(address from, uint256 amount) external onlyAuthorized {
        if (amount == 0) revert BurnAmountZero();

        uint256 balance = _balances[from];
        if (balance < amount) {
            revert InsufficientCreditBalance(from, balance, amount);
        }

        unchecked {
            _balances[from] = balance - amount;
        }

        emit CreditsBurned(from, amount);
    }

    /// @notice Authorize or deauthorize a contract to call mint/burn
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

    /// @notice Returns the credit balance of an address
    /// @param account The address to query
    /// @return balance The number of credits held by the address
    function balanceOf(address account) external view returns (uint256 balance) {
        return _balances[account];
    }

    // ─── UUPS
    // ─────────────────────────────────────────────────────

    /// @dev Only the owner (TimelockController) can authorize upgrades.
    ///      CreditLedger tracks virtual balances — no USDC held directly.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @dev Reserved storage gap for future upgrades.
    uint256[48] private __gap;
}
