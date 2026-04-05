"""MPC outcome selection via Lagrange polynomial evaluation.

Given N public outcomes (one per decoy line, 2 to 2000+) and a Shamir-shared
secret index, selects the real outcome without revealing the index.

Protocol:
1. Construct the Lagrange interpolation polynomial Q(x) through
   points (1, o_1), (2, o_2), ..., (N, o_N).  All coefficients
   are public (computed from the known outcomes).
2. Compute powers s^2, s^3, ..., s^(N-1) via Beaver triple
   multiplications:
   - For small N (<=50): sequential chain, N-2 rounds
   - For large N (>50): parallel power tree, O(log N) rounds
3. Each validator computes their share of
   Q(s) - c_0 = c_1*s + c_2*s^2 + ... + c_(N-1)*s^(N-1)
   using their local power shares and the public coefficients.
4. Reconstruct Q(s) - c_0 from shares, add c_0 to get Q(s).
5. Q(s) equals the outcome at the real index.

The MPC never outputs the secret index, only the outcome value (0-3).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import structlog

from djinn_validator.core.mpc import (
    generate_beaver_triples,
    reconstruct_at_zero,
)
from djinn_validator.utils.crypto import BN254_PRIME, Share, _mod_inv

log = structlog.get_logger()

PARALLEL_THRESHOLD = 50


def lagrange_interpolation_coefficients(
    outcomes: list[int],
    prime: int = BN254_PRIME,
) -> list[int]:
    """Compute polynomial coefficients for Lagrange interpolation.

    Given N outcomes, constructs the unique degree-(N-1) polynomial Q(x)
    passing through (1, o_1), (2, o_2), ..., (N, o_N).

    Returns [c_0, c_1, ..., c_(N-1)] such that Q(x) = sum c_k * x^k.
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
# Parallel power plan: O(log N) rounds of Beaver multiplications
# ---------------------------------------------------------------------------


def plan_parallel_powers(max_power: int) -> list[list[tuple[int, int]]]:
    """Plan O(log n) rounds of parallel Beaver triple multiplications.

    Given max_power, returns a list of rounds. Each round is a list of
    (a, b) tuples meaning "compute s^(a+b) = s^a * s^b". All
    multiplications in a round use only powers available from previous
    rounds (plus s^1 which is always known).

    Round 1: compute s^2 = s^1 * s^1
    Round 2: compute s^3 = s^2 * s^1, s^4 = s^2 * s^2 (parallel)
    Round 3: compute s^5..s^8 from known powers (parallel)
    Each round roughly doubles the set of known powers.

    Returns:
        List of rounds, where each round is a list of (a, b) factor pairs.
    """
    if max_power < 2:
        return []

    known = {1}
    rounds: list[list[tuple[int, int]]] = []

    while max(known) < max_power:
        # Plan this round: compute new powers from known ones
        round_ops: list[tuple[int, int]] = []
        sorted_known = sorted(known)

        # Greedily fill in missing powers using known ones
        new_targets: set[int] = set()
        for target in range(min(known) + 1, max_power + 1):
            if target in known:
                continue
            # Find a factorization (a, b) where both are known
            found = False
            for a in sorted_known:
                b = target - a
                if b >= 1 and b in known:
                    round_ops.append((a, b))
                    new_targets.add(target)
                    found = True
                    break
            if not found:
                break  # Can't compute this target yet; next round

        if not round_ops:
            # Shouldn't happen, but safety valve
            break

        rounds.append(round_ops)
        known |= new_targets

    return rounds


# ---------------------------------------------------------------------------
# Distributed participant state for polynomial evaluation
# ---------------------------------------------------------------------------


