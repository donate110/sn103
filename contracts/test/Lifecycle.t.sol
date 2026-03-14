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
import {_deployProxy} from "./helpers/DeployHelpers.sol";

/// @title LifecycleIntegrationTest
/// @notice End-to-end lifecycle tests covering the complete signal flow from
///         creation through settlement, multi-pair interactions, multi-cycle
///         credit reuse, and collateral exhaustion scenarios
contract LifecycleIntegrationTest is Test {
    MockUSDC usdc;
    SignalCommitment signalCommitment;
    Escrow escrow;
    Collateral collateral;
    CreditLedger creditLedger;
    DjinnAccount account;
    Audit audit;
    KeyRecovery keyRecovery;

    address owner;
    address genius1 = address(0xBEEF);
    address genius2 = address(0xBEE2);
    address idiot1 = address(0xCAFE);
    address idiot2 = address(0xCAF2);
    address treasury = address(0xFEE5);

    uint256 constant MAX_PRICE_BPS = 500; // 5%
    uint256 constant SLA_MULTIPLIER_BPS = 15_000; // 150%
    uint256 constant NOTIONAL = 1000e6; // 1000 USDC
    uint256 constant ODDS = 1_910_000; // 1.91 (6 decimal fixed point)
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

        // Wire Escrow
        escrow.setSignalCommitment(address(signalCommitment));
        escrow.setCollateral(address(collateral));
        escrow.setCreditLedger(address(creditLedger));
        escrow.setAccount(address(account));
        escrow.setAuditContract(address(audit));

        // Wire Audit
        audit.setEscrow(address(escrow));
        audit.setCollateral(address(collateral));
        audit.setCreditLedger(address(creditLedger));
        audit.setAccount(address(account));
        audit.setSignalCommitment(address(signalCommitment));
        audit.setProtocolTreasury(treasury);

        // Authorize callers
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

    function _createSignal(address genius) internal returns (uint256 signalId) {
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

    function _depositCollateral(address genius, uint256 amount) internal {
        usdc.mint(genius, amount);
        vm.startPrank(genius);
        usdc.approve(address(collateral), amount);
        collateral.deposit(amount);
        vm.stopPrank();
    }

    function _depositEscrow(address idiot, uint256 amount) internal {
        usdc.mint(idiot, amount);
        vm.startPrank(idiot);
        usdc.approve(address(escrow), amount);
        escrow.deposit(amount);
        vm.stopPrank();
    }

    function _purchaseSignal(address genius, address idiot, uint256 signalId, uint256 notional, uint256 odds)
        internal
        returns (uint256 purchaseId)
    {
        uint256 lockAmount = (notional * SLA_MULTIPLIER_BPS) / 10_000 + (notional * 50) / 10_000;
        uint256 fee = (notional * MAX_PRICE_BPS) / 10_000;
        uint256 protocolFeeShare = (notional * 50) / 10_000;
        _depositCollateral(genius, lockAmount + fee + protocolFeeShare);
        _depositEscrow(idiot, fee);

        vm.prank(idiot);
        purchaseId = escrow.purchase(signalId, notional, odds);
    }

    function _recordOutcome(address genius, address idiot, uint256 purchaseId, Outcome outcome) internal {
        account.recordOutcome(genius, idiot, purchaseId, outcome);
        escrow.setOutcome(purchaseId, outcome);
    }

    function _fullCycle(address genius, address idiot, Outcome[] memory outcomes)
        internal
        returns (uint256[] memory purchaseIds)
    {
        require(outcomes.length == 10, "Must provide 10 outcomes");
        purchaseIds = new uint256[](10);
        for (uint256 i; i < 10; i++) {
            uint256 sigId = _createSignal(genius);
            purchaseIds[i] = _purchaseSignal(genius, idiot, sigId, NOTIONAL, ODDS);
            _recordOutcome(genius, idiot, purchaseIds[i], outcomes[i]);
        }
    }

    // ─── Test 1: Complete Signal Lifecycle
    // ────────────────────────────────

    function test_completeLifecycle_commitToSettlement() public {
        // Step 1: Genius commits a signal with decoys
        uint256 signalId = _createSignal(genius1);
        Signal memory sig = signalCommitment.getSignal(signalId);
        assertEq(sig.genius, genius1);
        assertEq(uint8(sig.status), uint8(SignalStatus.Active));
        assertEq(sig.decoyLines.length, 10);

        // Step 2: Genius stores key recovery blob
        vm.prank(genius1);
        keyRecovery.storeRecoveryBlob(hex"aabbccdd");
        assertEq(keyRecovery.getRecoveryBlob(genius1), hex"aabbccdd");

        // Step 3: Genius deposits collateral
        uint256 lockAmount = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000 + (NOTIONAL * 50) / 10_000;
        uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        uint256 protocolFeeSlash = (NOTIONAL * 50) / 10_000;
        _depositCollateral(genius1, lockAmount + fee + protocolFeeSlash);

        // Step 4: Idiot deposits USDC into escrow
        _depositEscrow(idiot1, fee);
        assertEq(escrow.getBalance(idiot1), fee);

        // Step 5: Idiot purchases signal
        vm.prank(idiot1);
        uint256 purchaseId = escrow.purchase(signalId, NOTIONAL, ODDS);

        // Verify purchase recorded
        Purchase memory p = escrow.getPurchase(purchaseId);
        assertEq(p.idiot, idiot1);
        assertEq(p.notional, NOTIONAL);
        assertEq(p.feePaid, fee);
        assertEq(uint8(p.outcome), uint8(Outcome.Pending));

        // Verify signal status stays Active (multi-purchase support)
        sig = signalCommitment.getSignal(signalId);
        assertEq(uint8(sig.status), uint8(SignalStatus.Active));

        // Verify collateral locked
        assertEq(collateral.getSignalLock(genius1, signalId), lockAmount);

        // Verify account updated
        assertEq(account.getSignalCount(genius1, idiot1), 1);

        // Step 6: Game outcome attested (Favorable)
        _recordOutcome(genius1, idiot1, purchaseId, Outcome.Favorable);
        assertEq(uint8(account.getOutcome(genius1, idiot1, purchaseId)), uint8(Outcome.Favorable));

        // Step 7: Complete remaining 9 signals to reach audit threshold
        for (uint256 i = 1; i < 10; i++) {
            uint256 sid = _createSignal(genius1);
            uint256 pid = _purchaseSignal(genius1, idiot1, sid, NOTIONAL, ODDS);
            _recordOutcome(genius1, idiot1, pid, Outcome.Favorable);
        }

        // Step 8: Audit triggers at 10 signals
        assertTrue(account.isAuditReady(genius1, idiot1));
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        audit.trigger(genius1, idiot1);

        // Step 9: Verify settlement
        AuditResult memory result = audit.getAuditResult(genius1, idiot1, 0);
        assertTrue(result.qualityScore > 0, "All favorable should give positive score");
        assertEq(result.trancheA, 0, "No refund for positive score");
        assertEq(result.trancheB, 0, "No credits for positive score");
        assertTrue(result.protocolFee > 0, "Protocol fee should be collected");
        assertTrue(usdc.balanceOf(treasury) > treasuryBefore, "Treasury should receive fee");

        // Step 10: New cycle starts
        assertEq(account.getCurrentCycle(genius1, idiot1), 1);
        assertEq(account.getSignalCount(genius1, idiot1), 0);

        // Step 11: Collateral released
        assertEq(collateral.getLocked(genius1), 0);
    }

    // ─── Test 2: Multiple Genius-Idiot Pairs Simultaneously ──────────────

    function test_multiplePairs_independent() public {
        // Pair 1: genius1 + idiot1 (all favorable)
        Outcome[] memory outcomes1 = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes1[i] = Outcome.Favorable;
        }

        // Pair 2: genius2 + idiot2 (all unfavorable)
        Outcome[] memory outcomes2 = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes2[i] = Outcome.Unfavorable;
        }

        // Run both cycles
        _fullCycle(genius1, idiot1, outcomes1);
        _fullCycle(genius2, idiot2, outcomes2);

        // Both should be audit ready
        assertTrue(account.isAuditReady(genius1, idiot1));
        assertTrue(account.isAuditReady(genius2, idiot2));

        // Settle pair 1 (positive score)
        audit.trigger(genius1, idiot1);
        AuditResult memory r1 = audit.getAuditResult(genius1, idiot1, 0);
        assertTrue(r1.qualityScore > 0);

        // Settle pair 2 (negative score)
        audit.trigger(genius2, idiot2);
        AuditResult memory r2 = audit.getAuditResult(genius2, idiot2, 0);
        assertTrue(r2.qualityScore < 0);
        assertTrue(r2.trancheA > 0 || r2.trancheB > 0, "Damages should exist");

        // Both move to cycle 1 independently
        assertEq(account.getCurrentCycle(genius1, idiot1), 1);
        assertEq(account.getCurrentCycle(genius2, idiot2), 1);
    }

    // ─── Test 3: Cross-Pair (One Genius, Multiple Idiots) ────────────────

    function test_oneGenius_multipleIdiots() public {
        // genius1 with idiot1: favorable
        Outcome[] memory outcomes1 = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes1[i] = Outcome.Favorable;
        }
        _fullCycle(genius1, idiot1, outcomes1);

        // genius1 with idiot2: unfavorable
        Outcome[] memory outcomes2 = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes2[i] = Outcome.Unfavorable;
        }
        _fullCycle(genius1, idiot2, outcomes2);

        // Settle both
        audit.trigger(genius1, idiot1);
        audit.trigger(genius1, idiot2);

        AuditResult memory r1 = audit.getAuditResult(genius1, idiot1, 0);
        AuditResult memory r2 = audit.getAuditResult(genius1, idiot2, 0);

        assertTrue(r1.qualityScore > 0, "Pair 1 should be positive");
        assertTrue(r2.qualityScore < 0, "Pair 2 should be negative");
    }

    // ─── Test 4: Multi-Cycle with Credit Reuse
    // ──────────────────────────

    function test_multiCycle_creditsFromCycle0_usedInCycle1() public {
        // Cycle 0: all unfavorable -> idiot gets credits from tranche B
        Outcome[] memory outcomes0 = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes0[i] = Outcome.Unfavorable;
        }
        _fullCycle(genius1, idiot1, outcomes0);

        audit.trigger(genius1, idiot1);

        AuditResult memory r0 = audit.getAuditResult(genius1, idiot1, 0);
        assertTrue(r0.trancheB > 0, "Should have credits from tranche B");

        uint256 creditsBefore = creditLedger.balanceOf(idiot1);
        assertTrue(creditsBefore > 0, "Idiot should have credits");

        // Cycle 1: Use credits to pay for purchases
        // Create a signal and purchase using credits
        uint256 sigId = _createSignal(genius1);
        uint256 lockAmount = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000 + (NOTIONAL * 50) / 10_000;
        uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        uint256 protocolFeeShare = (NOTIONAL * 50) / 10_000;
        _depositCollateral(genius1, lockAmount + fee + protocolFeeShare);

        // If credits >= fee, no USDC needed
        if (creditsBefore >= fee) {
            // No USDC deposit needed, credits cover the fee
            vm.prank(idiot1);
            uint256 pid = escrow.purchase(sigId, NOTIONAL, ODDS);

            Purchase memory p = escrow.getPurchase(pid);
            assertEq(p.creditUsed, fee, "Credits should cover full fee");
            assertEq(p.usdcPaid, 0, "No USDC should be paid");
            assertEq(creditLedger.balanceOf(idiot1), creditsBefore - fee, "Credits should be burned");
        } else {
            // Credits partially offset the fee
            uint256 usdcNeeded = fee - creditsBefore;
            _depositEscrow(idiot1, usdcNeeded);

            vm.prank(idiot1);
            uint256 pid = escrow.purchase(sigId, NOTIONAL, ODDS);

            Purchase memory p = escrow.getPurchase(pid);
            assertEq(p.creditUsed, creditsBefore, "All credits should be used");
            assertEq(p.usdcPaid, usdcNeeded, "Remaining paid in USDC");
            assertEq(creditLedger.balanceOf(idiot1), 0, "All credits should be burned");
        }
    }

    // ─── Test 5: Three Full Cycles
    // ──────────────────────────────────────

    function test_threeCycles() public {
        for (uint256 cycle; cycle < 3; cycle++) {
            Outcome[] memory outcomes = new Outcome[](10);
            for (uint256 i; i < 10; i++) {
                outcomes[i] = (cycle % 2 == 0) ? Outcome.Favorable : Outcome.Unfavorable;
            }
            _fullCycle(genius1, idiot1, outcomes);
            audit.trigger(genius1, idiot1);

            assertEq(account.getCurrentCycle(genius1, idiot1), cycle + 1);
        }

        // Verify all three audit results exist
        AuditResult memory r0 = audit.getAuditResult(genius1, idiot1, 0);
        AuditResult memory r1 = audit.getAuditResult(genius1, idiot1, 1);
        AuditResult memory r2 = audit.getAuditResult(genius1, idiot1, 2);

        assertTrue(r0.qualityScore > 0, "Cycle 0 should be positive");
        assertTrue(r1.qualityScore < 0, "Cycle 1 should be negative");
        assertTrue(r2.qualityScore > 0, "Cycle 2 should be positive");
        assertTrue(r0.timestamp > 0);
        assertTrue(r1.timestamp > 0);
        assertTrue(r2.timestamp > 0);
    }

    // ─── Test 6: Settlement With Mixed Outcomes Preserves Invariants ─────

    function test_settlement_invariants() public {
        // Track total USDC in system before
        uint256 totalMinted = 0;

        Outcome[] memory outcomes = new Outcome[](10);
        outcomes[0] = Outcome.Favorable;
        outcomes[1] = Outcome.Favorable;
        outcomes[2] = Outcome.Favorable;
        outcomes[3] = Outcome.Unfavorable;
        outcomes[4] = Outcome.Unfavorable;
        outcomes[5] = Outcome.Unfavorable;
        outcomes[6] = Outcome.Unfavorable;
        outcomes[7] = Outcome.Unfavorable;
        outcomes[8] = Outcome.Void;
        outcomes[9] = Outcome.Void;

        // Create and purchase signals
        for (uint256 i; i < 10; i++) {
            uint256 sigId = _createSignal(genius1);
            uint256 lockAmount = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000 + (NOTIONAL * 50) / 10_000;
            uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
            uint256 protocolFeeShare = (NOTIONAL * 50) / 10_000;

            uint256 totalForSignal = lockAmount + fee + protocolFeeShare;
            usdc.mint(genius1, totalForSignal);
            totalMinted += totalForSignal;
            vm.startPrank(genius1);
            usdc.approve(address(collateral), totalForSignal);
            collateral.deposit(totalForSignal);
            vm.stopPrank();

            usdc.mint(idiot1, fee);
            totalMinted += fee;
            vm.startPrank(idiot1);
            usdc.approve(address(escrow), fee);
            escrow.deposit(fee);
            vm.stopPrank();

            vm.prank(idiot1);
            uint256 pid = escrow.purchase(sigId, NOTIONAL, ODDS);
            _recordOutcome(genius1, idiot1, pid, outcomes[i]);
        }

        // Settlement
        audit.trigger(genius1, idiot1);

        // Invariant: all USDC accounted for
        uint256 totalSystemUsdc = usdc.balanceOf(address(escrow)) + usdc.balanceOf(address(collateral))
            + usdc.balanceOf(treasury) + usdc.balanceOf(genius1) + usdc.balanceOf(idiot1);

        assertEq(totalSystemUsdc, totalMinted, "USDC conservation invariant violated");

        // Invariant: collateral locks fully released
        assertEq(collateral.getLocked(genius1), 0, "All locks should be released");
    }

    // ─── Test 7: Early Exit Then Full Cycle
    // ─────────────────────────────

    function test_earlyExit_thenFullCycle() public {
        // Create 5 signals (not enough for audit)
        for (uint256 i; i < 5; i++) {
            uint256 sigId = _createSignal(genius1);
            uint256 pid = _purchaseSignal(genius1, idiot1, sigId, NOTIONAL, ODDS);
            _recordOutcome(genius1, idiot1, pid, Outcome.Unfavorable);
        }

        assertFalse(account.isAuditReady(genius1, idiot1));

        // Early exit
        vm.prank(idiot1);
        audit.earlyExit(genius1, idiot1);

        uint256 creditsAfterEarlyExit = creditLedger.balanceOf(idiot1);
        assertTrue(creditsAfterEarlyExit > 0, "Should have credits from early exit");
        assertEq(account.getCurrentCycle(genius1, idiot1), 1, "Should be on cycle 1");

        // Now do a full cycle
        Outcome[] memory outcomes = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Favorable;
        }
        _fullCycle(genius1, idiot1, outcomes);

        audit.trigger(genius1, idiot1);
        assertEq(account.getCurrentCycle(genius1, idiot1), 2, "Should be on cycle 2");
    }

    // ─── Test 8: Concurrent Signals from Same Genius
    // ────────────────────

    function test_concurrent_signals_sameGenius() public {
        // Genius creates multiple signals at once, each purchased by different idiots
        uint256 sig1 = _createSignal(genius1);
        uint256 sig2 = _createSignal(genius1);

        // idiot1 purchases sig1
        uint256 pid1 = _purchaseSignal(genius1, idiot1, sig1, NOTIONAL, ODDS);
        _recordOutcome(genius1, idiot1, pid1, Outcome.Favorable);

        // idiot2 purchases sig2
        uint256 pid2 = _purchaseSignal(genius1, idiot2, sig2, NOTIONAL, ODDS);
        _recordOutcome(genius1, idiot2, pid2, Outcome.Unfavorable);

        // Both accounts updated independently
        assertEq(account.getSignalCount(genius1, idiot1), 1);
        assertEq(account.getSignalCount(genius1, idiot2), 1);
    }

    // ─── Test 9: Varying Notional and Odds Across Signals ───────────────

    function test_varyingNotionalAndOdds() public {
        uint256[] memory notionals = new uint256[](10);
        uint256[] memory oddsArr = new uint256[](10);
        Outcome[] memory outcomes = new Outcome[](10);

        notionals[0] = 500e6;
        oddsArr[0] = 1_500_000;
        outcomes[0] = Outcome.Favorable;
        notionals[1] = 2000e6;
        oddsArr[1] = 2_000_000;
        outcomes[1] = Outcome.Favorable;
        notionals[2] = 100e6;
        oddsArr[2] = 3_000_000;
        outcomes[2] = Outcome.Unfavorable;
        notionals[3] = 1000e6;
        oddsArr[3] = 1_910_000;
        outcomes[3] = Outcome.Unfavorable;
        notionals[4] = 750e6;
        oddsArr[4] = 1_800_000;
        outcomes[4] = Outcome.Favorable;
        notionals[5] = 300e6;
        oddsArr[5] = 2_500_000;
        outcomes[5] = Outcome.Void;
        notionals[6] = 1500e6;
        oddsArr[6] = 1_200_000;
        outcomes[6] = Outcome.Favorable;
        notionals[7] = 200e6;
        oddsArr[7] = 4_000_000;
        outcomes[7] = Outcome.Unfavorable;
        notionals[8] = 800e6;
        oddsArr[8] = 1_600_000;
        outcomes[8] = Outcome.Void;
        notionals[9] = 1000e6;
        oddsArr[9] = 1_910_000;
        outcomes[9] = Outcome.Favorable;

        for (uint256 i; i < 10; i++) {
            uint256 sigId = _createSignal(genius1);
            uint256 lockAmount = (notionals[i] * SLA_MULTIPLIER_BPS) / 10_000;
            uint256 fee = (notionals[i] * MAX_PRICE_BPS) / 10_000;
            uint256 protocolFeeSlash = (notionals[i] * 50) / 10_000;
            _depositCollateral(genius1, lockAmount + fee + protocolFeeSlash);
            _depositEscrow(idiot1, fee);

            vm.prank(idiot1);
            uint256 pid = escrow.purchase(sigId, notionals[i], oddsArr[i]);
            _recordOutcome(genius1, idiot1, pid, outcomes[i]);
        }

        // Compute expected score manually
        int256 expectedScore = 0;
        for (uint256 i; i < 10; i++) {
            if (outcomes[i] == Outcome.Favorable) {
                expectedScore += int256(notionals[i]) * (int256(oddsArr[i]) - 1e6) / 1e6;
            } else if (outcomes[i] == Outcome.Unfavorable) {
                expectedScore -= int256(notionals[i]) * int256(SLA_MULTIPLIER_BPS) / 10_000;
            }
        }

        int256 actualScore = audit.computeScore(genius1, idiot1);
        assertEq(actualScore, expectedScore, "Score should match manual computation");

        audit.trigger(genius1, idiot1);

        AuditResult memory result = audit.getAuditResult(genius1, idiot1, 0);
        assertEq(result.qualityScore, expectedScore, "Stored score should match");
    }

    // ─── Test 10: Full Lifecycle Through Claim and Withdraw ─────────────

    function test_fullLifecycle_throughClaimAndWithdraw() public {
        // Step 1: Run a full favorable cycle
        Outcome[] memory outcomes = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Favorable;
        }
        _fullCycle(genius1, idiot1, outcomes);

        // Step 2: Settle
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        audit.trigger(genius1, idiot1);

        AuditResult memory result = audit.getAuditResult(genius1, idiot1, 0);
        assertTrue(result.qualityScore > 0, "All favorable should give positive score");
        assertTrue(result.timestamp > 0, "Settlement timestamp should be set");

        // Step 3: Genius tries to claim fees immediately → ClaimTooEarly
        uint256 claimableAt = result.timestamp + escrow.FEE_CLAIM_DELAY();
        vm.expectRevert(
            abi.encodeWithSelector(Escrow.ClaimTooEarly.selector, genius1, idiot1, 0, claimableAt)
        );
        vm.prank(genius1);
        escrow.claimFees(idiot1, 0);

        // Step 4: Warp past fee claim delay
        vm.warp(result.timestamp + 48 hours + 1);

        // Step 5: Genius claims fees → success
        uint256 feePoolBalance = escrow.feePool(genius1, idiot1, 0);
        assertTrue(feePoolBalance > 0, "Fee pool should have USDC");

        uint256 geniusBalBefore = usdc.balanceOf(genius1);
        vm.prank(genius1);
        escrow.claimFees(idiot1, 0);

        assertEq(usdc.balanceOf(genius1), geniusBalBefore + feePoolBalance, "Genius should receive fees");
        assertEq(escrow.feePool(genius1, idiot1, 0), 0, "Fee pool should be zero after claim");

        // Step 6: Verify cycle advanced and system is clean
        assertEq(account.getCurrentCycle(genius1, idiot1), 1, "Should be on cycle 1");
        assertEq(collateral.getLocked(genius1), 0, "All collateral locks released");
        assertTrue(usdc.balanceOf(treasury) > treasuryBefore, "Treasury received protocol fee");
    }

    // ─── Test 11: Protocol Fee Accuracy Across Varied Notionals ─────────

    function test_protocolFee_variedNotionals() public {
        uint256 totalNotional = 0;

        for (uint256 i; i < 10; i++) {
            uint256 notional = (i + 1) * 100e6; // 100, 200, ... 1000 USDC
            totalNotional += notional;

            uint256 sigId = _createSignal(genius1);
            uint256 lockAmount = (notional * SLA_MULTIPLIER_BPS) / 10_000 + (notional * 50) / 10_000;
            uint256 fee = (notional * MAX_PRICE_BPS) / 10_000;
            uint256 protocolFeeSlash = (notional * 50) / 10_000;
            _depositCollateral(genius1, lockAmount + fee + protocolFeeSlash);
            _depositEscrow(idiot1, fee);

            vm.prank(idiot1);
            uint256 pid = escrow.purchase(sigId, notional, ODDS);
            _recordOutcome(genius1, idiot1, pid, Outcome.Favorable);
        }

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        audit.trigger(genius1, idiot1);

        uint256 expectedProtocolFee = (totalNotional * 50) / 10_000;
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, expectedProtocolFee, "Protocol fee wrong");
    }
}
