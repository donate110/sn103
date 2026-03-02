// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TrackRecord, VerifiedRecord} from "../src/TrackRecord.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

/// @notice Mock ZK verifier that can be configured to accept or reject proofs
contract MockZKVerifier {
    bool public shouldVerify;

    constructor(bool _shouldVerify) {
        shouldVerify = _shouldVerify;
    }

    function setShouldVerify(bool _val) external {
        shouldVerify = _val;
    }

    function verifyTrackRecordProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[106] calldata
    ) external view returns (bool) {
        return shouldVerify;
    }
}

/// @title TrackRecordTest
/// @notice Tests for the TrackRecord on-chain proof storage contract
contract TrackRecordTest is Test {
    TrackRecord trackRecord;
    MockZKVerifier verifier;

    address owner;
    address genius1 = address(0xBEEF);
    address genius2 = address(0xCAFE);
    address nonOwner = address(0xDEAD);

    function setUp() public {
        owner = address(this);
        verifier = new MockZKVerifier(true);
        trackRecord = TrackRecord(_deployProxy(address(new TrackRecord()), abi.encodeCall(TrackRecord.initialize, (owner))));
        trackRecord.setZKVerifier(address(verifier));
    }

    // ─── Helper: Build mock public signals
    // ─────────────────────────────────

    function _buildPubSignals(
        uint256 signalCount,
        uint256 totalGain,
        uint256 totalLoss,
        uint256 favCount,
        uint256 unfavCount,
        uint256 voidCount
    ) internal pure returns (uint256[106] memory pubSignals) {
        pubSignals[100] = signalCount;
        pubSignals[101] = totalGain;
        pubSignals[102] = totalLoss;
        pubSignals[103] = favCount;
        pubSignals[104] = unfavCount;
        pubSignals[105] = voidCount;
    }

    function _defaultProof()
        internal
        pure
        returns (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC)
    {
        pA = [uint256(1), 2];
        pB = [[uint256(3), 4], [uint256(5), 6]];
        pC = [uint256(7), 8];
    }

    /// @dev Commit a proof hash for sender and advance one block (commit-reveal pattern)
    function _commitProof(
        address sender,
        uint256[2] memory pA,
        uint256[2][2] memory pB,
        uint256[2] memory pC,
        uint256[106] memory pubSignals
    ) internal {
        bytes32 proofHash = keccak256(abi.encodePacked(pA, pB, pC, pubSignals));
        vm.prank(sender);
        trackRecord.commitProof(proofHash);
        vm.roll(block.number + 1);
    }

    // ─── Admin Tests
    // ───────────────────────────────────────────────────────

    function test_setZKVerifier_onlyOwner() public {
        address newVerifier = address(new MockZKVerifier(true));
        trackRecord.setZKVerifier(newVerifier);
        assertEq(address(trackRecord.zkVerifier()), newVerifier);
    }

    function test_setZKVerifier_reverts_nonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        vm.prank(nonOwner);
        trackRecord.setZKVerifier(address(verifier));
    }

    function test_setZKVerifier_reverts_zeroAddress() public {
        vm.expectRevert(TrackRecord.ZeroAddress.selector);
        trackRecord.setZKVerifier(address(0));
    }

    function test_setZKVerifier_emitsEvent() public {
        address newVerifier = address(new MockZKVerifier(true));
        vm.expectEmit(true, false, false, false);
        emit TrackRecord.ZKVerifierUpdated(newVerifier);
        trackRecord.setZKVerifier(newVerifier);
    }

    // ─── Submit Tests
    // ──────────────────────────────────────────────────────

    function test_submit_storesRecord() public {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals = _buildPubSignals(5, 500e6, 200e6, 3, 1, 1);

        _commitProof(genius1, pA, pB, pC, pubSignals);
        vm.prank(genius1);
        uint256 recordId = trackRecord.submit(pA, pB, pC, pubSignals);

        assertEq(recordId, 0);
        assertEq(trackRecord.recordCount(), 1);

        VerifiedRecord memory rec = trackRecord.getRecord(0);
        assertEq(rec.genius, genius1);
        assertEq(rec.signalCount, 5);
        assertEq(rec.totalGain, 500e6);
        assertEq(rec.totalLoss, 200e6);
        assertEq(rec.favCount, 3);
        assertEq(rec.unfavCount, 1);
        assertEq(rec.voidCount, 1);
        assertEq(rec.blockNumber, block.number);
        assertTrue(rec.proofHash != bytes32(0));
    }

    function test_submit_emitsEvent() public {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals = _buildPubSignals(10, 1000e6, 300e6, 7, 2, 1);

        _commitProof(genius1, pA, pB, pC, pubSignals);

        vm.expectEmit(true, true, false, true);
        emit TrackRecord.TrackRecordSubmitted(
            0, genius1, 10, 1000e6, 300e6, 7, 2, 1, keccak256(abi.encodePacked(pA, pB, pC, pubSignals))
        );

        vm.prank(genius1);
        trackRecord.submit(pA, pB, pC, pubSignals);
    }

    function test_submit_multipleRecordsSameGenius() public {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals1 = _buildPubSignals(5, 100e6, 50e6, 3, 1, 1);
        uint256[106] memory pubSignals2 = _buildPubSignals(10, 500e6, 200e6, 7, 2, 1);

        _commitProof(genius1, pA, pB, pC, pubSignals1);
        _commitProof(genius1, pA, pB, pC, pubSignals2);

        vm.startPrank(genius1);
        trackRecord.submit(pA, pB, pC, pubSignals1);
        trackRecord.submit(pA, pB, pC, pubSignals2);
        vm.stopPrank();

        assertEq(trackRecord.recordCount(), 2);
        assertEq(trackRecord.getRecordCount(genius1), 2);

        uint256[] memory ids = trackRecord.getRecordIds(genius1);
        assertEq(ids.length, 2);
        assertEq(ids[0], 0);
        assertEq(ids[1], 1);
    }

    function test_submit_multipleGeniuses() public {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals1 = _buildPubSignals(5, 100e6, 50e6, 3, 1, 1);
        uint256[106] memory pubSignals2 = _buildPubSignals(10, 500e6, 200e6, 7, 2, 1);

        _commitProof(genius1, pA, pB, pC, pubSignals1);
        _commitProof(genius2, pA, pB, pC, pubSignals2);

        vm.prank(genius1);
        trackRecord.submit(pA, pB, pC, pubSignals1);

        vm.prank(genius2);
        trackRecord.submit(pA, pB, pC, pubSignals2);

        assertEq(trackRecord.getRecordCount(genius1), 1);
        assertEq(trackRecord.getRecordCount(genius2), 1);

        VerifiedRecord memory rec1 = trackRecord.getRecord(0);
        VerifiedRecord memory rec2 = trackRecord.getRecord(1);
        assertEq(rec1.genius, genius1);
        assertEq(rec2.genius, genius2);
    }

    // ─── Revert Tests
    // ──────────────────────────────────────────────────────

    function test_submit_reverts_verifierNotSet() public {
        TrackRecord fresh = TrackRecord(_deployProxy(address(new TrackRecord()), abi.encodeCall(TrackRecord.initialize, (owner))));
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals = _buildPubSignals(5, 100e6, 50e6, 3, 1, 1);

        vm.expectRevert(TrackRecord.VerifierNotSet.selector);
        fresh.submit(pA, pB, pC, pubSignals);
    }

    function test_submit_reverts_proofFailed() public {
        verifier.setShouldVerify(false);
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals = _buildPubSignals(5, 100e6, 50e6, 3, 1, 1);

        _commitProof(genius1, pA, pB, pC, pubSignals);
        vm.expectRevert(TrackRecord.ProofVerificationFailed.selector);
        vm.prank(genius1);
        trackRecord.submit(pA, pB, pC, pubSignals);
    }

    function test_submit_reverts_duplicateProof() public {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals = _buildPubSignals(5, 100e6, 50e6, 3, 1, 1);

        _commitProof(genius1, pA, pB, pC, pubSignals);
        vm.prank(genius1);
        trackRecord.submit(pA, pB, pC, pubSignals);

        // DuplicateProof checked before ProofNotCommitted, so genius2 hits DuplicateProof
        vm.expectRevert(TrackRecord.DuplicateProof.selector);
        vm.prank(genius2);
        trackRecord.submit(pA, pB, pC, pubSignals);
    }

    function test_submit_reverts_proofNotCommitted() public {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals = _buildPubSignals(5, 100e6, 50e6, 3, 1, 1);

        vm.expectRevert(TrackRecord.ProofNotCommitted.selector);
        vm.prank(genius1);
        trackRecord.submit(pA, pB, pC, pubSignals);
    }

    function test_submit_reverts_commitTooRecent() public {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals = _buildPubSignals(5, 100e6, 50e6, 3, 1, 1);

        bytes32 proofHash = keccak256(abi.encodePacked(pA, pB, pC, pubSignals));
        vm.prank(genius1);
        trackRecord.commitProof(proofHash);
        // Don't advance block — commit is in the same block
        vm.expectRevert(abi.encodeWithSelector(TrackRecord.CommitTooRecent.selector, block.number, block.number));
        vm.prank(genius1);
        trackRecord.submit(pA, pB, pC, pubSignals);
    }

    function test_submit_reverts_commitExpired() public {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals = _buildPubSignals(5, 100e6, 50e6, 3, 1, 1);

        bytes32 proofHash = keccak256(abi.encodePacked(pA, pB, pC, pubSignals));
        uint256 commitBlock = block.number;
        vm.prank(genius1);
        trackRecord.commitProof(proofHash);
        // Advance past the expiry window (256 blocks + 1)
        vm.roll(commitBlock + 257);
        vm.expectRevert(abi.encodeWithSelector(TrackRecord.CommitExpired.selector, commitBlock, block.number));
        vm.prank(genius1);
        trackRecord.submit(pA, pB, pC, pubSignals);
    }

    // ─── View Tests
    // ────────────────────────────────────────────────────────

    function test_getRecordCount_empty() public view {
        assertEq(trackRecord.getRecordCount(genius1), 0);
    }

    function test_getRecordIds_empty() public view {
        uint256[] memory ids = trackRecord.getRecordIds(genius1);
        assertEq(ids.length, 0);
    }

    function test_getRecord_nonexistent() public view {
        VerifiedRecord memory rec = trackRecord.getRecord(999);
        assertEq(rec.genius, address(0));
        assertEq(rec.signalCount, 0);
    }

    function test_usedProofHashes_tracked() public {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals = _buildPubSignals(5, 100e6, 50e6, 3, 1, 1);
        bytes32 proofHash = keccak256(abi.encodePacked(pA, pB, pC, pubSignals));

        assertFalse(trackRecord.usedProofHashes(proofHash));

        _commitProof(genius1, pA, pB, pC, pubSignals);
        vm.prank(genius1);
        trackRecord.submit(pA, pB, pC, pubSignals);

        assertTrue(trackRecord.usedProofHashes(proofHash));
    }

    // ─── Edge Cases
    // ────────────────────────────────────────────────────────

    function test_submit_zeroStats_reverts() public {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals = _buildPubSignals(0, 0, 0, 0, 0, 0);

        _commitProof(genius1, pA, pB, pC, pubSignals);
        vm.expectRevert(abi.encodeWithSelector(TrackRecord.InvalidSignalCount.selector, 0));
        vm.prank(genius1);
        trackRecord.submit(pA, pB, pC, pubSignals);
    }

    function test_submit_maxSignals() public {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals = _buildPubSignals(20, 5000e6, 1000e6, 15, 3, 2);

        _commitProof(genius1, pA, pB, pC, pubSignals);
        vm.prank(genius1);
        uint256 recordId = trackRecord.submit(pA, pB, pC, pubSignals);

        VerifiedRecord memory rec = trackRecord.getRecord(recordId);
        assertEq(rec.signalCount, 20);
        assertEq(rec.favCount, 15);
        assertEq(rec.unfavCount, 3);
        assertEq(rec.voidCount, 2);
    }

    function test_submit_incrementsRecordId() public {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();

        for (uint256 i = 0; i < 5; i++) {
            uint256[106] memory pubSignals = _buildPubSignals(i + 1, (i + 1) * 100e6, i * 50e6, i + 1, 0, 0);
            _commitProof(genius1, pA, pB, pC, pubSignals);
            vm.prank(genius1);
            uint256 recordId = trackRecord.submit(pA, pB, pC, pubSignals);
            assertEq(recordId, i);
        }

        assertEq(trackRecord.recordCount(), 5);
    }

    function test_submit_recordsTimestamp() public {
        vm.warp(1_700_000_000);
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals = _buildPubSignals(5, 100e6, 50e6, 3, 1, 1);

        _commitProof(genius1, pA, pB, pC, pubSignals);
        vm.prank(genius1);
        trackRecord.submit(pA, pB, pC, pubSignals);

        VerifiedRecord memory rec = trackRecord.getRecord(0);
        assertEq(rec.submittedAt, 1_700_000_000);
    }

    // ─── Fuzz Tests
    // ────────────────────────────────────────────────────────

    function testFuzz_submit_storesAnyStats(
        uint256 signalCount,
        uint256 totalGain,
        uint256 totalLoss,
        uint256 favCount,
        uint256 unfavCount,
        uint256 voidCount
    ) public {
        // Bound to reasonable ranges to avoid gas issues (signalCount >= 1 per circuit constraint)
        signalCount = bound(signalCount, 1, 20);
        totalGain = bound(totalGain, 0, type(uint128).max);
        totalLoss = bound(totalLoss, 0, type(uint128).max);
        favCount = bound(favCount, 0, 20);
        unfavCount = bound(unfavCount, 0, 20);
        voidCount = bound(voidCount, 0, 20);

        uint256[106] memory pubSignals =
            _buildPubSignals(signalCount, totalGain, totalLoss, favCount, unfavCount, voidCount);
        // Vary proof elements to avoid duplicate proof hash
        uint256[2] memory pA = [signalCount, totalGain];
        uint256[2][2] memory pB = [[totalLoss, favCount], [unfavCount, voidCount]];
        uint256[2] memory pC = [uint256(7), 8];

        _commitProof(genius1, pA, pB, pC, pubSignals);
        vm.prank(genius1);
        uint256 recordId = trackRecord.submit(pA, pB, pC, pubSignals);

        VerifiedRecord memory rec = trackRecord.getRecord(recordId);
        assertEq(rec.genius, genius1);
        assertEq(rec.signalCount, signalCount);
        assertEq(rec.totalGain, totalGain);
        assertEq(rec.totalLoss, totalLoss);
        assertEq(rec.favCount, favCount);
        assertEq(rec.unfavCount, unfavCount);
        assertEq(rec.voidCount, voidCount);
    }

    function testFuzz_submit_proofHashUnique(uint256 seed1, uint256 seed2) public {
        vm.assume(seed1 != seed2);

        uint256[106] memory pubSignals1;
        pubSignals1[0] = seed1;
        pubSignals1[100] = 5;

        uint256[106] memory pubSignals2;
        pubSignals2[0] = seed2;
        pubSignals2[100] = 5;

        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();

        _commitProof(genius1, pA, pB, pC, pubSignals1);
        _commitProof(genius1, pA, pB, pC, pubSignals2);

        vm.prank(genius1);
        trackRecord.submit(pA, pB, pC, pubSignals1);

        vm.prank(genius1);
        trackRecord.submit(pA, pB, pC, pubSignals2);

        assertEq(trackRecord.recordCount(), 2);
    }

    function testFuzz_submit_anySender(address sender) public {
        vm.assume(sender != address(0));

        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) = _defaultProof();
        uint256[106] memory pubSignals = _buildPubSignals(5, 100e6, 50e6, 3, 1, 1);
        // Vary pubSignals to avoid duplicate proof hash across fuzz runs
        pubSignals[0] = uint256(uint160(sender));

        _commitProof(sender, pA, pB, pC, pubSignals);
        vm.prank(sender);
        uint256 recordId = trackRecord.submit(pA, pB, pC, pubSignals);

        VerifiedRecord memory rec = trackRecord.getRecord(recordId);
        assertEq(rec.genius, sender);
        assertEq(trackRecord.getRecordCount(sender), 1);
    }
}
