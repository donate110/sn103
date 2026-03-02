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

/// @title EscrowIntegrationTest
/// @notice Integration tests for the full purchase flow through Escrow
contract EscrowIntegrationTest is Test {
    MockUSDC usdc;
    SignalCommitment signalCommitment;
    Escrow escrow;
    Collateral collateral;
    CreditLedger creditLedger;
    DjinnAccount account;

    address owner;
    address genius = address(0xBEEF);
    address idiot = address(0xCAFE);

    // Standard signal parameters
    uint256 constant SIGNAL_ID = 1;
    uint256 constant MAX_PRICE_BPS = 500; // 5%
    uint256 constant SLA_MULTIPLIER_BPS = 15_000; // 150%
    uint256 constant NOTIONAL = 1000e6; // 1000 USDC
    uint256 constant ODDS = 1_910_000; // 1.91 (6 decimal fixed point)

    function setUp() public {
        owner = address(this);

        // Deploy all contracts
        usdc = new MockUSDC();
        signalCommitment = SignalCommitment(_deployProxy(address(new SignalCommitment()), abi.encodeCall(SignalCommitment.initialize, (owner))));
        escrow = Escrow(_deployProxy(address(new Escrow()), abi.encodeCall(Escrow.initialize, (address(usdc), owner))));
        collateral = Collateral(_deployProxy(address(new Collateral()), abi.encodeCall(Collateral.initialize, (address(usdc), owner))));
        creditLedger = CreditLedger(_deployProxy(address(new CreditLedger()), abi.encodeCall(CreditLedger.initialize, (owner))));
        account = DjinnAccount(_deployProxy(address(new DjinnAccount()), abi.encodeCall(DjinnAccount.initialize, (owner))));

        // Wire contracts together
        escrow.setSignalCommitment(address(signalCommitment));
        escrow.setCollateral(address(collateral));
        escrow.setCreditLedger(address(creditLedger));
        escrow.setAccount(address(account));
        escrow.setAuditContract(owner); // owner acts as audit for refund tests

        // Authorize callers
        signalCommitment.setAuthorizedCaller(address(escrow), true);
        collateral.setAuthorized(address(escrow), true);
        creditLedger.setAuthorizedCaller(address(escrow), true);
        account.setAuthorizedCaller(address(escrow), true);
        account.setAuthorizedCaller(owner, true); // for recording outcomes in tests
    }

    // ─── Helpers
    // ─────────────────────────────────────────────────────────

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
                availableSportsbooks: _buildSportsbooks()
            })
        );
    }

    function _depositGeniusCollateral(uint256 amount) internal {
        usdc.mint(genius, amount);
        vm.startPrank(genius);
        usdc.approve(address(collateral), amount);
        collateral.deposit(amount);
        vm.stopPrank();
    }

    function _depositIdiotEscrow(uint256 amount) internal {
        usdc.mint(idiot, amount);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), amount);
        escrow.deposit(amount);
        vm.stopPrank();
    }

    // ─── Deposit / Withdraw Tests
    // ────────────────────────────────────────

    function test_deposit() public {
        uint256 amount = 500e6;
        usdc.mint(idiot, amount);

        vm.startPrank(idiot);
        usdc.approve(address(escrow), amount);
        escrow.deposit(amount);
        vm.stopPrank();

        assertEq(escrow.getBalance(idiot), amount, "Escrow balance should match deposit");
        assertEq(usdc.balanceOf(address(escrow)), amount, "USDC should be in escrow contract");
    }

    function test_deposit_reverts_zero() public {
        vm.expectRevert(Escrow.ZeroAmount.selector);
        vm.prank(idiot);
        escrow.deposit(0);
    }

    function test_withdraw() public {
        uint256 depositAmount = 500e6;
        uint256 withdrawAmount = 200e6;

        _depositIdiotEscrow(depositAmount);

        vm.prank(idiot);
        escrow.withdraw(withdrawAmount);

        assertEq(escrow.getBalance(idiot), depositAmount - withdrawAmount, "Remaining balance wrong");
        assertEq(usdc.balanceOf(idiot), withdrawAmount, "Withdrawn USDC not received");
    }

    function test_withdraw_reverts_insufficient() public {
        _depositIdiotEscrow(100e6);

        vm.expectRevert(abi.encodeWithSelector(Escrow.InsufficientBalance.selector, 100e6, 200e6));
        vm.prank(idiot);
        escrow.withdraw(200e6);
    }

    function test_withdraw_reverts_zero() public {
        vm.expectRevert(Escrow.ZeroAmount.selector);
        vm.prank(idiot);
        escrow.withdraw(0);
    }

    function test_deposit_and_full_withdraw() public {
        uint256 amount = 1000e6;
        _depositIdiotEscrow(amount);

        vm.prank(idiot);
        escrow.withdraw(amount);

        assertEq(escrow.getBalance(idiot), 0, "Balance should be zero after full withdraw");
        assertEq(usdc.balanceOf(idiot), amount, "All USDC returned to idiot");
    }

    // ─── Successful Purchase
    // ─────────────────────────────────────────────

    function test_purchase_success() public {
        _createSignal(SIGNAL_ID);

        // Genius needs enough collateral for: notional * slaMultiplierBps / 10000
        // 1000e6 * 15000 / 10000 = 1500e6
        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);

        // Fee = notional * maxPriceBps / 10000 = 1000e6 * 500 / 10000 = 50e6
        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(expectedFee);

        uint256 idiotBalBefore = escrow.getBalance(idiot);

        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);

        // Verify Purchase struct
        Purchase memory p = escrow.getPurchase(purchaseId);
        assertEq(p.idiot, idiot, "Purchase idiot mismatch");
        assertEq(p.signalId, SIGNAL_ID, "Purchase signalId mismatch");
        assertEq(p.notional, NOTIONAL, "Purchase notional mismatch");
        assertEq(p.feePaid, expectedFee, "Purchase feePaid mismatch");
        assertEq(p.creditUsed, 0, "No credits should be used");
        assertEq(p.usdcPaid, expectedFee, "Purchase usdcPaid should equal fee");
        assertEq(p.odds, ODDS, "Purchase odds mismatch");
        assertEq(uint8(p.outcome), uint8(Outcome.Pending), "Purchase outcome should be Pending");

        // Verify escrow balance reduced
        assertEq(escrow.getBalance(idiot), idiotBalBefore - expectedFee, "Idiot escrow balance not reduced");

        // Verify collateral locked
        assertEq(collateral.getLocked(genius), requiredCollateral, "Collateral not locked");
        assertEq(collateral.getSignalLock(genius, SIGNAL_ID), requiredCollateral, "Signal lock amount mismatch");

        // Verify signal status stays Active (multi-purchase support)
        Signal memory sig = signalCommitment.getSignal(SIGNAL_ID);
        assertEq(uint8(sig.status), uint8(SignalStatus.Active), "Signal should remain Active");

        // Verify fee pool
        uint256 cycle = account.getCurrentCycle(genius, idiot);
        assertEq(escrow.feePool(genius, idiot, cycle), expectedFee, "Fee pool not tracked");

        // Verify account recorded the purchase
        assertEq(account.getSignalCount(genius, idiot), 1, "Account signal count wrong");
    }

    // ─── Purchase With Credits
    // ───────────────────────────────────────────

    function test_purchase_with_credits() public {
        _createSignal(SIGNAL_ID);

        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);

        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000; // 50e6
        uint256 creditAmount = 20e6; // 20 USDC worth of credits
        uint256 expectedUsdcPaid = expectedFee - creditAmount;

        // Mint credits to idiot (creditLedger needs authorized caller)
        creditLedger.setAuthorizedCaller(owner, true);
        creditLedger.mint(idiot, creditAmount);

        // Idiot only needs to deposit the USDC portion
        _depositIdiotEscrow(expectedUsdcPaid);

        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);

        Purchase memory p = escrow.getPurchase(purchaseId);
        assertEq(p.feePaid, expectedFee, "Total fee should be full amount");
        assertEq(p.creditUsed, creditAmount, "Credits should offset part of fee");
        assertEq(p.usdcPaid, expectedUsdcPaid, "USDC paid should be fee minus credits");

        // Credits should be burned
        assertEq(creditLedger.balanceOf(idiot), 0, "Credits should be burned");

        // Escrow balance should be zero (all USDC used)
        assertEq(escrow.getBalance(idiot), 0, "Idiot escrow balance should be zero");

        // Fee pool only tracks USDC, not credits
        uint256 cycle = account.getCurrentCycle(genius, idiot);
        assertEq(escrow.feePool(genius, idiot, cycle), expectedUsdcPaid, "Fee pool should only have USDC paid");
    }

    function test_purchase_fully_covered_by_credits() public {
        _createSignal(SIGNAL_ID);

        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);

        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000; // 50e6

        // Give idiot enough credits to fully cover the fee
        creditLedger.setAuthorizedCaller(owner, true);
        creditLedger.mint(idiot, expectedFee + 10e6); // extra credits

        // No USDC deposit needed
        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);

        Purchase memory p = escrow.getPurchase(purchaseId);
        assertEq(p.creditUsed, expectedFee, "Credits should cover entire fee");
        assertEq(p.usdcPaid, 0, "No USDC should be paid");

        // Leftover credits remain
        assertEq(creditLedger.balanceOf(idiot), 10e6, "Remaining credits should be untouched");

        // Fee pool should be zero since no USDC was paid
        uint256 cycle = account.getCurrentCycle(genius, idiot);
        assertEq(escrow.feePool(genius, idiot, cycle), 0, "Fee pool should be zero when paid entirely by credits");
    }

    // ─── Purchase Reverts
    // ────────────────────────────────────────────────

    function test_purchase_reverts_insufficient_balance() public {
        _createSignal(SIGNAL_ID);

        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);

        // Deposit less than needed
        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        uint256 insufficientDeposit = expectedFee / 2;
        _depositIdiotEscrow(insufficientDeposit);

        vm.expectRevert(abi.encodeWithSelector(Escrow.InsufficientBalance.selector, insufficientDeposit, expectedFee));
        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);
    }

    function test_purchase_reverts_non_active_signal() public {
        _createSignal(SIGNAL_ID);

        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);

        // Cancel the signal so it's not Active
        vm.prank(genius);
        signalCommitment.cancelSignal(SIGNAL_ID);

        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(expectedFee);

        vm.expectRevert(abi.encodeWithSelector(Escrow.SignalNotActive.selector, SIGNAL_ID));
        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);
    }

    function test_purchase_reverts_expired_signal() public {
        _createSignal(SIGNAL_ID);

        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);

        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(expectedFee);

        // Fast forward past expiration
        vm.warp(block.timestamp + 2 days);

        vm.expectRevert(abi.encodeWithSelector(Escrow.SignalExpired.selector, SIGNAL_ID));
        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);
    }

    function test_purchase_reverts_insufficient_collateral() public {
        _createSignal(SIGNAL_ID);

        // Deposit less collateral than needed
        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000; // 1500e6
        uint256 insufficientCollateral = requiredCollateral / 2;
        _depositGeniusCollateral(insufficientCollateral);

        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(expectedFee);

        vm.expectRevert(
            abi.encodeWithSelector(
                Collateral.InsufficientFreeCollateral.selector, insufficientCollateral, requiredCollateral
            )
        );
        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);
    }

    function test_purchase_reverts_zero_notional() public {
        _createSignal(SIGNAL_ID);

        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);

        _depositIdiotEscrow(1e6);

        vm.expectRevert(Escrow.ZeroAmount.selector);
        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, 0, ODDS);
    }

    // ─── Fee Calculation
    // ─────────────────────────────────────────────────

    function test_fee_calculation_various_maxPrice() public {
        // Test with different maxPriceBps values
        uint256[] memory priceBps = new uint256[](4);
        priceBps[0] = 100; // 1%
        priceBps[1] = 500; // 5%
        priceBps[2] = 1000; // 10%
        priceBps[3] = 5000; // 50% (max)

        for (uint256 i; i < priceBps.length; i++) {
            uint256 sigId = 100 + i;

            vm.prank(genius);
            signalCommitment.commit(
                SignalCommitment.CommitParams({
                    signalId: sigId,
                    encryptedBlob: hex"deadbeef",
                    commitHash: keccak256(abi.encodePacked("signal", i)),
                    sport: "NFL",
                    maxPriceBps: priceBps[i],
                    slaMultiplierBps: SLA_MULTIPLIER_BPS,
                maxNotional: 10_000e6,
                minNotional: 0,
                    expiresAt: block.timestamp + 1 days,
                    decoyLines: _buildDecoyLines(),
                    availableSportsbooks: _buildSportsbooks()
                })
            );

            uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
            _depositGeniusCollateral(requiredCollateral);

            uint256 expectedFee = (NOTIONAL * priceBps[i]) / 10_000;
            _depositIdiotEscrow(expectedFee);

            vm.prank(idiot);
            uint256 purchaseId = escrow.purchase(sigId, NOTIONAL, ODDS);

            Purchase memory p = escrow.getPurchase(purchaseId);
            assertEq(p.feePaid, expectedFee, "Fee calculation wrong");
        }
    }

    // ─── Multiple Purchases
    // ──────────────────────────────────────────────

    function test_multiple_purchases_same_pair() public {
        uint256 numPurchases = 5;

        for (uint256 i; i < numPurchases; i++) {
            uint256 sigId = 200 + i;
            _createSignalWithId(sigId);

            uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
            _depositGeniusCollateral(requiredCollateral);

            uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
            _depositIdiotEscrow(expectedFee);

            vm.prank(idiot);
            escrow.purchase(sigId, NOTIONAL, ODDS);
        }

        assertEq(account.getSignalCount(genius, idiot), numPurchases, "Signal count should match");
        assertEq(escrow.nextPurchaseId(), numPurchases, "Purchase counter wrong");
    }

    function _createSignalWithId(uint256 signalId) internal {
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: signalId,
                encryptedBlob: hex"deadbeef",
                commitHash: keccak256(abi.encodePacked("signal", signalId)),
                sport: "NFL",
                maxPriceBps: MAX_PRICE_BPS,
                slaMultiplierBps: SLA_MULTIPLIER_BPS,
                maxNotional: 10_000e6,
                minNotional: 0,
                expiresAt: block.timestamp + 1 days,
                decoyLines: _buildDecoyLines(),
                availableSportsbooks: _buildSportsbooks()
            })
        );
    }

    // ─── Refund (via Audit)
    // ──────────────────────────────────────────────

    function test_refund_from_audit() public {
        // Complete a purchase to build up fee pool
        _createSignal(SIGNAL_ID);
        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);
        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(expectedFee);

        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);

        uint256 cycle = account.getCurrentCycle(genius, idiot);
        uint256 poolBefore = escrow.feePool(genius, idiot, cycle);
        assertEq(poolBefore, expectedFee, "Pool should contain fee");

        // Owner acts as audit contract, trigger refund
        uint256 refundAmount = expectedFee / 2;
        escrow.refund(genius, idiot, cycle, refundAmount);

        assertEq(escrow.feePool(genius, idiot, cycle), poolBefore - refundAmount, "Pool not reduced");
        assertEq(escrow.getBalance(idiot), refundAmount, "Refund not credited to idiot balance");
    }

    function test_refund_unauthorized_reverts() public {
        address random = address(0xDEAD);
        vm.expectRevert(Escrow.Unauthorized.selector);
        vm.prank(random);
        escrow.refund(genius, idiot, 0, 100e6);
    }

    function test_refund_zero_reverts() public {
        vm.expectRevert(Escrow.ZeroAmount.selector);
        escrow.refund(genius, idiot, 0, 0);
    }

    function test_refund_exceeds_pool_reverts() public {
        // Build up a fee pool via a purchase
        _createSignal(SIGNAL_ID);
        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);
        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(expectedFee);

        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);

        uint256 cycle = account.getCurrentCycle(genius, idiot);
        uint256 poolBalance = escrow.feePool(genius, idiot, cycle);

        // Try to refund more than pool contains
        vm.expectRevert(abi.encodeWithSelector(Escrow.InsufficientBalance.selector, poolBalance, poolBalance + 1));
        escrow.refund(genius, idiot, cycle, poolBalance + 1);
    }

    function test_refund_successive_drains_pool() public {
        // Build up a fee pool via a purchase
        _createSignal(SIGNAL_ID);
        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);
        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000; // 50e6
        _depositIdiotEscrow(expectedFee);

        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);

        uint256 cycle = account.getCurrentCycle(genius, idiot);

        // First refund: half the pool
        escrow.refund(genius, idiot, cycle, expectedFee / 2);
        assertEq(escrow.feePool(genius, idiot, cycle), expectedFee / 2, "Pool half-drained");
        assertEq(escrow.getBalance(idiot), expectedFee / 2, "Idiot got first refund");

        // Second refund: remaining half
        escrow.refund(genius, idiot, cycle, expectedFee / 2);
        assertEq(escrow.feePool(genius, idiot, cycle), 0, "Pool fully drained");
        assertEq(escrow.getBalance(idiot), expectedFee, "Idiot got full refund");

        // Third refund: pool is empty, should revert
        vm.expectRevert(abi.encodeWithSelector(Escrow.InsufficientBalance.selector, 0, 1));
        escrow.refund(genius, idiot, cycle, 1);
    }

    // ─── setOutcome Tests
    // ─────────────────────────────────────────────────

    function test_setOutcome_success() public {
        // Complete a purchase
        _createSignal(SIGNAL_ID);
        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);
        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(expectedFee);

        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);

        // Set authorized caller
        escrow.setAuthorizedCaller(owner, true);

        escrow.setOutcome(purchaseId, Outcome.Favorable);

        Purchase memory p = escrow.getPurchase(purchaseId);
        assertEq(uint8(p.outcome), uint8(Outcome.Favorable), "Outcome should be Favorable");
    }

    function test_setOutcome_unauthorized_reverts() public {
        address random = address(0xDEAD);
        vm.expectRevert(Escrow.Unauthorized.selector);
        vm.prank(random);
        escrow.setOutcome(0, Outcome.Favorable);
    }

    function test_setOutcome_pending_reverts() public {
        escrow.setAuthorizedCaller(owner, true);
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidOutcome.selector, Outcome.Pending));
        escrow.setOutcome(0, Outcome.Pending);
    }

    function test_setOutcome_doubleSet_reverts() public {
        _createSignal(SIGNAL_ID);
        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);
        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(expectedFee);

        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);

        escrow.setAuthorizedCaller(owner, true);
        escrow.setOutcome(purchaseId, Outcome.Favorable);

        vm.expectRevert(abi.encodeWithSelector(Escrow.OutcomeAlreadySet.selector, purchaseId, Outcome.Favorable));
        escrow.setOutcome(purchaseId, Outcome.Unfavorable);
    }

    function test_setOutcome_nonexistent_reverts() public {
        escrow.setAuthorizedCaller(owner, true);
        vm.expectRevert(abi.encodeWithSelector(Escrow.PurchaseNotFound.selector, 999));
        escrow.setOutcome(999, Outcome.Favorable);
    }

    // ─── Purchase with credits exactly matching fee
    // ──────────────────────────────────────────────

    function test_purchase_credits_exactly_cover_fee() public {
        _createSignal(SIGNAL_ID);

        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);

        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;

        creditLedger.setAuthorizedCaller(owner, true);
        creditLedger.mint(idiot, expectedFee); // exactly the fee, no excess

        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);

        Purchase memory p = escrow.getPurchase(purchaseId);
        assertEq(p.creditUsed, expectedFee, "Credits should exactly cover fee");
        assertEq(p.usdcPaid, 0, "No USDC needed");
        assertEq(creditLedger.balanceOf(idiot), 0, "All credits consumed");
    }

    // ─── Boundary odds values
    // ──────────────────────────────────────────────

    function test_purchase_minOdds() public {
        _createSignal(SIGNAL_ID);

        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);
        uint256 expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(expectedFee);

        uint256 minOdds = 1_010_000; // 1.01x

        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(SIGNAL_ID, NOTIONAL, minOdds);

        Purchase memory p = escrow.getPurchase(purchaseId);
        assertEq(p.odds, minOdds, "Min odds should be stored");
    }

    function test_purchase_dustNotional_reverts() public {
        _createSignal(SIGNAL_ID);

        uint256 dustNotional = 100; // 0.0001 USDC — way below MIN_NOTIONAL
        vm.prank(idiot);
        vm.expectRevert(abi.encodeWithSelector(Escrow.NotionalTooSmall.selector, dustNotional, 1e6));
        escrow.purchase(SIGNAL_ID, dustNotional, ODDS);
    }

    // ─── maxNotional Enforcement
    // ──────────────────────────────────────────────

    function test_purchase_reverts_notional_exceeds_signal_max() public {
        _createSignal(SIGNAL_ID); // maxNotional = 10_000e6

        uint256 bigNotional = 10_001e6; // exceeds 10_000e6
        uint256 requiredCollateral = (bigNotional * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);
        uint256 expectedFee = (bigNotional * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(expectedFee);

        vm.expectRevert(abi.encodeWithSelector(Escrow.NotionalExceedsSignalMax.selector, bigNotional, 10_000e6));
        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, bigNotional, ODDS);
    }

    function test_purchase_succeeds_at_exact_maxNotional() public {
        _createSignal(SIGNAL_ID); // maxNotional = 10_000e6

        uint256 exactMax = 10_000e6;
        uint256 requiredCollateral = (exactMax * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);
        uint256 expectedFee = (exactMax * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(expectedFee);

        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(SIGNAL_ID, exactMax, ODDS);

        Purchase memory p = escrow.getPurchase(purchaseId);
        assertEq(p.notional, exactMax, "Notional at exact max should succeed");
    }

    function test_purchase_succeeds_with_unlimited_maxNotional() public {
        uint256 sigId = 500;
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: sigId,
                encryptedBlob: hex"deadbeef",
                commitHash: keccak256("unlimited"),
                sport: "NFL",
                maxPriceBps: MAX_PRICE_BPS,
                slaMultiplierBps: SLA_MULTIPLIER_BPS,
                maxNotional: 0, // unlimited
                minNotional: 0,
                expiresAt: block.timestamp + 1 days,
                decoyLines: _buildDecoyLines(),
                availableSportsbooks: _buildSportsbooks()
            })
        );

        uint256 bigNotional = 100_000e6;
        uint256 requiredCollateral = (bigNotional * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(requiredCollateral);
        uint256 expectedFee = (bigNotional * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(expectedFee);

        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(sigId, bigNotional, ODDS);

        Purchase memory p = escrow.getPurchase(purchaseId);
        assertEq(p.notional, bigNotional, "Unlimited maxNotional should allow any amount");
    }

    // ─── canPurchase View
    // ──────────────────────────────────────────────

    function test_canPurchase_active_signal() public {
        _createSignal(SIGNAL_ID);
        (bool canBuy, string memory reason) = escrow.canPurchase(SIGNAL_ID, NOTIONAL);
        assertTrue(canBuy, "Active signal should be purchasable");
        assertEq(bytes(reason).length, 0, "No reason for purchasable signal");
    }

    function test_canPurchase_cancelled_signal() public {
        _createSignal(SIGNAL_ID);
        vm.prank(genius);
        signalCommitment.cancelSignal(SIGNAL_ID);

        (bool canBuy, string memory reason) = escrow.canPurchase(SIGNAL_ID, NOTIONAL);
        assertFalse(canBuy, "Cancelled signal should not be purchasable");
        assertEq(reason, "Signal not active");
    }

    function test_canPurchase_expired_signal() public {
        _createSignal(SIGNAL_ID);
        vm.warp(block.timestamp + 2 days);

        (bool canBuy, string memory reason) = escrow.canPurchase(SIGNAL_ID, NOTIONAL);
        assertFalse(canBuy, "Expired signal should not be purchasable");
        assertEq(reason, "Signal expired");
    }

    function test_canPurchase_exceeds_maxNotional() public {
        _createSignal(SIGNAL_ID); // maxNotional = 10_000e6

        (bool canBuy, string memory reason) = escrow.canPurchase(SIGNAL_ID, 10_001e6);
        assertFalse(canBuy, "Notional exceeding max should fail");
        assertEq(reason, "Notional exceeds remaining capacity");
    }

    function test_canPurchase_below_minNotional() public {
        _createSignal(SIGNAL_ID);

        (bool canBuy, string memory reason) = escrow.canPurchase(SIGNAL_ID, 100); // dust
        assertFalse(canBuy, "Dust notional should fail");
        assertEq(reason, "Notional too small");
    }

    function test_canPurchase_above_maxNotional_global() public {
        uint256 sigId = 501;
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: sigId,
                encryptedBlob: hex"deadbeef",
                commitHash: keccak256("bigmax"),
                sport: "NFL",
                maxPriceBps: MAX_PRICE_BPS,
                slaMultiplierBps: SLA_MULTIPLIER_BPS,
                maxNotional: 0, // unlimited signal-level
                minNotional: 0,
                expiresAt: block.timestamp + 1 days,
                decoyLines: _buildDecoyLines(),
                availableSportsbooks: _buildSportsbooks()
            })
        );

        uint256 tooBig = 1e15 + 1; // exceeds MAX_NOTIONAL
        (bool canBuy, string memory reason) = escrow.canPurchase(sigId, tooBig);
        assertFalse(canBuy, "Above global MAX_NOTIONAL should fail");
        assertEq(reason, "Notional too large");
    }

    function test_canPurchase_signalCommitment_not_set() public {
        // Deploy fresh escrow without wiring
        Escrow freshEscrow = Escrow(_deployProxy(address(new Escrow()), abi.encodeCall(Escrow.initialize, (address(usdc), owner))));

        (bool canBuy, string memory reason) = freshEscrow.canPurchase(1, NOTIONAL);
        assertFalse(canBuy, "Should fail with no SignalCommitment set");
        assertEq(reason, "SignalCommitment not set");
    }

    // ─── Multi-Purchase Tests
    // ──────────────────────────────────────────────

    function test_multiPurchase_twoBuyers() public {
        _createSignal(SIGNAL_ID); // maxNotional = 10_000e6

        address idiot2 = address(0xDADA);

        // First buyer: 4000 USDC
        uint256 notional1 = 4000e6;
        uint256 collateral1 = (notional1 * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(collateral1);
        uint256 fee1 = (notional1 * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(fee1);

        vm.prank(idiot);
        uint256 pid1 = escrow.purchase(SIGNAL_ID, notional1, ODDS);

        // Signal should still be Active
        assertEq(uint8(signalCommitment.getSignal(SIGNAL_ID).status), uint8(SignalStatus.Active));
        assertEq(escrow.signalNotionalFilled(SIGNAL_ID), notional1);

        // Second buyer: 3000 USDC
        uint256 notional2 = 3000e6;
        uint256 collateral2 = (notional2 * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(collateral2);
        uint256 fee2 = (notional2 * MAX_PRICE_BPS) / 10_000;
        usdc.mint(idiot2, fee2);
        vm.startPrank(idiot2);
        usdc.approve(address(escrow), fee2);
        escrow.deposit(fee2);
        uint256 pid2 = escrow.purchase(SIGNAL_ID, notional2, ODDS);
        vm.stopPrank();

        // Verify both purchases recorded
        assertEq(escrow.signalNotionalFilled(SIGNAL_ID), notional1 + notional2);
        uint256[] memory purchaseIds = escrow.getPurchasesBySignal(SIGNAL_ID);
        assertEq(purchaseIds.length, 2);

        Purchase memory p1 = escrow.getPurchase(pid1);
        Purchase memory p2 = escrow.getPurchase(pid2);
        assertEq(p1.notional, notional1);
        assertEq(p2.notional, notional2);
        assertEq(p1.idiot, idiot);
        assertEq(p2.idiot, idiot2);
    }

    function test_multiPurchase_exceedsRemaining() public {
        _createSignal(SIGNAL_ID); // maxNotional = 10_000e6
        address idiot2 = address(0xDADA);

        // First purchase: 8000 USDC (idiot)
        uint256 notional1 = 8000e6;
        uint256 collateral1 = (notional1 * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(collateral1);
        uint256 fee1 = (notional1 * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(fee1);

        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, notional1, ODDS);

        // Second purchase by different idiot: 3000 USDC (only 2000 remaining)
        uint256 notional2 = 3000e6;
        uint256 collateral2 = (notional2 * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(collateral2);
        uint256 fee2 = (notional2 * MAX_PRICE_BPS) / 10_000;
        usdc.mint(idiot2, fee2);
        vm.startPrank(idiot2);
        usdc.approve(address(escrow), fee2);
        escrow.deposit(fee2);

        uint256 remaining = 10_000e6 - notional1; // 2000e6
        vm.expectRevert(abi.encodeWithSelector(Escrow.NotionalExceedsSignalMax.selector, notional2, remaining));
        escrow.purchase(SIGNAL_ID, notional2, ODDS);
        vm.stopPrank();
    }

    function test_multiPurchase_fillsExactly() public {
        _createSignal(SIGNAL_ID); // maxNotional = 10_000e6
        address idiot2 = address(0xDADA);
        address idiot3 = address(0xFADE);

        // First purchase: 6000 USDC (idiot)
        uint256 notional1 = 6000e6;
        uint256 collateral1 = (notional1 * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(collateral1);
        uint256 fee1 = (notional1 * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(fee1);

        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, notional1, ODDS);

        // Second purchase: exactly 4000 USDC remaining (idiot2 — different buyer)
        uint256 notional2 = 4000e6;
        uint256 collateral2 = (notional2 * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(collateral2);
        uint256 fee2 = (notional2 * MAX_PRICE_BPS) / 10_000;
        usdc.mint(idiot2, fee2);
        vm.startPrank(idiot2);
        usdc.approve(address(escrow), fee2);
        escrow.deposit(fee2);
        escrow.purchase(SIGNAL_ID, notional2, ODDS);
        vm.stopPrank();

        assertEq(escrow.signalNotionalFilled(SIGNAL_ID), 10_000e6, "Signal should be fully filled");

        // Third purchase should fail: 0 remaining
        _depositGeniusCollateral((1e6 * SLA_MULTIPLIER_BPS) / 10_000);
        uint256 fee3 = (1e6 * MAX_PRICE_BPS) / 10_000;
        usdc.mint(idiot3, fee3);
        vm.startPrank(idiot3);
        usdc.approve(address(escrow), fee3);
        escrow.deposit(fee3);
        vm.expectRevert(abi.encodeWithSelector(Escrow.NotionalExceedsSignalMax.selector, 1e6, 0));
        escrow.purchase(SIGNAL_ID, 1e6, ODDS);
        vm.stopPrank();
    }

    function test_multiPurchase_cancelAfterPartialFill() public {
        _createSignal(SIGNAL_ID); // maxNotional = 10_000e6

        // First purchase: 5000 USDC
        uint256 notional1 = 5000e6;
        uint256 collateral1 = (notional1 * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(collateral1);
        uint256 fee1 = (notional1 * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(fee1);

        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, notional1, ODDS);

        // Genius cancels the signal (stops new purchases)
        vm.prank(genius);
        signalCommitment.cancelSignal(SIGNAL_ID);

        assertEq(uint8(signalCommitment.getSignal(SIGNAL_ID).status), uint8(SignalStatus.Cancelled));

        // Second purchase should fail: signal cancelled
        _depositGeniusCollateral((1000e6 * SLA_MULTIPLIER_BPS) / 10_000);
        _depositIdiotEscrow((1000e6 * MAX_PRICE_BPS) / 10_000);

        vm.expectRevert(abi.encodeWithSelector(Escrow.SignalNotActive.selector, SIGNAL_ID));
        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, 1000e6, ODDS);
    }

    function test_multiPurchase_canPurchaseTracksRemaining() public {
        _createSignal(SIGNAL_ID); // maxNotional = 10_000e6

        // First purchase: 7000 USDC
        uint256 notional1 = 7000e6;
        uint256 collateral1 = (notional1 * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(collateral1);
        uint256 fee1 = (notional1 * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(fee1);

        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, notional1, ODDS);

        // canPurchase should reflect remaining capacity (3000e6)
        (bool canBuy, ) = escrow.canPurchase(SIGNAL_ID, 3000e6);
        assertTrue(canBuy, "Should be purchasable at remaining capacity");

        (bool canBuy2, string memory reason) = escrow.canPurchase(SIGNAL_ID, 3001e6);
        assertFalse(canBuy2, "Should fail above remaining capacity");
        assertEq(reason, "Notional exceeds remaining capacity");
    }

    function test_multiPurchase_getSignalNotionalFilled() public {
        _createSignal(SIGNAL_ID);

        assertEq(escrow.getSignalNotionalFilled(SIGNAL_ID), 0, "Should start at zero");

        uint256 notional1 = 2000e6;
        uint256 collateral1 = (notional1 * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(collateral1);
        uint256 fee1 = (notional1 * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(fee1);

        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, notional1, ODDS);

        assertEq(escrow.getSignalNotionalFilled(SIGNAL_ID), notional1, "Should track first purchase");
    }

    // ─── Duplicate Purchase Prevention
    // ──────────────────────────────────────────────

    function test_duplicatePurchase_reverts() public {
        _createSignal(SIGNAL_ID);

        uint256 notional1 = 1000e6;
        _depositGeniusCollateral((notional1 * SLA_MULTIPLIER_BPS) / 10_000);
        _depositIdiotEscrow((notional1 * MAX_PRICE_BPS) / 10_000);

        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, notional1, ODDS);

        // Same idiot tries to purchase the same signal again
        _depositGeniusCollateral((notional1 * SLA_MULTIPLIER_BPS) / 10_000);
        _depositIdiotEscrow((notional1 * MAX_PRICE_BPS) / 10_000);

        vm.expectRevert(abi.encodeWithSelector(Escrow.AlreadyPurchased.selector, SIGNAL_ID, idiot));
        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, notional1, ODDS);
    }

    function test_duplicatePurchase_differentIdiotsAllowed() public {
        _createSignal(SIGNAL_ID);
        address idiot2 = address(0xDADA);

        // First idiot purchases
        uint256 notional1 = 1000e6;
        _depositGeniusCollateral((notional1 * SLA_MULTIPLIER_BPS) / 10_000);
        _depositIdiotEscrow((notional1 * MAX_PRICE_BPS) / 10_000);

        vm.prank(idiot);
        escrow.purchase(SIGNAL_ID, notional1, ODDS);

        // Second (different) idiot purchases the same signal — allowed
        _depositGeniusCollateral((notional1 * SLA_MULTIPLIER_BPS) / 10_000);
        uint256 fee2 = (notional1 * MAX_PRICE_BPS) / 10_000;
        usdc.mint(idiot2, fee2);
        vm.startPrank(idiot2);
        usdc.approve(address(escrow), fee2);
        escrow.deposit(fee2);
        escrow.purchase(SIGNAL_ID, notional1, ODDS);
        vm.stopPrank();

        assertEq(escrow.signalNotionalFilled(SIGNAL_ID), notional1 * 2, "Both purchases should be tracked");
    }

    // ─── minNotional Tests
    // ──────────────────────────────────────────────

    function test_minNotional_enforced() public {
        uint256 sigId = 600;
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: sigId,
                encryptedBlob: hex"deadbeef",
                commitHash: keccak256("mintest"),
                sport: "NFL",
                maxPriceBps: MAX_PRICE_BPS,
                slaMultiplierBps: SLA_MULTIPLIER_BPS,
                maxNotional: 10_000e6,
                minNotional: 100e6, // min 100 USDC
                expiresAt: block.timestamp + 1 days,
                decoyLines: _buildDecoyLines(),
                availableSportsbooks: _buildSportsbooks()
            })
        );

        uint256 smallNotional = 50e6; // below min
        uint256 collateral1 = (smallNotional * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(collateral1);
        uint256 fee1 = (smallNotional * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(fee1);

        vm.expectRevert(abi.encodeWithSelector(Escrow.NotionalTooSmall.selector, smallNotional, 100e6));
        vm.prank(idiot);
        escrow.purchase(sigId, smallNotional, ODDS);
    }

    function test_minNotional_atExact() public {
        uint256 sigId = 601;
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: sigId,
                encryptedBlob: hex"deadbeef",
                commitHash: keccak256("mintest2"),
                sport: "NFL",
                maxPriceBps: MAX_PRICE_BPS,
                slaMultiplierBps: SLA_MULTIPLIER_BPS,
                maxNotional: 10_000e6,
                minNotional: 100e6,
                expiresAt: block.timestamp + 1 days,
                decoyLines: _buildDecoyLines(),
                availableSportsbooks: _buildSportsbooks()
            })
        );

        uint256 exactMin = 100e6;
        uint256 collateral1 = (exactMin * SLA_MULTIPLIER_BPS) / 10_000;
        _depositGeniusCollateral(collateral1);
        uint256 fee1 = (exactMin * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(fee1);

        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(sigId, exactMin, ODDS);

        Purchase memory p = escrow.getPurchase(purchaseId);
        assertEq(p.notional, exactMin, "Exact minimum notional should succeed");
    }

    function test_canPurchase_belowMinNotional() public {
        uint256 sigId = 602;
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: sigId,
                encryptedBlob: hex"deadbeef",
                commitHash: keccak256("mintest3"),
                sport: "NFL",
                maxPriceBps: MAX_PRICE_BPS,
                slaMultiplierBps: SLA_MULTIPLIER_BPS,
                maxNotional: 10_000e6,
                minNotional: 500e6,
                expiresAt: block.timestamp + 1 days,
                decoyLines: _buildDecoyLines(),
                availableSportsbooks: _buildSportsbooks()
            })
        );

        (bool canBuy, string memory reason) = escrow.canPurchase(sigId, 100e6);
        assertFalse(canBuy, "Below minNotional should fail");
        assertEq(reason, "Below minimum notional");
    }
}

