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
/// @notice Tests for OutcomeVoting and Audit.settleByVote / earlyExitByVote
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

    function _createAndPurchaseSignal(uint256 signalId) internal returns (uint256 purchaseId) {
        _createSignal(signalId);

        uint256 lockAmount = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
        uint256 fee = (NOTIONAL * MAX_PRICE_BPS) / 10_000;
        uint256 protocolFeeShare = (NOTIONAL * 50) / 10_000;
        _depositGeniusCollateral(lockAmount + fee + protocolFeeShare);
        _depositIdiotEscrow(fee);

        vm.prank(idiot);
        purchaseId = escrow.purchase(signalId, NOTIONAL, ODDS);
    }

    /// @dev Create 10 signals and purchase them (no outcomes recorded — voted path)
    function _create10SignalsNoOutcomes() internal {
        for (uint256 i; i < 10; i++) {
            _createAndPurchaseSignal(i + 1);
        }
    }

    /// @dev Create N signals and purchase them (no outcomes recorded)
    function _createNSignals(uint256 n) internal {
        for (uint256 i; i < n; i++) {
            _createAndPurchaseSignal(i + 1);
        }
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
        voting.removeValidator(validator2);
        assertEq(voting.validatorCount(), 2);
        assertFalse(voting.isValidator(validator2));
        assertTrue(voting.isValidator(validator1));
        assertTrue(voting.isValidator(validator3));
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
        _create10SignalsNoOutcomes();

        int256 score = 5000e6;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, score);

        assertTrue(voting.hasVoted(_cycleKey(0), validator1));
        assertEq(voting.getVoteCount(genius, idiot, 0, score), 1);
    }

    function test_submitVote_nonValidatorReverts() public {
        _create10SignalsNoOutcomes();

        vm.expectRevert(abi.encodeWithSelector(OutcomeVoting.NotValidator.selector, address(0xDEAD)));
        vm.prank(address(0xDEAD));
        voting.submitVote(genius, idiot, 5000e6);
    }

    function test_submitVote_doubleVoteReverts() public {
        _create10SignalsNoOutcomes();

        vm.prank(validator1);
        voting.submitVote(genius, idiot, 5000e6);

        bytes32 cycleKey = _cycleKey(0);
        vm.expectRevert(abi.encodeWithSelector(OutcomeVoting.AlreadyVoted.selector, validator1, cycleKey));
        vm.prank(validator1);
        voting.submitVote(genius, idiot, 5000e6);
    }

    // ─── Voting: Quorum Triggers Settlement ──────────────────

    function test_quorumTriggersSettlement_positiveScore() public {
        _create10SignalsNoOutcomes();

        int256 score = 5000e6; // Positive → genius keeps fees

        vm.prank(validator1);
        voting.submitVote(genius, idiot, score);

        // Not finalized yet (1/3, need 2/3)
        assertFalse(voting.isCycleFinalized(genius, idiot, 0));

        vm.prank(validator2);
        voting.submitVote(genius, idiot, score);

        // Finalized! (2/3 quorum)
        assertTrue(voting.isCycleFinalized(genius, idiot, 0));

        // Audit result stored
        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.qualityScore, score);
        assertTrue(result.timestamp > 0);
        assertEq(result.trancheA, 0, "Positive score: no tranche A");
        assertEq(result.trancheB, 0, "Positive score: no tranche B");

        // Protocol fee paid
        uint256 totalNotional = 10 * NOTIONAL;
        uint256 expectedFee = (totalNotional * 50) / 10_000;
        assertEq(result.protocolFee, expectedFee);
        assertEq(usdc.balanceOf(treasury), expectedFee);

        // Cycle advanced
        assertEq(account.getCurrentCycle(genius, idiot), 1);
    }

    function test_quorumTriggersSettlement_negativeScore() public {
        _create10SignalsNoOutcomes();

        // Negative score: -5000e6 → damages to idiot
        int256 score = -5000e6;
        uint256 totalDamages = uint256(-score);
        uint256 totalFees = 10 * (NOTIONAL * MAX_PRICE_BPS / 10_000); // 10 * 50e6 = 500e6

        uint256 idiotUsdcBefore = usdc.balanceOf(idiot);

        vm.prank(validator1);
        voting.submitVote(genius, idiot, score);

        vm.prank(validator2);
        voting.submitVote(genius, idiot, score);

        assertTrue(voting.isCycleFinalized(genius, idiot, 0));

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
        _create10SignalsNoOutcomes();

        // All 3 vote different scores → no quorum
        vm.prank(validator1);
        voting.submitVote(genius, idiot, 1000e6);

        vm.prank(validator2);
        voting.submitVote(genius, idiot, 2000e6);

        vm.prank(validator3);
        voting.submitVote(genius, idiot, 3000e6);

        assertFalse(voting.isCycleFinalized(genius, idiot, 0));
    }

    function test_quorum_partialAgreement() public {
        // 5 validators, need 4 for quorum
        voting.addValidator(validator4);
        voting.addValidator(validator5);

        _create10SignalsNoOutcomes();

        int256 score = 1000e6;

        // 2 agree
        vm.prank(validator1);
        voting.submitVote(genius, idiot, score);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, score);

        // 1 disagrees
        vm.prank(validator3);
        voting.submitVote(genius, idiot, 999e6);

        assertFalse(voting.isCycleFinalized(genius, idiot, 0));

        // 3 agree (need 4)
        vm.prank(validator4);
        voting.submitVote(genius, idiot, score);

        assertFalse(voting.isCycleFinalized(genius, idiot, 0));

        // 4 agree → quorum reached (but validator5 voted differently)
        // Wait, validator5 hasn't voted yet. Let's have v5 agree.
        vm.prank(validator5);
        voting.submitVote(genius, idiot, score);

        // Now 4/5 agree → finalized
        assertTrue(voting.isCycleFinalized(genius, idiot, 0));
    }

    // ─── Voted Settlement: Collateral Release ────────────────

    function test_votedSettlement_releasesSignalLocks() public {
        _create10SignalsNoOutcomes();

        // All signal locks should exist before
        for (uint256 i = 1; i <= 10; i++) {
            assertTrue(collateral.getSignalLock(genius, i) > 0);
        }

        int256 score = 5000e6;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, score);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, score);

        // All locks released
        for (uint256 i = 1; i <= 10; i++) {
            assertEq(collateral.getSignalLock(genius, i), 0);
        }
        assertEq(collateral.getLocked(genius), 0);
    }

    // ─── Early Exit Via Voting ──────────────────────────────

    function test_earlyExitByVote_creditsOnly() public {
        _createNSignals(5);

        // Request early exit
        vm.prank(idiot);
        voting.requestEarlyExit(genius, idiot);

        assertTrue(voting.earlyExitRequested(_cycleKey(0)));

        int256 score = -3000e6;
        uint256 idiotUsdcBefore = usdc.balanceOf(idiot);

        vm.prank(validator1);
        voting.submitVote(genius, idiot, score);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, score);

        assertTrue(voting.isCycleFinalized(genius, idiot, 0));

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.qualityScore, score);
        assertEq(result.trancheA, 0, "Early exit: no USDC refund");
        assertEq(result.trancheB, uint256(-score), "Early exit: all damages as credits");
        assertGt(result.protocolFee, 0, "Early exit: protocol fee charged");

        // No USDC movement for idiot
        assertEq(usdc.balanceOf(idiot), idiotUsdcBefore);
        // Credits minted (full damages — fee is slashed from genius collateral separately)
        assertEq(creditLedger.balanceOf(idiot), uint256(-score));
    }

    function test_earlyExitByVote_positiveScore_noDamages() public {
        _createNSignals(5);

        vm.prank(genius);
        voting.requestEarlyExit(genius, idiot);

        int256 score = 2000e6;

        vm.prank(validator1);
        voting.submitVote(genius, idiot, score);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, score);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.trancheA, 0);
        assertEq(result.trancheB, 0);
        assertEq(creditLedger.balanceOf(idiot), 0);
    }

    // ─── Early Exit Request Validation ──────────────────────

    function test_requestEarlyExit_onlyParty() public {
        _createNSignals(3);

        vm.expectRevert(
            abi.encodeWithSelector(OutcomeVoting.NotPartyToAudit.selector, address(0xDEAD), genius, idiot)
        );
        vm.prank(address(0xDEAD));
        voting.requestEarlyExit(genius, idiot);
    }

    function test_requestEarlyExit_noPurchasesReverts() public {
        vm.expectRevert(abi.encodeWithSelector(OutcomeVoting.NoPurchases.selector, genius, idiot));
        vm.prank(genius);
        voting.requestEarlyExit(genius, idiot);
    }

    function test_requestEarlyExit_doubleRequestReverts() public {
        _createNSignals(3);

        vm.prank(idiot);
        voting.requestEarlyExit(genius, idiot);

        bytes32 cycleKey = _cycleKey(0);
        vm.expectRevert(abi.encodeWithSelector(OutcomeVoting.EarlyExitAlreadyRequested.selector, cycleKey));
        vm.prank(genius);
        voting.requestEarlyExit(genius, idiot);
    }

    // ─── Authorization Checks ────────────────────────────────

    function test_settleByVote_onlyOutcomeVoting() public {
        vm.expectRevert(abi.encodeWithSelector(Audit.CallerNotOutcomeVoting.selector, address(this)));
        audit.settleByVote(genius, idiot, 1000e6);
    }

    function test_earlyExitByVote_onlyOutcomeVoting() public {
        vm.expectRevert(abi.encodeWithSelector(Audit.CallerNotOutcomeVoting.selector, address(this)));
        audit.earlyExitByVote(genius, idiot, 1000e6);
    }

    // ─── Cannot Re-settle After Voted Settlement ─────────────

    function test_cannotResettleAfterVote() public {
        _create10SignalsNoOutcomes();

        int256 score = 5000e6;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, score);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, score);

        // Try to settle again via traditional trigger
        vm.expectRevert(abi.encodeWithSelector(Audit.NotAuditReady.selector, genius, idiot));
        audit.trigger(genius, idiot);
    }

    function test_voteAfterSettlement_goesToNewCycle() public {
        _create10SignalsNoOutcomes();

        int256 score = 5000e6;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, score);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, score);

        // Cycle 0 is finalized and cycle advanced to 1
        assertTrue(voting.isCycleFinalized(genius, idiot, 0));
        assertEq(account.getCurrentCycle(genius, idiot), 1);

        // Validator3's vote goes to cycle 1 (new cycle), not cycle 0
        vm.prank(validator3);
        voting.submitVote(genius, idiot, score);

        // Vote is recorded on cycle 1, not cycle 0
        assertEq(voting.getVoteCount(genius, idiot, 1, score), 1);
        assertTrue(voting.hasVoted(_cycleKey(1), validator3));
    }

    function _cycleKey(address g, address i, uint256 cycle) internal pure returns (bytes32) {
        return keccak256(abi.encode(g, i, cycle));
    }

    // ─── Two Voted Cycles ────────────────────────────────────

    function test_twoVotedCycles() public {
        // Cycle 0
        _create10SignalsNoOutcomes();

        int256 score0 = 3000e6;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, score0);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, score0);

        assertEq(account.getCurrentCycle(genius, idiot), 1);

        // Cycle 1
        for (uint256 i; i < 10; i++) {
            _createAndPurchaseSignal(i + 100);
        }

        int256 score1 = -2000e6;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, score1);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, score1);

        assertEq(account.getCurrentCycle(genius, idiot), 2);

        AuditResult memory r0 = audit.getAuditResult(genius, idiot, 0);
        AuditResult memory r1 = audit.getAuditResult(genius, idiot, 1);
        assertEq(r0.qualityScore, score0);
        assertEq(r1.qualityScore, score1);
    }

    // ─── Zero Score Via Vote ─────────────────────────────────

    function test_zeroScoreVote_noDamages() public {
        _create10SignalsNoOutcomes();

        int256 score = 0;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, score);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, score);

        AuditResult memory result = audit.getAuditResult(genius, idiot, 0);
        assertEq(result.qualityScore, 0);
        assertEq(result.trancheA, 0);
        assertEq(result.trancheB, 0);
    }

    // ─── Pause/Unpause ──────────────────────────────────────

    function test_pausedVotingReverts() public {
        _create10SignalsNoOutcomes();

        voting.pause();

        vm.expectRevert();
        vm.prank(validator1);
        voting.submitVote(genius, idiot, 1000e6);

        voting.unpause();

        vm.prank(validator1);
        voting.submitVote(genius, idiot, 1000e6);
        assertTrue(voting.hasVoted(_cycleKey(0), validator1));
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
        _create10SignalsNoOutcomes();

        int256 extremeScore = audit.MAX_QUALITY_SCORE() + 1;

        // First vote succeeds (no quorum yet)
        vm.prank(validator1);
        voting.submitVote(genius, idiot, extremeScore);

        // Second vote reaches quorum → triggers settleByVote → reverts with bounds check
        vm.prank(validator2);
        vm.expectRevert();
        voting.submitVote(genius, idiot, extremeScore);

        // Cycle should NOT be finalized (settlement reverted)
        assertFalse(voting.isCycleFinalized(genius, idiot, 0));
    }

    function test_settleByVote_revertsOnExtremeNegativeScore() public {
        _create10SignalsNoOutcomes();

        int256 extremeScore = -(audit.MAX_QUALITY_SCORE() + 1);

        vm.prank(validator1);
        voting.submitVote(genius, idiot, extremeScore);

        vm.prank(validator2);
        vm.expectRevert();
        voting.submitVote(genius, idiot, extremeScore);

        assertFalse(voting.isCycleFinalized(genius, idiot, 0));
    }

    function test_settleByVote_maxBoundaryAccepted() public {
        _create10SignalsNoOutcomes();

        // Exactly at the boundary should work (though damages may exceed collateral)
        int256 maxScore = audit.MAX_QUALITY_SCORE();

        vm.prank(validator1);
        voting.submitVote(genius, idiot, maxScore);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, maxScore);

        assertTrue(voting.isCycleFinalized(genius, idiot, 0));
    }

    // ─── Validator Snapshot for Quorum ──────────────────────

    function test_quorumSnapshot_recordedOnFirstVote() public {
        _create10SignalsNoOutcomes();

        bytes32 cycleKey = _cycleKey(0);
        assertEq(voting.cycleValidatorSnapshot(cycleKey), 0, "No snapshot before voting");

        vm.prank(validator1);
        voting.submitVote(genius, idiot, 1000e6);

        assertEq(voting.cycleValidatorSnapshot(cycleKey), 3, "Snapshot should be 3 after first vote");
    }

    function test_quorumSnapshot_addingValidatorMidVoteRejectsNewVotes() public {
        _create10SignalsNoOutcomes();

        // First vote snapshots at 3 validators and syncNonce
        vm.prank(validator1);
        voting.submitVote(genius, idiot, 1000e6);

        // Add 2 more validators after first vote (changes syncNonce)
        voting.addValidator(validator4);
        voting.addValidator(validator5);

        // Subsequent votes should revert because validator set changed
        bytes32 cycleKey = _cycleKey(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                OutcomeVoting.ValidatorSetChanged.selector,
                cycleKey,
                voting.cycleSyncNonce(cycleKey),
                voting.syncNonce()
            )
        );
        vm.prank(validator2);
        voting.submitVote(genius, idiot, 1000e6);
    }

    function test_quorumSnapshot_removingValidatorMidVoteRejectsNewVotes() public {
        // Start with 5 validators
        voting.addValidator(validator4);
        voting.addValidator(validator5);

        _create10SignalsNoOutcomes();

        // First vote snapshots at 5 and syncNonce
        vm.prank(validator1);
        voting.submitVote(genius, idiot, 2000e6);

        // Remove 2 validators (changes syncNonce)
        voting.removeValidator(validator4);
        voting.removeValidator(validator5);

        // Subsequent votes should revert because validator set changed
        bytes32 cycleKey = _cycleKey(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                OutcomeVoting.ValidatorSetChanged.selector,
                cycleKey,
                voting.cycleSyncNonce(cycleKey),
                voting.syncNonce()
            )
        );
        vm.prank(validator2);
        voting.submitVote(genius, idiot, 2000e6);
    }

    function test_cycleQuorumThreshold_returnsZeroBeforeVotes() public {
        assertEq(voting.cycleQuorumThreshold(genius, idiot, 0), 0);
    }

    function test_cycleQuorumThreshold_matchesSnapshotAfterVote() public {
        _create10SignalsNoOutcomes();

        vm.prank(validator1);
        voting.submitVote(genius, idiot, 1000e6);

        // 3 validators snapshotted, threshold = ceil(3*2/3) = 2
        assertEq(voting.cycleQuorumThreshold(genius, idiot, 0), 2);
    }

    // ─── settleByVote requires isAuditReady ────────────────

    function test_settleByVote_revertsWhenNotAuditReady() public {
        // Only create 5 signals (not 10), so isAuditReady returns false
        _createNSignals(5);

        // No early exit requested — so quorum routes to settleByVote
        int256 score = 1000e6;

        vm.prank(validator1);
        voting.submitVote(genius, idiot, score);

        // Second vote reaches quorum → triggers settleByVote → reverts NotAuditReady
        vm.prank(validator2);
        vm.expectRevert();
        voting.submitVote(genius, idiot, score);

        // Not finalized because settlement reverted
        assertFalse(voting.isCycleFinalized(genius, idiot, 0));
    }

    function test_earlyExitByVote_worksWhenNotAuditReady() public {
        // Only 5 signals — early exit path should work
        _createNSignals(5);

        // Request early exit
        vm.prank(idiot);
        voting.requestEarlyExit(genius, idiot);

        int256 score = -1000e6;

        vm.prank(validator1);
        voting.submitVote(genius, idiot, score);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, score);

        // Early exit should succeed even with fewer than 10 signals
        assertTrue(voting.isCycleFinalized(genius, idiot, 0));
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
        uint256 lockPerPurchase = (NOTIONAL * SLA_MULTIPLIER_BPS) / 10_000;
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
        // (purchase 1 already counts as signal 1, need 9 more)
        for (uint256 i = 2; i <= 10; i++) {
            _createAndPurchaseSignal(i);
        }

        // Vote to settle genius-idiot pair with a positive score (no damages)
        int256 score = 1000e6;
        vm.prank(validator1);
        voting.submitVote(genius, idiot, score);
        vm.prank(validator2);
        voting.submitVote(genius, idiot, score);

        // After settling idiot's cycle, only idiot's portion of signal 1 lock should be released
        uint256 remainingLock = collateral.getSignalLock(genius, 1);
        assertEq(remainingLock, lockPerPurchase, "Idiot2's lock on signal 1 should remain");
    }

    // ─── Internal Helpers ────────────────────────────────────

    function _cycleKey(uint256 cycle) internal view returns (bytes32) {
        return keccak256(abi.encode(genius, idiot, cycle));
    }
}