@dataclass
class PolyEvalParticipantState:
    """Per-session state for a participant in the polynomial evaluation MPC.

    Computes powers of the secret s via Beaver triple multiplications
    (sequential or parallel), then evaluates Q(s) using public coefficients.

    Sequential mode (small N): power chain s^2, s^3, ..., s^(N-1)
    Parallel mode (large N): power tree via plan_parallel_powers
    """

    validator_x: int
    secret_share_y: int
    triple_a: list[int]
    triple_b: list[int]
    triple_c: list[int]
    prime: int = BN254_PRIME
    _gates_completed: int = field(default=0, init=False)
    # Sequential mode: list of power shares (s^2, s^3, ...)
    _power_shares: list[int] = field(default_factory=list, init=False)
    # Parallel mode: dict mapping power -> share
    _power_share_map: dict[int, int] = field(default_factory=dict, init=False)

    def compute_gate(
        self,
        gate_idx: int,
        prev_opened_d: int | None = None,
        prev_opened_e: int | None = None,
    ) -> tuple[int, int]:
        """Compute (d_i, e_i) for a power-chain multiplication gate (sequential mode).

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

    def compute_parallel_gate(
        self,
        gate_idx: int,
        a_power: int,
        b_power: int,
        a_share: int,
        b_share: int,
    ) -> tuple[int, int]:
        """Compute (d_i, e_i) for a parallel multiplication gate.

        Multiplies share of s^a_power by share of s^b_power to produce
        share of s^(a_power + b_power).
        """
        p = self.prime
        d_i = (a_share - self.triple_a[gate_idx]) % p
        e_i = (b_share - self.triple_b[gate_idx]) % p
        return d_i, e_i

    def finalize_parallel_gate(
        self,
        gate_idx: int,
        opened_d: int,
        opened_e: int,
        target_power: int,
    ) -> None:
        """Compute the output share for a parallel gate and store it."""
        p = self.prime
        z = (
            opened_d * opened_e
            + opened_d * self.triple_b[gate_idx]
            + opened_e * self.triple_a[gate_idx]
            + self.triple_c[gate_idx]
        ) % p
        self._power_share_map[target_power] = z

    def finalize_last_gate(
        self,
        last_opened_d: int,
        last_opened_e: int,
    ) -> None:
        """Compute the final power share from the last gate's opened values (sequential)."""
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

        Q(s) - c_0 = c_1*s + c_2*s^2 + c_3*s^3 + ... + c_(N-1)*s^(N-1)

        The c_0 term is public and added after reconstruction.
        Uses _power_share_map if populated (parallel mode), else _power_shares (sequential).
        """
        p = self.prime
        share_sum = (coefficients[1] * self.secret_share_y) % p

        if self._power_share_map:
            # Parallel mode: powers indexed by exponent
            for k in range(2, len(coefficients)):
                ps = self._power_share_map.get(k, 0)
                share_sum = (share_sum + coefficients[k] * ps) % p
        else:
            # Sequential mode: _power_shares[0] = s^2, [1] = s^3, ...
            for k in range(2, len(coefficients)):
                idx = k - 2
                if idx < len(self._power_shares):
                    share_sum = (share_sum + coefficients[k] * self._power_shares[idx]) % p
        return share_sum


# ---------------------------------------------------------------------------
# Secure polynomial evaluation (local simulation)
# ---------------------------------------------------------------------------


def _secure_select_sequential(
    shares: list[Share],
    outcomes: list[int],
    threshold: int,
    prime: int,
) -> int | None:
    """Sequential Beaver chain for small N (<=PARALLEL_THRESHOLD)."""
    n_lines = len(outcomes)
    n_power_gates = n_lines - 2  # gates for s^2..s^(N-1)

    x_coords = sorted(s.x for s in shares)
    share_map = {s.x: s.y for s in shares}

    coeffs = lagrange_interpolation_coefficients(outcomes, prime)
    c_0 = coeffs[0]

    if n_power_gates == 0:
        # Only 2 lines: Q(s) = c_0 + c_1*s, no gates needed
        q_minus_c0_shares: dict[int, int] = {}
        for vx in x_coords:
            q_minus_c0_shares[vx] = (coeffs[1] * share_map[vx]) % prime
        q_minus_c0 = reconstruct_at_zero(q_minus_c0_shares, prime)
        q_s = (q_minus_c0 + c_0) % prime
        if q_s > 3:
            log.error("mpc_outcome_invalid", raw_result=q_s, outcomes=outcomes)
            return None
        return int(q_s)

    triples = generate_beaver_triples(
        n_power_gates, n=len(shares), k=threshold, prime=prime, x_coords=x_coords,
    )

    participants: dict[int, PolyEvalParticipantState] = {}
    for vx in x_coords:
        participants[vx] = PolyEvalParticipantState(
            validator_x=vx,
            secret_share_y=share_map[vx],
            triple_a=[triples[g].a_shares[i].y for g, i in _triple_indices(vx, x_coords, n_power_gates)],
            triple_b=[triples[g].b_shares[i].y for g, i in _triple_indices(vx, x_coords, n_power_gates)],
            triple_c=[triples[g].c_shares[i].y for g, i in _triple_indices(vx, x_coords, n_power_gates)],
            prime=prime,
        )

    prev_d: int | None = None
    prev_e: int | None = None

    for gate_idx in range(n_power_gates):
        d_by_v: dict[int, int] = {}
        e_by_v: dict[int, int] = {}
        for vx in x_coords:
            d_i, e_i = participants[vx].compute_gate(gate_idx, prev_d, prev_e)
            d_by_v[vx] = d_i
            e_by_v[vx] = e_i

        prev_d = reconstruct_at_zero(d_by_v, prime)
        prev_e = reconstruct_at_zero(e_by_v, prime)

    assert prev_d is not None and prev_e is not None
    for vx in x_coords:
        participants[vx].finalize_last_gate(prev_d, prev_e)

    q_minus_c0_shares = {}
    for vx in x_coords:
        q_minus_c0_shares[vx] = participants[vx].get_outcome_share(coeffs)

    q_minus_c0 = reconstruct_at_zero(q_minus_c0_shares, prime)
    q_s = (q_minus_c0 + c_0) % prime

    if q_s > 3:
        log.error("mpc_outcome_invalid", raw_result=q_s, outcomes=outcomes)
        return None

    return int(q_s)


def _secure_select_parallel(
    shares: list[Share],
    outcomes: list[int],
    threshold: int,
    prime: int,
) -> int | None:
    """Parallel power tree for large N (>PARALLEL_THRESHOLD)."""
    n_lines = len(outcomes)
    max_power = n_lines - 1  # need s^2 through s^(N-1)

    x_coords = sorted(s.x for s in shares)
    share_map = {s.x: s.y for s in shares}

    coeffs = lagrange_interpolation_coefficients(outcomes, prime)
    c_0 = coeffs[0]

    rounds = plan_parallel_powers(max_power)

    # Count total gates across all rounds
    total_gates = sum(len(r) for r in rounds)

    triples = generate_beaver_triples(
        total_gates, n=len(shares), k=threshold, prime=prime, x_coords=x_coords,
    )

    # Build participant states with all triples
    participants: dict[int, PolyEvalParticipantState] = {}
    for vx in x_coords:
        participants[vx] = PolyEvalParticipantState(
            validator_x=vx,
            secret_share_y=share_map[vx],
            triple_a=[triples[g].a_shares[i].y for g, i in _triple_indices(vx, x_coords, total_gates)],
            triple_b=[triples[g].b_shares[i].y for g, i in _triple_indices(vx, x_coords, total_gates)],
            triple_c=[triples[g].c_shares[i].y for g, i in _triple_indices(vx, x_coords, total_gates)],
            prime=prime,
        )
        # s^1 is always known
        participants[vx]._power_share_map[1] = share_map[vx]

    gate_offset = 0
    for round_ops in rounds:
        # All ops in this round can be computed in parallel
        round_d: dict[int, dict[int, int]] = {}  # gate -> {vx: d}
        round_e: dict[int, dict[int, int]] = {}  # gate -> {vx: e}

        for op_idx, (a_pow, b_pow) in enumerate(round_ops):
            gate_idx = gate_offset + op_idx
            d_by_v: dict[int, int] = {}
            e_by_v: dict[int, int] = {}
            for vx in x_coords:
                a_share = participants[vx]._power_share_map[a_pow]
                b_share = participants[vx]._power_share_map[b_pow]
                d_i, e_i = participants[vx].compute_parallel_gate(
                    gate_idx, a_pow, b_pow, a_share, b_share,
                )
                d_by_v[vx] = d_i
                e_by_v[vx] = e_i

            round_d[gate_idx] = d_by_v
            round_e[gate_idx] = e_by_v

        # Reconstruct opened d, e for all gates in this round
        for op_idx, (a_pow, b_pow) in enumerate(round_ops):
            gate_idx = gate_offset + op_idx
            opened_d = reconstruct_at_zero(round_d[gate_idx], prime)
            opened_e = reconstruct_at_zero(round_e[gate_idx], prime)
            target_power = a_pow + b_pow

            for vx in x_coords:
                participants[vx].finalize_parallel_gate(
                    gate_idx, opened_d, opened_e, target_power,
                )

        gate_offset += len(round_ops)

    # Compute outcome shares
    q_minus_c0_shares: dict[int, int] = {}
    for vx in x_coords:
        q_minus_c0_shares[vx] = participants[vx].get_outcome_share(coeffs)

    q_minus_c0 = reconstruct_at_zero(q_minus_c0_shares, prime)
    q_s = (q_minus_c0 + c_0) % prime

    if q_s > 3:
        log.error("mpc_outcome_invalid", raw_result=q_s, outcomes=outcomes)
        return None

    log.info(
        "mpc_outcome_selected_parallel",
        outcome=int(q_s),
        participants=len(shares),
        lines=len(outcomes),
        rounds=len(rounds),
        total_gates=total_gates,
    )
    return int(q_s)


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
        outcomes: List of N outcome values (0-3), one per line (2 to 2000+).
        threshold: Minimum shares needed.
        prime: Field prime.

    Returns:
        The outcome value (0-3) at the secret index, or None on failure.
    """
    n_lines = len(outcomes)
    if n_lines < 2:
        log.warning("wrong_outcome_count", min_expected=2, got=n_lines)
        return None
    if len(shares) < threshold:
        log.warning("insufficient_shares", got=len(shares), threshold=threshold)
        return None

    if n_lines <= PARALLEL_THRESHOLD:
        result = _secure_select_sequential(shares, outcomes, threshold, prime)
    else:
        result = _secure_select_parallel(shares, outcomes, threshold, prime)

    if result is not None:
        log.info(
            "mpc_outcome_selected",
            outcome=result,
            participants=len(shares),
            lines=n_lines,
        )

    return result


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
    n_lines = len(outcomes)
    if n_lines < 2:
        return None
    if len(shares) < threshold:
        return None

    # Reconstruct secret index
    secret = reconstruct_at_zero({s.x: s.y for s in shares}, prime)

    # Index is 1-based (1..N)
    if secret < 1 or secret > n_lines:
        log.warning("reconstructed_index_out_of_range", secret=secret, max_index=n_lines)
        return None

    outcome = outcomes[secret - 1]
    if outcome < 0 or outcome > 3:
        return None

    return outcome
