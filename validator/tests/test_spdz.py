"""Tests for SPDZ MAC verification and authenticated MPC."""

from __future__ import annotations

import os
import random
import secrets
from unittest.mock import patch

import pytest

from djinn_validator.core.spdz import (
    AuthenticatedBeaverTriple,
    AuthenticatedMPCSession,
    AuthenticatedParticipantState,
    AuthenticatedShare,
    MACCheckCommitment,
    MACCheckReveal,
    MACKeyShare,
    MACVerificationError,
    authenticate_value,
    compute_mac_check,
    create_mac_commitment,
    generate_authenticated_triples,
    generate_mac_key,
    verify_mac_commitment,
    verify_mac_opening,
    verify_mac_opening_with_commitments,
)

# Use a small prime for fast tests
SMALL_PRIME = 104729


class TestMACKeyGeneration:
    """Test global MAC key generation and sharing."""

    def test_key_generation(self) -> None:
        x_coords = [1, 2, 3, 4, 5]
        alpha, shares = generate_mac_key(x_coords, threshold=3, prime=SMALL_PRIME)

        assert 1 <= alpha < SMALL_PRIME
        assert len(shares) == 5
        for s, x in zip(shares, x_coords):
            assert s.x == x

    def test_key_reconstruction(self) -> None:
        """MAC key can be reconstructed from threshold shares via Lagrange."""
        from djinn_validator.utils.crypto import Share, reconstruct_secret

        x_coords = [1, 2, 3, 4, 5]
        alpha, shares = generate_mac_key(x_coords, threshold=3, prime=SMALL_PRIME)

        # Reconstruct from any 3 shares
        recon_shares = [Share(x=s.x, y=s.alpha_share) for s in shares[:3]]
        reconstructed = reconstruct_secret(recon_shares, prime=SMALL_PRIME)
        assert reconstructed == alpha

    def test_key_different_subsets(self) -> None:
        """Different subsets of threshold shares reconstruct same key."""
        from djinn_validator.utils.crypto import Share, reconstruct_secret

        x_coords = [1, 2, 3, 4, 5]
        alpha, shares = generate_mac_key(x_coords, threshold=3, prime=SMALL_PRIME)

        subset1 = [Share(x=shares[0].x, y=shares[0].alpha_share),
                    Share(x=shares[1].x, y=shares[1].alpha_share),
                    Share(x=shares[2].x, y=shares[2].alpha_share)]
        subset2 = [Share(x=shares[2].x, y=shares[2].alpha_share),
                    Share(x=shares[3].x, y=shares[3].alpha_share),
                    Share(x=shares[4].x, y=shares[4].alpha_share)]

        r1 = reconstruct_secret(subset1, prime=SMALL_PRIME)
        r2 = reconstruct_secret(subset2, prime=SMALL_PRIME)
        assert r1 == r2 == alpha


class TestAuthenticateValue:
    """Test authenticated value sharing."""

    def test_value_reconstruction(self) -> None:
        from djinn_validator.utils.crypto import Share, reconstruct_secret

        x_coords = [1, 2, 3, 4, 5]
        alpha = 42
        secret = 777

        auth_shares = authenticate_value(secret, alpha, x_coords, threshold=3, prime=SMALL_PRIME)

        # Reconstruct value
        value_shares = [Share(x=s.x, y=s.y) for s in auth_shares[:3]]
        assert reconstruct_secret(value_shares, prime=SMALL_PRIME) == secret

    def test_mac_reconstruction(self) -> None:
        from djinn_validator.utils.crypto import Share, reconstruct_secret

        x_coords = [1, 2, 3, 4, 5]
        alpha = 42
        secret = 777

        auth_shares = authenticate_value(secret, alpha, x_coords, threshold=3, prime=SMALL_PRIME)

        # Reconstruct MAC
        mac_shares = [Share(x=s.x, y=s.mac) for s in auth_shares[:3]]
        mac_value = reconstruct_secret(mac_shares, prime=SMALL_PRIME)
        assert mac_value == (alpha * secret) % SMALL_PRIME

    def test_mac_invariant(self) -> None:
        """MAC = α * v for all values."""
        x_coords = [1, 2, 3, 4, 5, 6, 7]
        alpha = secrets.randbelow(SMALL_PRIME - 1) + 1

        for _ in range(5):
            secret = secrets.randbelow(SMALL_PRIME)
            auth_shares = authenticate_value(secret, alpha, x_coords, threshold=4, prime=SMALL_PRIME)

            from djinn_validator.utils.crypto import Share, reconstruct_secret
            mac_value = reconstruct_secret(
                [Share(x=s.x, y=s.mac) for s in auth_shares[:4]], prime=SMALL_PRIME
            )
            assert mac_value == (alpha * secret) % SMALL_PRIME


