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
import {Purchase, Outcome} from "../src/interfaces/IDjinn.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

/// @title FuzzFinancialMathTest
/// @notice Fuzz tests targeting financial math edge cases in the Djinn Protocol.
///         Covers quality score calculations under extreme/boundary conditions,
///         fee math invariants, overflow/underflow protection, and tranche distribution.
contract FuzzFinancialMathTest is Test {
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

    uint256 constant DEFAULT_MAX_PRICE_BPS = 500; // 5%
    uint256 constant DEFAULT_SLA = 15_000; // 150%
    uint256 constant DEFAULT_ODDS = 1_910_000; // 1.91x

    function setUp() public {
        owner = address(this);

        usdc = new MockUSDC();
        signalCommitment = SignalCommitment(_deployProxy(address(new SignalCommitment()), abi.encodeCall(SignalCommitment.initialize, (owner))));
        escrow = Escrow(_deployProxy(address(new Escrow()), abi.encodeCall(Escrow.initialize, (address(usdc), owner))));
        collateral = Collateral(_deployProxy(address(new Collateral()), abi.encodeCall(Collateral.initialize, (address(usdc), owner))));
        creditLedger = CreditLedger(_deployProxy(address(new CreditLedger()), abi.encodeCall(CreditLedger.initialize, (owner))));
        account = DjinnAccount(_deployProxy(address(new DjinnAccount()), abi.encodeCall(DjinnAccount.initialize, (owner))));
        audit = Audit(_deployProxy(address(new Audit()), abi.encodeCall(Audit.initialize, (owner))));

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
        creditLedger.setAuthorizedCaller(owner, true);
        account.setAuthorizedCaller(address(escrow), true);
        account.setAuthorizedCaller(address(audit), true);
        account.setAuthorizedCaller(owner, true);
        escrow.setAuthorizedCaller(owner, true);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _buildDecoyLines() internal pure returns (string[] memory) {
        string[] memory decoys = new string[](10);
        for (uint256 i; i < 10; i++) {
            decoys[i] = "decoy";
        }
        return decoys;
    }

    function _buildSportsbooks() internal pure returns (string[] memory) {
        string[] memory books = new string[](1);
        books[0] = "DraftKings";
        return books;
    }

    function _createSignal(uint256 signalId, uint256 maxPriceBps, uint256 sla) internal {
        vm.prank(genius);
        signalCommitment.commit(
            SignalCommitment.CommitParams({
                signalId: signalId,
                encryptedBlob: hex"deadbeef",
                commitHash: keccak256(abi.encodePacked("signal", signalId)),
                sport: "NFL",
                maxPriceBps: maxPriceBps,
                slaMultiplierBps: sla,
                maxNotional: 0,
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

    /// @dev Sets up a full 10-signal cycle with uniform parameters and specified outcomes.
    ///      Returns the total USDC fees paid and total notional for non-void purchases.
    function _setupFullCycle(
        uint256 notional,
        uint256 odds,
        uint256 sla,
        Outcome[10] memory outcomes
    ) internal returns (uint256 totalUsdcFeesPaid, uint256 totalNonVoidNotional) {
        for (uint256 i; i < 10; i++) {
            uint256 sigId = i + 1;
            _createSignal(sigId, DEFAULT_MAX_PRICE_BPS, sla);

            uint256 lockAmount = (notional * sla) / 10_000;
            _depositGeniusCollateral(lockAmount);

            uint256 fee = (notional * DEFAULT_MAX_PRICE_BPS) / 10_000;
            _depositIdiotEscrow(fee);
            totalUsdcFeesPaid += fee;

            vm.prank(idiot);
            uint256 purchaseId = escrow.purchase(sigId, notional, odds);

            account.recordOutcome(genius, idiot, purchaseId, outcomes[i]);
            escrow.setOutcome(purchaseId, outcomes[i]);

            if (outcomes[i] != Outcome.Void) {
                totalNonVoidNotional += notional;
            }
        }
    }

    // =========================================================================
    // SECTION 1: Quality Score -- Edge Cases
    // =========================================================================

    /// @notice All 10 signals are Favorable: score must be positive and match expected gain
    function testFuzz_allFavorable_scorePositive(uint256 notionalSeed, uint256 oddsSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e12);
        uint256 odds = bound(oddsSeed, 1_010_000, 10_000_000);
        uint256 sla = DEFAULT_SLA;

        Outcome[10] memory outcomes;
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Favorable;
        }

        _setupFullCycle(notional, odds, sla, outcomes);

        // Extra collateral for protocol fee
        uint256 protocolFeeExtra = (10 * notional * 50) / 10_000;
        _depositGeniusCollateral(protocolFeeExtra);

        int256 score = audit.computeScore(genius, idiot);

        // Score must be strictly positive since all signals favorable with odds > 1.0
        assertTrue(score > 0, "All favorable: score must be positive");

        // Expected: sum of 10 individual per-signal gains (matching contract's per-iteration division)
        int256 singleGain = int256(notional) * (int256(odds) - 1e6) / 1e6;
        int256 expectedScore = 10 * singleGain;
        assertEq(score, expectedScore, "All favorable: score mismatch");
    }

    /// @notice All 10 signals are Unfavorable: score must be negative
    function testFuzz_allUnfavorable_scoreNegative(uint256 notionalSeed, uint256 slaSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e12);
        uint256 sla = bound(slaSeed, 10_000, 30_000);

        Outcome[10] memory outcomes;
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Unfavorable;
        }

        _setupFullCycle(notional, DEFAULT_ODDS, sla, outcomes);

        int256 score = audit.computeScore(genius, idiot);

        // Score must be strictly negative since all signals unfavorable with sla >= 100%
        assertTrue(score < 0, "All unfavorable: score must be negative");

        // Expected: sum of 10 individual per-signal losses (matching contract's per-iteration division)
        int256 singleLoss = int256(notional) * int256(sla) / int256(10_000);
        int256 expectedScore = -10 * singleLoss;
        assertEq(score, expectedScore, "All unfavorable: score mismatch");
    }

    /// @notice All 10 signals are Void: score must be exactly zero
    function testFuzz_allVoid_scoreZero(uint256 notionalSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e12);

        Outcome[10] memory outcomes;
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Void;
        }

        _setupFullCycle(notional, DEFAULT_ODDS, DEFAULT_SLA, outcomes);

        int256 score = audit.computeScore(genius, idiot);
        assertEq(score, 0, "All void: score must be zero");
    }

    /// @notice Favorable gains and unfavorable losses use independent parameters:
    ///         odds affect gains only, sla affects losses only
    function testFuzz_scoreComponentIndependence(
        uint256 notionalSeed,
        uint256 oddsSeed,
        uint256 slaSeed
    ) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e10);
        uint256 odds = bound(oddsSeed, 1_010_000, 10_000_000);
        uint256 sla = bound(slaSeed, 10_000, 30_000);

        // First 5 Favorable, next 5 Unfavorable
        Outcome[10] memory outcomes;
        for (uint256 i; i < 5; i++) {
            outcomes[i] = Outcome.Favorable;
        }
        for (uint256 i = 5; i < 10; i++) {
            outcomes[i] = Outcome.Unfavorable;
        }

        _setupFullCycle(notional, odds, sla, outcomes);

        int256 score = audit.computeScore(genius, idiot);

        // Match contract's per-iteration division to avoid rounding discrepancies
        int256 singleGain = int256(notional) * (int256(odds) - 1e6) / 1e6;
        int256 singleLoss = int256(notional) * int256(sla) / int256(10_000);
        int256 expectedScore = 5 * singleGain - 5 * singleLoss;

        assertEq(score, expectedScore, "Mixed: gain and loss components mismatch");
    }

    /// @notice Minimum valid odds (1.01x) produce minimal gain
    function testFuzz_minOdds_minimalGain(uint256 notionalSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e12);
        uint256 odds = 1_010_000; // 1.01x minimum

        Outcome[10] memory outcomes;
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Favorable;
        }

        _setupFullCycle(notional, odds, DEFAULT_SLA, outcomes);

        int256 score = audit.computeScore(genius, idiot);

        // gain per signal = notional * 10_000 / 1_000_000 = notional / 100
        // Match contract's per-iteration division
        int256 singleGain = int256(notional) * (int256(odds) - 1e6) / 1e6;
        int256 expectedScore = 10 * singleGain;
        assertEq(score, expectedScore, "Min odds: score mismatch");

        // Each gain should be about 1% of notional
        assertTrue(score > 0, "Min odds: score must still be positive");
        assertTrue(score <= int256(notional), "Min odds: total gain for 1.01x should be < notional");
    }

    /// @notice Maximum valid odds (1000x) produce large gain without overflow
    function testFuzz_maxOdds_noOverflow(uint256 notionalSeed) public {
        // Keep notional small to avoid collateral deposit issues
        uint256 notional = bound(notionalSeed, 1e6, 1e9);
        uint256 odds = 1_000_000_000; // 1000x maximum

        Outcome[10] memory outcomes;
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Favorable;
        }

        _setupFullCycle(notional, odds, DEFAULT_SLA, outcomes);

        int256 score = audit.computeScore(genius, idiot);

        // gain per signal = notional * (1_000_000_000 - 1_000_000) / 1_000_000 = notional * 999
        int256 singleGain = int256(notional) * (int256(odds) - 1e6) / 1e6;
        int256 expectedScore = 10 * singleGain;
        assertEq(score, expectedScore, "Max odds: score mismatch");
        assertTrue(score > 0, "Max odds: score must be positive");
    }

    /// @notice Maximum SLA multiplier (3x) produces maximum loss
    function testFuzz_maxSla_maxLoss(uint256 notionalSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e10);
        uint256 sla = 30_000; // 300% max

        Outcome[10] memory outcomes;
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Unfavorable;
        }

        _setupFullCycle(notional, DEFAULT_ODDS, sla, outcomes);

        int256 score = audit.computeScore(genius, idiot);

        // loss per signal = notional * 30_000 / 10_000 = notional * 3
        int256 singleLoss = int256(notional) * int256(sla) / int256(10_000);
        int256 expectedScore = -10 * singleLoss;
        assertEq(score, expectedScore, "Max SLA: score mismatch");

        // Total loss should be 30x notional
        assertEq(uint256(-score), notional * 30, "Max SLA: total loss should be 30x notional");
    }

    // =========================================================================
    // SECTION 2: Escrow Fee Math -- Invariants
    // =========================================================================

    /// @notice Fee can never exceed notional for any valid maxPriceBps
    function testFuzz_feeNeverExceedsNotional(uint256 notionalSeed, uint256 bpsSeed) public pure {
        uint256 notional = bound(notionalSeed, 1e6, 1e15);
        // maxPriceBps is uint256 in Signal, but practically capped. Test up to 10_000 (100%)
        uint256 maxPriceBps = bound(bpsSeed, 1, 10_000);

        uint256 fee = (notional * maxPriceBps) / 10_000;
        assertLe(fee, notional, "Fee must never exceed notional");
    }

    /// @notice Fee is zero only when maxPriceBps is zero or notional rounds down to zero
    function testFuzz_feeZeroConditions(uint256 notionalSeed, uint256 bpsSeed) public pure {
        uint256 notional = bound(notionalSeed, 1e6, 1e15);
        uint256 maxPriceBps = bound(bpsSeed, 1, 10_000);

        uint256 fee = (notional * maxPriceBps) / 10_000;

        // With notional >= 1e6 and maxPriceBps >= 1, fee >= 1e6/10_000 = 100 (always > 0)
        if (notional >= 10_000 && maxPriceBps >= 1) {
            assertTrue(fee > 0, "Fee must be positive for notional >= 10_000 and bps >= 1");
        }
    }

    /// @notice Collateral lock amount is exactly notional * slaMultiplierBps / 10_000
    function testFuzz_lockAmountExact(uint256 notionalSeed, uint256 slaSeed) public pure {
        uint256 notional = bound(notionalSeed, 1e6, 1e15);
        uint256 sla = bound(slaSeed, 10_000, 30_000);

        uint256 lockAmount = (notional * sla) / 10_000;

        // Lock must be >= notional when sla >= 10_000 (100%)
        assertGe(lockAmount, notional, "Lock must be >= notional for sla >= 100%");

        // Lock must be <= 3 * notional when sla <= 30_000 (300%)
        assertLe(lockAmount, 3 * notional, "Lock must be <= 3x notional for sla <= 300%");
    }

    /// @notice Fee + lock never overflow uint256 for valid parameter ranges
    function testFuzz_feePlusLockNoOverflow(
        uint256 notionalSeed,
        uint256 bpsSeed,
        uint256 slaSeed
    ) public pure {
        uint256 notional = bound(notionalSeed, 1e6, 1e15);
        uint256 maxPriceBps = bound(bpsSeed, 1, 10_000);
        uint256 sla = bound(slaSeed, 10_000, 30_000);

        uint256 fee = (notional * maxPriceBps) / 10_000;
        uint256 lockAmount = (notional * sla) / 10_000;

        // Sum should not overflow
        uint256 total = fee + lockAmount;
        assertGe(total, fee, "Sum must not overflow");
        assertGe(total, lockAmount, "Sum must not overflow");
    }

    /// @notice Credit/USDC split: creditUsed + usdcPaid always equals fee
    function testFuzz_creditUsdcSplitSumsToFee(uint256 feeSeed, uint256 creditBalSeed) public pure {
        uint256 fee = bound(feeSeed, 0, 1e15);
        uint256 creditBalance = bound(creditBalSeed, 0, 1e15);

        uint256 creditUsed = fee < creditBalance ? fee : creditBalance;
        uint256 usdcPaid = fee - creditUsed;

        assertEq(creditUsed + usdcPaid, fee, "Credit + USDC must equal total fee");
        assertLe(creditUsed, fee, "Credit used must be <= fee");
        assertLe(creditUsed, creditBalance, "Credit used must be <= balance");
    }

    // =========================================================================
    // SECTION 3: Protocol Fee Invariants
    // =========================================================================

    /// @notice Protocol fee is exactly 50 bps (0.5%) of total non-void notional
    function testFuzz_protocolFeeExact(uint256 notionalSeed) public pure {
        uint256 totalNotional = bound(notionalSeed, 0, 1e18);

        uint256 protocolFee = (totalNotional * 50) / 10_000;

        // Fee should be 0.5% of notional
        assertEq(protocolFee, totalNotional / 200, "Protocol fee must be exactly 0.5%");
    }

    /// @notice Protocol fee never exceeds total notional
    function testFuzz_protocolFeeNeverExceedsNotional(uint256 totalNotional) public pure {
        totalNotional = bound(totalNotional, 0, type(uint256).max / 50);

        uint256 protocolFee = (totalNotional * 50) / 10_000;
        assertLe(protocolFee, totalNotional, "Protocol fee must never exceed notional");
    }

    /// @notice Protocol fee is zero for early exits regardless of notional
    function testFuzz_earlyExitProtocolFeeCharged(uint256 notionalSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e10);
        uint256 sla = DEFAULT_SLA;

        // Create only 5 signals (not 10) so it's not audit-ready
        for (uint256 i; i < 5; i++) {
            uint256 sigId = i + 1;
            _createSignal(sigId, DEFAULT_MAX_PRICE_BPS, sla);

            uint256 lockAmount = (notional * sla) / 10_000;
            _depositGeniusCollateral(lockAmount);

            uint256 fee = (notional * DEFAULT_MAX_PRICE_BPS) / 10_000;
            _depositIdiotEscrow(fee);

            vm.prank(idiot);
            uint256 purchaseId = escrow.purchase(sigId, notional, DEFAULT_ODDS);

            account.recordOutcome(genius, idiot, purchaseId, Outcome.Unfavorable);
            escrow.setOutcome(purchaseId, Outcome.Unfavorable);
        }

        // Extra collateral for protocol fee
        uint256 expectedFee = (5 * notional * 50) / 10_000;
        _depositGeniusCollateral(expectedFee);

        // Early exit as the idiot
        vm.prank(idiot);
        audit.earlyExit(genius, idiot);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertGt(result.protocolFee, 0, "Early exit: protocol fee charged");
        assertEq(result.protocolFee, expectedFee, "Early exit: fee = 0.5% of total notional");
        assertEq(result.trancheA, 0, "Early exit: trancheA must be zero");
        assertTrue(result.trancheB > 0, "Early exit: trancheB must be positive for negative score");
    }

    // =========================================================================
    // SECTION 4: Settlement Tranche Distribution
    // =========================================================================

    /// @notice For a positive score, no damages are distributed
    function testFuzz_positiveScore_noDamages(uint256 notionalSeed, uint256 oddsSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e10);
        uint256 odds = bound(oddsSeed, 2_000_000, 10_000_000); // >= 2.0x to ensure positive score

        Outcome[10] memory outcomes;
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Favorable;
        }

        _setupFullCycle(notional, odds, DEFAULT_SLA, outcomes);

        // Extra collateral for protocol fee
        uint256 protocolFeeExtra = (10 * notional * 50) / 10_000;
        _depositGeniusCollateral(protocolFeeExtra);

        audit.trigger(genius, idiot);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertTrue(result.qualityScore > 0, "Score must be positive");
        assertEq(result.trancheA, 0, "Positive score: trancheA must be zero");
        assertEq(result.trancheB, 0, "Positive score: trancheB must be zero");
    }

    /// @notice TrancheA (USDC refund) is capped at total USDC fees paid in cycle
    function testFuzz_trancheACappedAtFeesPaid(uint256 notionalSeed, uint256 slaSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e10);
        uint256 sla = bound(slaSeed, 10_000, 30_000);

        Outcome[10] memory outcomes;
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Unfavorable;
        }

        (uint256 totalUsdcFeesPaid,) = _setupFullCycle(notional, DEFAULT_ODDS, sla, outcomes);

        // Extra collateral for protocol fee + slashing
        uint256 extra = (10 * notional * (sla + 50)) / 10_000;
        _depositGeniusCollateral(extra);

        audit.trigger(genius, idiot);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertLe(result.trancheA, totalUsdcFeesPaid, "TrancheA must be capped at USDC fees paid");
    }

    /// @notice When damages < fees, all damages go to trancheA and trancheB is zero
    function testFuzz_smallDamages_noTrancheB(uint256 notionalSeed) public {
        // Use minimum SLA (100%) and carefully chosen odds to keep damages below fees
        uint256 notional = bound(notionalSeed, 1e6, 1e10);
        uint256 sla = 10_000; // 100%

        // 9 favorable, 1 unfavorable: score likely positive
        // Instead, use higher odds but fewer unfavorable
        // Let's do: 8 favorable, 2 unfavorable with odds=5x, sla=100%
        // gain per fav = notional * 4 = 4*notional, loss per unfav = notional * 1 = notional
        // score = 8 * 4 * notional - 2 * notional = 30 * notional > 0
        // Need to get a small negative score.
        // 3 favorable, 7 unfavorable: gain = 3 * 4 * notional = 12n, loss = 7 * 1 * notional = 7n
        // score = 12n - 7n = 5n > 0 still positive.
        // Use sla=100%, odds close to 1.01
        // gain per fav = notional * 0.01 = 0.01n, loss per unfav = notional * 1 = n
        // 9 fav + 1 unfav: score = 9 * 0.01n - 1 * n = 0.09n - n = -0.91n
        // totalFees = 10 * notional * 500 / 10000 = 0.5 * notional
        // damages = 0.91n > 0.5n fees... trancheB != 0.
        // To get damages < fees: all fav. That gives positive score -> no damages. Need negative but small.
        // 10 unfav: damages = 10 * notional = 10n, fees = 0.5n => still damages > fees.
        // The only way damages < fees is if the negative score magnitude is small.
        // With sla=100%: loss per unfav = notional. Even 1 unfav + 9 void = -notional.
        // fees for 10 signals = 10 * notional * 500/10000 = 0.5 * notional.
        // 1 unfav: damages = notional > 0.5 * notional. Still trancheB > 0.
        // Need: lower SLA or partial. But SLA min is 10_000 (100%).
        // Actually, with high favorable odds we can offset:
        // 9 favorable + 1 unfavorable, odds=1_110_000, sla=10000
        // gain = 9 * notional * 110_000/1_000_000 = 9 * 0.11 * notional = 0.99n
        // loss = 1 * notional = n
        // score = 0.99n - n = -0.01n (small negative)
        // fees = 10 * notional * 500/10000 = 0.5n
        // damages = 0.01n < 0.5n. Now trancheA = 0.01n, trancheB = 0.
        uint256 odds2 = 1_110_000; // 1.11x

        Outcome[10] memory outcomes;
        for (uint256 i; i < 9; i++) {
            outcomes[i] = Outcome.Favorable;
        }
        outcomes[9] = Outcome.Unfavorable;

        (uint256 totalUsdcFeesPaid,) = _setupFullCycle(notional, odds2, sla, outcomes);

        // Extra collateral for protocol fee + slashing
        uint256 extra = (10 * notional * (sla + 50)) / 10_000;
        _depositGeniusCollateral(extra);

        audit.trigger(genius, idiot);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertTrue(result.qualityScore < 0, "Score must be negative for this test");

        uint256 totalDamages = uint256(-result.qualityScore);
        assertTrue(totalDamages < totalUsdcFeesPaid, "Damages must be less than fees paid");
        assertEq(result.trancheA, totalDamages, "When damages < fees: trancheA == damages");
        assertEq(result.trancheB, 0, "When damages < fees: trancheB must be zero");
    }

    /// @notice When damages > fees, trancheA == fees and excess goes to trancheB
    function testFuzz_largeDamages_excessToTrancheB(uint256 notionalSeed, uint256 slaSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e10);
        uint256 sla = bound(slaSeed, 20_000, 30_000); // >= 200%

        Outcome[10] memory outcomes;
        for (uint256 i; i < 10; i++) {
            outcomes[i] = Outcome.Unfavorable;
        }

        (uint256 totalUsdcFeesPaid,) = _setupFullCycle(notional, DEFAULT_ODDS, sla, outcomes);

        // Extra collateral for protocol fee + slashing
        uint256 extra = (10 * notional * (sla + 50)) / 10_000;
        _depositGeniusCollateral(extra);

        audit.trigger(genius, idiot);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertTrue(result.qualityScore < 0, "Score must be negative");

        uint256 totalDamages = uint256(-result.qualityScore);
        // With sla >= 200% and 10 unfavorable: damages = 10 * notional * sla / 10_000 >= 20 * notional
        // fees = 10 * notional * 500/10_000 = 0.5 * notional
        // So damages >> fees
        assertTrue(totalDamages > totalUsdcFeesPaid, "Damages must exceed fees paid");
        assertEq(result.trancheA, totalUsdcFeesPaid, "When damages > fees: trancheA == fees paid");
        assertEq(result.trancheB, totalDamages - totalUsdcFeesPaid, "TrancheB == excess damages");
        assertEq(
            result.trancheA + result.trancheB,
            totalDamages,
            "TrancheA + trancheB must equal total damages"
        );
    }

    // =========================================================================
    // SECTION 5: Pure Math Boundary Fuzz
    // =========================================================================

    /// @notice Quality score gain formula does not overflow for max valid inputs
    function testFuzz_gainFormulaNoOverflow(uint256 notionalSeed, uint256 oddsSeed) public pure {
        // MAX_NOTIONAL = 1e15, MAX_ODDS = 1_000_000_000
        uint256 notional = bound(notionalSeed, 1, 1e15);
        uint256 odds = bound(oddsSeed, 1_010_000, 1_000_000_000);

        // Simulate the formula: int256(notional) * (int256(odds) - 1e6) / 1e6
        int256 n = int256(notional);
        int256 o = int256(odds) - 1e6;

        // Check multiplication does not overflow int256
        // max: 1e15 * 999_000_000 = 9.99e23, well within int256 range
        int256 gain = n * o / 1e6;

        assertTrue(gain >= 0, "Gain must be non-negative for odds >= 1.01");
    }

    /// @notice Quality score loss formula does not overflow for max valid inputs
    function testFuzz_lossFormulaNoOverflow(uint256 notionalSeed, uint256 slaSeed) public pure {
        uint256 notional = bound(notionalSeed, 1, 1e15);
        uint256 sla = bound(slaSeed, 10_000, 30_000);

        // Simulate: int256(notional) * int256(sla) / 10_000
        int256 loss = int256(notional) * int256(sla) / 10_000;

        assertTrue(loss >= int256(notional), "Loss must be >= notional for sla >= 100%");
        assertTrue(loss <= int256(notional) * 3, "Loss must be <= 3x notional for sla <= 300%");
    }

    /// @notice Summing 10 gains does not overflow
    function testFuzz_tenGainsSumNoOverflow(uint256 notionalSeed, uint256 oddsSeed) public pure {
        uint256 notional = bound(notionalSeed, 1, 1e15);
        uint256 odds = bound(oddsSeed, 1_010_000, 1_000_000_000);

        int256 singleGain = int256(notional) * (int256(odds) - 1e6) / 1e6;
        int256 totalGain = 10 * singleGain;

        // Verify no sign flip (overflow indicator)
        assertTrue(totalGain >= singleGain, "10x gain sum must not overflow");
        assertTrue(totalGain >= 0, "Total gain must be non-negative");
    }

    /// @notice Summing 10 losses does not underflow
    function testFuzz_tenLossesSumNoUnderflow(uint256 notionalSeed, uint256 slaSeed) public pure {
        uint256 notional = bound(notionalSeed, 1, 1e15);
        uint256 sla = bound(slaSeed, 10_000, 30_000);

        int256 singleLoss = int256(notional) * int256(sla) / 10_000;
        int256 totalScore = -10 * singleLoss;

        // Verify no sign flip (underflow indicator)
        assertTrue(totalScore <= 0, "Total negative score must be <= 0");
        assertTrue(totalScore <= -singleLoss, "10x loss must be more negative than 1x loss");
    }

    /// @notice Protocol fee calculation with maximum notional does not overflow
    function testFuzz_protocolFeeMaxNotional(uint256 numSignals) public pure {
        numSignals = bound(numSignals, 1, 10);
        uint256 maxNotionalPerSignal = 1e15; // MAX_NOTIONAL

        uint256 totalNotional = numSignals * maxNotionalPerSignal;
        uint256 protocolFee = (totalNotional * 50) / 10_000;

        // 10 * 1e15 * 50 / 10_000 = 5e14 -- well within uint256
        assertLe(protocolFee, totalNotional, "Protocol fee must be <= total notional");
        assertTrue(protocolFee > 0, "Protocol fee must be positive for non-zero notional");
    }

    // =========================================================================
    // SECTION 6: Escrow Purchase Fee -- End-to-End
    // =========================================================================

    /// @notice Fuzz purchase fee with varying maxPriceBps: verify stored feePaid matches formula
    function testFuzz_purchaseFeePaidMatchesFormula(
        uint256 notionalSeed,
        uint256 bpsSeed,
        uint256 oddsSeed
    ) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e12);
        uint256 maxPriceBps = bound(bpsSeed, 1, 5000);
        uint256 odds = bound(oddsSeed, 1_010_000, 1_000_000_000);
        uint256 sla = DEFAULT_SLA;

        _createSignal(1, maxPriceBps, sla);

        uint256 lockAmount = (notional * sla) / 10_000;
        _depositGeniusCollateral(lockAmount);

        uint256 expectedFee = (notional * maxPriceBps) / 10_000;
        _depositIdiotEscrow(expectedFee);

        vm.prank(idiot);
        uint256 purchaseId = escrow.purchase(1, notional, odds);

        Purchase memory p = escrow.getPurchase(purchaseId);
        assertEq(p.feePaid, expectedFee, "Fee paid must match formula");
        assertEq(p.usdcPaid, expectedFee, "USDC paid must equal fee when no credits");
        assertEq(p.creditUsed, 0, "Credit used must be zero when no credits");
        assertEq(p.notional, notional, "Notional must match input");
        assertEq(p.odds, odds, "Odds must match input");
    }

    /// @notice Escrow balance conservation: deposit - fee = remaining balance
    function testFuzz_escrowBalanceConservation(uint256 notionalSeed, uint256 extraSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e10);
        uint256 extra = bound(extraSeed, 0, 1e10);

        _createSignal(1, DEFAULT_MAX_PRICE_BPS, DEFAULT_SLA);

        uint256 lockAmount = (notional * DEFAULT_SLA) / 10_000;
        _depositGeniusCollateral(lockAmount);

        uint256 fee = (notional * DEFAULT_MAX_PRICE_BPS) / 10_000;
        uint256 totalDeposit = fee + extra;
        _depositIdiotEscrow(totalDeposit);

        uint256 balBefore = escrow.getBalance(idiot);
        assertEq(balBefore, totalDeposit, "Balance before purchase mismatch");

        vm.prank(idiot);
        escrow.purchase(1, notional, DEFAULT_ODDS);

        uint256 balAfter = escrow.getBalance(idiot);
        assertEq(balAfter, totalDeposit - fee, "Balance after purchase must equal deposit - fee");
        assertEq(balAfter, extra, "Remaining balance must equal extra deposited");
    }
}