/// @title MockAuditForClaims
/// @notice Minimal mock that implements the auditResults view for fee claim tests
contract MockAuditForClaims {
    mapping(address => mapping(address => mapping(uint256 => uint256))) public settledTimestamps;

    function markSettled(address genius, address idiot, uint256 cycle) external {
        settledTimestamps[genius][idiot][cycle] = block.timestamp;
    }

    function auditResults(address genius, address idiot, uint256 cycle)
        external
        view
        returns (int256, uint256, uint256, uint256, uint256)
    {
        return (0, 0, 0, 0, settledTimestamps[genius][idiot][cycle]);
    }

    // Also implement refund interface so it can act as audit for Escrow
    function refund(address, address, uint256, uint256) external pure {}
}

/// @title EscrowFeeClaimTest
/// @notice Tests for the Genius fee claim mechanism
contract EscrowFeeClaimTest is Test {
    MockUSDC usdc;
    SignalCommitment signalCommitment;
    Escrow escrow;
    Collateral collateral;
    CreditLedger creditLedger;
    DjinnAccount account;
    MockAuditForClaims mockAudit;

    address owner;
    address genius = address(0xBEEF);
    address idiot = address(0xCAFE);

    uint256 constant SIGNAL_ID = 1;
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
        mockAudit = new MockAuditForClaims();

        escrow.setSignalCommitment(address(signalCommitment));
        escrow.setCollateral(address(collateral));
        escrow.setCreditLedger(address(creditLedger));
        escrow.setAccount(address(account));
        escrow.setAuditContract(address(mockAudit));

        signalCommitment.setAuthorizedCaller(address(escrow), true);
        collateral.setAuthorized(address(escrow), true);
        creditLedger.setAuthorizedCaller(address(escrow), true);
        account.setAuthorizedCaller(address(escrow), true);
    }

    function _buildDecoyLines() internal pure returns (string[] memory) {
        string[] memory decoys = new string[](10);
        for (uint256 i; i < 10; i++) decoys[i] = "decoy";
        return decoys;
    }

    function _buildSportsbooks() internal pure returns (string[] memory) {
        string[] memory books = new string[](2);
        books[0] = "DraftKings";
        books[1] = "FanDuel";
        return books;
    }

    function _createSignalAndPurchase() internal returns (uint256 expectedFee) {
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: SIGNAL_ID,
                encryptedBlob: hex"deadbeef",
                commitHash: keccak256("signal"),
                sport: "NFL",
                maxPriceBps: MAX_PRICE_BPS,
                slaMultiplierBps: SLA_MULTIPLIER_BPS,
                maxNotional: 10_000e6,
                minNotional: 0,
                expiresAt: block.timestamp + 1 days,
                decoyLines: _buildDecoyLines(),
                availableSportsbooks: _buildSportsbooks()
            })
        );

        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        usdc.mint(genius, requiredCollateral);
        vm.startPrank(genius);
        usdc.approve(address(collateral), requiredCollateral);
        collateral.deposit(requiredCollateral);
        vm.stopPrank();

        expectedFee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        usdc.mint(idiot, expectedFee);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), expectedFee);
        escrow.deposit(expectedFee);
        escrow.purchase(SIGNAL_ID, NOTIONAL, ODDS);
        vm.stopPrank();
    }

    function test_claimFees_success() public {
        uint256 expectedFee = _createSignalAndPurchase();
        uint256 cycle = account.getCurrentCycle(genius, idiot);

        // Mark cycle as settled in mock audit
        mockAudit.markSettled(genius, idiot, cycle);

        uint256 geniusBalBefore = usdc.balanceOf(genius);

        vm.prank(genius);
        escrow.claimFees(idiot, cycle);

        assertEq(usdc.balanceOf(genius), geniusBalBefore + expectedFee, "Genius should receive fees");
        assertEq(escrow.feePool(genius, idiot, cycle), 0, "Fee pool should be zero after claim");
    }

    function test_claimFees_revertCycleNotSettled() public {
        _createSignalAndPurchase();
        uint256 cycle = account.getCurrentCycle(genius, idiot);

        // Do NOT mark cycle as settled
        vm.expectRevert(abi.encodeWithSelector(Escrow.CycleNotSettled.selector, genius, idiot, cycle));
        vm.prank(genius);
        escrow.claimFees(idiot, cycle);
    }

    function test_claimFees_revertNoFees() public {
        // No purchase made, so fee pool is empty
        mockAudit.markSettled(genius, idiot, 0);

        vm.expectRevert(abi.encodeWithSelector(Escrow.NoFeesToClaim.selector, genius, idiot, 0));
        vm.prank(genius);
        escrow.claimFees(idiot, 0);
    }

    function test_claimFees_revertDoubleClaim() public {
        uint256 expectedFee = _createSignalAndPurchase();
        uint256 cycle = account.getCurrentCycle(genius, idiot);
        mockAudit.markSettled(genius, idiot, cycle);

        vm.prank(genius);
        escrow.claimFees(idiot, cycle);

        // Second claim should revert — pool is empty
        vm.expectRevert(abi.encodeWithSelector(Escrow.NoFeesToClaim.selector, genius, idiot, cycle));
        vm.prank(genius);
        escrow.claimFees(idiot, cycle);
    }

    function test_claimFees_onlyGeniusCaller() public {
        _createSignalAndPurchase();
        uint256 cycle = account.getCurrentCycle(genius, idiot);
        mockAudit.markSettled(genius, idiot, cycle);

        // Idiot tries to claim genius's fees — should get CycleNotSettled
        // because auditResults is keyed by msg.sender (idiot), not genius
        vm.expectRevert(abi.encodeWithSelector(Escrow.CycleNotSettled.selector, idiot, idiot, cycle));
        vm.prank(idiot);
        escrow.claimFees(idiot, cycle);
    }

    function test_claimFeesBatch_success() public {
        // Create 2 signals with 2 different idiots
        address idiot2 = address(0xDADA);

        // First purchase with idiot
        uint256 expectedFee1 = _createSignalAndPurchase();
        uint256 cycle1 = account.getCurrentCycle(genius, idiot);

        // Second purchase with idiot2
        uint256 sigId2 = 2;
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: sigId2,
                encryptedBlob: hex"deadbeef",
                commitHash: keccak256("signal2"),
                sport: "NFL",
                maxPriceBps: MAX_PRICE_BPS,
                slaMultiplierBps: SLA_MULTIPLIER_BPS,
                maxNotional: 10_000e6,
                minNotional: 0,
                expiresAt: block.timestamp + 1 days,
                decoyLines: _buildDecoyLines(),
                availableSportsbooks: _buildSportsbooks()
            })
        );

        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        usdc.mint(genius, requiredCollateral);
        vm.startPrank(genius);
        usdc.approve(address(collateral), requiredCollateral);
        collateral.deposit(requiredCollateral);
        vm.stopPrank();

        account.setAuthorizedCaller(address(escrow), true);

        uint256 expectedFee2 = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        usdc.mint(idiot2, expectedFee2);
        vm.startPrank(idiot2);
        usdc.approve(address(escrow), expectedFee2);
        escrow.deposit(expectedFee2);
        escrow.purchase(sigId2, NOTIONAL, ODDS);
        vm.stopPrank();

        uint256 cycle2 = account.getCurrentCycle(genius, idiot2);

        // Mark both cycles as settled
        mockAudit.markSettled(genius, idiot, cycle1);
        mockAudit.markSettled(genius, idiot2, cycle2);

        uint256 geniusBalBefore = usdc.balanceOf(genius);

        address[] memory idiots = new address[](2);
        idiots[0] = idiot;
        idiots[1] = idiot2;
        uint256[] memory cycles = new uint256[](2);
        cycles[0] = cycle1;
        cycles[1] = cycle2;

        vm.prank(genius);
        escrow.claimFeesBatch(idiots, cycles);

        assertEq(usdc.balanceOf(genius), geniusBalBefore + expectedFee1 + expectedFee2, "Genius should receive both fees");
    }

    function test_claimFeesBatch_revertAllEmpty() public {
        mockAudit.markSettled(genius, idiot, 0);

        address[] memory idiots = new address[](1);
        idiots[0] = idiot;
        uint256[] memory cycles = new uint256[](1);
        cycles[0] = 0;

        vm.expectRevert(Escrow.ZeroAmount.selector);
        vm.prank(genius);
        escrow.claimFeesBatch(idiots, cycles);
    }

    function test_claimFees_emitsEvent() public {
        uint256 expectedFee = _createSignalAndPurchase();
        uint256 cycle = account.getCurrentCycle(genius, idiot);
        mockAudit.markSettled(genius, idiot, cycle);

        vm.expectEmit(true, true, false, true);
        emit Escrow.FeesClaimed(genius, idiot, cycle, expectedFee);

        vm.prank(genius);
        escrow.claimFees(idiot, cycle);
    }
}