class TestMACVerification:
    """Test MAC verification on opened values."""

    def test_valid_opening(self) -> None:
        x_coords = [1, 2, 3, 4, 5]
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=3, prime=SMALL_PRIME)
        secret = 42

        auth_shares = authenticate_value(secret, alpha, x_coords, threshold=3, prime=SMALL_PRIME)

        assert verify_mac_opening(secret, auth_shares, alpha_shares, SMALL_PRIME)

    def test_invalid_opening_detected(self) -> None:
        """Corrupted opened value is detected by MAC check."""
        x_coords = [1, 2, 3, 4, 5]
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=3, prime=SMALL_PRIME)

        auth_shares = authenticate_value(42, alpha, x_coords, threshold=3, prime=SMALL_PRIME)

        # Wrong opened value
        assert not verify_mac_opening(43, auth_shares, alpha_shares, SMALL_PRIME)

    def test_corrupted_share_detected(self) -> None:
        """Corrupted MAC share is detected."""
        x_coords = [1, 2, 3, 4, 5]
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=3, prime=SMALL_PRIME)

        auth_shares = authenticate_value(42, alpha, x_coords, threshold=3, prime=SMALL_PRIME)

        # Corrupt one MAC share
        corrupted = list(auth_shares)
        bad = corrupted[2]
        corrupted[2] = AuthenticatedShare(x=bad.x, y=bad.y, mac=(bad.mac + 1) % SMALL_PRIME)

        assert not verify_mac_opening(42, corrupted, alpha_shares, SMALL_PRIME)

    def test_corrupted_value_share_detected(self) -> None:
        """Corrupted value share leads to wrong reconstruction, detected by MAC."""
        x_coords = [1, 2, 3, 4, 5]
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=3, prime=SMALL_PRIME)

        auth_shares = authenticate_value(42, alpha, x_coords, threshold=3, prime=SMALL_PRIME)

        # Corrupt one value share (but not its MAC)
        corrupted = list(auth_shares)
        bad = corrupted[1]
        corrupted[1] = AuthenticatedShare(x=bad.x, y=(bad.y + 1) % SMALL_PRIME, mac=bad.mac)

        # The opened value with corrupted share will be wrong
        from djinn_validator.utils.crypto import Share, reconstruct_secret
        wrong_value = reconstruct_secret(
            [Share(x=s.x, y=s.y) for s in corrupted[:3]], prime=SMALL_PRIME
        )
        # MAC check on wrong value should fail
        assert not verify_mac_opening(wrong_value, corrupted, alpha_shares, SMALL_PRIME)

    def test_linear_mac_subtraction(self) -> None:
        """MAC is linear: MAC(v - c) = MAC(v) - α*c for public constant c."""
        x_coords = [1, 2, 3]
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=2, prime=SMALL_PRIME)

        secret = 50
        constant = 7
        auth_shares = authenticate_value(secret, alpha, x_coords, threshold=2, prime=SMALL_PRIME)

        # Subtract constant from shares: v' = v - c (all parties subtract)
        adjusted = []
        for s in auth_shares:
            ak = next(a for a in alpha_shares if a.x == s.x)
            new_y = (s.y - constant) % SMALL_PRIME
            new_mac = (s.mac - ak.alpha_share * constant) % SMALL_PRIME
            adjusted.append(AuthenticatedShare(x=s.x, y=new_y, mac=new_mac))

        # Should verify with v - c
        assert verify_mac_opening(
            (secret - constant) % SMALL_PRIME, adjusted, alpha_shares, SMALL_PRIME
        )


