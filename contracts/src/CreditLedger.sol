// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title CreditLedger
/// @notice Non-transferable, non-cashable Djinn Credits used as discounts on future signal purchases.
///         Credits are minted as Tranche B during negative audit settlement (see whitepaper Section 7)
///         and burned by the Escrow contract when an Idiot uses them to offset a purchase fee.
/// @dev This is intentionally NOT an ERC20. Credits cannot be transferred, approved, or redeemed for cash.
contract CreditLedger is Initializable, OwnableUpgradeable, PausableUpgradeable, UUPSUpgradeable {
    // ─── Storage
    // ────────────────────────────────────────────────────────

    /// @dev address => credit balance
    mapping(address => uint256) private _balances;

    /// @notice Total credits outstanding across all addresses
    uint256 private _totalSupply;

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

    /// @notice Minting would exceed the maximum supply cap
    error MaxSupplyExceeded(uint256 totalSupply, uint256 amount, uint256 maxSupply);

    /// @notice Address must not be zero
    error ZeroAddress();

    /// @notice Maximum total supply of credits (1 billion USDC-equivalent, 6 decimals)
    uint256 public constant MAX_SUPPLY = 1_000_000_000e6;

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
        __Pausable_init();
    }

    // ─── External Functions
    // ─────────────────────────────────────────────

    /// @notice Mint credits to an address
    /// @dev Only callable by authorized contracts (e.g. Audit during negative settlement).
    /// @param to The address receiving credits
    /// @param amount The number of credits to mint
    function mint(address to, uint256 amount) external onlyAuthorized whenNotPaused {
        if (to == address(0)) revert MintToZeroAddress();
        if (amount == 0) revert MintAmountZero();
        if (_totalSupply + amount > MAX_SUPPLY) revert MaxSupplyExceeded(_totalSupply, amount, MAX_SUPPLY);

        _balances[to] += amount;
        _totalSupply += amount;

        emit CreditsMinted(to, amount);
    }

    /// @notice Burn credits from an address
    /// @dev Only callable by authorized contracts (e.g. Escrow when credits offset a purchase fee).
    /// @param from The address whose credits are being burned
    /// @param amount The number of credits to burn
    function burn(address from, uint256 amount) external onlyAuthorized whenNotPaused {
        if (amount == 0) revert BurnAmountZero();

        uint256 balance = _balances[from];
        if (balance < amount) {
            revert InsufficientCreditBalance(from, balance, amount);
        }

        _balances[from] = balance - amount;
        _totalSupply -= amount;

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

    /// @notice Returns the total credits outstanding across all addresses
    /// @return supply Total credits minted minus burned
    function totalSupply() external view returns (uint256 supply) {
        return _totalSupply;
    }

    // ─── Emergency Pause
    // ─────────────────────────────────────────────────────

    /// @notice Address authorized to pause this contract in emergencies
    address public pauser;

    /// @notice Caller is not the pauser or the owner
    error NotPauserOrOwner(address caller);

    /// @notice Emitted when the pauser address is updated
    event PauserUpdated(address indexed newPauser);

    /// @notice Set the emergency pauser address
    /// @param _pauser New pauser address (address(0) to disable)
    function setPauser(address _pauser) external onlyOwner {
        pauser = _pauser;
        emit PauserUpdated(_pauser);
    }

    /// @notice Pause minting and burning
    function pause() external {
        if (msg.sender != pauser && msg.sender != owner()) revert NotPauserOrOwner(msg.sender);
        _pause();
    }

    /// @notice Unpause minting and burning
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── UUPS
    // ─────────────────────────────────────────────────────

    /// @dev Owner can authorize upgrades only when paused.
    ///      CreditLedger tracks virtual balances; pausing prevents state
    ///      changes during upgrade.
    function _authorizeUpgrade(address) internal override onlyOwner whenPaused {}

    /// @dev Disabled to prevent accidental permanent bricking of upgradeable proxy.
    function renounceOwnership() public pure override {
        revert("disabled");
    }

    /// @dev Reserved storage gap for future upgrades.
    uint256[46] private __gap;
}
