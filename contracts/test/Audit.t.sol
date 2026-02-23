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
import {Outcome} from "../src/interfaces/IDjinn.sol";

/// @title AuditIntegrationTest
/// @notice Full lifecycle integration tests for the Audit contract
contract AuditIntegrationTest is Test {
    MockUSDC usdc;
    SignalCommitment signalCommitment;
    Escrow escrow;
    Collateral collateral;
    CreditLedger creditLedger;
    DjinnAccount account;
    Audit audit;

    address owner;
    address genius = address(0xBEEF);
    address idiot = address(0xCAFE);
    address treasury = address(0xFEE5);

    // Signal parameters
    uint256 constant MAX_PRICE_BPS = 500; // 5%
    uint256 constant SLA_MULTIPLIER_BPS = 15_000; // 150%
    uint256 constant NOTIONAL = 1000e6; // 1000 USDC
    uint256 constant ODDS = 1_910_000; // 1.91 (6 decimal fixed point)

    function setUp() public {
        owner = address(this);

        // Deploy all contracts
        usdc = new MockUSDC();
        signalCommitment = new SignalCommitment(owner);
        escrow = new Escrow(address(usdc), owner);
        collateral = new Collateral(address(usdc), owner);
        creditLedger = new CreditLedger(owner);
        account = new DjinnAccount(owner);
        audit = new Audit(owner);

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
        account.setAuthorizedCaller(owner, true); // test contract records outcomes
        escrow.setAuthorizedCaller(owner, true); // test contract sets purchase outcomes
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

    function _createSignal(uint256 signalId, uint256 sla) internal {
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: signalId,
                encryptedBlob: hex"deadbeef",
                commitHash: keccak256(abi.encodePacked("signal", signalId)),
                sport: "NFL",
                maxPriceBps: MAX_PRICE_BPS,
                slaMultiplierBps: sla,
                maxNotional: 10_000e6,
                minNotional: 0,
                expiresAt: block.timestamp + 1 days,
                decoyLines: _buildDecoyLines(),
                availableSportsbooks: _buildSportsbooks()
            })
        );
    }

    function _createSignal(uint256 signalId) internal {
        _createSignal(signalId, SLA_MULTIPLIER_BPS);
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

    /// @dev Record outcome on both Account and Escrow (Purchase struct)
    function _recordOutcome(uint256 purchaseId, Outcome outcome) internal {
        account.recordOutcome(genius, idiot, purchaseId, outcome);
        escrow.setOutcome(purchaseId, outcome);
    }

    /// @dev Create a signal, deposit collateral + extra for slashing, deposit escrow, purchase, record outcome
    function _createAndPurchaseSignal(uint256 signalId, uint256 notional, uint256 odds, uint256 sla, Outcome outcome)
        internal
        returns (uint256 purchaseId)
    {
        _createSignal(signalId, sla);

        // Lock amount + surplus for protocol fee (0.5%) + potential trancheA refund (fee amount)
        uint256 lockAmount = (notional * sla) / 10_000;
        uint256 fee = (notional * MAX_PRICE_BPS) / 10_000;
        uint256 protocolFeeShare = (notional * 50) / 10_000;
        _depositGeniusCollateral(lockAmount + fee + protocolFeeShare);

        _depositIdiotEscrow(fee);

        vm.prank(idiot);
        purchaseId = escrow.purchase(signalId, notional, odds);

        // Record outcome on both Account and Escrow
        if (outcome != Outcome.Pending) {
            _recordOutcome(purchaseId, outcome);
        }
    }

    /// @dev Create 10 signals and purchase all, returning purchase IDs
    function _create10Signals(Outcome[] memory outcomes, uint256[] memory notionals, uint256[] memory oddsArr)
        internal
        returns (uint256[] memory purchaseIds)
    {
        purchaseIds = new uint256[](10);
        for (uint256 i; i < 10; i++) {
            purchaseIds[i] = _createAndPurchaseSignal(
                i + 1, // signalId
                notionals[i],
                oddsArr[i],
                SLA_MULTIPLIER_BPS,
                outcomes[i]
            );
        }
    }

    function _uniformArrays() internal pure returns (uint256[] memory notionals, uint256[] memory oddsArr) {
        notionals = new uint256[](10);
        oddsArr = new uint256[](10);
        for (uint256 i; i < 10; i++) {
            notionals[i] = NOTIONAL;
            oddsArr[i] = ODDS;
        }
    }

    // ─── Quality Score Computation
    // ───────────────────────────────────────

    function test_qualityScore_computation() public {
        // Create 10 signals: 6 favorable, 3 unfavorable, 1 void
        Outcome[] memory outcomes = new Outcome[](10);
        outcomes[0] = Outcome.Favorable;
        outcomes[1] = Outcome.Favorable;
        outcomes[2] = Outcome.Favorable;
        outcomes[3] = Outcome.Favorable;
        outcomes[4] = Outcome.Favorable;
        outcomes[5] = Outcome.Favorable;
        outcomes[6] = Outcome.Unfavorable;
        outcomes[7] = Outcome.Unfavorable;
        outcomes[8] = Outcome.Unfavorable;
        outcomes[9] = Outcome.Void;

        (uint256[] memory notionals, uint256[] memory oddsArr) = _uniformArrays();
        _create10Signals(outcomes, notionals, oddsArr);

        int256 score = audit.computeScore(genius, idiot);

        // Favorable: +notional * (odds - 1e6) / 1e6
        // = 1000e6 * (1_910_000 - 1_000_000) / 1_000_000
        // = 1000e6 * 910_000 / 1_000_000
        // = 910e6 per favorable
        int256 favorablePerSignal = int256(NOTIONAL) * (int256(ODDS) - 1e6) / 1e6;
        assertEq(favorablePerSignal, 910e6, "Favorable gain per signal wrong");

        // Unfavorable: -notional * slaMultiplierBps / 10000
        // = 1000e6 * 15000 / 10000 = 1500e6 per unfavorable
        int256 unfavorablePerSignal = int256(NOTIONAL) * int256(SLA_MULTIPLIER_BPS) / 10_000;
        assertEq(unfavorablePerSignal, 1500e6, "Unfavorable loss per signal wrong");

        // Expected: 6 * 910e6 - 3 * 1500e6 = 5460e6 - 4500e6 = 960e6
        int256 expected = 6 * favorablePerSignal - 3 * unfavorablePerSignal;
        assertEq(score, expected, "Quality score mismatch");
        assertTrue(score > 0, "Score should be positive");
    }

    function test_qualityScore_all_unfavorable() public {
        Outcome[] memory outcomes = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Unfavorable;
        }

        (uint256[] memory notionals, uint256[] memory oddsArr) = _uniformArrays();
        _create10Signals(outcomes, notionals, oddsArr);

        int256 score = audit.computeScore(genius, idiot);

        // All unfavorable: -10 * notional * sla / 10000
        int256 expected = -10 * int256(NOTIONAL) * int256(SLA_MULTIPLIER_BPS) / 10_000;
        assertEq(score, expected, "All unfavorable score wrong");
        assertTrue(score < 0, "Score should be negative");
    }

    function test_qualityScore_all_favorable() public {
        Outcome[] memory outcomes = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Favorable;
        }

        (uint256[] memory notionals, uint256[] memory oddsArr) = _uniformArrays();
        _create10Signals(outcomes, notionals, oddsArr);

        int256 score = audit.computeScore(genius, idiot);

        int256 expected = 10 * int256(NOTIONAL) * (int256(ODDS) - 1e6) / 1e6;
        assertEq(score, expected, "All favorable score wrong");
        assertTrue(score > 0, "Score should be positive");
    }

    function test_qualityScore_void_skipped() public {
        Outcome[] memory outcomes = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Void;
        }

        (uint256[] memory notionals, uint256[] memory oddsArr) = _uniformArrays();
        _create10Signals(outcomes, notionals, oddsArr);

        int256 score = audit.computeScore(genius, idiot);
        assertEq(score, 0, "All void signals should give zero score");
    }

    // ─── Positive QS: Genius Keeps Fees
    // ──────────────────────────────────

    function test_positiveScore_geniusKeepsFees() public {
        Outcome[] memory outcomes = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Favorable;
        }

        (uint256[] memory notionals, uint256[] memory oddsArr) = _uniformArrays();
        _create10Signals(outcomes, notionals, oddsArr);

        uint256 idiotBalBefore = escrow.getBalance(idiot);
        uint256 creditsBefore = creditLedger.balanceOf(idiot);

        audit.trigger(genius, idiot);

        // Idiot should get no refund (trancheA=0, trancheB=0)
        assertEq(escrow.getBalance(idiot), idiotBalBefore, "Idiot should get no USDC refund");
        assertEq(creditLedger.balanceOf(idiot), creditsBefore, "Idiot should get no credits");

        // Protocol fee should go to treasury
        uint256 totalNotional = 10 * NOTIONAL;
        uint256 expectedProtocolFee = (totalNotional * 50) / 10_000; // 0.5%
        assertEq(usdc.balanceOf(treasury), expectedProtocolFee, "Treasury should receive protocol fee");

        // Verify audit result stored
        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertTrue(result.qualityScore > 0, "Score should be positive");
        assertEq(result.trancheA, 0, "No tranche A for positive score");
        assertEq(result.trancheB, 0, "No tranche B for positive score");
        assertEq(result.protocolFee, expectedProtocolFee, "Protocol fee mismatch");
        assertTrue(result.timestamp > 0, "Timestamp should be set");
    }

    // ─── Negative QS: Tranche A + B
    // ─────────────────────────────────────

    function test_negativeScore_trancheA_and_B() public {
        // All unfavorable -> large negative score -> damages exceed fees paid
        Outcome[] memory outcomes = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Unfavorable;
        }

        (uint256[] memory notionals, uint256[] memory oddsArr) = _uniformArrays();
        _create10Signals(outcomes, notionals, oddsArr);

        uint256 idiotUsdcBefore = usdc.balanceOf(idiot);
        uint256 creditsBefore = creditLedger.balanceOf(idiot);

        // Total damages = 10 * 1000e6 * 15000/10000 = 15_000e6
        uint256 totalDamages = 10 * NOTIONAL * SLA_MULTIPLIER_BPS / 10_000;
        // Total fees paid in USDC per signal = 1000e6 * 500/10000 = 50e6
        uint256 feePerSignal = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        uint256 totalUsdcFeesPaid = 10 * feePerSignal;
        // Tranche A: capped at total USDC fees paid
        uint256 expectedTrancheA = totalUsdcFeesPaid; // 500e6 (damages > fees)
        // Tranche B: excess as credits
        uint256 expectedTrancheB = totalDamages - expectedTrancheA;

        audit.trigger(genius, idiot);

        // Idiot gets USDC refund (tranche A) directly to wallet from genius collateral
        assertEq(usdc.balanceOf(idiot), idiotUsdcBefore + expectedTrancheA, "Idiot should get tranche A USDC refund");

        // Idiot gets credits (tranche B)
        assertEq(creditLedger.balanceOf(idiot), creditsBefore + expectedTrancheB, "Idiot should get tranche B credits");

        // Verify audit result
        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertTrue(result.qualityScore < 0, "Score should be negative");
        assertEq(result.trancheA, expectedTrancheA, "Tranche A mismatch");
        assertEq(result.trancheB, expectedTrancheB, "Tranche B mismatch");
    }

    function test_negativeScore_trancheA_only_when_damages_less_than_fees() public {
        // 9 void + 1 unfavorable with small notional
        // damage = 300e6 * 15000/10000 = 450e6
        // total USDC fees = 9 * 50e6 + 15e6 = 465e6
        // damages 450e6 < fees 465e6 -> trancheA = 450e6, trancheB = 0

        uint256[] memory notionals = new uint256[](10);
        uint256[] memory oddsArr = new uint256[](10);
        Outcome[] memory outcomes = new Outcome[](10);

        for (uint256 i; i < 9; i++) {
            notionals[i] = NOTIONAL;
            oddsArr[i] = ODDS;
            outcomes[i] = Outcome.Void;
        }
        notionals[9] = 300e6;
        oddsArr[9] = ODDS;
        outcomes[9] = Outcome.Unfavorable;

        for (uint256 i; i < 10; i++) {
            uint256 sigId = 500 + i;
            _createSignal(sigId);

            uint256 lockAmount = (notionals[i] * SLA_MULTIPLIER_BPS) / 10_000;
            uint256 feeShare = (notionals[i] * MAX_PRICE_BPS) / 10_000;
            uint256 protocolFeeShare = (notionals[i] * 50) / 10_000;
            _depositGeniusCollateral(lockAmount + feeShare + protocolFeeShare);

            uint256 fee = (notionals[i] * MAX_PRICE_BPS) / 10_000;
            _depositIdiotEscrow(fee);

            vm.prank(idiot);
            uint256 pid = escrow.purchase(sigId, notionals[i], oddsArr[i]);

            if (outcomes[i] != Outcome.Pending) {
                _recordOutcome(pid, outcomes[i]);
            }
        }

        uint256 expectedDamages = 300e6 * SLA_MULTIPLIER_BPS / 10_000; // 450e6
        uint256 expectedTotalFees = 9 * (NOTIONAL * MAX_PRICE_BPS / 10_000) + (300e6 * MAX_PRICE_BPS / 10_000);

        assertTrue(expectedDamages < expectedTotalFees, "Damages should be less than fees for this test");

        uint256 idiotUsdcBefore = usdc.balanceOf(idiot);

        audit.trigger(genius, idiot);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.trancheA, expectedDamages, "Tranche A should equal total damages");
        assertEq(result.trancheB, 0, "Tranche B should be zero when damages < fees");
        assertEq(usdc.balanceOf(idiot), idiotUsdcBefore + expectedDamages, "Idiot should get full damage refund");
    }

    // ─── Protocol Fee
    // ────────────────────────────────────────────────────

    function test_protocolFee_half_percent() public {
        Outcome[] memory outcomes = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Favorable;
        }

        (uint256[] memory notionals, uint256[] memory oddsArr) = _uniformArrays();
        _create10Signals(outcomes, notionals, oddsArr);

        uint256 treasuryBefore = usdc.balanceOf(treasury);

        audit.trigger(genius, idiot);

        // totalNotional = 10 * 1000e6 = 10_000e6
        // protocolFee = 10_000e6 * 50 / 10_000 = 50e6 (0.5%)
        uint256 expectedFee = (10 * NOTIONAL * 50) / 10_000;
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, expectedFee, "Protocol fee incorrect");

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.protocolFee, expectedFee, "Stored protocol fee mismatch");
    }

    // ─── Collateral Release After Settlement
    // ─────────────────────────────

    function test_collateralReleasedAfterSettlement() public {
        Outcome[] memory outcomes = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Favorable;
        }

        (uint256[] memory notionals, uint256[] memory oddsArr) = _uniformArrays();
        _create10Signals(outcomes, notionals, oddsArr);

        // All signal locks should exist before settlement
        for (uint256 i; i < 10; i++) {
            uint256 lockAmount = collateral.getSignalLock(genius, i + 1);
            assertTrue(lockAmount > 0, "Signal lock should exist before settlement");
        }

        audit.trigger(genius, idiot);

        // After settlement, all signal locks should be released
        for (uint256 i; i < 10; i++) {
            uint256 lockAmount = collateral.getSignalLock(genius, i + 1);
            assertEq(lockAmount, 0, "Signal lock should be released after settlement");
        }

        // Total locked should be zero
        assertEq(collateral.getLocked(genius), 0, "Total locked should be zero after settlement");
    }

    // ─── New Cycle After Settlement
    // ──────────────────────────────────────

    function test_newCycleStartsAfterSettlement() public {
        Outcome[] memory outcomes = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Favorable;
        }

        (uint256[] memory notionals, uint256[] memory oddsArr) = _uniformArrays();
        _create10Signals(outcomes, notionals, oddsArr);

        uint256 cycleBefore = account.getCurrentCycle(genius, idiot);
        assertEq(cycleBefore, 0, "Initial cycle should be 0");
        assertEq(account.getSignalCount(genius, idiot), 10, "Should have 10 signals before audit");

        audit.trigger(genius, idiot);

        uint256 cycleAfter = account.getCurrentCycle(genius, idiot);
        assertEq(cycleAfter, cycleBefore + 1, "Cycle should increment after settlement");
        assertEq(account.getSignalCount(genius, idiot), 0, "Signal count should reset after new cycle");
    }

    // ─── Early Exit
    // ──────────────────────────────────────────────────────

    function test_earlyExit_creditsDamagesOnly() public {
        // Create 5 signals (less than 10) - all unfavorable
        for (uint256 i; i < 5; i++) {
            _createAndPurchaseSignal(i + 1, NOTIONAL, ODDS, SLA_MULTIPLIER_BPS, Outcome.Unfavorable);
        }

        uint256 idiotBalBefore = escrow.getBalance(idiot);

        vm.prank(idiot);
        audit.earlyExit(genius, idiot);

        // All damages should be in credits, not USDC
        assertEq(escrow.getBalance(idiot), idiotBalBefore, "Idiot should get no USDC refund on early exit");

        // Credits should be minted for the damages
        uint256 expectedDamages = 5 * NOTIONAL * SLA_MULTIPLIER_BPS / 10_000;
        assertEq(creditLedger.balanceOf(idiot), expectedDamages, "Credits should equal total damages on early exit");

        // Verify audit result
        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.trancheA, 0, "Early exit should have no tranche A");
        assertEq(result.trancheB, expectedDamages, "Early exit tranche B should be all damages");

        // Protocol fee should still be charged on early exits (prevents fee dodging)
        uint256 expectedFee = (5 * NOTIONAL * 50) / 10_000;
        assertGt(result.protocolFee, 0, "Early exit should charge protocol fee");
        assertEq(result.protocolFee, expectedFee, "Early exit protocol fee should be 0.5% of notional");
    }

    function test_earlyExit_positiveScore_noDamages() public {
        for (uint256 i; i < 5; i++) {
            _createAndPurchaseSignal(i + 1, NOTIONAL, ODDS, SLA_MULTIPLIER_BPS, Outcome.Favorable);
        }

        vm.prank(genius);
        audit.earlyExit(genius, idiot);

        assertEq(creditLedger.balanceOf(idiot), 0, "No credits should be minted for positive score");

        // Protocol fee charged even on positive early exits
        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertGt(result.protocolFee, 0, "Positive early exit should still charge protocol fee");
    }

    function test_earlyExit_onlyPartyCanTrigger() public {
        _createAndPurchaseSignal(1, NOTIONAL, ODDS, SLA_MULTIPLIER_BPS, Outcome.Favorable);

        address random = address(0xDEAD);
        vm.expectRevert(abi.encodeWithSelector(Audit.NotPartyToAudit.selector, random, genius, idiot));
        vm.prank(random);
        audit.earlyExit(genius, idiot);
    }

    function test_earlyExit_reverts_if_auditReady() public {
        Outcome[] memory outcomes = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Favorable;
        }
        (uint256[] memory notionals, uint256[] memory oddsArr) = _uniformArrays();
        _create10Signals(outcomes, notionals, oddsArr);

        vm.expectRevert(abi.encodeWithSelector(Audit.AuditAlreadyReady.selector, genius, idiot));
        vm.prank(idiot);
        audit.earlyExit(genius, idiot);
    }

    // ─── Cannot Re-settle Same Cycle
    // ─────────────────────────────────────

    function test_cannotResettle() public {
        Outcome[] memory outcomes = new Outcome[](10);
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Favorable;
        }

        (uint256[] memory notionals, uint256[] memory oddsArr) = _uniformArrays();
        _create10Signals(outcomes, notionals, oddsArr);

        audit.trigger(genius, idiot);

        vm.expectRevert(abi.encodeWithSelector(Audit.NotAuditReady.selector, genius, idiot));
        audit.trigger(genius, idiot);
    }

    // ─── Mixed Outcome Scenario (10 signals)
    // ────────────────────────────

    function test_mixedOutcome_fullLifecycle() public {
        // 10 signals: 4 favorable, 4 unfavorable, 2 void
        Outcome[] memory outcomes = new Outcome[](10);
        outcomes[0] = Outcome.Favorable;
        outcomes[1] = Outcome.Favorable;
        outcomes[2] = Outcome.Favorable;
        outcomes[3] = Outcome.Favorable;
        outcomes[4] = Outcome.Unfavorable;
        outcomes[5] = Outcome.Unfavorable;
        outcomes[6] = Outcome.Unfavorable;
        outcomes[7] = Outcome.Unfavorable;
        outcomes[8] = Outcome.Void;
        outcomes[9] = Outcome.Void;

        (uint256[] memory notionals, uint256[] memory oddsArr) = _uniformArrays();
        _create10Signals(outcomes, notionals, oddsArr);

        int256 score = audit.computeScore(genius, idiot);

        // favorable: 4 * 910e6 = 3640e6
        // unfavorable: 4 * 1500e6 = 6000e6
        // net = 3640e6 - 6000e6 = -2360e6
        int256 expected = 4 * int256(NOTIONAL) * (int256(ODDS) - 1e6) / 1e6 - 4 * int256(NOTIONAL)
            * int256(SLA_MULTIPLIER_BPS) / 10_000;
        assertEq(score, expected, "Mixed outcome score mismatch");
        assertTrue(score < 0, "Score should be negative for this mix");

        uint256 idiotUsdcBefore = usdc.balanceOf(idiot);

        audit.trigger(genius, idiot);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);

        uint256 totalDamages = uint256(-score);
        uint256 totalFees = 10 * (NOTIONAL * MAX_PRICE_BPS / 10_000);
        uint256 expectedA = totalFees; // damages > fees
        uint256 expectedB = totalDamages - expectedA;

        assertEq(result.trancheA, expectedA, "Tranche A mismatch in mixed scenario");
        assertEq(result.trancheB, expectedB, "Tranche B mismatch in mixed scenario");

        assertEq(usdc.balanceOf(idiot), idiotUsdcBefore + expectedA, "Idiot refund wrong");
        assertEq(creditLedger.balanceOf(idiot), expectedB, "Credits mismatch");
        assertEq(account.getCurrentCycle(genius, idiot), 1, "New cycle should start");
    }

    // ─── Protocol Fee With Void Signals
    // ──────────────────────────────────

    function test_protocolFee_excludesVoidNotional() public {
        Outcome[] memory outcomes = new Outcome[](10);
        for (uint256 i; i < 5; i++) {
            outcomes[i] = Outcome.Favorable;
        }
        for (uint256 i = 5; i < 10; i++) {
            outcomes[i] = Outcome.Void;
        }

        (uint256[] memory notionals, uint256[] memory oddsArr) = _uniformArrays();
        _create10Signals(outcomes, notionals, oddsArr);

        audit.trigger(genius, idiot);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);

        // Only 5 non-void signals contribute to notional
        uint256 expectedFee = (5 * NOTIONAL * 50) / 10_000;
        assertEq(result.protocolFee, expectedFee, "Protocol fee should exclude void notional");
    }

    // ─── Damages Priority Over Protocol Fee
    // ─────────────────────────────────────────────────

    function test_damagesPrioritizedOverProtocolFee() public {
        // Verify that when genius collateral is limited, damages (tranche A)
        // are paid first, and protocol fee only gets what remains.
        // 10 unfavorable signals with tight collateral.
        for (uint256 i; i < 10; i++) {
            uint256 sigId = 700 + i;
            _createSignal(sigId, SLA_MULTIPLIER_BPS);

            uint256 lockAmount = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
            uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
            // Only deposit lock + fee (no extra for protocol fee)
            _depositGeniusCollateral(lockAmount + fee);
            _depositIdiotEscrow(fee);

            vm.prank(idiot);
            uint256 pid = escrow.purchase(sigId, NOTIONAL, ODDS);
            _recordOutcome(pid, Outcome.Unfavorable);
        }

        uint256 idiotUsdcBefore = usdc.balanceOf(idiot);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        audit.trigger(genius, idiot);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);

        // Damages should be fully paid
        assertTrue(result.trancheA > 0, "Tranche A should be nonzero");
        assertEq(usdc.balanceOf(idiot), idiotUsdcBefore + result.trancheA, "Idiot should get damages");

        // Protocol fee may be partially paid (capped at available collateral)
        // The key invariant: damages + protocolFee(actual) <= total collateral deposited
        uint256 treasuryReceived = usdc.balanceOf(treasury) - treasuryBefore;
        assertTrue(treasuryReceived <= result.protocolFee, "Treasury should not receive more than recorded fee");
    }

    // ─── Zero Score Settlement
    // ─────────────────────────────────────────────────

    function test_zeroScore_noRefundNoCredit() public {
        // Mix favorable and unfavorable outcomes to get score near zero
        // 5 favorable + 5 void → positive score, no damages
        for (uint256 i; i < 10; i++) {
            uint256 sigId = 800 + i;
            _createSignal(sigId, SLA_MULTIPLIER_BPS);

            uint256 lockAmount = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
            uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
            uint256 protocolFeeShare = (NOTIONAL * 50) / 10_000;
            _depositGeniusCollateral(lockAmount + fee + protocolFeeShare);
            _depositIdiotEscrow(fee);

            vm.prank(idiot);
            uint256 pid = escrow.purchase(sigId, NOTIONAL, ODDS);
            _recordOutcome(pid, Outcome.Void);
        }

        audit.trigger(genius, idiot);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.qualityScore, 0, "Score should be zero with all voids");
        assertEq(result.trancheA, 0, "No damages when score >= 0");
        assertEq(result.trancheB, 0, "No credits when score >= 0");
    }

    // ─── Two Full Cycles
    // ─────────────────────────────────────────────────

    function test_twoCycles() public {
        // Cycle 0: all favorable
        (uint256[] memory notionals1, uint256[] memory oddsArr1) = _uniformArrays();

        for (uint256 i; i < 10; i++) {
            _createAndPurchaseSignal(i + 1, notionals1[i], oddsArr1[i], SLA_MULTIPLIER_BPS, Outcome.Favorable);
        }

        audit.trigger(genius, idiot);
        assertEq(account.getCurrentCycle(genius, idiot), 1, "Should be on cycle 1");

        // Cycle 1: all unfavorable
        for (uint256 i; i < 10; i++) {
            _createAndPurchaseSignal(i + 100, notionals1[i], oddsArr1[i], SLA_MULTIPLIER_BPS, Outcome.Unfavorable);
        }

        audit.trigger(genius, idiot);
        assertEq(account.getCurrentCycle(genius, idiot), 2, "Should be on cycle 2");

        // Verify both audit results exist
        AuditResult memory r0 = audit.getAuditResult(genius, idiot, 0);
        AuditResult memory r1 = audit.getAuditResult(genius, idiot, 1);
        assertTrue(r0.qualityScore > 0, "Cycle 0 should be positive");
        assertTrue(r1.qualityScore < 0, "Cycle 1 should be negative");
    }
}