class TestCommitmentProtocol:
    """Test the commit-then-reveal MAC verification protocol."""

    def test_valid_commitment(self) -> None:
        sigma = 12345
        commitment, reveal = create_mac_commitment(validator_x=1, sigma=sigma)
        assert verify_mac_commitment(commitment, reveal)

    def test_wrong_sigma_rejected(self) -> None:
        commitment, reveal = create_mac_commitment(validator_x=1, sigma=12345)
        forged = MACCheckReveal(validator_x=1, sigma=99999, nonce=reveal.nonce)
        assert not verify_mac_commitment(commitment, forged)

    def test_wrong_nonce_rejected(self) -> None:
        commitment, reveal = create_mac_commitment(validator_x=1, sigma=12345)
        forged = MACCheckReveal(validator_x=1, sigma=12345, nonce=b"\x00" * 32)
        assert not verify_mac_commitment(commitment, forged)

    def test_full_commitment_verification(self) -> None:
        x_coords = [1, 2, 3, 4, 5]
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=3, prime=SMALL_PRIME)
        secret = 42

        auth_shares = authenticate_value(secret, alpha, x_coords, threshold=3, prime=SMALL_PRIME)

        # Each party creates commitment
        commitments = []
        reveals = []
        alpha_map = {s.x: s for s in alpha_shares}
        for s in auth_shares:
            sigma = compute_mac_check(secret, s.mac, alpha_map[s.x].alpha_share, SMALL_PRIME)
            comm, rev = create_mac_commitment(validator_x=s.x, sigma=sigma)
            commitments.append(comm)
            reveals.append(rev)

        assert verify_mac_opening_with_commitments(
            secret, commitments, reveals, SMALL_PRIME
        )

    def test_forged_commitment_detected(self) -> None:
        x_coords = [1, 2, 3, 4, 5]
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=3, prime=SMALL_PRIME)

        auth_shares = authenticate_value(42, alpha, x_coords, threshold=3, prime=SMALL_PRIME)

        alpha_map = {s.x: s for s in alpha_shares}
        commitments = []
        reveals = []
        for i, s in enumerate(auth_shares):
            sigma = compute_mac_check(42, s.mac, alpha_map[s.x].alpha_share, SMALL_PRIME)
            if i == 2:
                sigma = (sigma + 1) % SMALL_PRIME  # Forge one sigma
            comm, rev = create_mac_commitment(validator_x=s.x, sigma=sigma)
            commitments.append(comm)
            reveals.append(rev)

        assert not verify_mac_opening_with_commitments(
            42, commitments, reveals, SMALL_PRIME
        )


class TestAuthenticatedTriples:
    """Test authenticated Beaver triple generation."""

    def test_triple_correctness(self) -> None:
        """c = a * b with proper MACs on all components."""
        from djinn_validator.utils.crypto import Share, reconstruct_secret

        x_coords = [1, 2, 3, 4, 5]
        alpha = 99

        triples = generate_authenticated_triples(
            count=3, alpha=alpha, x_coords=x_coords,
            threshold=3, prime=SMALL_PRIME,
        )

        for t in triples:
            a_val = reconstruct_secret(
                [Share(x=s.x, y=s.y) for s in t.a_shares[:3]], prime=SMALL_PRIME
            )
            b_val = reconstruct_secret(
                [Share(x=s.x, y=s.y) for s in t.b_shares[:3]], prime=SMALL_PRIME
            )
            c_val = reconstruct_secret(
                [Share(x=s.x, y=s.y) for s in t.c_shares[:3]], prime=SMALL_PRIME
            )
            assert c_val == (a_val * b_val) % SMALL_PRIME

    def test_triple_macs(self) -> None:
        """All triple components have valid MACs."""
        from djinn_validator.utils.crypto import Share, reconstruct_secret

        x_coords = [1, 2, 3, 4, 5]
        alpha = 99

        triples = generate_authenticated_triples(
            count=2, alpha=alpha, x_coords=x_coords,
            threshold=3, prime=SMALL_PRIME,
        )

        for t in triples:
            for shares in [t.a_shares, t.b_shares, t.c_shares]:
                val = reconstruct_secret(
                    [Share(x=s.x, y=s.y) for s in shares[:3]], prime=SMALL_PRIME
                )
                mac_val = reconstruct_secret(
                    [Share(x=s.x, y=s.mac) for s in shares[:3]], prime=SMALL_PRIME
                )
                assert mac_val == (alpha * val) % SMALL_PRIME


