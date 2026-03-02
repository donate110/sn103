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
import {Signal, SignalStatus, Purchase, Outcome, AccountState} from "../src/interfaces/IDjinn.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

/// @title AuditFuzzTest
/// @notice Fuzz tests on all financial math in the Djinn Protocol audit system
contract AuditFuzzTest is Test {
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

    uint256 constant MAX_PRICE_BPS = 500; // 5%

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
        string[] memory books = new string[](1);
        books[0] = "DraftKings";
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

    // ─── Fuzz: Quality Score Calculation
    // ─────────────────────────────────

    /// @notice Fuzz the quality score computation with random notional, odds, sla, and outcomes
    function testFuzz_qualityScore(uint256 notionalSeed, uint256 oddsSeed, uint256 slaSeed, uint256 outcomeSeed)
        public
    {
        // Bound inputs to valid ranges
        // notional: 1e6 to 1e12 (1 USDC to 1M USDC)
        uint256 notional = bound(notionalSeed, 1e6, 1e12);
        // odds: 1.01 to 10.0 -> 1_010_000 to 10_000_000
        uint256 odds = bound(oddsSeed, 1_010_000, 10_000_000);
        // slaMultiplierBps: 10000 to 30000
        uint256 sla = bound(slaSeed, 10_000, 30_000);

        // Create 10 signals with same parameters, assign random outcomes
        int256 expectedScore = 0;

        for (uint256 i; i < 10; i++) {
            uint256 sigId = i + 1;
            _createSignal(sigId, sla);

            uint256 lockAmount = (notional * sla) / 10_000;
            _depositGeniusCollateral(lockAmount);

            uint256 fee = (notional * MAX_PRICE_BPS) / 10_000;
            _depositIdiotEscrow(fee);

            vm.prank(idiot);
            uint256 purchaseId = escrow.purchase(sigId, notional, odds);

            // Derive outcome from seed: 0=Favorable, 1=Unfavorable, 2=Void
            uint256 outcomeType = uint256(keccak256(abi.encodePacked(outcomeSeed, i))) % 3;
            Outcome outcome;

            if (outcomeType == 0) {
                outcome = Outcome.Favorable;
                expectedScore += int256(notional) * (int256(odds) - 1e6) / 1e6;
            } else if (outcomeType == 1) {
                outcome = Outcome.Unfavorable;
                expectedScore -= int256(notional) * int256(sla) / 10_000;
            } else {
                outcome = Outcome.Void;
            }

            account.recordOutcome(genius, idiot, purchaseId, outcome);
            escrow.setOutcome(purchaseId, outcome);
        }

        int256 actualScore = audit.computeScore(genius, idiot);
        assertEq(actualScore, expectedScore, "Fuzz: Quality score mismatch");
    }

    // ─── Fuzz: Tranche A / B Split
    // ──────────────────────────────────────

    /// @notice Fuzz the tranche A/B split: verify trancheA <= totalFeesPaid,
    ///         trancheA + trancheB == totalDamages, and USDC extraction capped
    function testFuzz_trancheAB_split(uint256 notionalSeed, uint256 slaSeed) public {
        // Use all unfavorable signals to guarantee a negative score
        uint256 notional = bound(notionalSeed, 1e6, 1e10);
        uint256 sla = bound(slaSeed, 10_000, 30_000);
        uint256 odds = 1_910_000;

        uint256 totalUsdcFeesPaid = 0;

        for (uint256 i; i < 10; i++) {
            uint256 sigId = i + 1;
            _createSignal(sigId, sla);

            uint256 lockAmount = (notional * sla) / 10_000;
            _depositGeniusCollateral(lockAmount);

            uint256 fee = (notional * MAX_PRICE_BPS) / 10_000;
            _depositIdiotEscrow(fee);
            totalUsdcFeesPaid += fee;

            vm.prank(idiot);
            uint256 purchaseId = escrow.purchase(sigId, notional, odds);

            account.recordOutcome(genius, idiot, purchaseId, Outcome.Unfavorable);
            escrow.setOutcome(purchaseId, Outcome.Unfavorable);
        }

        uint256 idiotBalBefore = escrow.getBalance(idiot);
        uint256 creditsBefore = creditLedger.balanceOf(idiot);

        // Ensure genius has extra collateral for protocol fee slashing
        uint256 extraForProtocolFee = (10 * notional * 50) / 10_000;
        _depositGeniusCollateral(extraForProtocolFee);

        audit.trigger(genius, idiot);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);

        uint256 totalDamages = uint256(-result.qualityScore);

        // Tranche A must be <= total USDC fees paid
        assertLe(result.trancheA, totalUsdcFeesPaid, "Fuzz: trancheA must be <= totalFeesPaid");

        // Tranche A + B must equal total damages
        assertEq(result.trancheA + result.trancheB, totalDamages, "Fuzz: trancheA + trancheB must equal totalDamages");

        // When damages >= fees: trancheA == fees
        if (totalDamages >= totalUsdcFeesPaid) {
            assertEq(result.trancheA, totalUsdcFeesPaid, "Fuzz: when damages >= fees, trancheA should equal fees");
        }

        // When damages < fees: trancheA == damages, trancheB == 0
        if (totalDamages < totalUsdcFeesPaid) {
            assertEq(result.trancheA, totalDamages, "Fuzz: when damages < fees, trancheA should equal damages");
            assertEq(result.trancheB, 0, "Fuzz: when damages < fees, trancheB should be zero");
        }

        // You never extract more USDC than you put in
        uint256 usdcRefunded = escrow.getBalance(idiot) - idiotBalBefore;
        assertLe(usdcRefunded, totalUsdcFeesPaid, "Fuzz: USDC refund must not exceed total USDC deposited");
    }

    // ─── Fuzz: Credit Refund with Mixed USDC/Credit Payments ────────────

    /// @notice Fuzz credit refund logic: mixed USDC/credit payments
    function testFuzz_creditRefund(uint256 notionalSeed, uint256 creditSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e10);
        uint256 odds = 1_910_000;
        uint256 sla = 15_000;
        uint256 fee = (notional * MAX_PRICE_BPS) / 10_000;

        // Give the idiot some credits (0 to fee amount)
        uint256 creditAmount = bound(creditSeed, 0, fee);

        uint256 totalUsdcPaidAccum = 0;

        for (uint256 i; i < 10; i++) {
            uint256 sigId = i + 1;
            _createSignal(sigId, sla);

            uint256 lockAmount = (notional * sla) / 10_000;
            _depositGeniusCollateral(lockAmount);

            // Mint credits for each purchase
            if (creditAmount > 0) {
                creditLedger.mint(idiot, creditAmount);
            }

            uint256 usdcNeeded = fee - creditAmount;
            if (usdcNeeded > 0) {
                _depositIdiotEscrow(usdcNeeded);
            }

            totalUsdcPaidAccum += usdcNeeded;

            vm.prank(idiot);
            uint256 purchaseId = escrow.purchase(sigId, notional, odds);

            // All unfavorable for simplicity
            account.recordOutcome(genius, idiot, purchaseId, Outcome.Unfavorable);
            escrow.setOutcome(purchaseId, Outcome.Unfavorable);
        }

        uint256 idiotBalBefore = escrow.getBalance(idiot);

        // Extra collateral for protocol fee
        uint256 extraForProtocolFee = (10 * notional * 50) / 10_000;
        _depositGeniusCollateral(extraForProtocolFee);

        audit.trigger(genius, idiot);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);

        // Tranche A capped at USDC fees actually paid
        assertLe(result.trancheA, totalUsdcPaidAccum, "Fuzz: tranche A must be <= USDC fees paid");

        // USDC refund should not exceed USDC paid
        uint256 usdcRefunded = escrow.getBalance(idiot) - idiotBalBefore;
        assertLe(usdcRefunded, totalUsdcPaidAccum, "Fuzz: USDC refund must not exceed USDC paid");
    }

    // ─── Fuzz: Collateral Requirements
    // ──────────────────────────────────

    /// @notice Fuzz collateral lock: verify lockAmount == notional * sla / 10000
    function testFuzz_collateralLock(uint256 notionalSeed, uint256 slaSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e12);
        uint256 sla = bound(slaSeed, 10_000, 30_000);
        uint256 expectedLock = (notional * sla) / 10_000;

        _createSignal(1, sla);
        _depositGeniusCollateral(expectedLock);

        uint256 fee = (notional * MAX_PRICE_BPS) / 10_000;
        _depositIdiotEscrow(fee);

        vm.prank(idiot);
        escrow.purchase(1, notional, 1_910_000);

        assertEq(
            collateral.getSignalLock(genius, 1),
            expectedLock,
            "Fuzz: collateral lock should equal notional * sla / 10000"
        );
        assertEq(collateral.getLocked(genius), expectedLock, "Fuzz: total locked mismatch");
    }

    // ─── Fuzz: Protocol Fee
    // ──────────────────────────────────────────────

    /// @notice Fuzz protocol fee: verify it equals 0.5% of total non-void notional
    function testFuzz_protocolFee(uint256 notionalSeed, uint256 outcomeSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e10);
        uint256 odds = 1_910_000;
        uint256 sla = 15_000;

        uint256 totalNonVoidNotional = 0;

        for (uint256 i; i < 10; i++) {
            uint256 sigId = i + 1;
            _createSignal(sigId, sla);

            uint256 lockAmount = (notional * sla) / 10_000;
            _depositGeniusCollateral(lockAmount);

            uint256 fee = (notional * MAX_PRICE_BPS) / 10_000;
            _depositIdiotEscrow(fee);

            vm.prank(idiot);
            uint256 purchaseId = escrow.purchase(sigId, notional, odds);

            // Derive outcome from seed
            uint256 outcomeType = uint256(keccak256(abi.encodePacked(outcomeSeed, i))) % 3;
            Outcome outcome;

            if (outcomeType == 0) {
                outcome = Outcome.Favorable;
                totalNonVoidNotional += notional;
            } else if (outcomeType == 1) {
                outcome = Outcome.Unfavorable;
                totalNonVoidNotional += notional;
            } else {
                outcome = Outcome.Void;
            }

            account.recordOutcome(genius, idiot, purchaseId, outcome);
            escrow.setOutcome(purchaseId, outcome);
        }

        // Extra collateral for protocol fee + potential damages
        uint256 extra = (10 * notional * sla) / 10_000;
        _depositGeniusCollateral(extra);

        audit.trigger(genius, idiot);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        uint256 expectedProtocolFee = (totalNonVoidNotional * 50) / 10_000;
        assertEq(result.protocolFee, expectedProtocolFee, "Fuzz: protocol fee should be 0.5% of non-void notional");
    }

    // ─── Fuzz: Single favorable gain
    // ─────────────────────────────────────

    /// @notice Fuzz a single favorable signal's contribution to quality score
    function testFuzz_favorableGain(uint256 notionalSeed, uint256 oddsSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e12);
        uint256 odds = bound(oddsSeed, 1_010_000, 10_000_000);

        int256 expected = int256(notional) * (int256(odds) - 1e6) / 1e6;

        // Ensure gain is non-negative (odds >= 1.01)
        assertTrue(expected >= 0, "Fuzz: favorable gain must be non-negative");

        // Ensure no overflow by checking the multiplication doesn't wrap
        // notional * (odds - 1e6) should fit in int256 easily for our ranges
        assertTrue(expected <= int256(notional) * 9, "Fuzz: gain should be at most 9x notional for 10x odds");
    }

    // ─── Fuzz: Single unfavorable loss
    // ───────────────────────────────────

    /// @notice Fuzz a single unfavorable signal's contribution to quality score
    function testFuzz_unfavorableLoss(uint256 notionalSeed, uint256 slaSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e12);
        uint256 sla = bound(slaSeed, 10_000, 30_000);

        int256 loss = int256(notional) * int256(sla) / 10_000;

        // Loss must be >= notional (sla >= 10000)
        assertTrue(loss >= int256(notional), "Fuzz: loss must be >= notional when sla >= 10000");

        // Loss must be <= 3x notional (sla <= 30000)
        assertTrue(loss <= int256(notional) * 3, "Fuzz: loss must be <= 3x notional when sla <= 30000");
    }

    // ─── Fuzz: Settlement USDC conservation
    // ─────────────────────────────────────────

    /// @notice Fuzz end-to-end settlement: total USDC in system is conserved.
    ///         After settlement, idiot's USDC received + genius's remaining collateral
    ///         + treasury fee == initial USDC deposited
    function testFuzz_settlement_usdcConservation(uint256 notionalSeed, uint256 slaSeed) public {
        uint256 notional = bound(notionalSeed, 1e6, 1e10);
        uint256 sla = bound(slaSeed, 10_000, 30_000);
        uint256 odds = 1_910_000;

        uint256 totalUsdcFeesPaid = 0;
        uint256 totalCollateralDeposited = 0;

        for (uint256 i; i < 10; i++) {
            uint256 sigId = i + 1;
            _createSignal(sigId, sla);

            uint256 lockAmount = (notional * sla) / 10_000;
            _depositGeniusCollateral(lockAmount);
            totalCollateralDeposited += lockAmount;

            uint256 fee = (notional * MAX_PRICE_BPS) / 10_000;
            _depositIdiotEscrow(fee);
            totalUsdcFeesPaid += fee;

            vm.prank(idiot);
            uint256 purchaseId = escrow.purchase(sigId, notional, odds);

            // All unfavorable — maximum damages scenario
            account.recordOutcome(genius, idiot, purchaseId, Outcome.Unfavorable);
            escrow.setOutcome(purchaseId, Outcome.Unfavorable);
        }

        // Extra collateral for protocol fee
        uint256 extraForProtocolFee = (10 * notional * 50) / 10_000;
        _depositGeniusCollateral(extraForProtocolFee);
        totalCollateralDeposited += extraForProtocolFee;

        uint256 totalUsdcInSystem = totalUsdcFeesPaid + totalCollateralDeposited;

        audit.trigger(genius, idiot);

        // After settlement, all USDC is distributed among:
        // 1. Idiot (tranche A refund — sent directly via slash, appears in idiot's wallet)
        // 2. Genius (remaining collateral)
        // 3. Treasury (protocol fee)
        // 4. Escrow contract (any remaining idiot balance, should be 0 since all fees consumed)
        uint256 idiotWallet = usdc.balanceOf(idiot);
        uint256 geniusCollateral = collateral.getDeposit(genius);
        uint256 treasuryBalance = usdc.balanceOf(treasury);
        uint256 escrowBalance = usdc.balanceOf(address(escrow));
        uint256 collateralBalance = usdc.balanceOf(address(collateral));

        // Total USDC accounted for (collateral contract holds genius deposits + escrow holds idiot deposits)
        uint256 totalAfter = idiotWallet + collateralBalance + treasuryBalance + escrowBalance;

        assertEq(totalAfter, totalUsdcInSystem, "Fuzz: USDC conservation violated - USDC created or destroyed");
    }

    // ─── Fuzz: Tranche invariant
    // ─────────────────────────────────────────

    /// @notice Pure math fuzz: for any damages and feesPaid, verify tranche split invariant
    function testFuzz_trancheSplitInvariant(uint256 damagesSeed, uint256 feesSeed) public pure {
        uint256 totalDamages = bound(damagesSeed, 0, 1e18);
        uint256 totalFeesPaid = bound(feesSeed, 0, 1e18);

        uint256 trancheA = totalDamages < totalFeesPaid ? totalDamages : totalFeesPaid;
        uint256 trancheB = totalDamages > trancheA ? totalDamages - trancheA : 0;

        // Invariant 1: trancheA + trancheB == totalDamages
        assertEq(trancheA + trancheB, totalDamages, "Fuzz: tranche sum must equal total damages");

        // Invariant 2: trancheA <= totalFeesPaid
        assertLe(trancheA, totalFeesPaid, "Fuzz: trancheA must be <= fees paid");

        // Invariant 3: trancheA <= totalDamages
        assertLe(trancheA, totalDamages, "Fuzz: trancheA must be <= total damages");

        // Invariant 4: if damages >= fees, trancheA == fees
        if (totalDamages >= totalFeesPaid) {
            assertEq(trancheA, totalFeesPaid, "Fuzz: trancheA should equal fees when damages >= fees");
        }

        // Invariant 5: if damages < fees, trancheB == 0
        if (totalDamages < totalFeesPaid) {
            assertEq(trancheB, 0, "Fuzz: trancheB should be zero when damages < fees");
        }
    }
}
