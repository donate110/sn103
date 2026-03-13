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

/// @title EscrowFuzzTest
/// @notice Fuzz tests for Escrow purchase fee calculation and edge cases
contract EscrowFuzzTest is Test {
    MockUSDC usdc;
    SignalCommitment signalCommitment;
    Escrow escrow;
    Collateral collateral;
    CreditLedger creditLedger;
    DjinnAccount account;

    address owner;
    address genius = address(0xBEEF);
    address idiot = address(0xCAFE);

    uint256 nextSignalId = 1;

    function setUp() public {
        owner = address(this);

        usdc = new MockUSDC();
        signalCommitment = SignalCommitment(_deployProxy(address(new SignalCommitment()), abi.encodeCall(SignalCommitment.initialize, (owner))));
        escrow = Escrow(_deployProxy(address(new Escrow()), abi.encodeCall(Escrow.initialize, (address(usdc), owner))));
        collateral = Collateral(_deployProxy(address(new Collateral()), abi.encodeCall(Collateral.initialize, (address(usdc), owner))));
        creditLedger = CreditLedger(_deployProxy(address(new CreditLedger()), abi.encodeCall(CreditLedger.initialize, (owner))));
        account = DjinnAccount(_deployProxy(address(new DjinnAccount()), abi.encodeCall(DjinnAccount.initialize, (owner))));

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

    function _buildDecoys() internal pure returns (string[] memory) {
        string[] memory d = new string[](10);
        for (uint256 i; i < 10; i++) {
            d[i] = "d";
        }
        return d;
    }

    function _buildBooks() internal pure returns (string[] memory) {
        string[] memory b = new string[](2);
        b[0] = "DK";
        b[1] = "FD";
        return b;
    }

    /// @notice Fuzz purchase with varying notional and maxPriceBps
    /// @dev Verifies: fee = notional * maxPriceBps / 10_000, credit/USDC split correct,
    ///      collateral locked = notional * slaMultiplierBps / 10_000
    function testFuzz_purchase_feeMath(uint256 notional, uint16 maxPriceBps) public {
        // Bound to realistic ranges to avoid overflow
        notional = bound(notional, 1e6, 1e12); // 1 USDC to 1M USDC (MIN_NOTIONAL = 1e6)
        maxPriceBps = uint16(bound(uint256(maxPriceBps), 1, 5000)); // 0.01% to 50%

        uint256 slaMultiplierBps = 15_000; // 150%
        uint256 odds = 1_910_000; // 1.91x

        uint256 sigId = nextSignalId++;
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: sigId,
                encryptedBlob: hex"aa",
                commitHash: keccak256(abi.encodePacked("s", sigId)),
                sport: "NFL",
                maxPriceBps: maxPriceBps,
                slaMultiplierBps: slaMultiplierBps,
                maxNotional: 0,
                minNotional: 0,
                expiresAt: block.timestamp + 1 days,
                decoyLines: _buildDecoys(),
                availableSportsbooks: _buildBooks()
            })
        );

        uint256 fee = (notional * maxPriceBps) / 10_000;
        uint256 lockAmount = (notional * slaMultiplierBps) / 10_000 + (notional * 50) / 10_000;

        // Deposit collateral
        usdc.mint(genius, lockAmount);
        vm.startPrank(genius);
        usdc.approve(address(collateral), lockAmount);
        collateral.deposit(lockAmount);
        vm.stopPrank();

        // Deposit escrow for idiot
        usdc.mint(idiot, fee);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), fee);
        if (fee > 0) {
            escrow.deposit(fee);
        }
        vm.stopPrank();

        // Purchase
        if (lockAmount == 0) {
            // Zero lock amount reverts with ZeroAmount in Collateral.lock
            vm.expectRevert(Collateral.ZeroAmount.selector);
            vm.prank(idiot);
            escrow.purchase(sigId, notional, odds);
            return;
        }

        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(sigId, notional, odds);

        // Verify purchase record
        Purchase memory p = escrow.getPurchase(purchaseId);
        assertEq(p.notional, notional, "notional mismatch");
        assertEq(p.feePaid, fee, "feePaid mismatch");
        assertEq(p.usdcPaid, fee, "usdcPaid mismatch (no credits)");
        assertEq(p.creditUsed, 0, "creditUsed should be 0");
        assertEq(p.odds, odds, "odds mismatch");

        // Verify escrow balance deducted
        assertEq(escrow.getBalance(idiot), 0, "idiot balance should be 0");

        // Verify collateral locked
        assertEq(collateral.getSignalLock(genius, sigId), lockAmount, "signal lock mismatch");
    }

    /// @notice Fuzz purchase with credits offsetting fees
    function testFuzz_purchase_creditOffset(uint256 notional, uint256 creditAmount) public {
        notional = bound(notional, 1e6, 1e12); // at least 1 USDC
        uint256 maxPriceBps = 500;
        uint256 slaMultiplierBps = 15_000;
        uint256 odds = 1_910_000;

        uint256 fee = (notional * maxPriceBps) / 10_000;
        creditAmount = bound(creditAmount, 0, fee * 2); // 0 to 2x the fee

        uint256 sigId = nextSignalId++;
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: sigId,
                encryptedBlob: hex"bb",
                commitHash: keccak256(abi.encodePacked("c", sigId)),
                sport: "NBA",
                maxPriceBps: maxPriceBps,
                slaMultiplierBps: slaMultiplierBps,
                maxNotional: 0,
                minNotional: 0,
                expiresAt: block.timestamp + 1 days,
                decoyLines: _buildDecoys(),
                availableSportsbooks: _buildBooks()
            })
        );

        uint256 lockAmount = (notional * slaMultiplierBps) / 10_000 + (notional * 50) / 10_000;

        // Deposit collateral
        usdc.mint(genius, lockAmount);
        vm.startPrank(genius);
        usdc.approve(address(collateral), lockAmount);
        collateral.deposit(lockAmount);
        vm.stopPrank();

        // Mint credits
        if (creditAmount > 0) {
            creditLedger.setAuthorizedCaller(owner, true);
            creditLedger.mint(idiot, creditAmount);
        }

        // Calculate expected split
        uint256 expectedCreditUsed = fee < creditAmount ? fee : creditAmount;
        uint256 expectedUsdcPaid = fee - expectedCreditUsed;

        // Deposit USDC if needed
        if (expectedUsdcPaid > 0) {
            usdc.mint(idiot, expectedUsdcPaid);
            vm.startPrank(idiot);
            usdc.approve(address(escrow), expectedUsdcPaid);
            escrow.deposit(expectedUsdcPaid);
            vm.stopPrank();
        }

        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(sigId, notional, odds);

        Purchase memory p = escrow.getPurchase(purchaseId);
        assertEq(p.creditUsed, expectedCreditUsed, "credit used mismatch");
        assertEq(p.usdcPaid, expectedUsdcPaid, "usdc paid mismatch");
        assertEq(p.feePaid, fee, "total fee mismatch");
    }

    /// @notice Fuzz deposit and withdraw to verify balance invariants
    function testFuzz_depositWithdraw(uint256 depositAmt, uint256 withdrawAmt) public {
        depositAmt = bound(depositAmt, 1, 1e12);
        withdrawAmt = bound(withdrawAmt, 1, depositAmt);

        usdc.mint(idiot, depositAmt);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), depositAmt);
        escrow.deposit(depositAmt);

        assertEq(escrow.getBalance(idiot), depositAmt, "balance after deposit");
        assertEq(usdc.balanceOf(idiot), 0, "USDC should be in escrow");

        escrow.withdraw(withdrawAmt);
        vm.stopPrank();

        assertEq(escrow.getBalance(idiot), depositAmt - withdrawAmt, "balance after withdraw");
        assertEq(usdc.balanceOf(idiot), withdrawAmt, "USDC returned after withdraw");
    }

    /// @notice Fuzz: small notional values — test rounding behavior at minimums
    /// @dev When notional * maxPriceBps / 10_000 == 0, fee is zero.
    ///      This tests that the system handles zero-fee and near-zero-fee purchases correctly.
    function testFuzz_smallNotional_roundingBehavior(uint256 notional, uint16 maxPriceBps) public {
        notional = bound(notional, 1e6, 10e6); // 1 to 10 USDC (small range)
        maxPriceBps = uint16(bound(uint256(maxPriceBps), 1, 100)); // 0.01% to 1%

        uint256 slaMultiplierBps = 10_000; // 100% — minimum valid
        uint256 odds = 1_910_000;

        uint256 sigId = nextSignalId++;
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: sigId,
                encryptedBlob: hex"cc",
                commitHash: keccak256(abi.encodePacked("r", sigId)),
                sport: "NFL",
                maxPriceBps: maxPriceBps,
                slaMultiplierBps: slaMultiplierBps,
                maxNotional: 0,
                minNotional: 0,
                expiresAt: block.timestamp + 1 days,
                decoyLines: _buildDecoys(),
                availableSportsbooks: _buildBooks()
            })
        );

        uint256 fee = (notional * maxPriceBps) / 10_000;
        uint256 lockAmount = (notional * slaMultiplierBps) / 10_000 + (notional * 50) / 10_000;

        // Deposit collateral
        usdc.mint(genius, lockAmount);
        vm.startPrank(genius);
        usdc.approve(address(collateral), lockAmount);
        collateral.deposit(lockAmount);
        vm.stopPrank();

        if (fee > 0) {
            usdc.mint(idiot, fee);
            vm.startPrank(idiot);
            usdc.approve(address(escrow), fee);
            escrow.deposit(fee);
            vm.stopPrank();
        }

        // Purchase should succeed
        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(sigId, notional, odds);

        Purchase memory p = escrow.getPurchase(purchaseId);
        // Fee calculation must be exact integer division
        assertEq(p.feePaid, fee, "Fuzz: fee must match integer division result");
        // Fee must never exceed notional
        assertLe(p.feePaid, notional, "Fuzz: fee must never exceed notional");
        // Rounding: fee * 10_000 / maxPriceBps should be <= notional (no rounding up)
        if (fee > 0) {
            assertLe(fee * 10_000 / maxPriceBps, notional, "Fuzz: no rounding up in fee calculation");
        }
    }

    /// @notice Fuzz: withdraw more than balance should revert
    function testFuzz_withdrawExceedsBalance_reverts(uint256 depositAmt, uint256 withdrawAmt) public {
        depositAmt = bound(depositAmt, 1, 1e12);
        withdrawAmt = bound(withdrawAmt, depositAmt + 1, type(uint256).max);

        usdc.mint(idiot, depositAmt);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), depositAmt);
        escrow.deposit(depositAmt);

        vm.expectRevert(abi.encodeWithSelector(Escrow.InsufficientBalance.selector, depositAmt, withdrawAmt));
        escrow.withdraw(withdrawAmt);
        vm.stopPrank();
    }
}