class TestAuthenticatedMPCSession:
    """Test the full SPDZ-style authenticated MPC protocol."""

    def _setup_session(
        self,
        secret: int,
        available_indices: set[int],
        n: int = 7,
        k: int = 4,
    ) -> AuthenticatedMPCSession:
        x_coords = list(range(1, n + 1))
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=k, prime=SMALL_PRIME)
        secret_shares = authenticate_value(secret, alpha, x_coords, threshold=k, prime=SMALL_PRIME)

        n_mults = max(len(available_indices), 1)
        triples = generate_authenticated_triples(
            count=n_mults, alpha=alpha, x_coords=x_coords,
            threshold=k, prime=SMALL_PRIME,
        )

        return AuthenticatedMPCSession(
            available_indices=available_indices,
            shares=secret_shares,
            alpha_shares=alpha_shares,
            triples=triples,
            threshold=k,
            prime=SMALL_PRIME,
        )

    def test_secret_in_set(self) -> None:
        """Secret is in the available set → available=True."""
        session = self._setup_session(secret=3, available_indices={1, 2, 3, 4, 5})
        available, n_parts = session.run()
        assert available is True
        assert n_parts == 7

    def test_secret_not_in_set(self) -> None:
        """Secret is NOT in the available set → available=False."""
        session = self._setup_session(secret=3, available_indices={1, 2, 4, 5})
        available, n_parts = session.run()
        assert available is False

    def test_single_element_set(self) -> None:
        session = self._setup_session(secret=5, available_indices={5})
        available, _ = session.run()
        assert available is True

    def test_single_element_miss(self) -> None:
        session = self._setup_session(secret=5, available_indices={3})
        available, _ = session.run()
        assert available is False

    def test_full_set(self) -> None:
        session = self._setup_session(secret=7, available_indices=set(range(1, 11)))
        available, _ = session.run()
        assert available is True

    def test_empty_set(self) -> None:
        session = self._setup_session(secret=3, available_indices=set())
        available, _ = session.run()
        assert available is False

    def test_insufficient_validators(self) -> None:
        x_coords = [1, 2, 3]
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=2, prime=SMALL_PRIME)
        secret_shares = authenticate_value(5, alpha, x_coords, threshold=2, prime=SMALL_PRIME)
        triples = generate_authenticated_triples(
            count=1, alpha=alpha, x_coords=x_coords,
            threshold=2, prime=SMALL_PRIME,
        )

        session = AuthenticatedMPCSession(
            available_indices={5},
            shares=secret_shares[:1],  # Only 1 share, threshold=2
            alpha_shares=alpha_shares[:1],
            triples=triples,
            threshold=2,
            prime=SMALL_PRIME,
        )
        available, n = session.run()
        assert available is False
        assert n == 1

    def test_tampered_share_detected(self) -> None:
        """Corrupting a share should trigger MACVerificationError."""
        x_coords = [1, 2, 3, 4, 5, 6, 7]
        k = 4
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=k, prime=SMALL_PRIME)
        secret_shares = authenticate_value(3, alpha, x_coords, threshold=k, prime=SMALL_PRIME)

        # Corrupt one share value
        corrupted = list(secret_shares)
        bad = corrupted[2]
        corrupted[2] = AuthenticatedShare(x=bad.x, y=(bad.y + 1) % SMALL_PRIME, mac=bad.mac)

        n_mults = 3  # available_indices = {1, 2, 3}
        triples = generate_authenticated_triples(
            count=n_mults, alpha=alpha, x_coords=x_coords,
            threshold=k, prime=SMALL_PRIME,
        )

        session = AuthenticatedMPCSession(
            available_indices={1, 2, 3},
            shares=corrupted,
            alpha_shares=alpha_shares,
            triples=triples,
            threshold=k,
            prime=SMALL_PRIME,
        )

        with pytest.raises(MACVerificationError):
            session.run()

    def test_tampered_triple_detected(self) -> None:
        """Corrupting a Beaver triple share should trigger MACVerificationError."""
        x_coords = [1, 2, 3, 4, 5, 6, 7]
        k = 4
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=k, prime=SMALL_PRIME)
        secret_shares = authenticate_value(3, alpha, x_coords, threshold=k, prime=SMALL_PRIME)

        triples = generate_authenticated_triples(
            count=1, alpha=alpha, x_coords=x_coords,
            threshold=k, prime=SMALL_PRIME,
        )

        # Corrupt one triple a-share value
        corrupted_triple = triples[0]
        bad_a = list(corrupted_triple.a_shares)
        old = bad_a[0]
        bad_a[0] = AuthenticatedShare(x=old.x, y=(old.y + 1) % SMALL_PRIME, mac=old.mac)

        triples[0] = AuthenticatedBeaverTriple(
            a_shares=tuple(bad_a),
            b_shares=corrupted_triple.b_shares,
            c_shares=corrupted_triple.c_shares,
        )

        session = AuthenticatedMPCSession(
            available_indices={3},
            shares=secret_shares,
            alpha_shares=alpha_shares,
            triples=triples,
            threshold=k,
            prime=SMALL_PRIME,
        )

        with pytest.raises(MACVerificationError):
            session.run()

    def test_randomized(self) -> None:
        """Randomized correctness check over multiple trials."""
        for _ in range(10):
            secret = secrets.randbelow(10) + 1  # 1-10
            n_available = secrets.randbelow(10) + 1
            indices = set(random.sample(range(1, 11), n_available))

            session = self._setup_session(
                secret=secret, available_indices=indices, n=7, k=4,
            )
            available, _ = session.run()
            assert available == (secret in indices)

    def test_reconstruct_alpha_blocked_outside_simulation(self) -> None:
        """R25-07: _reconstruct_alpha raises RuntimeError when DJINN_SPDZ_SIMULATION != 1."""
        session = self._setup_session(secret=3, available_indices={1, 2, 3})
        # Temporarily disable simulation mode on this instance
        session._SIMULATION_MODE = False
        with pytest.raises(RuntimeError, match="Cannot reconstruct alpha in production"):
            session._reconstruct_alpha()

    def test_run_blocked_outside_simulation(self) -> None:
        """R25-07: run() fails when simulation mode is off (defense-in-depth check)."""
        session = self._setup_session(secret=3, available_indices={1, 2, 3})
        session._SIMULATION_MODE = False
        with pytest.raises(RuntimeError, match="requires simulation mode"):
            session.run()


