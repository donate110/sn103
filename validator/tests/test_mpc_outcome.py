"""Tests for MPC outcome selection via polynomial evaluation."""

from __future__ import annotations

import pytest

from djinn_validator.core.mpc_outcome import (
    NUM_LINES,
    PolyEvalParticipantState,
    _eval_polynomial,
    lagrange_interpolation_coefficients,
    prototype_select_outcome,
    secure_select_outcome,
)
from djinn_validator.utils.crypto import BN254_PRIME, Share, split_secret


# Use a small prime for faster tests where field size doesn't matter
SMALL_PRIME = 104729


def _make_shares(secret: int, n: int = 10, k: int = 7, prime: int = BN254_PRIME) -> list[Share]:
    return split_secret(secret, n, k, prime)


# ---------------------------------------------------------------------------
# Lagrange Interpolation Coefficients
# ---------------------------------------------------------------------------


class TestLagrangeCoefficients:
    def test_constant_polynomial(self) -> None:
        """All outcomes same → constant polynomial."""
        outcomes = [2] * 10
        coeffs = lagrange_interpolation_coefficients(outcomes, SMALL_PRIME)
        for x in range(1, 11):
            assert _eval_polynomial(coeffs, x, SMALL_PRIME) == 2

    def test_correctness_at_all_points(self) -> None:
        """Polynomial passes through all 10 (index, outcome) pairs."""
        outcomes = [1, 0, 2, 3, 1, 2, 0, 3, 1, 2]
        coeffs = lagrange_interpolation_coefficients(outcomes, SMALL_PRIME)
        for i, o in enumerate(outcomes):
            assert _eval_polynomial(coeffs, i + 1, SMALL_PRIME) == o

    def test_identity_like(self) -> None:
        """Outcomes = [1, 2, 3, ...] (linear-ish in small field)."""
        outcomes = [i % 4 for i in range(10)]
        coeffs = lagrange_interpolation_coefficients(outcomes, SMALL_PRIME)
        for i, o in enumerate(outcomes):
            assert _eval_polynomial(coeffs, i + 1, SMALL_PRIME) == o

    def test_all_zeros(self) -> None:
        outcomes = [0] * 10
        coeffs = lagrange_interpolation_coefficients(outcomes, SMALL_PRIME)
        for x in range(1, 11):
            assert _eval_polynomial(coeffs, x, SMALL_PRIME) == 0

    def test_bn254_field(self) -> None:
        """Verify correctness in the actual BN254 field."""
        outcomes = [1, 2, 0, 3, 1, 0, 2, 3, 0, 1]
        coeffs = lagrange_interpolation_coefficients(outcomes, BN254_PRIME)
        for i, o in enumerate(outcomes):
            assert _eval_polynomial(coeffs, i + 1, BN254_PRIME) == o


# ---------------------------------------------------------------------------
# Prototype Outcome Selection
# ---------------------------------------------------------------------------


class TestPrototypeSelect:
    def test_selects_correct_outcome(self) -> None:
        """For each possible real index, prototype selects the right outcome."""
        outcomes = [1, 2, 0, 3, 1, 0, 2, 3, 0, 1]
        for real_index in range(1, 11):
            shares = _make_shares(real_index)
            result = prototype_select_outcome(shares, outcomes)
            assert result == outcomes[real_index - 1], f"index={real_index}"

    def test_insufficient_shares(self) -> None:
        shares = _make_shares(3)[:3]  # Only 3 shares, threshold is 7
        outcomes = [1, 2, 0, 3, 1, 0, 2, 3, 0, 1]
        assert prototype_select_outcome(shares, outcomes) is None

    def test_wrong_outcome_count(self) -> None:
        shares = _make_shares(1)
        assert prototype_select_outcome(shares, [1, 2, 3]) is None

    def test_all_same_outcome(self) -> None:
        shares = _make_shares(5)
        outcomes = [2] * 10
        assert prototype_select_outcome(shares, outcomes) == 2


# ---------------------------------------------------------------------------
# Secure MPC Outcome Selection
# ---------------------------------------------------------------------------


