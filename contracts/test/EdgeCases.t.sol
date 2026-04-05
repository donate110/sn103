// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {SignalCommitment} from "../src/SignalCommitment.sol";
import {Escrow} from "../src/Escrow.sol";
import {Collateral} from "../src/Collateral.sol";
import {CreditLedger} from "../src/CreditLedger.sol";
import {Account as DjinnAccount} from "../src/Account.sol";
import {Audit, AuditResult} from "../src/Audit.sol";
import {KeyRecovery} from "../src/KeyRecovery.sol";
import {Signal, SignalStatus, Purchase, Outcome} from "../src/interfaces/IDjinn.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

/// @title EdgeCaseIntegrationTest
/// @notice Tests edge cases from whitepaper Section 14: cancelled games, postponed
///         games, push, line moved, collateral exhaustion, device loss recovery,
///         genius abandonment, validator churn, and dispute resolution flows
contract EdgeCaseIntegrationTest is Test {
    MockUSDC usdc;
    SignalCommitment signalCommitment;
    Escrow escrow;
    Collateral collateral;
    CreditLedger creditLedger;
    DjinnAccount account;
    Audit audit;
    KeyRecovery keyRecovery;

    address owner;
    address genius = address(0xBEEF);
    address idiot = address(0xCAFE);
    address treasury = address(0xFEE5);

    uint256 constant MAX_PRICE_BPS = 500; // 5%
    uint256 constant SLA_MULTIPLIER_BPS = 15_000; // 150%
    uint256 constant NOTIONAL = 1000e6;
    uint256 constant ODDS = 1_910_000;
    uint256 nextSignalId = 1;

    function setUp() public {
        owner = address(this);

        usdc = new MockUSDC();
        signalCommitment = SignalCommitment(_deployProxy(address(new SignalCommitment()), abi.encodeCall(SignalCommitment.initialize, (owner))));
        escrow = Escrow(_deployProxy(address(new Escrow()), abi.encodeCall(Escrow.initialize, (address(usdc), owner))));
        collateral = Collateral(_deployProxy(address(new Collateral()), abi.encodeCall(Collateral.initialize, (address(usdc), owner))));
        creditLedger = CreditLedger(_deployProxy(address(new CreditLedger()), abi.encodeCall(CreditLedger.initialize, (owner))));
        account = DjinnAccount(_deployProxy(address(new DjinnAccount()), abi.encodeCall(DjinnAccount.initialize, (owner))));
        audit = Audit(_deployProxy(address(new Audit()), abi.encodeCall(Audit.initialize, (owner))));
        keyRecovery = new KeyRecovery();

        // Wire contracts
        escrow.setSignalCommitment(address(signalCommitment));
        escrow.setCollateral(address(collateral));
        escrow.setCreditLedger(address(creditLedger));
        escrow.setAccount(address(account));
        escrow.setAuditContract(address(audit));

        audit.setEscrow(address(escrow));
        audit.setCollateral(address(collateral));
        audit.setCreditLedger(address(creditLedger));
        audit.setAccount(address(account));
        audit.setSignalCommitment(address(signalCommitment));
        audit.setProtocolTreasury(treasury);

        signalCommitment.setAuthorizedCaller(address(escrow), true);
        collateral.setAuthorized(address(escrow), true);
        collateral.setAuthorized(address(audit), true);
        creditLedger.setAuthorizedCaller(address(escrow), true);
        creditLedger.setAuthorizedCaller(address(audit), true);
        account.setAuthorizedCaller(address(escrow), true);
        account.setAuthorizedCaller(address(audit), true);
        account.setAuthorizedCaller(owner, true);
        escrow.setAuthorizedCaller(owner, true);
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

    function _createSignal() internal returns (uint256 signalId) {
        signalId = nextSignalId++;
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

    function _depositCollateral(uint256 amount) internal {
        usdc.mint(genius, amount);
        vm.startPrank(genius);
        usdc.approve(address(collateral), amount);
        collateral.deposit(amount);
        vm.stopPrank();
    }

    function _depositEscrow(uint256 amount) internal {
        usdc.mint(idiot, amount);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), amount);
        escrow.deposit(amount);
        vm.stopPrank();
    }

    function _purchaseSignal(uint256 signalId) internal returns (uint256 purchaseId) {
        uint256 lockAmount = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000 + (NOTIONAL * 50) / 10_000;
        uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        uint256 protocolFee = (NOTIONAL * 50) / 10_000;
        _depositCollateral(lockAmount + fee + protocolFee);
        _depositEscrow(fee);

        vm.prank(idiot);
        purchaseId = escrow.purchase(signalId, NOTIONAL, ODDS);
    }

    function _recordOutcome(uint256 purchaseId, Outcome outcome) internal {
        account.recordOutcome(genius, idiot, purchaseId, outcome);
        escrow.setOutcome(purchaseId, outcome);
    }

    /// @dev Build an array of purchaseIds [0..n-1]
    function _buildPurchaseIds(uint256 n) internal pure returns (uint256[] memory pids) {
        pids = new uint256[](n);
        for (uint256 i; i < n; i++) {
            pids[i] = i;
        }
    }

    // ─── Cancelled/Postponed Game: Void Outcome
    // ────────────────────────

    function test_cancelledGame_allVoid_zeroScore() public {
        uint256[] memory pids = new uint256[](10);
        for (uint256 i; i < 10; i++) {
            uint256 sigId = _createSignal();
            uint256 pid = _purchaseSignal(sigId);
            _recordOutcome(pid, Outcome.Void);
            pids[i] = pid;
        }

        int256 score = audit.computeScore(genius, idiot, pids);
        assertEq(score, 0, "All void should give zero score");

        audit.settle(genius, idiot, pids);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.qualityScore, 0, "Stored score should be zero");
        assertEq(result.trancheA, 0, "No tranche A for zero score");
        assertEq(result.trancheB, 0, "No tranche B for zero score");
        // Protocol fee is still charged on non-void notional
        assertEq(result.protocolFee, 0, "Protocol fee should be zero when all void");
    }

    function test_postponedGame_partialVoid() public {
        // 5 favorable, 5 void (postponed games)
        uint256[] memory pids = new uint256[](10);
        for (uint256 i; i < 10; i++) {
            uint256 sigId = _createSignal();
            uint256 pid = _purchaseSignal(sigId);
            Outcome o = i < 5 ? Outcome.Favorable : Outcome.Void;
            _recordOutcome(pid, o);
            pids[i] = pid;
        }

        audit.settle(genius, idiot, pids);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertTrue(result.qualityScore > 0, "5 favorable should give positive score");

        // Protocol fee only on non-void notional
        uint256 expectedFee = (5 * NOTIONAL * 50) / 10_000;
        assertEq(result.protocolFee, expectedFee, "Fee only on non-void signals");
    }

    // ─── Push: Void Outcome
    // ────────────────────────────────────────────

    function test_push_treatedAsVoid() public {
        // A "push" in sports betting means the game lands on the spread exactly.
        // In Djinn, this maps to Void outcome.
        uint256[] memory pids = new uint256[](10);
        for (uint256 i; i < 10; i++) {
            uint256 sigId = _createSignal();
            uint256 pid = _purchaseSignal(sigId);
            // Push = Void
            _recordOutcome(pid, Outcome.Void);
            pids[i] = pid;
        }

        audit.settle(genius, idiot, pids);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.qualityScore, 0, "All pushes (void) should give zero score");
        assertEq(result.trancheA, 0);
        assertEq(result.trancheB, 0);
    }

    // ─── Expired Signal Cannot Be Purchased
    // ─────────────────────────────

    function test_expiredSignal_purchaseReverts() public {
        uint256 sigId = _createSignal();

        uint256 lockAmount = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000 + (NOTIONAL * 50) / 10_000;
        uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        uint256 protocolFee = (NOTIONAL * 50) / 10_000;
        _depositCollateral(lockAmount + fee + protocolFee);
        _depositEscrow(fee);

        // Fast forward past expiration
        vm.warp(block.timestamp + 2 days);

        vm.expectRevert(abi.encodeWithSelector(Escrow.SignalExpired.selector, sigId));
        vm.prank(idiot);
        escrow.purchase(sigId, NOTIONAL, ODDS);
    }

    // ─── Genius Abandonment (Signal Cancelled by Genius) ───────────────────

    function test_geniusAbandonment_cancelSignal() public {
        uint256 sigId = _createSignal();

        // Genius cancels the signal before anyone purchases it
        vm.prank(genius);
        signalCommitment.cancelSignal(sigId);

        Signal memory sig = signalCommitment.getSignal(sigId);
        assertEq(uint8(sig.status), uint8(SignalStatus.Cancelled));

        // Cannot purchase a cancelled signal
        uint256 lockAmount = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000 + (NOTIONAL * 50) / 10_000;
        uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        _depositCollateral(lockAmount);
        _depositEscrow(fee);

        vm.expectRevert(abi.encodeWithSelector(Escrow.SignalNotActive.selector, sigId));
        vm.prank(idiot);
        escrow.purchase(sigId, NOTIONAL, ODDS);
    }

    function test_cannotCancel_afterSettled() public {
        uint256 sigId = _createSignal();

        // Settle the signal via authorized caller
        vm.prank(address(escrow));
        signalCommitment.updateStatus(sigId, SignalStatus.Settled);

        // Genius tries to cancel after settlement
        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.SignalNotCancellable.selector, sigId, SignalStatus.Settled));
        vm.prank(genius);
        signalCommitment.cancelSignal(sigId);
    }

    // ─── Collateral Exhaustion
    // ──────────────────────────────────────────

    function test_collateralExhaustion_purchaseRevertsWhenInsufficient() public {
        uint256 sigId = _createSignal();

        uint256 requiredCollateral = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000 + (NOTIONAL * 50) / 10_000;
        uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;

        // Deposit less collateral than required
        uint256 insufficientCollateral = requiredCollateral / 2;
        _depositCollateral(insufficientCollateral);
        _depositEscrow(fee);

        vm.expectRevert(
            abi.encodeWithSelector(
                Collateral.InsufficientFreeCollateral.selector, insufficientCollateral, requiredCollateral
            )
        );
        vm.prank(idiot);
        escrow.purchase(sigId, NOTIONAL, ODDS);
    }

    function test_collateralWithdrawal_blocked_whenLocked() public {
        uint256 sigId = _createSignal();
        _purchaseSignal(sigId);

        // All collateral is locked, try to withdraw
        uint256 available = collateral.getAvailable(genius);
        if (available > 0) {
            // Only the excess can be withdrawn
            vm.prank(genius);
            collateral.withdraw(available);
        }

        // Trying to withdraw more should fail
        vm.expectRevert(abi.encodeWithSelector(Collateral.WithdrawalExceedsAvailable.selector, 0, 1));
        vm.prank(genius);
        collateral.withdraw(1);
    }

    // ─── Device Loss Recovery
    // ───────────────────────────────────────────

    function test_keyRecovery_storeAndRetrieve() public {
        bytes memory blob1 = hex"aabbccdd11223344";

        // User stores recovery blob
        vm.prank(genius);
        keyRecovery.storeRecoveryBlob(blob1);

        // Retrieve from any address (data is encrypted)
        bytes memory retrieved = keyRecovery.getRecoveryBlob(genius);
        assertEq(retrieved, blob1, "Recovery blob should match");

        // Can overwrite with new blob (device change)
        bytes memory blob2 = hex"deadbeef";
        vm.prank(genius);
        keyRecovery.storeRecoveryBlob(blob2);

        retrieved = keyRecovery.getRecoveryBlob(genius);
        assertEq(retrieved, blob2, "Updated blob should match");
    }

    function test_keyRecovery_emptyBlobReverts() public {
        vm.expectRevert(KeyRecovery.EmptyBlob.selector);
        vm.prank(genius);
        keyRecovery.storeRecoveryBlob(hex"");
    }

    function test_keyRecovery_noBlob_returnsEmpty() public {
        bytes memory retrieved = keyRecovery.getRecoveryBlob(address(0xDEAD));
        assertEq(retrieved.length, 0, "Should return empty bytes for unset blob");
    }

    // ─── Early Exit Edge Cases
    // ──────────────────────────────────────────

    function test_earlyExit_singleSignal() public {
        uint256 sigId = _createSignal();
        uint256 pid = _purchaseSignal(sigId);
        _recordOutcome(pid, Outcome.Unfavorable);

        uint256[] memory pids = new uint256[](1);
        pids[0] = pid;

        vm.prank(idiot);
        audit.earlyExit(genius, idiot, pids);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertTrue(result.qualityScore < 0, "Single unfavorable should be negative");
        assertEq(result.trancheA, 0, "Early exit should have no tranche A");
        assertTrue(result.trancheB > 0, "Early exit should have credits");
    }

    function test_earlyExit_geniusCanTrigger() public {
        uint256 sigId = _createSignal();
        uint256 pid = _purchaseSignal(sigId);
        _recordOutcome(pid, Outcome.Favorable);

        uint256[] memory pids = new uint256[](1);
        pids[0] = pid;

        // Genius triggers early exit
        vm.prank(genius);
        audit.earlyExit(genius, idiot, pids);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertTrue(result.qualityScore > 0, "Should be positive");
        assertEq(result.trancheB, 0, "No credits for positive score");
    }

    function test_earlyExit_randomCallerReverts() public {
        uint256 sigId = _createSignal();
        uint256 pid = _purchaseSignal(sigId);
        _recordOutcome(pid, Outcome.Favorable);

        uint256[] memory pids = new uint256[](1);
        pids[0] = pid;

        address random = address(0xDEAD);
        vm.expectRevert(abi.encodeWithSelector(Audit.NotPartyToAudit.selector, random, genius, idiot));
        vm.prank(random);
        audit.earlyExit(genius, idiot, pids);
    }

    // ─── Dispute Resolution (Re-settlement Not Possible) ────────────────

    function test_cannotResettle_settledBatch() public {
        // Complete full batch of 10
        uint256[] memory pids = new uint256[](10);
        for (uint256 i; i < 10; i++) {
            uint256 sigId = _createSignal();
            uint256 pid = _purchaseSignal(sigId);
            _recordOutcome(pid, Outcome.Favorable);
            pids[i] = pid;
        }

        audit.settle(genius, idiot, pids);

        // Cannot re-settle same batch (purchases are now marked audited)
        vm.expectRevert();
        audit.settle(genius, idiot, pids);
    }

    // ─── Signal With Maximum SLA
    // ────────────────────────────────────────

    function test_highSLA_largeDamages() public {
        // SLA of 300% (30000 bps): maximum damage per unfavorable signal
        uint256 highSla = 30_000;

        uint256[] memory pids = new uint256[](10);
        for (uint256 i; i < 10; i++) {
            uint256 sigId = nextSignalId++;
            vm.prank(genius);
            signalCommitment.commit(
                SignalCommitment.CommitParams({
                    signalId: sigId,
                    encryptedBlob: hex"deadbeef",
                    commitHash: keccak256(abi.encodePacked("signal", sigId)),
                    sport: "NFL",
                    maxPriceBps: MAX_PRICE_BPS,
                    slaMultiplierBps: highSla,
                maxNotional: 10_000e6,
                minNotional: 0,
                    expiresAt: block.timestamp + 1 days,
                    decoyLines: _buildDecoyLines(),
                    availableSportsbooks: _buildSportsbooks()
                })
            );

            uint256 lockAmount = (NOTIONAL * highSla) / 10_000;
            uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
            uint256 protocolFee = (NOTIONAL * 50) / 10_000;
            _depositCollateral(lockAmount + fee + protocolFee);
            _depositEscrow(fee);

            vm.prank(idiot);
            uint256 pid = escrow.purchase(sigId, NOTIONAL, ODDS);
            _recordOutcome(pid, Outcome.Unfavorable);
            pids[i] = pid;
        }

        audit.settle(genius, idiot, pids);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertTrue(result.qualityScore < 0, "All unfavorable with high SLA should be very negative");

        // damages = 10 * 1000e6 * 30000 / 10000 = 30_000e6
        // fees = 10 * 50e6 = 500e6
        // trancheA = min(damages, fees) = 500e6
        // trancheB = 30_000e6 - 500e6 = 29_500e6
        uint256 expectedDamages = 10 * NOTIONAL * highSla / 10_000;
        uint256 totalFees = 10 * (NOTIONAL * MAX_PRICE_BPS / 10_000);
        assertEq(result.trancheA, totalFees, "Tranche A should equal total fees");
        assertEq(result.trancheB, expectedDamages - totalFees, "Tranche B should be excess damages");
    }

    // ─── Credit-Only Purchases Don't Contribute to Fee Pool ─────────────

    function test_creditOnlyPurchase_noFeePool() public {
        // Give idiot enough credits to cover all purchases
        creditLedger.setAuthorizedCaller(owner, true);
        uint256 feePerSignal = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        creditLedger.mint(idiot, feePerSignal * 10);

        uint256[] memory pids = new uint256[](10);
        for (uint256 i; i < 10; i++) {
            uint256 sigId = _createSignal();
            uint256 lockAmount = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000 + (NOTIONAL * 50) / 10_000;
            uint256 protocolFee = (NOTIONAL * 50) / 10_000;
            _depositCollateral(lockAmount + feePerSignal + protocolFee);

            vm.prank(idiot);
            uint256 pid = escrow.purchase(sigId, NOTIONAL, ODDS);
            _recordOutcome(pid, Outcome.Unfavorable);
            pids[i] = pid;
        }

        // feePool is no longer written to in v2, so we skip that assertion.
        // In v2, fees are computed from Purchase records at settlement time.

        uint256 idiotBalBefore = escrow.getBalance(idiot);

        audit.settle(genius, idiot, pids);

        // Even though QS is negative, tranche A refund is capped at USDC fees paid (0 for credit-only)
        // So idiot gets 0 USDC refund but gets credits from tranche B
        assertEq(escrow.getBalance(idiot), idiotBalBefore, "No USDC refund when paid entirely by credits");
        assertTrue(creditLedger.balanceOf(idiot) > 0, "Credits should be minted for damages");
    }

    // ─── Outcome Recording Edge Cases
    // ───────────────────────────────────

    function test_cannotRecordPendingOutcome() public {
        uint256 sigId = _createSignal();
        _purchaseSignal(sigId);

        vm.expectRevert(DjinnAccount.InvalidOutcome.selector);
        account.recordOutcome(genius, idiot, 0, Outcome.Pending);
    }

    function test_cannotRecordOutcomeTwice() public {
        uint256 sigId = _createSignal();
        uint256 pid = _purchaseSignal(sigId);
        _recordOutcome(pid, Outcome.Favorable);

        vm.expectRevert(abi.encodeWithSelector(DjinnAccount.OutcomeAlreadyRecorded.selector, genius, idiot, pid));
        account.recordOutcome(genius, idiot, pid, Outcome.Unfavorable);
    }

    // ─── No Cycle Signal Limit (v2: unlimited purchases per pair)
    // ─────────────────────────────────────────────

    function test_moreThan10SignalsPerPair() public {
        // v2 has no cycle limit; purchases accumulate without limit
        for (uint256 i; i < 15; i++) {
            uint256 sigId = _createSignal();
            _purchaseSignal(sigId);
        }

        // 15 purchases should all succeed
        assertEq(account.getSignalCount(genius, idiot), 15, "Should have 15 unaudited purchases");
    }

    // ─── Zero Notional Edge
    // ─────────────────────────────────────────────

    function test_zeroNotional_zeroFee() public {
        uint256 sigId = _createSignal();

        // Genius needs collateral for lock amount: 0 * sla / 10000 = 0
        // But collateral.lock requires amount > 0, so this should revert
        vm.expectRevert(Collateral.ZeroAmount.selector);
        vm.prank(idiot);
        escrow.purchase(sigId, 0, ODDS);
    }

    // ─── Zero-address checks on auth setters
    // ─────────────────────────────────────────────

    function test_escrow_setAuthorizedCaller_zeroAddress_reverts() public {
        vm.expectRevert(Escrow.ZeroAddress.selector);
        escrow.setAuthorizedCaller(address(0), true);
    }

    function test_account_setAuthorizedCaller_zeroAddress_reverts() public {
        vm.expectRevert(DjinnAccount.ZeroAddress.selector);
        account.setAuthorizedCaller(address(0), true);
    }

    function test_collateral_setAuthorized_zeroAddress_reverts() public {
        vm.expectRevert(Collateral.ZeroAddress.selector);
        collateral.setAuthorized(address(0), true);
    }

    function test_creditLedger_setAuthorizedCaller_zeroAddress_reverts() public {
        vm.expectRevert(CreditLedger.ZeroAddress.selector);
        creditLedger.setAuthorizedCaller(address(0), true);
    }

    function test_signalCommitment_setAuthorizedCaller_zeroAddress_reverts() public {
        vm.expectRevert(SignalCommitment.ZeroAddress.selector);
        signalCommitment.setAuthorizedCaller(address(0), true);
    }

    function test_collateral_initialize_zeroUsdc_reverts() public {
        Collateral colImpl = new Collateral();
        vm.expectRevert(abi.encodeWithSignature("ZeroAddress()"));
        new ERC1967Proxy(address(colImpl), abi.encodeCall(Collateral.initialize, (address(0), owner)));
    }

    // ─── Early Exit: Protocol Fee Charged
    // ──────────────────────

    function test_earlyExit_protocolFeeCharged() public {
        // Create only 3 signals (< 10 = early exit)
        uint256[] memory pids = new uint256[](3);
        for (uint256 i; i < 3; i++) {
            uint256 sid = _createSignal();
            uint256 pid = _purchaseSignal(sid);
            _recordOutcome(pid, Outcome.Unfavorable);
            pids[i] = pid;
        }

        // Trigger early exit (must be called by genius or idiot)
        vm.prank(idiot);
        audit.earlyExit(genius, idiot, pids);

        // v2 early exit charges protocol fee from collateral
        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertGt(result.protocolFee, 0, "Protocol fee should be charged on early exit");
    }

    // ─── Escrow: MAX_NOTIONAL limit
    // ──────────────────────────────

    function test_purchase_revertOnExcessiveNotional() public {
        uint256 sid = _createSignal();
        uint256 excessiveNotional = escrow.MAX_NOTIONAL() + 1;

        // Don't need actual deposits: revert happens before balance checks
        vm.expectRevert(
            abi.encodeWithSelector(Escrow.NotionalTooLarge.selector, excessiveNotional, escrow.MAX_NOTIONAL())
        );
        vm.prank(idiot);
        escrow.purchase(sid, excessiveNotional, ODDS);
    }
}