class TestAuthenticatedParticipantState:
    """Test per-validator authenticated participant state."""

    def test_compute_gate_returns_mac_values(self) -> None:
        """compute_gate returns both d,e values and their MAC shares."""
        x_coords = [1, 2, 3]
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=2, prime=SMALL_PRIME)

        secret = 5
        secret_shares = authenticate_value(secret, alpha, x_coords, threshold=2, prime=SMALL_PRIME)
        r = 42
        r_shares = authenticate_value(r, alpha, x_coords, threshold=2, prime=SMALL_PRIME)

        triples = generate_authenticated_triples(
            count=1, alpha=alpha, x_coords=x_coords,
            threshold=2, prime=SMALL_PRIME,
        )

        state = AuthenticatedParticipantState(
            validator_x=1,
            secret_share=secret_shares[0],
            r_share=r_shares[0],
            alpha_share=alpha_shares[0],
            available_indices=[3],
            triple_a=[triples[0].a_shares[0]],
            triple_b=[triples[0].b_shares[0]],
            triple_c=[triples[0].c_shares[0]],
            prime=SMALL_PRIME,
        )

        d_val, e_val, d_mac, e_mac = state.compute_gate(0)

        # d = r_share - a_share (values)
        expected_d = (r_shares[0].y - triples[0].a_shares[0].y) % SMALL_PRIME
        assert d_val == expected_d

        # d_mac = r_mac - a_mac (MACs)
        expected_d_mac = (r_shares[0].mac - triples[0].a_shares[0].mac) % SMALL_PRIME
        assert d_mac == expected_d_mac

    def test_finalize_gate(self) -> None:
        """finalize_gate computes z share correctly."""
        x_coords = [1, 2, 3]
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=2, prime=SMALL_PRIME)

        secret = 5
        secret_shares = authenticate_value(secret, alpha, x_coords, threshold=2, prime=SMALL_PRIME)
        r = 42
        r_shares = authenticate_value(r, alpha, x_coords, threshold=2, prime=SMALL_PRIME)

        triples = generate_authenticated_triples(
            count=1, alpha=alpha, x_coords=x_coords,
            threshold=2, prime=SMALL_PRIME,
        )

        state = AuthenticatedParticipantState(
            validator_x=1,
            secret_share=secret_shares[0],
            r_share=r_shares[0],
            alpha_share=alpha_shares[0],
            available_indices=[3],
            triple_a=[triples[0].a_shares[0]],
            triple_b=[triples[0].b_shares[0]],
            triple_c=[triples[0].c_shares[0]],
            prime=SMALL_PRIME,
        )

        state.compute_gate(0)
        state.finalize_gate(opened_d=10, opened_e=20)

        output = state.get_output_share()
        assert output is not None
        assert output.x == 1

    def test_sequential_gates(self) -> None:
        """Multiple gates can be computed sequentially."""
        x_coords = [1, 2, 3]
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=2, prime=SMALL_PRIME)

        secret = 5
        secret_shares = authenticate_value(secret, alpha, x_coords, threshold=2, prime=SMALL_PRIME)
        r = 42
        r_shares = authenticate_value(r, alpha, x_coords, threshold=2, prime=SMALL_PRIME)

        triples = generate_authenticated_triples(
            count=2, alpha=alpha, x_coords=x_coords,
            threshold=2, prime=SMALL_PRIME,
        )

        state = AuthenticatedParticipantState(
            validator_x=1,
            secret_share=secret_shares[0],
            r_share=r_shares[0],
            alpha_share=alpha_shares[0],
            available_indices=[3, 5],
            triple_a=[triples[0].a_shares[0], triples[1].a_shares[0]],
            triple_b=[triples[0].b_shares[0], triples[1].b_shares[0]],
            triple_c=[triples[0].c_shares[0], triples[1].c_shares[0]],
            prime=SMALL_PRIME,
        )

        # Gate 0
        state.compute_gate(0)
        state.finalize_gate(opened_d=10, opened_e=20)

        # Gate 1
        state.compute_gate(1, prev_opened_d=10, prev_opened_e=20)
        state.finalize_gate(opened_d=5, opened_e=15)

        output = state.get_output_share()
        assert output is not None

    def test_wrong_gate_order_rejected(self) -> None:
        """Gates must be computed in order."""
        x_coords = [1, 2, 3]
        alpha, alpha_shares = generate_mac_key(x_coords, threshold=2, prime=SMALL_PRIME)

        secret_shares = authenticate_value(5, alpha, x_coords, threshold=2, prime=SMALL_PRIME)
        r_shares = authenticate_value(42, alpha, x_coords, threshold=2, prime=SMALL_PRIME)

        triples = generate_authenticated_triples(
            count=2, alpha=alpha, x_coords=x_coords,
            threshold=2, prime=SMALL_PRIME,
        )

        state = AuthenticatedParticipantState(
            validator_x=1,
            secret_share=secret_shares[0],
            r_share=r_shares[0],
            alpha_share=alpha_shares[0],
            available_indices=[3, 5],
            triple_a=[triples[0].a_shares[0], triples[1].a_shares[0]],
            triple_b=[triples[0].b_shares[0], triples[1].b_shares[0]],
            triple_c=[triples[0].c_shares[0], triples[1].c_shares[0]],
            prime=SMALL_PRIME,
        )

        with pytest.raises(ValueError, match="Expected gate 0"):
            state.compute_gate(1)
