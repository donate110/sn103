// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {SignalCommitment} from "../src/SignalCommitment.sol";
import {Escrow} from "../src/Escrow.sol";
import {Collateral} from "../src/Collateral.sol";
import {CreditLedger} from "../src/CreditLedger.sol";
import {Account as DjinnAccount} from "../src/Account.sol";
import {Signal, SignalStatus, Purchase, Outcome} from "../src/interfaces/IDjinn.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

/// @notice Malicious CreditLedger that tries to reenter Escrow.purchase via burn()
contract ReentrantCreditLedger {
    Escrow public target;
    uint256 public attackSignalId;
    bool public attacking;
    bool public reentered;

    function setTarget(address _target) external {
        target = Escrow(_target);
    }

    function setAttackSignalId(uint256 _signalId) external {
        attackSignalId = _signalId;
    }

    /// @notice Returns a positive balance so burn() gets called
    function balanceOf(address) external pure returns (uint256) {
        return 1e18; // large balance so credits are used
    }

    /// @notice When burn is called during purchase(), try to reenter
    function burn(address, uint256) external {
        if (attacking) {
            attacking = false; // prevent infinite loop
            // Try to reenter purchase() — should be blocked by nonReentrant
            try target.purchase(attackSignalId, 100e6, 1_910_000) {
                reentered = true;
            } catch {
                reentered = false;
            }
        }
    }

    function startAttack() external {
        attacking = true;
        reentered = false;
    }
}

