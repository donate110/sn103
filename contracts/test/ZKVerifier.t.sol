// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ZKVerifier} from "../src/ZKVerifier.sol";
import {_deployProxy} from "./helpers/DeployHelpers.sol";

/// @notice Mock verifier that always returns true
contract MockVerifierTrue {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[52] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[106] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

/// @notice Mock verifier that always returns false
contract MockVerifierFalse {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[52] calldata)
        external
        pure
        returns (bool)
    {
        return false;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[106] calldata)
        external
        pure
        returns (bool)
    {
        return false;
    }
}

/// @notice Mock verifier that reverts
contract MockVerifierReverts {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[52] calldata)
        external
        pure
        returns (bool)
    {
        revert("proof verification failed");
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[106] calldata)
        external
        pure
        returns (bool)
    {
        revert("proof verification failed");
    }
}

/// @notice Mock verifier that returns invalid data (too short)
contract MockVerifierBadReturn {
    fallback() external {
        // Return only 1 byte instead of 32
        assembly {
            mstore(0, 0x01)
            return(0, 1)
        }
    }
}

/// @title ZKVerifierTest
/// @notice Tests for ZKVerifier admin functions and proof verification delegation
contract ZKVerifierTest is Test {
    ZKVerifier verifier;
    MockVerifierTrue mockTrue;
    MockVerifierFalse mockFalse;
    MockVerifierReverts mockReverts;
    MockVerifierBadReturn mockBadReturn;

    address owner;
    address nonOwner = address(0xCAFE);

    // Dummy proof elements (zeroed out — mock verifiers don't check them)
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[52] pubSignals52;
    uint256[106] pubSignals106;

    function setUp() public {
        owner = address(this);
        verifier = ZKVerifier(_deployProxy(address(new ZKVerifier()), abi.encodeCall(ZKVerifier.initialize, (owner))));
        mockTrue = new MockVerifierTrue();
        mockFalse = new MockVerifierFalse();
        mockReverts = new MockVerifierReverts();
        mockBadReturn = new MockVerifierBadReturn();
    }

    // ─── Admin: setAuditVerifier
    // ─────────────────────────────

    function test_setAuditVerifier_setsAddress() public {
        verifier.setAuditVerifier(address(mockTrue));
        assertEq(verifier.auditVerifier(), address(mockTrue));
    }

    function test_setAuditVerifier_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit ZKVerifier.AuditVerifierUpdated(address(mockTrue));
        verifier.setAuditVerifier(address(mockTrue));
    }

    function test_setAuditVerifier_revertsOnZeroAddress() public {
        vm.expectRevert(ZKVerifier.ZeroAddress.selector);
        verifier.setAuditVerifier(address(0));
    }

    function test_setAuditVerifier_revertsForNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert();
        verifier.setAuditVerifier(address(mockTrue));
    }

    // ─── Admin: setTrackRecordVerifier ───────────────────────

    function test_setTrackRecordVerifier_setsAddress() public {
        verifier.setTrackRecordVerifier(address(mockTrue));
        assertEq(verifier.trackRecordVerifier(), address(mockTrue));
    }

    function test_setTrackRecordVerifier_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit ZKVerifier.TrackRecordVerifierUpdated(address(mockTrue));
        verifier.setTrackRecordVerifier(address(mockTrue));
    }

    function test_setTrackRecordVerifier_revertsOnZeroAddress() public {
        vm.expectRevert(ZKVerifier.ZeroAddress.selector);
        verifier.setTrackRecordVerifier(address(0));
    }

    function test_setTrackRecordVerifier_revertsForNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert();
        verifier.setTrackRecordVerifier(address(mockTrue));
    }

    // ─── verifyAuditProof
    // ────────────────────────────────────

    function test_verifyAuditProof_revertsWhenNotSet() public {
        vm.expectRevert(ZKVerifier.VerifierNotSet.selector);
        verifier.verifyAuditProof(pA, pB, pC, pubSignals52);
    }

    function test_verifyAuditProof_returnsTrue() public {
        verifier.setAuditVerifier(address(mockTrue));
        bool valid = verifier.verifyAuditProof(pA, pB, pC, pubSignals52);
        assertTrue(valid);
    }

    function test_verifyAuditProof_returnsFalse() public {
        verifier.setAuditVerifier(address(mockFalse));
        bool valid = verifier.verifyAuditProof(pA, pB, pC, pubSignals52);
        assertFalse(valid);
    }

    function test_verifyAuditProof_revertsOnCallFailure() public {
        verifier.setAuditVerifier(address(mockReverts));
        vm.expectRevert(ZKVerifier.VerificationCallFailed.selector);
        verifier.verifyAuditProof(pA, pB, pC, pubSignals52);
    }

    function test_verifyAuditProof_revertsOnShortReturn() public {
        verifier.setAuditVerifier(address(mockBadReturn));
        vm.expectRevert(ZKVerifier.VerificationCallFailed.selector);
        verifier.verifyAuditProof(pA, pB, pC, pubSignals52);
    }

    function test_verifyAuditProof_revertsOnEOAVerifier() public {
        // Set verifier to an EOA (no code) — staticcall will fail
        verifier.setAuditVerifier(address(0xDEAD));
        vm.expectRevert(ZKVerifier.VerificationCallFailed.selector);
        verifier.verifyAuditProof(pA, pB, pC, pubSignals52);
    }

    // ─── verifyTrackRecordProof
    // ──────────────────────────────

    function test_verifyTrackRecordProof_revertsWhenNotSet() public {
        vm.expectRevert(ZKVerifier.VerifierNotSet.selector);
        verifier.verifyTrackRecordProof(pA, pB, pC, pubSignals106);
    }

    function test_verifyTrackRecordProof_returnsTrue() public {
        verifier.setTrackRecordVerifier(address(mockTrue));
        bool valid = verifier.verifyTrackRecordProof(pA, pB, pC, pubSignals106);
        assertTrue(valid);
    }

    function test_verifyTrackRecordProof_returnsFalse() public {
        verifier.setTrackRecordVerifier(address(mockFalse));
        bool valid = verifier.verifyTrackRecordProof(pA, pB, pC, pubSignals106);
        assertFalse(valid);
    }

    function test_verifyTrackRecordProof_revertsOnCallFailure() public {
        verifier.setTrackRecordVerifier(address(mockReverts));
        vm.expectRevert(ZKVerifier.VerificationCallFailed.selector);
        verifier.verifyTrackRecordProof(pA, pB, pC, pubSignals106);
    }

    function test_verifyTrackRecordProof_revertsOnShortReturn() public {
        verifier.setTrackRecordVerifier(address(mockBadReturn));
        vm.expectRevert(ZKVerifier.VerificationCallFailed.selector);
        verifier.verifyTrackRecordProof(pA, pB, pC, pubSignals106);
    }

    // ─── Verifier update
    // ─────────────────────────────────────

    function test_canUpdateVerifier() public {
        verifier.setAuditVerifier(address(mockFalse));
        assertFalse(verifier.verifyAuditProof(pA, pB, pC, pubSignals52));

        verifier.setAuditVerifier(address(mockTrue));
        assertTrue(verifier.verifyAuditProof(pA, pB, pC, pubSignals52));
    }
}
