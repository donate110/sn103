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
import {OutcomeVoting} from "../src/OutcomeVoting.sol";
import {Outcome} from "../src/interfaces/IDjinn.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

/// @title OutcomeVotingTest
/// @notice Tests for OutcomeVoting and Audit.settleByVote / earlyExitByVote (v2 queue-based)
contract OutcomeVotingTest is Test {
    MockUSDC usdc;
    SignalCommitment signalCommitment;
    Escrow escrow;
    Collateral collateral;
    CreditLedger creditLedger;
    DjinnAccount account;
    Audit audit;
    OutcomeVoting voting;

    address owner;
    address genius = address(0xBEEF);
    address idiot = address(0xCAFE);
    address treasury = address(0xFEE5);

    address validator1 = address(0xA001);
    address validator2 = address(0xA002);
    address validator3 = address(0xA003);
    address validator4 = address(0xA004);
    address validator5 = address(0xA005);

    uint256 constant MAX_PRICE_BPS = 500;
    uint256 constant SLA_MULTIPLIER_BPS = 15_000;
    uint256 constant NOTIONAL = 1000e6;
    uint256 constant ODDS = 1_910_000;
    uint256 constant TOTAL_NOTIONAL_10 = 10 * NOTIONAL; // 10_000e6
    uint256 constant TOTAL_NOTIONAL_5 = 5 * NOTIONAL;   // 5_000e6

    function setUp() public {
        owner = address(this);

        usdc = new MockUSDC();
        signalCommitment = SignalCommitment(_deployProxy(address(new SignalCommitment()), abi.encodeCall(SignalCommitment.initialize, (owner))));
        escrow = Escrow(_deployProxy(address(new Escrow()), abi.encodeCall(Escrow.initialize, (address(usdc), owner))));
        collateral = Collateral(_deployProxy(address(new Collateral()), abi.encodeCall(Collateral.initialize, (address(usdc), owner))));
        creditLedger = CreditLedger(_deployProxy(address(new CreditLedger()), abi.encodeCall(CreditLedger.initialize, (owner))));
        account = DjinnAccount(_deployProxy(address(new DjinnAccount()), abi.encodeCall(DjinnAccount.initialize, (owner))));
        audit = Audit(_deployProxy(address(new Audit()), abi.encodeCall(Audit.initialize, (owner))));
        voting = OutcomeVoting(_deployProxy(address(new OutcomeVoting()), abi.encodeCall(OutcomeVoting.initialize, (owner))));

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
        audit.setOutcomeVoting(address(voting));

        // Wire OutcomeVoting
        voting.setAudit(address(audit));
        voting.setAccount(address(account));

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

        // Register validators
        voting.addValidator(validator1);
        voting.addValidator(validator2);
        voting.addValidator(validator3);
    }

    // ─── Helpers ─────────────────────────────────────────────

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
                commitHash: keccak256(abi.encodePacked("signal", signalId)),
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

    function _createAndPurchaseSignal(uint256 signalId) internal returns (uint256 purchaseId) {
        _createSignal(signalId);

        uint256 lockAmount = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000 + (NOTIONAL * 50) / 10_000;
        uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        uint256 protocolFeeShare = (NOTIONAL * 50) / 10_000;
        _depositGeniusCollateral(lockAmount + fee + protocolFeeShare);
        _depositIdiotEscrow(fee);

        vm.prank(idiot);
        purchaseId = escrow.purchase(signalId, NOTIONAL, ODDS);
    }

    /// @dev Create 10 signals, purchase, and record Favorable outcomes (required for settlement)
    function _create10SignalsNoOutcomes() internal returns (uint256[] memory purchaseIds) {
        purchaseIds = new uint256[](10);
        for (uint256 i; i < 10; i++) {
            purchaseIds[i] = _createAndPurchaseSignal(i + 1);
            // v2 requires outcomes recorded before markBatchAudited
            account.recordOutcome(genius, idiot, purchaseIds[i], Outcome.Favorable);
        }
    }

    /// @dev Create N signals, purchase, and record Favorable outcomes
    function _createNSignals(uint256 n) internal returns (uint256[] memory purchaseIds) {
        purchaseIds = new uint256[](n);
        for (uint256 i; i < n; i++) {
            purchaseIds[i] = _createAndPurchaseSignal(i + 1);
            account.recordOutcome(genius, idiot, purchaseIds[i], Outcome.Favorable);
        }
    }

    /// @dev Compute the batch key for a set of purchaseIds (matches OutcomeVoting logic)
    function _batchKey(uint256[] memory purchaseIds) internal view returns (bytes32) {
        return keccak256(abi.encode(genius, idiot, keccak256(abi.encode(purchaseIds))));
    }

    // ─── Validator Management ────────────────────────────────

    function test_addValidator() public {
        assertEq(voting.validatorCount(), 3);
        assertTrue(voting.isValidator(validator1));
        assertTrue(voting.isValidator(validator2));
        assertTrue(voting.isValidator(validator3));
    }

    function test_addValidator_revertsDuplicate() public {
        vm.expectRevert(abi.encodeWithSelector(OutcomeVoting.ValidatorAlreadyRegistered.selector, validator1));
        voting.addValidator(validator1);
    }

    function test_addValidator_revertsZeroAddress() public {
        vm.expectRevert(abi.encodeWithSelector(OutcomeVoting.ZeroAddress.selector));
        voting.addValidator(address(0));
    }

    function test_removeValidator() public {
        // Must have > MIN_VALIDATORS to remove; add extra validators first
        voting.addValidator(validator4);
        voting.removeValidator(validator2);
        assertEq(voting.validatorCount(), 3);
        assertFalse(voting.isValidator(validator2));
        assertTrue(voting.isValidator(validator1));
        assertTrue(voting.isValidator(validator3));
        assertTrue(voting.isValidator(validator4));
    }

    function test_removeValidator_revertsNotRegistered() public {
        vm.expectRevert(abi.encodeWithSelector(OutcomeVoting.ValidatorNotRegistered.selector, validator4));
        voting.removeValidator(validator4);
    }

    function test_quorumThreshold_3validators() public {
        // ceil(3 * 2 / 3) = 2
        assertEq(voting.quorumThreshold(), 2);
    }

    function test_quorumThreshold_5validators() public {
        voting.addValidator(validator4);
        voting.addValidator(validator5);
        // ceil(5 * 2 / 3) = ceil(10/3) = 4
        assertEq(voting.quorumThreshold(), 4);
    }

    // ─── Voting: Basic Flow ─────────────────────────────────

    function test_submitVote_recordsVote() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        int256 score = 5000e6;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);

        bytes32 batchKey = _batchKey(pids);
        assertTrue(voting.hasVoted(batchKey, validator1));
    }

    function test_submitVote_nonValidatorReverts() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        vm.expectRevert(abi.encodeWithSelector(OutcomeVoting.NotValidator.selector, address(0xDEAD)));
        vm.prank(address(0xDEAD));
        voting.submitVote(genius, idiot, pids, 5000e6, TOTAL_NOTIONAL_10, false);
    }

    function test_submitVote_doubleVoteReverts() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, 5000e6, TOTAL_NOTIONAL_10, false);

        bytes32 batchKey = _batchKey(pids);
        vm.expectRevert(abi.encodeWithSelector(OutcomeVoting.AlreadyVoted.selector, validator1, batchKey));
        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, 5000e6, TOTAL_NOTIONAL_10, false);
    }

    // ─── Voting: Quorum Triggers Settlement ──────────────────

    function test_quorumTriggersSettlement_positiveScore() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        int256 score = 5000e6; // Positive: genius keeps fees

        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);

        // Not finalized yet (1/3, need 2/3)
        bytes32 batchKey = _batchKey(pids);
        assertFalse(voting.isBatchFinalized(batchKey));

        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);

        // Finalized! (2/3 quorum)
        assertTrue(voting.isBatchFinalized(batchKey));

        // Audit result stored (batchId = 0 since first batch)
        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.qualityScore, score);
        assertTrue(result.timestamp > 0);
        assertEq(result.trancheA, 0, "Positive score: no tranche A");
        assertEq(result.trancheB, 0, "Positive score: no tranche B");

        // Protocol fee paid
        uint256 expectedFee = (TOTAL_NOTIONAL_10 * 50) / 10_000;
        assertEq(result.protocolFee, expectedFee);
        assertEq(usdc.balanceOf(treasury), expectedFee);

        // Batch count advanced
        assertEq(account.getCurrentCycle(genius, idiot), 1);
    }

    function test_quorumTriggersSettlement_negativeScore() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        // Negative score: -5000e6: damages to idiot
        int256 score = -5000e6;
        uint256 totalDamages = uint256(-score);
        uint256 totalFees = 10 * (NOTIONAL * MAX_PRICE_BPS / 10_000); // 10 * 50e6 = 500e6

        uint256 idiotUsdcBefore = usdc.balanceOf(idiot);

        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);

        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);

        bytes32 batchKey = _batchKey(pids);
        assertTrue(voting.isBatchFinalized(batchKey));

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.qualityScore, score);

        // Tranche A capped at total USDC fees paid
        assertEq(result.trancheA, totalFees, "Tranche A should equal fees paid");

        // Tranche B = damages - trancheA
        uint256 expectedTrancheB = totalDamages - totalFees;
        assertEq(result.trancheB, expectedTrancheB, "Tranche B should be excess");

        // Idiot gets USDC (tranche A)
        assertEq(usdc.balanceOf(idiot), idiotUsdcBefore + totalFees);

        // Idiot gets credits (tranche B)
        assertEq(creditLedger.balanceOf(idiot), expectedTrancheB);
    }

    function test_quorum_disagreementNoFinalization() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        // All 3 vote different scores: no quorum
        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, 1000e6, TOTAL_NOTIONAL_10, false);

        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids, 2000e6, TOTAL_NOTIONAL_10, false);

        vm.prank(validator3);
        voting.submitVote(genius, idiot, pids, 3000e6, TOTAL_NOTIONAL_10, false);

        bytes32 batchKey = _batchKey(pids);
        assertFalse(voting.isBatchFinalized(batchKey));
    }

    function test_quorum_partialAgreement() public {
        // 5 validators, need 4 for quorum
        voting.addValidator(validator4);
        voting.addValidator(validator5);

        uint256[] memory pids = _create10SignalsNoOutcomes();

        int256 score = 1000e6;

        // 2 agree
        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);

        // 1 disagrees
        vm.prank(validator3);
        voting.submitVote(genius, idiot, pids, 999e6, TOTAL_NOTIONAL_10, false);

        bytes32 batchKey = _batchKey(pids);
        assertFalse(voting.isBatchFinalized(batchKey));

        // 3 agree (need 4)
        vm.prank(validator4);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);

        assertFalse(voting.isBatchFinalized(batchKey));

        // 4 agree: quorum reached
        vm.prank(validator5);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);

        // Now 4/5 agree: finalized
        assertTrue(voting.isBatchFinalized(batchKey));
    }

    // ─── Voted Settlement: Collateral Release ────────────────

    function test_votedSettlement_releasesSignalLocks() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        // All signal locks should exist before
        for (uint256 i = 1; i <= 10; i++) {
            assertTrue(collateral.getSignalLock(genius, i) > 0);
        }

        int256 score = 5000e6;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);

        // All locks released
        for (uint256 i = 1; i <= 10; i++) {
            assertEq(collateral.getSignalLock(genius, i), 0);
        }
        assertEq(collateral.getLocked(genius), 0);
    }

    // ─── Early Exit Via Voting ──────────────────────────────

    function test_earlyExitByVote_creditsOnly() public {
        uint256[] memory pids = _createNSignals(5);

        // Request early exit (v2: takes purchaseIds)
        vm.prank(idiot);
        voting.requestEarlyExit(genius, idiot, pids);

        bytes32 batchKey = _batchKey(pids);
        assertTrue(voting.earlyExitRequested(batchKey));

        int256 score = -3000e6;
        uint256 idiotUsdcBefore = usdc.balanceOf(idiot);

        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_5, true);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_5, true);

        assertTrue(voting.isBatchFinalized(batchKey));

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.qualityScore, score);
        assertEq(result.trancheA, 0, "Early exit: no USDC refund");
        assertEq(result.trancheB, uint256(-score), "Early exit: all damages as credits");
        assertGt(result.protocolFee, 0, "Early exit: protocol fee charged");

        // No USDC movement for idiot
        assertEq(usdc.balanceOf(idiot), idiotUsdcBefore);
        // Credits minted (full damages)
        assertEq(creditLedger.balanceOf(idiot), uint256(-score));
    }

    function test_earlyExitByVote_positiveScore_noDamages() public {
        uint256[] memory pids = _createNSignals(5);

        vm.prank(genius);
        voting.requestEarlyExit(genius, idiot, pids);

        int256 score = 2000e6;

        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_5, true);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_5, true);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.trancheA, 0);
        assertEq(result.trancheB, 0);
        assertEq(creditLedger.balanceOf(idiot), 0);
    }

    // ─── Early Exit Request Validation ──────────────────────

    function test_requestEarlyExit_onlyParty() public {
        uint256[] memory pids = _createNSignals(3);

        vm.expectRevert(
            abi.encodeWithSelector(OutcomeVoting.NotPartyToAudit.selector, address(0xDEAD), genius, idiot)
        );
        vm.prank(address(0xDEAD));
        voting.requestEarlyExit(genius, idiot, pids);
    }

    function test_requestEarlyExit_noPurchasesReverts() public {
        uint256[] memory empty = new uint256[](0);
        vm.expectRevert(abi.encodeWithSelector(OutcomeVoting.NoPurchases.selector, genius, idiot));
        vm.prank(genius);
        voting.requestEarlyExit(genius, idiot, empty);
    }

    function test_requestEarlyExit_doubleRequestReverts() public {
        uint256[] memory pids = _createNSignals(3);

        vm.prank(idiot);
        voting.requestEarlyExit(genius, idiot, pids);

        bytes32 batchKey = _batchKey(pids);
        vm.expectRevert(abi.encodeWithSelector(OutcomeVoting.EarlyExitAlreadyRequested.selector, batchKey));
        vm.prank(genius);
        voting.requestEarlyExit(genius, idiot, pids);
    }

    // ─── Authorization Checks ────────────────────────────────

    function test_settleByVote_onlyOutcomeVoting() public {
        uint256[] memory pids = new uint256[](1);
        pids[0] = 0;
        vm.expectRevert(abi.encodeWithSelector(Audit.CallerNotOutcomeVoting.selector, address(this)));
        audit.settleByVote(genius, idiot, pids, 1000e6, 10_000e6);
    }

    function test_earlyExitByVote_onlyOutcomeVoting() public {
        uint256[] memory pids = new uint256[](1);
        pids[0] = 0;
        vm.expectRevert(abi.encodeWithSelector(Audit.CallerNotOutcomeVoting.selector, address(this)));
        audit.earlyExitByVote(genius, idiot, pids, 1000e6, 5_000e6);
    }

    // ─── Cannot Re-settle After Voted Settlement ─────────────

    function test_cannotResettleAfterVote() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        int256 score = 5000e6;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);

        // Batch already finalized; voting on the same purchaseIds again reverts
        bytes32 batchKey = _batchKey(pids);
        assertTrue(voting.isBatchFinalized(batchKey));

        vm.expectRevert(abi.encodeWithSelector(OutcomeVoting.CycleAlreadyFinalized.selector, batchKey));
        vm.prank(validator3);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);
    }

    // ─── Two Voted Batches ────────────────────────────────────

    function test_twoVotedBatches() public {
        // Batch 0
        uint256[] memory pids0 = _create10SignalsNoOutcomes();

        int256 score0 = 3000e6;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids0, score0, TOTAL_NOTIONAL_10, false);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids0, score0, TOTAL_NOTIONAL_10, false);

        assertEq(account.getCurrentCycle(genius, idiot), 1);

        // Batch 1
        uint256[] memory pids1 = new uint256[](10);
        for (uint256 i; i < 10; i++) {
            pids1[i] = _createAndPurchaseSignal(i + 100);
            account.recordOutcome(genius, idiot, pids1[i], Outcome.Favorable);
        }

        int256 score1 = -2000e6;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids1, score1, TOTAL_NOTIONAL_10, false);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids1, score1, TOTAL_NOTIONAL_10, false);

        assertEq(account.getCurrentCycle(genius, idiot), 2);

        AuditResult memory r0 = audit.getAuditResult(genius, idiot, 0);
        AuditResult memory r1 = audit.getAuditResult(genius, idiot, 1);
        assertEq(r0.qualityScore, score0);
        assertEq(r1.qualityScore, score1);
    }

    // ─── Zero Score Via Vote ─────────────────────────────────

    function test_zeroScoreVote_noDamages() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        int256 score = 0;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_10, false);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.qualityScore, 0);
        assertEq(result.trancheA, 0);
        assertEq(result.trancheB, 0);
    }

    // ─── Pause/Unpause ──────────────────────────────────────

    function test_pausedVotingReverts() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        voting.pause();

        vm.expectRevert();
        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, 1000e6, TOTAL_NOTIONAL_10, false);

        voting.unpause();

        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, 1000e6, TOTAL_NOTIONAL_10, false);
        bytes32 batchKey = _batchKey(pids);
        assertTrue(voting.hasVoted(batchKey, validator1));
    }

    // ─── Admin: setOutcomeVoting on Audit ────────────────────

    function test_setOutcomeVoting_onlyOwner() public {
        vm.expectRevert();
        vm.prank(address(0xDEAD));
        audit.setOutcomeVoting(address(0x1234));
    }

    function test_setOutcomeVoting_revertsZeroAddress() public {
        vm.expectRevert();
        audit.setOutcomeVoting(address(0));
    }

    // ─── Quality Score Bounds Checking ──────────────────────

    function test_settleByVote_revertsOnExtremePositiveScore() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        int256 extremeScore = audit.MAX_QUALITY_SCORE() + 1;

        // First vote succeeds (no quorum yet)
        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, extremeScore, TOTAL_NOTIONAL_10, false);

        // Second vote reaches quorum: triggers settleByVote which reverts with bounds check
        vm.prank(validator2);
        vm.expectRevert();
        voting.submitVote(genius, idiot, pids, extremeScore, TOTAL_NOTIONAL_10, false);

        // Batch should NOT be finalized (settlement reverted)
        bytes32 batchKey = _batchKey(pids);
        assertFalse(voting.isBatchFinalized(batchKey));
    }

    function test_settleByVote_revertsOnExtremeNegativeScore() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        int256 extremeScore = -(audit.MAX_QUALITY_SCORE() + 1);

        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, extremeScore, TOTAL_NOTIONAL_10, false);

        vm.prank(validator2);
        vm.expectRevert();
        voting.submitVote(genius, idiot, pids, extremeScore, TOTAL_NOTIONAL_10, false);

        bytes32 batchKey = _batchKey(pids);
        assertFalse(voting.isBatchFinalized(batchKey));
    }

    function test_settleByVote_maxBoundaryAccepted() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        // Exactly at the boundary should work (though damages may exceed collateral)
        int256 maxScore = audit.MAX_QUALITY_SCORE();

        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, maxScore, TOTAL_NOTIONAL_10, false);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids, maxScore, TOTAL_NOTIONAL_10, false);

        bytes32 batchKey = _batchKey(pids);
        assertTrue(voting.isBatchFinalized(batchKey));
    }

    // ─── Validator Snapshot for Quorum ──────────────────────

    function test_quorumSnapshot_recordedOnFirstVote() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        bytes32 batchKey = _batchKey(pids);
        assertEq(voting.cycleValidatorSnapshot(batchKey), 0, "No snapshot before voting");

        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, 1000e6, TOTAL_NOTIONAL_10, false);

        assertEq(voting.cycleValidatorSnapshot(batchKey), 3, "Snapshot should be 3 after first vote");
    }

    function test_quorumSnapshot_addingValidatorMidVoteResetsSnapshot() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        // First vote snapshots at 3 validators and syncNonce
        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, 1000e6, TOTAL_NOTIONAL_10, false);

        bytes32 batchKey = _batchKey(pids);
        assertEq(voting.cycleValidatorSnapshot(batchKey), 3, "Snapshot should be 3 after first vote");

        // Add 2 more validators after first vote (changes syncNonce)
        voting.addValidator(validator4);
        voting.addValidator(validator5);

        // Next vote resets the snapshot and re-snapshots with 5 validators
        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids, 1000e6, TOTAL_NOTIONAL_10, false);

        assertEq(voting.cycleValidatorSnapshot(batchKey), 5, "Snapshot should be 5 after reset");
    }

    function test_quorumSnapshot_removingValidatorMidVoteResetsSnapshot() public {
        // Start with 5 validators
        voting.addValidator(validator4);
        voting.addValidator(validator5);

        uint256[] memory pids = _create10SignalsNoOutcomes();

        // First vote snapshots at 5 and syncNonce
        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, 2000e6, TOTAL_NOTIONAL_10, false);

        bytes32 batchKey = _batchKey(pids);
        assertEq(voting.cycleValidatorSnapshot(batchKey), 5, "Snapshot should be 5 after first vote");

        // Remove 2 validators (changes syncNonce, leaves MIN_VALIDATORS=3)
        voting.removeValidator(validator4);
        voting.removeValidator(validator5);

        // Next vote resets the snapshot and re-snapshots with 3 validators
        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids, 2000e6, TOTAL_NOTIONAL_10, false);

        assertEq(voting.cycleValidatorSnapshot(batchKey), 3, "Snapshot should be 3 after reset");
    }

    function test_batchQuorumThreshold_returnsZeroBeforeVotes() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();
        bytes32 batchKey = _batchKey(pids);
        assertEq(voting.batchQuorumThreshold(batchKey), 0);
    }

    function test_batchQuorumThreshold_matchesSnapshotAfterVote() public {
        uint256[] memory pids = _create10SignalsNoOutcomes();

        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, 1000e6, TOTAL_NOTIONAL_10, false);

        bytes32 batchKey = _batchKey(pids);
        // 3 validators snapshotted, threshold = ceil(3*2/3) = 2
        assertEq(voting.batchQuorumThreshold(batchKey), 2);
    }

    // ─── settleByVote with < 10 purchases reverts (BatchTooSmall) ────

    function test_settleByVote_revertsWhenBatchTooSmall() public {
        // Only create 5 signals (not 10), so batch is too small for settleByVote
        uint256[] memory pids = _createNSignals(5);

        // Non-early-exit quorum routes to settleByVote which reverts BatchTooSmall
        int256 score = 1000e6;

        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_5, false);

        // Second vote reaches quorum: triggers settleByVote with 5 < MIN_BATCH_SIZE
        vm.prank(validator2);
        vm.expectRevert();
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_5, false);

        // Not finalized because settlement reverted
        bytes32 batchKey = _batchKey(pids);
        assertFalse(voting.isBatchFinalized(batchKey));
    }

    function test_earlyExitByVote_worksWithSmallBatch() public {
        // Only 5 signals; early exit path should work
        uint256[] memory pids = _createNSignals(5);

        // Request early exit
        vm.prank(idiot);
        voting.requestEarlyExit(genius, idiot, pids);

        int256 score = -1000e6;

        vm.prank(validator1);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_5, true);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, pids, score, TOTAL_NOTIONAL_5, true);

        // Early exit should succeed even with fewer than 10 signals
        bytes32 batchKey = _batchKey(pids);
        assertTrue(voting.isBatchFinalized(batchKey));
        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.qualityScore, score);
        assertGt(result.protocolFee, 0, "Early exit: protocol fee charged");
    }

    // ─── Signal Lock Per-Purchase Release ────────────────────

    /// @notice When two Idiots buy the same signal, settling one pair should
    ///         only release that Idiot's portion of the collateral lock, not all of it.
    function test_settlementReleasesOnlyPerPurchaseLock() public {
        address idiot2 = address(0xD00D);

        // Create one signal (shared by two Idiots)
        _createSignal(1);

        // Deposit enough genius collateral for two purchases + fees
        uint256 lockPerPurchase = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000 + (NOTIONAL * 50) / 10_000;
        uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        uint256 protocolFee = (NOTIONAL * 50) / 10_000;
        uint256 totalNeeded = (lockPerPurchase + fee + protocolFee) * 2;
        _depositGeniusCollateral(totalNeeded);

        // Idiot 1 purchases
        _depositIdiotEscrow(fee);
        vm.prank(idiot);
        escrow.purchase(1, NOTIONAL, ODDS);

        // Idiot 2 purchases the same signal
        usdc.mint(idiot2, fee);
        vm.startPrank(idiot2);
        usdc.approve(address(escrow), fee);
        escrow.deposit(fee);
        escrow.purchase(1, NOTIONAL, ODDS);
        vm.stopPrank();

        // Both Idiots' locks should be accumulated on signalId 1
        uint256 totalSignalLock = collateral.getSignalLock(genius, 1);
        assertEq(totalSignalLock, lockPerPurchase * 2, "Both locks accumulated");

        // Fill 10 signals for genius-idiot pair to make it audit-ready
        // (purchase 0 already counts as signal 1, need 9 more)
        uint256[] memory allPids = new uint256[](10);
        allPids[0] = 0; // first purchase
        // Record outcome for first purchase
        account.recordOutcome(genius, idiot, 0, Outcome.Favorable);
        for (uint256 i = 2; i <= 10; i++) {
            uint256 pid = _createAndPurchaseSignal(i);
            account.recordOutcome(genius, idiot, pid, Outcome.Favorable);
            allPids[i - 1] = pid;
        }

        // Vote to settle genius-idiot pair with a positive score (no damages)
        int256 score = 1000e6;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, allPids, score, TOTAL_NOTIONAL_10, false);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, allPids, score, TOTAL_NOTIONAL_10, false);

        // After settling idiot's batch, only idiot's portion of signal 1 lock should be released
        uint256 remainingLock = collateral.getSignalLock(genius, 1);
        assertEq(remainingLock, lockPerPurchase, "Idiot2's lock on signal 1 should remain");
    }
}