/// @title ReentrancyTest
/// @notice Verifies that nonReentrant modifier prevents reentrancy on Escrow and Audit
contract ReentrancyTest is Test {
    MockUSDC usdc;
    SignalCommitment signalCommitment;
    Escrow escrow;
    Collateral collateral;
    CreditLedger creditLedger;
    DjinnAccount account;
    ReentrantCreditLedger maliciousLedger;

    address owner;
    address genius = address(0xBEEF);
    address idiot = address(0xCAFE);

    uint256 constant SIGNAL_ID_1 = 1;
    uint256 constant SIGNAL_ID_2 = 2;
    uint256 constant MAX_PRICE_BPS = 500;
    uint256 constant SLA_MULTIPLIER_BPS = 15_000;
    uint256 constant NOTIONAL = 1000e6;
    uint256 constant ODDS = 1_910_000;

    function setUp() public {
        owner = address(this);

        usdc = new MockUSDC();
        signalCommitment = SignalCommitment(_deployProxy(address(new SignalCommitment()), abi.encodeCall(SignalCommitment.initialize, (owner))));
        escrow = Escrow(_deployProxy(address(new Escrow()), abi.encodeCall(Escrow.initialize, (address(usdc), owner))));
        collateral = Collateral(_deployProxy(address(new Collateral()), abi.encodeCall(Collateral.initialize, (address(usdc), owner))));
        creditLedger = CreditLedger(_deployProxy(address(new CreditLedger()), abi.encodeCall(CreditLedger.initialize, (owner))));
        account = DjinnAccount(_deployProxy(address(new DjinnAccount()), abi.encodeCall(DjinnAccount.initialize, (owner))));
        maliciousLedger = new ReentrantCreditLedger();

        // Wire contracts
        escrow.setSignalCommitment(address(signalCommitment));
        escrow.setCollateral(address(collateral));
        escrow.setCreditLedger(address(creditLedger));
        escrow.setAccount(address(account));
        escrow.setAuditContract(owner);

        signalCommitment.setAuthorizedCaller(address(escrow), true);
        collateral.setAuthorized(address(escrow), true);
        creditLedger.setAuthorizedCaller(address(escrow), true);
        account.setAuthorizedCaller(address(escrow), true);
    }

    function _buildDecoyLines() internal pure returns (string[] memory) {
        string[] memory decoys = new string[](10);
        for (uint256 i; i < 10; i++) {
            decoys[i] = "decoy";
        }
        return decoys;
    }

    function _buildSportsbooks() internal pure returns (string[] memory) {
        string[] memory books = new string[](2);
        books[0] = "DraftKings";
        books[1] = "FanDuel";
        return books;
    }

    function _createSignal(uint256 signalId) internal {
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: signalId,
                encryptedBlob: hex"deadbeef",
                commitHash: keccak256("signal"),
                sport: "NFL",
                maxPriceBps: MAX_PRICE_BPS,
                slaMultiplierBps: SLA_MULTIPLIER_BPS,
                maxNotional: 10_000e6,
                minNotional: 0,
                expiresAt: block.timestamp + 1 days,
                decoyLines: _buildDecoyLines(),
                availableSportsbooks: _buildSportsbooks(),
                linesHash: bytes32(0),
                lineCount: 0,
                bpaMode: false
            })
        );
    }

    /// @notice Test that nonReentrant blocks reentry into purchase() via malicious burn()
    function test_purchase_blocksReentrancy_viaBurn() public {
        _createSignal(SIGNAL_ID_1);
        _createSignal(SIGNAL_ID_2);

        // Deposit collateral for genius
        uint256 collateralNeeded = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000 + (NOTIONAL * 50) / 10_000;
        usdc.mint(genius, collateralNeeded * 2);
        vm.startPrank(genius);
        usdc.approve(address(collateral), collateralNeeded * 2);
        collateral.deposit(collateralNeeded * 2);
        vm.stopPrank();

        // Deposit escrow for idiot (no fee needed if credits cover it)
        usdc.mint(idiot, 500e6);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), 500e6);
        escrow.deposit(500e6);
        vm.stopPrank();

        // Swap in malicious credit ledger that reenters via burn()
        maliciousLedger.setTarget(address(escrow));
        maliciousLedger.setAttackSignalId(SIGNAL_ID_2);
        escrow.setCreditLedger(address(maliciousLedger));

        // Start attack
        maliciousLedger.startAttack();

        // Purchase signal 1 — malicious burn() will try to reenter purchase(SIGNAL_ID_2)
        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID_1, NOTIONAL, ODDS);

        // Verify reentrant call was blocked
        assertFalse(maliciousLedger.reentered(), "Reentrant call should have been blocked");

        // Signal 2 should NOT be purchased
        Signal memory sig2 = signalCommitment.getSignal(SIGNAL_ID_2);
        assertEq(uint8(sig2.status), uint8(SignalStatus.Active), "Signal 2 should still be Active");

        // Only 1 purchase should exist
        assertEq(escrow.nextPurchaseId(), 1, "Only one purchase should have succeeded");
    }

    /// @notice Test that normal purchase still works with nonReentrant modifier
    function test_purchase_normalFlow() public {
        _createSignal(SIGNAL_ID_1);

        uint256 collateralNeeded = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000 + (NOTIONAL * 50) / 10_000;
        usdc.mint(genius, collateralNeeded);
        vm.startPrank(genius);
        usdc.approve(address(collateral), collateralNeeded);
        collateral.deposit(collateralNeeded);
        vm.stopPrank();

        uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        usdc.mint(idiot, fee);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), fee);
        escrow.deposit(fee);
        vm.stopPrank();

        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(SIGNAL_ID_1, NOTIONAL, ODDS);

        assertEq(purchaseId, 0);
        Purchase memory p = escrow.getPurchase(0);
        assertEq(p.signalId, SIGNAL_ID_1);
        assertEq(p.notional, NOTIONAL);
    }

    /// @notice Verify withdraw still works normally with nonReentrant
    function test_withdraw_normalFlow() public {
        usdc.mint(idiot, 500e6);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), 500e6);
        escrow.deposit(500e6);
        escrow.withdraw(200e6);
        vm.stopPrank();

        assertEq(escrow.getBalance(idiot), 300e6);
        assertEq(usdc.balanceOf(idiot), 200e6);
    }

    /// @notice Verify deposit/withdraw still works normally with nonReentrant
    function test_depositWithdraw_normalFlow() public {
        usdc.mint(idiot, 500e6);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), 500e6);
        escrow.deposit(500e6);
        escrow.withdraw(200e6);
        vm.stopPrank();

        assertEq(escrow.getBalance(idiot), 300e6);
        assertEq(usdc.balanceOf(idiot), 200e6);
    }
}