class TestSecureSelect:
    def test_selects_correct_outcome_all_indices(self) -> None:
        """Secure MPC selects the correct outcome for every possible index."""
        outcomes = [1, 2, 0, 3, 1, 0, 2, 3, 0, 1]
        for real_index in range(1, 11):
            shares = _make_shares(real_index)
            result = secure_select_outcome(shares, outcomes)
            assert result == outcomes[real_index - 1], f"index={real_index}"

    def test_all_same_outcome(self) -> None:
        """When all outcomes are identical, any index gives that outcome."""
        for val in range(4):
            outcomes = [val] * 10
            shares = _make_shares(3)
            result = secure_select_outcome(shares, outcomes)
            assert result == val

    def test_mixed_outcomes(self) -> None:
        outcomes = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1]
        shares = _make_shares(4)
        result = secure_select_outcome(shares, outcomes)
        assert result == 3  # outcomes[3] (0-indexed)

    def test_insufficient_shares(self) -> None:
        shares = _make_shares(1)[:3]
        outcomes = [1] * 10
        assert secure_select_outcome(shares, outcomes) is None

    def test_wrong_outcome_count(self) -> None:
        shares = _make_shares(1)
        assert secure_select_outcome(shares, [1, 2]) is None

    def test_matches_prototype(self) -> None:
        """Secure MPC and prototype must agree for all indices."""
        outcomes = [3, 0, 1, 2, 3, 0, 1, 2, 3, 0]
        for real_index in range(1, 11):
            shares = _make_shares(real_index)
            secure = secure_select_outcome(shares, outcomes)
            proto = prototype_select_outcome(shares, outcomes)
            assert secure == proto, f"index={real_index}: secure={secure}, proto={proto}"

    def test_boundary_outcomes(self) -> None:
        """All outcomes at boundary values (0 and 3)."""
        outcomes = [0, 3, 0, 3, 0, 3, 0, 3, 0, 3]
        shares = _make_shares(2)
        assert secure_select_outcome(shares, outcomes) == 3
        shares = _make_shares(1)
        assert secure_select_outcome(shares, outcomes) == 0


# ---------------------------------------------------------------------------
# PolyEvalParticipantState
# ---------------------------------------------------------------------------


class TestPolyEvalParticipantState:
    def test_gate_count(self) -> None:
        """Must call exactly 8 gates sequentially."""
        state = PolyEvalParticipantState(
            validator_x=1,
            secret_share_y=42,
            triple_a=[0] * 8,
            triple_b=[0] * 8,
            triple_c=[0] * 8,
            prime=SMALL_PRIME,
        )
        # Gate 0 needs no prev values
        state.compute_gate(0)
        # Gates 1-7 need prev values
        for g in range(1, 8):
            state.compute_gate(g, prev_opened_d=0, prev_opened_e=0)

    def test_wrong_gate_order_raises(self) -> None:
        state = PolyEvalParticipantState(
            validator_x=1,
            secret_share_y=42,
            triple_a=[0] * 8,
            triple_b=[0] * 8,
            triple_c=[0] * 8,
            prime=SMALL_PRIME,
        )
        with pytest.raises(ValueError, match="Expected gate 0"):
            state.compute_gate(1)

    def test_gate_0_no_prev_values_needed(self) -> None:
        state = PolyEvalParticipantState(
            validator_x=1,
            secret_share_y=100,
            triple_a=[10] * 8,
            triple_b=[20] * 8,
            triple_c=[200] * 8,
            prime=SMALL_PRIME,
        )
        d, e = state.compute_gate(0)
        # d = (s_share - a[0]) mod p = (100 - 10) % p = 90
        # e = (s_share - b[0]) mod p = (100 - 20) % p = 80
        assert d == 90
        assert e == 80

    def test_gate_1_requires_prev_values(self) -> None:
        state = PolyEvalParticipantState(
            validator_x=1,
            secret_share_y=42,
            triple_a=[0] * 8,
            triple_b=[0] * 8,
            triple_c=[0] * 8,
            prime=SMALL_PRIME,
        )
        state.compute_gate(0)
        with pytest.raises(ValueError, match="Previous gate"):
            state.compute_gate(1)
