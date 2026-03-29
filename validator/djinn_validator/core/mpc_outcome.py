"""MPC outcome selection via Lagrange polynomial evaluation.

Given 10 public outcomes (one per decoy line) and a Shamir-shared secret
index, selects the real outcome without revealing the index.

Protocol:
1. Construct the Lagrange interpolation polynomial Q(x) through
   points (1, o_1), (2, o_2), ..., (10, o_10).  All coefficients
   are public (computed from the known outcomes).
2. Compute powers s^2, s^3, ..., s^9 via 8 sequential Beaver triple
   multiplications (each gate multiplies the running power by s).
3. Each validator computes their share of
   Q(s) - c_0 = c_1*s + c_2*s^2 + ... + c_9*s^9
   using their local power shares and the public coefficients.
4. Reconstruct Q(s) - c_0 from shares, add c_0 to get Q(s).
5. Q(s) equals the outcome at the real index.

The MPC never outputs the secret index — only the outcome value (0-3).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import structlog

from djinn_validator.core.mpc import (
    generate_beaver_triples,
    reconstruct_at_zero,
)
from djinn_validator.utils.crypto import BN254_PRIME, Share, _mod_inv

log = structlog.get_logger()

NUM_LINES = 10
NUM_POWER_GATES = NUM_LINES - 2  # 8 gates for s^2..s^9


def lagrange_interpolation_coefficients(
    outcomes: list[int],
    prime: int = BN254_PRIME,
) -> list[int]:
    """Compute polynomial coefficients for Lagrange interpolation.

    Given 10 outcomes, constructs the unique degree-9 polynomial Q(x)
    passing through (1, o_1), (2, o_2), ..., (10, o_10).

    Returns [c_0, c_1, ..., c_9] such that Q(x) = Σ c_k * x^k.
    """
    n = len(outcomes)
    points = [(i + 1, outcomes[i] % prime) for i in range(n)]
    coeffs = [0] * n

    for i in range(n):
        xi, yi = points[i]
        # Build Lagrange basis polynomial L_i(x) in coefficient form
        basis = [1]
        for j in range(n):
            if j == i:
                continue
            xj = points[j][0]
            denom_inv = _mod_inv((xi - xj) % prime, prime)
            # Multiply basis polynomial by (x - xj) / (xi - xj)
            new_basis = [0] * (len(basis) + 1)
            neg_xj = (-xj) % prime
            for k, bk in enumerate(basis):
                new_basis[k] = (new_basis[k] + bk * neg_xj % prime * denom_inv) % prime
                new_basis[k + 1] = (new_basis[k + 1] + bk * denom_inv) % prime
            basis = new_basis

        # Add yi * L_i(x) to accumulated coefficients
        for k in range(len(basis)):
            coeffs[k] = (coeffs[k] + yi * basis[k]) % prime

    return coeffs


def _eval_polynomial(coeffs: list[int], x: int, prime: int = BN254_PRIME) -> int:
    """Evaluate polynomial at a point (Horner's method)."""
    result = 0
    for c in reversed(coeffs):
        result = (result * x + c) % prime
    return result


# ---------------------------------------------------------------------------
# Distributed participant state for polynomial evaluation
# ---------------------------------------------------------------------------


@dataclass
class PolyEvalParticipantState:
    """Per-session state for a participant in the polynomial evaluation MPC.

    Computes powers of the secret s via sequential Beaver triple
    multiplications, then evaluates Q(s) using public coefficients.

    Gate topology (8 gates):
      Gate 0: s × s → s^2
      Gate 1: s^2 × s → s^3
      ...
      Gate 7: s^8 × s → s^9
    """

    validator_x: int
    secret_share_y: int
    triple_a: list[int]
    triple_b: list[int]
    triple_c: list[int]
    prime: int = BN254_PRIME
    _gates_completed: int = field(default=0, init=False)
    _power_shares: list[int] = field(default_factory=list, init=False)

    def compute_gate(
        self,
        gate_idx: int,
        prev_opened_d: int | None = None,
        prev_opened_e: int | None = None,
    ) -> tuple[int, int]:
        """Compute (d_i, e_i) for a power-chain multiplication gate.

        Gate 0: x_input = s_share, y_input = s_share (produces s^2)
        Gate k>0: x_input = z_prev (s^(k+1)), y_input = s_share (produces s^(k+2))
        """
        if gate_idx != self._gates_completed:
            raise ValueError(f"Expected gate {self._gates_completed}, got {gate_idx}")

        p = self.prime

        if gate_idx == 0:
            x_input = self.secret_share_y
        else:
            if prev_opened_d is None or prev_opened_e is None:
                raise ValueError("Previous gate opened values required for gate > 0")
            # Compute local share of z from previous gate
            pg = gate_idx - 1
            z_prev = (
                prev_opened_d * prev_opened_e
                + prev_opened_d * self.triple_b[pg]
                + prev_opened_e * self.triple_a[pg]
                + self.triple_c[pg]
            ) % p
            self._power_shares.append(z_prev)
            x_input = z_prev

        y_input = self.secret_share_y

        d_i = (x_input - self.triple_a[gate_idx]) % p
        e_i = (y_input - self.triple_b[gate_idx]) % p

        self._gates_completed += 1
        return d_i, e_i

    def finalize_last_gate(
        self,
        last_opened_d: int,
        last_opened_e: int,
    ) -> None:
        """Compute the final power share (s^9) from the last gate's opened values."""
        p = self.prime
        last = self._gates_completed - 1
        z = (
            last_opened_d * last_opened_e
            + last_opened_d * self.triple_b[last]
            + last_opened_e * self.triple_a[last]
            + self.triple_c[last]
        ) % p
        self._power_shares.append(z)

    def get_outcome_share(self, coefficients: list[int]) -> int:
        """Compute this validator's share of Q(s) - c_0.

        Q(s) - c_0 = c_1*s + c_2*s^2 + c_3*s^3 + ... + c_9*s^9

        The c_0 term is public and added after reconstruction.
        """
        p = self.prime
        # _power_shares[0] = share of s^2, [1] = share of s^3, ..., [7] = share of s^9
        share_sum = (coefficients[1] * self.secret_share_y) % p
        for k in range(2, len(coefficients)):
            idx = k - 2  # power_shares index
            if idx < len(self._power_shares):
                share_sum = (share_sum + coefficients[k] * self._power_shares[idx]) % p
        return share_sum


# ---------------------------------------------------------------------------
# Secure polynomial evaluation (local simulation)
# ---------------------------------------------------------------------------


def secure_select_outcome(
    shares: list[Share],
    outcomes: list[int],
    threshold: int = 7,
    prime: int = BN254_PRIME,
) -> int | None:
    """Select the real outcome via secure MPC polynomial evaluation.

    Simulates the distributed protocol locally (trusted-dealer model).
    No single party learns the secret index.

    Args:
        shares: Shamir shares of the secret index from participating validators.
        outcomes: List of 10 outcome values (0-3), one per decoy line.
        threshold: Minimum shares needed.
        prime: Field prime.

    Returns:
        The outcome value (0-3) at the secret index, or None on failure.
    """
    if len(outcomes) != NUM_LINES:
        log.warning("wrong_outcome_count", expected=NUM_LINES, got=len(outcomes))
        return None
    if len(shares) < threshold:
        log.warning("insufficient_shares", got=len(shares), threshold=threshold)
        return None

    x_coords = sorted(s.x for s in shares)
    share_map = {s.x: s.y for s in shares}

    # Compute public polynomial coefficients
    coeffs = lagrange_interpolation_coefficients(outcomes, prime)
    c_0 = coeffs[0]

    # Generate 8 Beaver triples for the power chain
    triples = generate_beaver_triples(
        NUM_POWER_GATES, n=len(shares), k=threshold, prime=prime, x_coords=x_coords,
    )

    # Build participant states
    participants: dict[int, PolyEvalParticipantState] = {}
    for vx in x_coords:
        participants[vx] = PolyEvalParticipantState(
            validator_x=vx,
            secret_share_y=share_map[vx],
            triple_a=[triples[g].a_shares[i].y for g, i in _triple_indices(vx, x_coords, NUM_POWER_GATES)],
            triple_b=[triples[g].b_shares[i].y for g, i in _triple_indices(vx, x_coords, NUM_POWER_GATES)],
            triple_c=[triples[g].c_shares[i].y for g, i in _triple_indices(vx, x_coords, NUM_POWER_GATES)],
            prime=prime,
        )

    # Run 8 sequential gates
    prev_d: int | None = None
    prev_e: int | None = None

    for gate_idx in range(NUM_POWER_GATES):
        # Each participant computes (d_i, e_i)
        d_by_v: dict[int, int] = {}
        e_by_v: dict[int, int] = {}
        for vx in x_coords:
            d_i, e_i = participants[vx].compute_gate(gate_idx, prev_d, prev_e)
            d_by_v[vx] = d_i
            e_by_v[vx] = e_i

        # Reconstruct opened d and e
        prev_d = reconstruct_at_zero(d_by_v, prime)
        prev_e = reconstruct_at_zero(e_by_v, prime)

    # Finalize last gate
    assert prev_d is not None and prev_e is not None
    for vx in x_coords:
        participants[vx].finalize_last_gate(prev_d, prev_e)

    # Each participant computes their share of Q(s) - c_0
    q_minus_c0_shares: dict[int, int] = {}
    for vx in x_coords:
        q_minus_c0_shares[vx] = participants[vx].get_outcome_share(coeffs)

    # Reconstruct Q(s) - c_0 and add c_0
    q_minus_c0 = reconstruct_at_zero(q_minus_c0_shares, prime)
    q_s = (q_minus_c0 + c_0) % prime

    # Validate result is a valid outcome (0-3)
    if q_s > 3:
        log.error("mpc_outcome_invalid", raw_result=q_s, outcomes=outcomes)
        return None

    log.info(
        "mpc_outcome_selected",
        outcome=int(q_s),
        participants=len(shares),
    )
    return int(q_s)


def _triple_indices(
    vx: int,
    x_coords: list[int],
    n_gates: int,
) -> list[tuple[int, int]]:
    """Map (gate_idx, share_idx) for a validator's triple shares."""
    vx_idx = x_coords.index(vx)
    return [(g, vx_idx) for g in range(n_gates)]


# ---------------------------------------------------------------------------
# Prototype (single-validator / dev mode)
# ---------------------------------------------------------------------------


def prototype_select_outcome(
    shares: list[Share],
    outcomes: list[int],
    threshold: int = 7,
    prime: int = BN254_PRIME,
) -> int | None:
    """PROTOTYPE: Select outcome by reconstructing the secret index.

    Functionally correct but the caller learns the secret index.
    Used in single-validator dev mode only.
    """
    if len(outcomes) != NUM_LINES:
        return None
    if len(shares) < threshold:
        return None

    # Reconstruct secret index
    secret = reconstruct_at_zero({s.x: s.y for s in shares}, prime)

    # Index is 1-based (1..10)
    if secret < 1 or secret > NUM_LINES:
        log.warning("reconstructed_index_out_of_range", secret=secret)
        return None

    outcome = outcomes[secret - 1]
    if outcome < 0 or outcome > 3:
        return None

    return outcome
