// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OutcomeVoting} from "../src/OutcomeVoting.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

/// @title OutcomeVotingSyncTest
/// @notice Tests for the consensus-based validator set sync mechanism
contract OutcomeVotingSyncTest is Test {
    OutcomeVoting voting;

    address owner;
    address v1 = address(0xA001);
    address v2 = address(0xA002);
    address v3 = address(0xA003);
    address v4 = address(0xA004);
    address v5 = address(0xA005);

    function setUp() public {
        owner = address(this);
        voting = OutcomeVoting(_deployProxy(address(new OutcomeVoting()), abi.encodeCall(OutcomeVoting.initialize, (owner))));
    }

    // ─── Helpers ─────────────────────────────────────────────

    function _sorted2(address a, address b) internal pure returns (address[] memory) {
        address[] memory arr = new address[](2);
        if (a < b) { arr[0] = a; arr[1] = b; }
        else { arr[0] = b; arr[1] = a; }
        return arr;
    }

    function _sorted3(address a, address b, address c) internal pure returns (address[] memory) {
        address[] memory arr = new address[](3);
        arr[0] = a; arr[1] = b; arr[2] = c;
        // Bubble sort for 3 elements
        if (arr[0] > arr[1]) (arr[0], arr[1]) = (arr[1], arr[0]);
        if (arr[1] > arr[2]) (arr[1], arr[2]) = (arr[2], arr[1]);
        if (arr[0] > arr[1]) (arr[0], arr[1]) = (arr[1], arr[0]);
        return arr;
    }

    function _single(address a) internal pure returns (address[] memory) {
        address[] memory arr = new address[](1);
        arr[0] = a;
        return arr;
    }

    // ─── Single Validator: auto-applies ──────────────────────

    function test_proposeSync_singleValidator_appliesImmediately() public {
        voting.addValidator(v1);
        uint256 nonce = voting.syncNonce();

        address[] memory proposed = _sorted2(v1, v2);

        vm.prank(v1);
        voting.proposeSync(proposed, nonce);

        // Should have applied: v1 and v2 are now validators
        assertTrue(voting.isValidator(v1));
        assertTrue(voting.isValidator(v2));
        assertEq(voting.validatorCount(), 2);
        assertEq(voting.syncNonce(), nonce + 1);
    }

    // ─── Three Validators: quorum at 2 ──────────────────────

    function test_proposeSync_threeValidators_quorumAtTwo() public {
        voting.addValidator(v1);
        voting.addValidator(v2);
        voting.addValidator(v3);
        uint256 nonce = voting.syncNonce();

        address[] memory proposed = _sorted2(v4, v5);

        // First vote — no quorum yet
        vm.prank(v1);
        voting.proposeSync(proposed, nonce);
        assertFalse(voting.isValidator(v4));
        assertEq(voting.syncNonce(), nonce); // unchanged

        // Second vote — quorum reached (2/3)
        vm.prank(v2);
        voting.proposeSync(proposed, nonce);
        assertTrue(voting.isValidator(v4));
        assertTrue(voting.isValidator(v5));
        assertFalse(voting.isValidator(v1));
        assertFalse(voting.isValidator(v2));
        assertFalse(voting.isValidator(v3));
        assertEq(voting.validatorCount(), 2);
        assertEq(voting.syncNonce(), nonce + 1);
    }

    // ─── Stale Nonce Reverts ─────────────────────────────────

    function test_proposeSync_staleNonce_reverts() public {
        voting.addValidator(v1);
        uint256 nonce = voting.syncNonce();

        vm.expectRevert(
            abi.encodeWithSelector(OutcomeVoting.StaleNonce.selector, nonce, nonce + 1)
        );
        vm.prank(v1);
        voting.proposeSync(_single(v1), nonce + 1);
    }

    // ─── Non-Validator Reverts ───────────────────────────────

    function test_proposeSync_nonValidator_reverts() public {
        voting.addValidator(v1);
        uint256 nonce = voting.syncNonce();

        vm.expectRevert(
            abi.encodeWithSelector(OutcomeVoting.NotValidator.selector, v2)
        );
        vm.prank(v2);
        voting.proposeSync(_single(v1), nonce);
    }

    // ─── Duplicate Vote Reverts ──────────────────────────────

    function test_proposeSync_duplicateVote_reverts() public {
        voting.addValidator(v1);
        voting.addValidator(v2);
        voting.addValidator(v3);
        uint256 nonce = voting.syncNonce();

        address[] memory proposed = _sorted3(v1, v2, v3);

        vm.prank(v1);
        voting.proposeSync(proposed, nonce);

        vm.expectRevert(
            abi.encodeWithSelector(OutcomeVoting.AlreadySyncVoted.selector, v1, nonce)
        );
        vm.prank(v1);
        voting.proposeSync(proposed, nonce);
    }

    // ─── Empty Set Reverts ───────────────────────────────────

    function test_proposeSync_emptySet_reverts() public {
        voting.addValidator(v1);
        uint256 nonce = voting.syncNonce();

        address[] memory empty = new address[](0);
        vm.expectRevert(OutcomeVoting.EmptyValidatorSet.selector);
        vm.prank(v1);
        voting.proposeSync(empty, nonce);
    }

    // ─── Unsorted Array Reverts ──────────────────────────────

    function test_proposeSync_unsorted_reverts() public {
        voting.addValidator(v1);
        uint256 nonce = voting.syncNonce();

        address[] memory unsorted = new address[](2);
        // Ensure descending order (larger first)
        if (v1 > v2) { unsorted[0] = v1; unsorted[1] = v2; }
        else { unsorted[0] = v2; unsorted[1] = v1; }

        vm.expectRevert(OutcomeVoting.UnsortedOrDuplicateValidators.selector);
        vm.prank(v1);
        voting.proposeSync(unsorted, nonce);
    }

    // ─── Duplicate Addresses Reverts ─────────────────────────

    function test_proposeSync_duplicateAddresses_reverts() public {
        voting.addValidator(v1);
        uint256 nonce = voting.syncNonce();

        address[] memory dupes = new address[](2);
        dupes[0] = v2;
        dupes[1] = v2;

        vm.expectRevert(OutcomeVoting.UnsortedOrDuplicateValidators.selector);
        vm.prank(v1);
        voting.proposeSync(dupes, nonce);
    }

    // ─── Zero Address in Proposal Reverts ────────────────────

    function test_proposeSync_zeroAddress_reverts() public {
        voting.addValidator(v1);
        uint256 nonce = voting.syncNonce();

        address[] memory withZero = new address[](1);
        withZero[0] = address(0);

        vm.expectRevert(OutcomeVoting.ZeroAddress.selector);
        vm.prank(v1);
        voting.proposeSync(withZero, nonce);
    }

    // ─── addValidator Increments Nonce ───────────────────────

    function test_addValidator_incrementsNonce() public {
        uint256 nonceBefore = voting.syncNonce();
        voting.addValidator(v1);
        assertEq(voting.syncNonce(), nonceBefore + 1);
    }

    // ─── removeValidator Increments Nonce ────────────────────

    function test_removeValidator_incrementsNonce() public {
        voting.addValidator(v1);
        uint256 nonceBefore = voting.syncNonce();
        voting.removeValidator(v1);
        assertEq(voting.syncNonce(), nonceBefore + 1);
    }

    // ─── getValidators Returns Full Set ──────────────────────

    function test_getValidators_returnsFullSet() public {
        voting.addValidator(v1);
        voting.addValidator(v2);
        voting.addValidator(v3);

        address[] memory vals = voting.getValidators();
        assertEq(vals.length, 3);
        assertEq(vals[0], v1);
        assertEq(vals[1], v2);
        assertEq(vals[2], v3);
    }

    // ─── Full Replacement Preserves Integrity ────────────────

    function test_proposeSync_replaceEntireSet() public {
        voting.addValidator(v1);
        voting.addValidator(v2);
        voting.addValidator(v3);
        uint256 nonce = voting.syncNonce();

        // New set: v3, v4, v5 (completely different except v3)
        address[] memory proposed = _sorted3(v3, v4, v5);

        vm.prank(v1);
        voting.proposeSync(proposed, nonce);
        vm.prank(v2);
        voting.proposeSync(proposed, nonce);

        // Old validators removed (except v3 which is in new set)
        assertFalse(voting.isValidator(v1));
        assertFalse(voting.isValidator(v2));
        // New validators active
        assertTrue(voting.isValidator(v3));
        assertTrue(voting.isValidator(v4));
        assertTrue(voting.isValidator(v5));

        assertEq(voting.validatorCount(), 3);

        // getValidators returns the new sorted set
        address[] memory vals = voting.getValidators();
        assertEq(vals.length, 3);
        // Should be in sorted order
        for (uint256 i = 1; i < vals.length; i++) {
            assertTrue(vals[i] > vals[i - 1], "Validators not sorted after sync");
        }
    }

    // ─── Disagreement: Different proposals don't cross-count ─

    function test_proposeSync_disagreementNoFinalization() public {
        voting.addValidator(v1);
        voting.addValidator(v2);
        voting.addValidator(v3);
        uint256 nonce = voting.syncNonce();

        // v1 proposes {v4}
        vm.prank(v1);
        voting.proposeSync(_single(v4), nonce);

        // v2 proposes {v5} — different set
        vm.prank(v2);
        voting.proposeSync(_single(v5), nonce);

        // Neither reached quorum — old set unchanged
        assertTrue(voting.isValidator(v1));
        assertTrue(voting.isValidator(v2));
        assertTrue(voting.isValidator(v3));
        assertFalse(voting.isValidator(v4));
        assertFalse(voting.isValidator(v5));
        assertEq(voting.syncNonce(), nonce); // unchanged
    }

    // ─── After sync, new validators can propose next sync ────

    function test_proposeSync_newValidatorsCanProposeNext() public {
        voting.addValidator(v1);
        uint256 nonce = voting.syncNonce();

        // v1 proposes {v2}
        vm.prank(v1);
        voting.proposeSync(_single(v2), nonce);

        // Now v2 is the only validator, v1 is gone
        assertTrue(voting.isValidator(v2));
        assertFalse(voting.isValidator(v1));

        uint256 nonce2 = voting.syncNonce();
        assertEq(nonce2, nonce + 1);

        // v2 can now propose again
        address[] memory proposed = _sorted2(v2, v3);
        vm.prank(v2);
        voting.proposeSync(proposed, nonce2);

        assertTrue(voting.isValidator(v2));
        assertTrue(voting.isValidator(v3));
    }

    // ─── Fuzz: Wrong nonce always reverts ────────────────────

    function testFuzz_proposeSyncNonce(uint256 wrongNonce) public {
        voting.addValidator(v1);
        uint256 correctNonce = voting.syncNonce();
        vm.assume(wrongNonce != correctNonce);

        vm.expectRevert(
            abi.encodeWithSelector(OutcomeVoting.StaleNonce.selector, correctNonce, wrongNonce)
        );
        vm.prank(v1);
        voting.proposeSync(_single(v1), wrongNonce);
    }

    // ─── Paused: proposeSync reverts ─────────────────────────

    function test_proposeSync_pausedReverts() public {
        voting.addValidator(v1);
        uint256 nonce = voting.syncNonce();
        voting.pause();

        vm.expectRevert();
        vm.prank(v1);
        voting.proposeSync(_single(v1), nonce);
    }
}
