// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {SignalCommitment} from "../src/SignalCommitment.sol";
import {Signal, SignalStatus} from "../src/interfaces/IDjinn.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

contract SignalCommitmentTest is Test {
    SignalCommitment public sc;

    address public owner = address(this);
    address public genius = address(0xA1);
    address public authorizedCaller = address(0xA2);
    address public unauthorizedCaller = address(0xA3);

    function setUp() public {
        sc = SignalCommitment(_deployProxy(address(new SignalCommitment()), abi.encodeCall(SignalCommitment.initialize, (owner))));
        sc.setAuthorizedCaller(authorizedCaller, true);
    }

    // ─── Helpers
    // ─────────────────────────────────────────────────────────

    function _makeDecoyLines() internal pure returns (string[] memory) {
        string[] memory lines = new string[](10);
        for (uint256 i = 0; i < 10; i++) {
            lines[i] = string(abi.encodePacked("decoy-", vm.toString(i)));
        }
        return lines;
    }

    function _makeSportsbooks() internal pure returns (string[] memory) {
        string[] memory books = new string[](2);
        books[0] = "DraftKings";
        books[1] = "FanDuel";
        return books;
    }

    function _defaultParams(uint256 signalId) internal view returns (SignalCommitment.CommitParams memory) {
        return SignalCommitment.CommitParams({
            signalId: signalId,
            encryptedBlob: hex"aabbccdd",
            commitHash: keccak256("test-commit"),
            sport: "NFL",
            maxPriceBps: 500,
            slaMultiplierBps: 15_000,
                maxNotional: 10_000e6,
                minNotional: 0,
            expiresAt: block.timestamp + 1 hours,
            decoyLines: _makeDecoyLines(),
            availableSportsbooks: _makeSportsbooks()
        });
    }

    function _commitDefault(uint256 signalId) internal {
        vm.prank(genius);
        sc.commit(_defaultParams(signalId));
    }

    // ─── Tests: Successful commit
    // ────────────────────────────────────────

    function test_commit_success() public {
        uint256 signalId = 1;
        SignalCommitment.CommitParams memory p = _defaultParams(signalId);

        vm.prank(genius);
        sc.commit(p);

        assertTrue(sc.signalExists(signalId));

        Signal memory sig = sc.getSignal(signalId);
        assertEq(sig.genius, genius);
        assertEq(sig.commitHash, p.commitHash);
        assertEq(keccak256(sig.encryptedBlob), keccak256(p.encryptedBlob));
        assertEq(keccak256(bytes(sig.sport)), keccak256(bytes("NFL")));
        assertEq(sig.maxPriceBps, 500);
        assertEq(sig.slaMultiplierBps, 15_000);
        assertEq(sig.expiresAt, p.expiresAt);
        assertEq(sig.decoyLines.length, 10);
        assertEq(sig.availableSportsbooks.length, 2);
        assertEq(uint8(sig.status), uint8(SignalStatus.Active));
        assertEq(sig.createdAt, block.timestamp);
    }

    function test_commit_emitsEvent() public {
        uint256 signalId = 42;
        SignalCommitment.CommitParams memory p = _defaultParams(signalId);

        vm.expectEmit(true, true, false, true);
        emit SignalCommitment.SignalCommitted(signalId, genius, "NFL", p.maxPriceBps, p.slaMultiplierBps, p.maxNotional, p.expiresAt);

        vm.prank(genius);
        sc.commit(p);
    }

    // ─── Tests: Revert on duplicate signal ID
    // ────────────────────────────

    function test_commit_revertOnDuplicateSignalId() public {
        _commitDefault(1);

        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.SignalAlreadyExists.selector, 1));
        vm.prank(genius);
        sc.commit(_defaultParams(1));
    }

    // ─── Tests: Revert on invalid decoy lines length
    // ─────────────────────

    function test_commit_revertOnDecoyLinesTooFew() public {
        SignalCommitment.CommitParams memory p = _defaultParams(100);
        string[] memory shortLines = new string[](5);
        for (uint256 i = 0; i < 5; i++) {
            shortLines[i] = "decoy";
        }
        p.decoyLines = shortLines;

        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.InvalidDecoyLinesLength.selector, 5));
        vm.prank(genius);
        sc.commit(p);
    }

    function test_commit_revertOnDecoyLinesTooMany() public {
        SignalCommitment.CommitParams memory p = _defaultParams(101);
        string[] memory longLines = new string[](11);
        for (uint256 i = 0; i < 11; i++) {
            longLines[i] = "decoy";
        }
        p.decoyLines = longLines;

        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.InvalidDecoyLinesLength.selector, 11));
        vm.prank(genius);
        sc.commit(p);
    }

    // ─── Tests: Revert on SLA multiplier too low
    // ─────────────────────────

    function test_commit_revertOnSlaMultiplierTooLow() public {
        SignalCommitment.CommitParams memory p = _defaultParams(200);
        p.slaMultiplierBps = 9999;

        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.SlaMultiplierTooLow.selector, 9999));
        vm.prank(genius);
        sc.commit(p);
    }

    function test_commit_slaMultiplierExactMinimum() public {
        SignalCommitment.CommitParams memory p = _defaultParams(201);
        p.slaMultiplierBps = 10_000;

        vm.prank(genius);
        sc.commit(p);

        assertTrue(sc.signalExists(201));
    }

    function test_commit_revertOnSlaMultiplierTooHigh() public {
        SignalCommitment.CommitParams memory p = _defaultParams(202);
        p.slaMultiplierBps = 30_001;

        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.SlaMultiplierTooHigh.selector, 30_001));
        vm.prank(genius);
        sc.commit(p);
    }

    function test_commit_slaMultiplierExactMaximum() public {
        SignalCommitment.CommitParams memory p = _defaultParams(203);
        p.slaMultiplierBps = 30_000;

        vm.prank(genius);
        sc.commit(p);

        assertTrue(sc.signalExists(203));
    }

    // ─── Tests: Revert on invalid max price
    // ──────────────────────────────

    function test_commit_revertOnMaxPriceZero() public {
        SignalCommitment.CommitParams memory p = _defaultParams(300);
        p.maxPriceBps = 0;

        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.InvalidMaxPriceBps.selector, 0));
        vm.prank(genius);
        sc.commit(p);
    }

    function test_commit_revertOnMaxPriceTooHigh() public {
        SignalCommitment.CommitParams memory p = _defaultParams(301);
        p.maxPriceBps = 5001;

        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.InvalidMaxPriceBps.selector, 5001));
        vm.prank(genius);
        sc.commit(p);
    }

    function test_commit_maxPriceExactMaximum() public {
        SignalCommitment.CommitParams memory p = _defaultParams(302);
        p.maxPriceBps = 5000;

        vm.prank(genius);
        sc.commit(p);

        assertTrue(sc.signalExists(302));
    }

    function test_commit_maxPriceExactMinimum() public {
        SignalCommitment.CommitParams memory p = _defaultParams(303);
        p.maxPriceBps = 1;

        vm.prank(genius);
        sc.commit(p);

        assertTrue(sc.signalExists(303));
    }

    // ─── Tests: Notional range validation
    // ─────────────────────────────────

    function test_commit_revertOnInvalidNotionalRange() public {
        SignalCommitment.CommitParams memory p = _defaultParams(350);
        p.minNotional = 100e6; // 100 USDC min
        p.maxNotional = 50e6;  // 50 USDC max — invalid: min > max

        vm.expectRevert(
            abi.encodeWithSelector(SignalCommitment.InvalidNotionalRange.selector, 100e6, 50e6)
        );
        vm.prank(genius);
        sc.commit(p);
    }

    function test_commit_allowsZeroMaxNotional() public {
        // maxNotional=0 means "no limit", should be allowed regardless of minNotional
        SignalCommitment.CommitParams memory p = _defaultParams(351);
        p.minNotional = 100e6;
        p.maxNotional = 0;

        vm.prank(genius);
        sc.commit(p);

        assertTrue(sc.signalExists(351));
    }

    function test_commit_allowsEqualMinMax() public {
        SignalCommitment.CommitParams memory p = _defaultParams(352);
        p.minNotional = 50e6;
        p.maxNotional = 50e6;

        vm.prank(genius);
        sc.commit(p);

        assertTrue(sc.signalExists(352));
    }

    // ─── Tests: Revert on expired signal
    // ─────────────────────────────────

    function test_commit_revertOnExpiredSignal() public {
        SignalCommitment.CommitParams memory p = _defaultParams(400);
        p.expiresAt = block.timestamp; // equal to current time, not future

        vm.expectRevert(
            abi.encodeWithSelector(SignalCommitment.ExpirationInPast.selector, p.expiresAt, block.timestamp)
        );
        vm.prank(genius);
        sc.commit(p);
    }

    function test_commit_revertOnPastExpiration() public {
        SignalCommitment.CommitParams memory p = _defaultParams(401);
        p.expiresAt = block.timestamp - 1;

        vm.expectRevert(
            abi.encodeWithSelector(SignalCommitment.ExpirationInPast.selector, p.expiresAt, block.timestamp)
        );
        vm.prank(genius);
        sc.commit(p);
    }

    // ─── Tests: Revert on empty encrypted blob
    // ──────────────────────────

    function test_commit_revertOnEmptyBlob() public {
        SignalCommitment.CommitParams memory p = _defaultParams(500);
        p.encryptedBlob = "";

        vm.expectRevert(SignalCommitment.EmptyEncryptedBlob.selector);
        vm.prank(genius);
        sc.commit(p);
    }

    // ─── Tests: Revert on zero commit hash
    // ───────────────────────────────

    function test_commit_revertOnZeroCommitHash() public {
        SignalCommitment.CommitParams memory p = _defaultParams(501);
        p.commitHash = bytes32(0);

        vm.expectRevert(SignalCommitment.ZeroCommitHash.selector);
        vm.prank(genius);
        sc.commit(p);
    }

    // ─── Tests: Cancel signal by genius
    // ────────────────────────────────────

    function test_cancelSignal_success() public {
        _commitDefault(600);

        vm.prank(genius);
        sc.cancelSignal(600);

        Signal memory sig = sc.getSignal(600);
        assertEq(uint8(sig.status), uint8(SignalStatus.Cancelled));
    }

    function test_cancelSignal_emitsEvent() public {
        _commitDefault(601);

        vm.expectEmit(true, true, false, true);
        emit SignalCommitment.SignalCancelled(601, genius);

        vm.prank(genius);
        sc.cancelSignal(601);
    }

    // ─── Tests: Revert cancel by non-genius
    // ────────────────────────────────

    function test_cancelSignal_revertByNonGenius() public {
        _commitDefault(700);

        address imposter = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.NotSignalGenius.selector, imposter, genius));
        vm.prank(imposter);
        sc.cancelSignal(700);
    }

    // ─── Tests: Revert cancel on settled signal ──────────────────

    function test_cancelSignal_revertOnSettledSignal_direct() public {
        _commitDefault(800);

        // Set status to Settled via authorized caller
        vm.prank(authorizedCaller);
        sc.updateStatus(800, SignalStatus.Settled);

        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.SignalNotCancellable.selector, 800, SignalStatus.Settled));
        vm.prank(genius);
        sc.cancelSignal(800);
    }

    function test_cancelSignal_revertOnNonExistentSignal() public {
        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.SignalNotFound.selector, 999));
        vm.prank(genius);
        sc.cancelSignal(999);
    }

    // ─── Tests: Update status by authorized caller
    // ───────────────────────

    function test_updateStatus_byAuthorizedCaller() public {
        _commitDefault(900);

        vm.prank(authorizedCaller);
        sc.updateStatus(900, SignalStatus.Settled);

        Signal memory sig = sc.getSignal(900);
        assertEq(uint8(sig.status), uint8(SignalStatus.Settled));
    }

    function test_updateStatus_emitsEvent() public {
        _commitDefault(901);

        vm.expectEmit(true, false, false, true);
        emit SignalCommitment.SignalStatusUpdated(901, SignalStatus.Settled);

        vm.prank(authorizedCaller);
        sc.updateStatus(901, SignalStatus.Settled);
    }

    // ─── Tests: Revert update status by unauthorized caller ──────────────

    function test_updateStatus_revertByUnauthorizedCaller() public {
        _commitDefault(1000);

        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.CallerNotAuthorized.selector, unauthorizedCaller));
        vm.prank(unauthorizedCaller);
        sc.updateStatus(1000, SignalStatus.Settled);
    }

    function test_updateStatus_revertOnNonExistentSignal() public {
        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.SignalNotFound.selector, 1111));
        vm.prank(authorizedCaller);
        sc.updateStatus(1111, SignalStatus.Settled);
    }

    // ─── Tests: View functions
    // ───────────────────────────────────────────

    function test_getSignal_revertsForNonExistent() public {
        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.SignalNotFound.selector, 2000));
        sc.getSignal(2000);
    }

    function test_getSignalGenius_returnsCorrectAddress() public {
        _commitDefault(2001);
        assertEq(sc.getSignalGenius(2001), genius);
    }

    function test_getSignalGenius_revertsForNonExistent() public {
        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.SignalNotFound.selector, 2002));
        sc.getSignalGenius(2002);
    }

    function test_isActive_trueForActiveSignal() public {
        _commitDefault(2003);
        assertTrue(sc.isActive(2003));
    }

    function test_isActive_falseForNonExistent() public {
        assertFalse(sc.isActive(2004));
    }

    function test_isActive_falseForCancelledSignal() public {
        _commitDefault(2005);
        vm.prank(genius);
        sc.cancelSignal(2005);
        assertFalse(sc.isActive(2005));
    }

    function test_isActive_falseForExpiredSignal() public {
        _commitDefault(2006);
        // Warp time past expiration
        vm.warp(block.timestamp + 2 hours);
        assertFalse(sc.isActive(2006));
    }

    function test_signalExists_trueAfterCommit() public {
        _commitDefault(2007);
        assertTrue(sc.signalExists(2007));
    }

    function test_signalExists_falseBeforeCommit() public {
        assertFalse(sc.signalExists(2008));
    }

    // ─── Tests: setAuthorizedCaller
    // ──────────────────────────────────────

    function test_setAuthorizedCaller_onlyOwner() public {
        address newCaller = address(0xCAFE);
        sc.setAuthorizedCaller(newCaller, true);
        assertTrue(sc.authorizedCallers(newCaller));

        sc.setAuthorizedCaller(newCaller, false);
        assertFalse(sc.authorizedCallers(newCaller));
    }

    function test_setAuthorizedCaller_revertNonOwner() public {
        vm.prank(genius);
        vm.expectRevert();
        sc.setAuthorizedCaller(address(0xDEAD), true);
    }

    // ─── Tests: State transition coverage
    // ─────────────────────────────────

    function test_updateStatus_activeToSettled() public {
        _commitDefault(3000);

        vm.prank(authorizedCaller);
        sc.updateStatus(3000, SignalStatus.Settled);

        assertEq(uint8(sc.getSignal(3000).status), uint8(SignalStatus.Settled));
    }

    function test_updateStatus_activeToCancelled() public {
        _commitDefault(3002);

        vm.prank(authorizedCaller);
        sc.updateStatus(3002, SignalStatus.Cancelled);

        assertEq(uint8(sc.getSignal(3002).status), uint8(SignalStatus.Cancelled));
    }

    function test_isActive_falseAfterSettled_v2() public {
        _commitDefault(3003);

        vm.prank(authorizedCaller);
        sc.updateStatus(3003, SignalStatus.Settled);

        assertFalse(sc.isActive(3003));
    }

    function test_cancelSignal_revertOnCancelledSignal() public {
        _commitDefault(3005);

        vm.prank(genius);
        sc.cancelSignal(3005);

        // Cancelled signals are not Active, so cancelSignal should revert
        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.SignalNotCancellable.selector, 3005, SignalStatus.Cancelled));
        vm.prank(genius);
        sc.cancelSignal(3005);
    }

    function test_cancelSignal_revertOnSettledSignal_v2() public {
        _commitDefault(3006);

        vm.prank(authorizedCaller);
        sc.updateStatus(3006, SignalStatus.Settled);

        vm.expectRevert(abi.encodeWithSelector(SignalCommitment.SignalNotCancellable.selector, 3006, SignalStatus.Settled));
        vm.prank(genius);
        sc.cancelSignal(3006);
    }

    // ─── Tests: Invalid state transitions
    // ────────────────────────────────

    function test_updateStatus_revertActiveToActive() public {
        _commitDefault(4000);

        vm.expectRevert(
            abi.encodeWithSelector(
                SignalCommitment.InvalidStatusTransition.selector, 4000, SignalStatus.Active, SignalStatus.Active
            )
        );
        vm.prank(authorizedCaller);
        sc.updateStatus(4000, SignalStatus.Active);
    }

    function test_updateStatus_revertSettledToActive() public {
        _commitDefault(4001);

        vm.prank(authorizedCaller);
        sc.updateStatus(4001, SignalStatus.Settled);

        vm.expectRevert(
            abi.encodeWithSelector(
                SignalCommitment.InvalidStatusTransition.selector, 4001, SignalStatus.Settled, SignalStatus.Active
            )
        );
        vm.prank(authorizedCaller);
        sc.updateStatus(4001, SignalStatus.Active);
    }

    function test_updateStatus_revertSettledToSettled() public {
        _commitDefault(4002);

        vm.prank(authorizedCaller);
        sc.updateStatus(4002, SignalStatus.Settled);

        vm.expectRevert(
            abi.encodeWithSelector(
                SignalCommitment.InvalidStatusTransition.selector, 4002, SignalStatus.Settled, SignalStatus.Settled
            )
        );
        vm.prank(authorizedCaller);
        sc.updateStatus(4002, SignalStatus.Settled);
    }

    function test_updateStatus_revertCancelledToActive() public {
        _commitDefault(4003);

        vm.prank(authorizedCaller);
        sc.updateStatus(4003, SignalStatus.Cancelled);

        vm.expectRevert(
            abi.encodeWithSelector(
                SignalCommitment.InvalidStatusTransition.selector, 4003, SignalStatus.Cancelled, SignalStatus.Active
            )
        );
        vm.prank(authorizedCaller);
        sc.updateStatus(4003, SignalStatus.Active);
    }

    function test_updateStatus_cancelledToSettled() public {
        _commitDefault(4004);

        vm.prank(authorizedCaller);
        sc.updateStatus(4004, SignalStatus.Cancelled);

        // Cancelled signals can transition to Settled (existing purchases still settle)
        vm.prank(authorizedCaller);
        sc.updateStatus(4004, SignalStatus.Settled);

        assertEq(uint8(sc.getSignal(4004).status), uint8(SignalStatus.Settled));
    }

    // ─── Tests: Blob size limit
    // ──────────────────────────────────

    function test_commit_revertOnBlobTooLarge() public {
        SignalCommitment.CommitParams memory p = _defaultParams(5000);
        p.encryptedBlob = new bytes(sc.MAX_BLOB_SIZE() + 1);
        p.encryptedBlob[0] = 0x01;

        vm.expectRevert(
            abi.encodeWithSelector(SignalCommitment.BlobTooLarge.selector, sc.MAX_BLOB_SIZE() + 1, sc.MAX_BLOB_SIZE())
        );
        vm.prank(genius);
        sc.commit(p);
    }

    function test_commit_blobAtMaxSize() public {
        SignalCommitment.CommitParams memory p = _defaultParams(5001);
        p.encryptedBlob = new bytes(sc.MAX_BLOB_SIZE());
        p.encryptedBlob[0] = 0x01;

        vm.prank(genius);
        sc.commit(p);
        assertTrue(sc.signalExists(5001));
    }

    // ─── Tests: Sportsbooks limit
    // ──────────────────────────────────

    function test_commit_revertOnTooManySportsbooks() public {
        SignalCommitment.CommitParams memory p = _defaultParams(5100);
        string[] memory books = new string[](sc.MAX_SPORTSBOOKS() + 1);
        for (uint256 i = 0; i < books.length; i++) {
            books[i] = "book";
        }
        p.availableSportsbooks = books;

        vm.expectRevert(
            abi.encodeWithSelector(
                SignalCommitment.TooManySportsbooks.selector, sc.MAX_SPORTSBOOKS() + 1, sc.MAX_SPORTSBOOKS()
            )
        );
        vm.prank(genius);
        sc.commit(p);
    }

    function test_commit_sportsbooksAtMax() public {
        SignalCommitment.CommitParams memory p = _defaultParams(5101);
        string[] memory books = new string[](sc.MAX_SPORTSBOOKS());
        for (uint256 i = 0; i < books.length; i++) {
            books[i] = "book";
        }
        p.availableSportsbooks = books;

        vm.prank(genius);
        sc.commit(p);
        assertTrue(sc.signalExists(5101));
    }

    // ─── Tests: Per-string length limits
    // ──────────────────────────────────

    function _makeOversizedString(uint256 length) internal pure returns (string memory) {
        bytes memory b = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            b[i] = "A";
        }
        return string(b);
    }

    function test_commit_revertOnDecoyLineTooLong() public {
        SignalCommitment.CommitParams memory p = _defaultParams(6000);
        p.decoyLines[0] = _makeOversizedString(sc.MAX_DECOY_LINE_LENGTH() + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                SignalCommitment.StringTooLong.selector,
                "decoyLine",
                sc.MAX_DECOY_LINE_LENGTH() + 1,
                sc.MAX_DECOY_LINE_LENGTH()
            )
        );
        vm.prank(genius);
        sc.commit(p);
    }

    function test_commit_decoyLineAtMaxLength() public {
        SignalCommitment.CommitParams memory p = _defaultParams(6001);
        p.decoyLines[0] = _makeOversizedString(sc.MAX_DECOY_LINE_LENGTH());

        vm.prank(genius);
        sc.commit(p);
        assertTrue(sc.signalExists(6001));
    }

    function test_commit_revertOnSportTooLong() public {
        SignalCommitment.CommitParams memory p = _defaultParams(6002);
        p.sport = _makeOversizedString(sc.MAX_SPORT_LENGTH() + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                SignalCommitment.StringTooLong.selector,
                "sport",
                sc.MAX_SPORT_LENGTH() + 1,
                sc.MAX_SPORT_LENGTH()
            )
        );
        vm.prank(genius);
        sc.commit(p);
    }

    function test_commit_sportAtMaxLength() public {
        SignalCommitment.CommitParams memory p = _defaultParams(6003);
        p.sport = _makeOversizedString(sc.MAX_SPORT_LENGTH());

        vm.prank(genius);
        sc.commit(p);
        assertTrue(sc.signalExists(6003));
    }

    function test_commit_revertOnSportsbookNameTooLong() public {
        SignalCommitment.CommitParams memory p = _defaultParams(6004);
        p.availableSportsbooks[0] = _makeOversizedString(sc.MAX_SPORTSBOOK_LENGTH() + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                SignalCommitment.StringTooLong.selector,
                "sportsbook",
                sc.MAX_SPORTSBOOK_LENGTH() + 1,
                sc.MAX_SPORTSBOOK_LENGTH()
            )
        );
        vm.prank(genius);
        sc.commit(p);
    }

    function test_commit_sportsbookNameAtMaxLength() public {
        SignalCommitment.CommitParams memory p = _defaultParams(6005);
        p.availableSportsbooks[0] = _makeOversizedString(sc.MAX_SPORTSBOOK_LENGTH());

        vm.prank(genius);
        sc.commit(p);
        assertTrue(sc.signalExists(6005));
    }

    // ─── Collateral Gate Tests ──────────────────────────────

    function test_setCollateral_onlyOwner() public {
        address mockCollateral = address(0xC01);
        sc.setCollateral(mockCollateral);
        assertEq(sc.collateral(), mockCollateral);
    }

    function test_setCollateral_revertNonOwner() public {
        vm.prank(genius);
        vm.expectRevert();
        sc.setCollateral(address(0xC01));
    }

    function test_commit_noCollateralSetAllowed() public {
        // Without collateral contract set, commit should work (backwards compat)
        assertEq(sc.collateral(), address(0));
        _commitDefault(7001);
        assertTrue(sc.signalExists(7001));
    }

    function test_commit_withCollateralSufficientPasses() public {
        // Deploy a mock collateral that returns enough available
        MockCollateral mock = new MockCollateral();
        // Default params: maxNotional=10_000e6, slaMultiplierBps=15_000
        // Required: 10_000e6 * 15_000 / 10_000 = 15_000e6
        mock.setAvailable(genius, 15_000e6);
        sc.setCollateral(address(mock));

        _commitDefault(7002);
        assertTrue(sc.signalExists(7002));
    }

    function test_commit_withCollateralInsufficientReverts() public {
        MockCollateral mock = new MockCollateral();
        // Set available below required (15_000e6)
        mock.setAvailable(genius, 10_000e6);
        sc.setCollateral(address(mock));

        vm.prank(genius);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignalCommitment.InsufficientCollateral.selector,
                genius,
                10_000e6,
                15_000e6
            )
        );
        sc.commit(_defaultParams(7003));
    }

    function test_commit_withCollateralZeroAvailableReverts() public {
        MockCollateral mock = new MockCollateral();
        mock.setAvailable(genius, 0);
        sc.setCollateral(address(mock));

        vm.prank(genius);
        vm.expectRevert();
        sc.commit(_defaultParams(7004));
    }

    function test_commit_unlimitedNotionalSkipsCollateralCheck() public {
        MockCollateral mock = new MockCollateral();
        mock.setAvailable(genius, 0); // zero collateral
        sc.setCollateral(address(mock));

        // maxNotional=0 means unlimited, collateral check is skipped
        SignalCommitment.CommitParams memory p = _defaultParams(7005);
        p.maxNotional = 0;

        vm.prank(genius);
        sc.commit(p);
        assertTrue(sc.signalExists(7005));
    }
}

/// @dev Mock collateral contract for testing
contract MockCollateral {
    mapping(address => uint256) private _available;

    function setAvailable(address genius, uint256 amount) external {
        _available[genius] = amount;
    }

    function getAvailable(address genius) external view returns (uint256) {
        return _available[genius];
    }
}
