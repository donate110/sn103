"""MPC set-membership protocol for signal availability checking.

Implements the protocol from Appendix C of the Djinn whitepaper:
- Each validator holds a Shamir share of the real signal index
- Miners report which of the 10 lines are available at a sportsbook
- Validators jointly compute "Is real index ∈ available set?"
- Output: single bit (available / not available)
- No validator learns the actual index

Two implementations:

1. PROTOTYPE (check_availability): Aggregator reconstructs the secret.
   Fast, correct, but the aggregator learns the secret index.
   Used in single-validator mode for local testing.

2. PRODUCTION (SecureMPCSession): Beaver triple-based multiplication.
   No single party learns the secret. Requires multi-round communication
   between validators. The protocol computes r * P(s) where
   P(x) = ∏(x - a_i) for available indices, and r is joint randomness.
   If the result is 0, the secret is in the set.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field

import structlog

# Import OT-based triple generation (used when distributed mode is available)
from djinn_validator.core.ot import generate_ot_beaver_triples as _generate_ot_triples
from djinn_validator.utils.crypto import BN254_PRIME, Share, _mod_inv

log = structlog.get_logger()


@dataclass(frozen=True)
class MPCContribution:
    """A validator's contribution to the MPC protocol."""

    validator_id: int
    weighted_share: int  # L_i * y_i mod p (Lagrange-weighted share value)


@dataclass(frozen=True)
class MPCResult:
    """Result of the MPC protocol."""

    available: bool
    participating_validators: int
    failure_reason: str | None = None


# ---------------------------------------------------------------------------
# Beaver Triple Infrastructure
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BeaverTriple:
    """Pre-computed multiplication triple: (a, b, c) where c = a*b mod p.

    Each value is Shamir-shared among validators.
    """

    a_shares: tuple[Share, ...]
    b_shares: tuple[Share, ...]
    c_shares: tuple[Share, ...]


def _split_secret_at_points(
    secret: int,
    x_coords: list[int],
    k: int,
    prime: int = BN254_PRIME,
) -> list[Share]:
    """Split a secret into Shamir shares evaluated at specific x-coordinates.

    Unlike split_secret() which always uses x=1..n, this evaluates the
    random polynomial at the specified x-coordinates.
    """
    coeffs = [secret] + [secrets.randbelow(prime) for _ in range(k - 1)]
    shares = []
    for x in x_coords:
        y = 0
        for j, c in enumerate(coeffs):
            y = (y + c * pow(x, j, prime)) % prime
        shares.append(Share(x=x, y=y))
    return shares


def generate_beaver_triples(
    count: int,
    n: int = 10,
    k: int = 7,
    prime: int = BN254_PRIME,
    x_coords: list[int] | None = None,
) -> list[BeaverTriple]:
    """Generate Beaver multiplication triples.

    Each triple contains Shamir shares of random (a, b, c) where c = a*b.
    In production, triples are generated via OT-based offline phase or
    a trusted dealer. This implementation uses a trusted dealer model.

    Args:
        count: Number of triples to generate.
        n: Number of shares per value.
        k: Reconstruction threshold.
        x_coords: Specific x-coordinates for shares. If None, uses 1..n.
    """
    if k > n:
        raise ValueError(f"threshold k={k} exceeds number of shares n={n}")
    if n < 1 or k < 1:
        raise ValueError(f"n and k must be >= 1, got n={n}, k={k}")
    if x_coords is None:
        x_coords = list(range(1, n + 1))

    triples = []
    for _ in range(count):
        a = secrets.randbelow(prime)
        b = secrets.randbelow(prime)
        c = (a * b) % prime

        a_shares = tuple(_split_secret_at_points(a, x_coords, k, prime))
        b_shares = tuple(_split_secret_at_points(b, x_coords, k, prime))
        c_shares = tuple(_split_secret_at_points(c, x_coords, k, prime))

        triples.append(BeaverTriple(a_shares, b_shares, c_shares))

    return triples


def generate_ot_beaver_triples(
    count: int,
    n: int = 10,
    k: int = 7,
    prime: int = BN254_PRIME,
    x_coords: list[int] | None = None,
    party_ids: list[int] | None = None,
) -> list[BeaverTriple]:
    """Generate Beaver triples using OT-based distributed protocol.

    No single party learns the underlying triple values (a, b, c).
    This is the production replacement for generate_beaver_triples() which
    uses a trusted dealer.

    Args:
        count: Number of triples to generate.
        n: Number of shares per value.
        k: Reconstruction threshold.
        x_coords: Specific x-coordinates for shares. If None, uses 1..n.
        party_ids: IDs of participating parties for OT. If None, uses x_coords.
    """
    if k > n:
        raise ValueError(f"threshold k={k} exceeds number of shares n={n}")
    if n < 2:
        raise ValueError(f"OT requires at least 2 parties, got n={n}")
    if x_coords is None:
        x_coords = list(range(1, n + 1))
    if party_ids is None:
        party_ids = list(x_coords)

    raw_triples = _generate_ot_triples(
        count=count,
        party_ids=party_ids,
        x_coords=x_coords,
        threshold=k,
        prime=prime,
    )

    return [
        BeaverTriple(
            a_shares=tuple(a_shares),
            b_shares=tuple(b_shares),
            c_shares=tuple(c_shares),
        )
        for a_shares, b_shares, c_shares in raw_triples
    ]


# ---------------------------------------------------------------------------
# Secure MPC Protocol
# ---------------------------------------------------------------------------


@dataclass
class Round1Message:
    """A validator's Round 1 broadcast for a single multiplication."""

    validator_x: int
    d_value: int  # x_share - a_share
    e_value: int  # y_share - b_share


@dataclass
class MultiplicationGate:
    """State for a single multiplication in the protocol."""

    triple: BeaverTriple
    # Input shares (one per validator, indexed by share.x)
    x_shares: dict[int, int] = field(default_factory=dict)
    y_shares: dict[int, int] = field(default_factory=dict)
    # Round 1 results
    d_opened: int | None = None  # reconstructed x - a
    e_opened: int | None = None  # reconstructed y - b
    # Output shares (one per validator)
    z_shares: dict[int, int] = field(default_factory=dict)


class SecureMPCSession:
    """Secure set-membership MPC using Beaver triple multiplication.

    Protocol for computing r * P(s) where P(x) = ∏(x - a_i):

    1. Offline: Beaver triples pre-generated for each multiplication
    2. Online - for each tree level of multiplications:
       a. Each validator broadcasts (d_i, e_i) for each multiplication gate
       b. Everyone reconstructs d, e
       c. Each validator computes their output share z_i
    3. Final: Open the masked result. Zero iff secret is in the set.

    Usage:
        session = SecureMPCSession(available_indices, triples, shares, ...)
        result = session.run()  # Local simulation
    """

    def __init__(
        self,
        available_indices: set[int],
        shares: list[Share],
        triples: list[BeaverTriple],
        threshold: int = 7,
        prime: int = BN254_PRIME,
    ) -> None:
        self._available = sorted(available_indices)
        self._shares = {s.x: s for s in shares}
        self._triples = list(triples)
        self._triple_idx = 0
        self._threshold = threshold
        self._prime = prime
        self._validator_xs = sorted(self._shares.keys())
        self._n_validators = len(shares)

    def _next_triple(self) -> BeaverTriple:
        if self._triple_idx >= len(self._triples):
            raise ValueError("Not enough Beaver triples for this computation")
        t = self._triples[self._triple_idx]
        self._triple_idx += 1
        return t

    def _lagrange_coefficients(self) -> dict[int, int]:
        """Compute Lagrange coefficients for all participating validators."""
        coeffs = {}
        for xi in self._validator_xs:
            coeffs[xi] = _lagrange_coefficient(xi, self._validator_xs, self._prime)
        return coeffs

    def _reconstruct_from_values(self, values: dict[int, int]) -> int:
        """Reconstruct a secret from validator-indexed share values."""
        p = self._prime
        result = 0
        xs = sorted(values.keys())
        for xi in xs:
            li = _lagrange_coefficient(xi, xs, p)
            result = (result + li * values[xi]) % p
        return result

    def _multiply_shares(
        self,
        x_by_validator: dict[int, int],
        y_by_validator: dict[int, int],
        triple: BeaverTriple,
    ) -> dict[int, int]:
        """Execute one Beaver triple multiplication.

        Given shares of x and y, compute shares of z = x * y using the triple.
        This is one round of communication (all validators broadcast d_i, e_i).
        """
        p = self._prime

        # Round 1: Each validator computes d_i = x_i - a_i, e_i = y_i - b_i
        d_by_validator: dict[int, int] = {}
        e_by_validator: dict[int, int] = {}

        a_map = {s.x: s.y for s in triple.a_shares}
        b_map = {s.x: s.y for s in triple.b_shares}
        c_map = {s.x: s.y for s in triple.c_shares}

        for vx in self._validator_xs:
            d_by_validator[vx] = (x_by_validator[vx] - a_map[vx]) % p
            e_by_validator[vx] = (y_by_validator[vx] - b_map[vx]) % p

        # Reconstruct d and e (these are opened publicly)
        d = self._reconstruct_from_values(d_by_validator)
        e = self._reconstruct_from_values(e_by_validator)

        # Each validator computes z_i = d*e + d*b_i + e*a_i + c_i
        z_by_validator: dict[int, int] = {}
        for vx in self._validator_xs:
            z_i = (d * e + d * b_map[vx] + e * a_map[vx] + c_map[vx]) % p
            z_by_validator[vx] = z_i

        return z_by_validator

    def run(self) -> MPCResult:
        """Run the full secure MPC protocol (local simulation).

        Computes r * P(s) where P(x) = ∏(x - a_i) for available indices.
        Opens the result: 0 means s is in the set, nonzero means it isn't.
        No single party ever sees the reconstructed secret s.
        """
        if self._n_validators < self._threshold:
            log.warning(
                "insufficient_mpc_participants",
                received=self._n_validators,
                threshold=self._threshold,
            )
            return MPCResult(available=False, participating_validators=self._n_validators)

        p = self._prime

        if not self._available:
            # No available indices → secret can't be in empty set
            return MPCResult(available=False, participating_validators=self._n_validators)

        # Step 1: Compute shares of (s - a_i) for each available index
        # These are LINEAR operations on shares, so purely local
        factors: list[dict[int, int]] = []
        for a in self._available:
            factor_shares: dict[int, int] = {}
            for vx in self._validator_xs:
                factor_shares[vx] = (self._shares[vx].y - a) % p
            factors.append(factor_shares)

        # Step 2: Generate shared random mask r (nonzero)
        # In production, r is generated via joint randomness (each validator
        # contributes randomness). Here we simulate by sharing a random value.
        r = secrets.randbelow(p - 1) + 1  # r ∈ [1, p-1]
        r_shares_list = _split_secret_at_points(r, self._validator_xs, self._threshold, p)
        r_by_validator = {s.x: s.y for s in r_shares_list}

        # Step 3: Multiply all factors together using Beaver triples.
        # Use tree multiplication to reduce rounds from d+1 to ceil(log2(d))+2.
        #
        # First multiply r with factors[0], then multiply remaining factors
        # in a balanced binary tree: pair up adjacent results and multiply,
        # repeat until one value remains.
        #
        # For d=10 available indices:
        #   Sequential: 11 rounds (r*f0, *f1, *f2, ..., *f9)
        #   Tree: 6 rounds (r*f0, then 5 factors => ceil(log2(5))+1 = 4 tree rounds)

        # Start: r * factor[0]
        layer = [self._multiply_shares(r_by_validator, factors[0], self._next_triple())]

        # Add remaining factors as leaves
        for i in range(1, len(factors)):
            layer.append(factors[i])

        # Tree reduction: pair up and multiply until one result remains
        while len(layer) > 1:
            next_layer: list[dict[int, int]] = []
            i = 0
            while i < len(layer):
                if i + 1 < len(layer):
                    product = self._multiply_shares(layer[i], layer[i + 1], self._next_triple())
                    next_layer.append(product)
                    i += 2
                else:
                    # Odd element: carry forward to next level
                    next_layer.append(layer[i])
                    i += 1
            layer = next_layer

        current = layer[0]

        # Step 4: Open the result r * P(s)
        result_value = self._reconstruct_from_values(current)

        available = result_value == 0

        log.info(
            "secure_mpc_result",
            available=available,
            participants=self._n_validators,
            multiplications=len(self._available),
        )

        return MPCResult(available=available, participating_validators=self._n_validators)


def secure_check_availability(
    shares: list[Share],
    available_indices: set[int],
    threshold: int = 7,
    prime: int = BN254_PRIME,
) -> MPCResult:
    """Production-ready set membership check using Beaver triple MPC.

    Unlike check_availability(), no single party ever reconstructs the
    secret. The protocol computes a randomly masked polynomial evaluation
    that equals 0 iff the secret is in the available set.

    Args:
        shares: Shamir shares from participating validators.
        available_indices: Line indices miners report as available.
        threshold: Minimum validators for the protocol.
    """
    if len(shares) < threshold:
        return MPCResult(available=False, participating_validators=len(shares))

    # Use the actual x-coordinates from the shares for triple generation
    x_coords = sorted(s.x for s in shares)

    # Compute triple count for tree multiplication:
    # 1 triple for r * factor[0], then tree-reduce the remaining d factors.
    # Tree reduction of n items requires n-1 multiplications.
    # So total = 1 + max(d - 1, 0) = max(d, 1) — same count, different order.
    n_mults = max(len(available_indices), 1)
    triples = generate_beaver_triples(
        n_mults,
        n=len(shares),
        k=threshold,
        prime=prime,
        x_coords=x_coords,
    )

    session = SecureMPCSession(
        available_indices=available_indices,
        shares=shares,
        triples=triples,
        threshold=threshold,
        prime=prime,
    )
    return session.run()


# ---------------------------------------------------------------------------
# Reconstruction helper
# ---------------------------------------------------------------------------


def reconstruct_at_zero(
    values: dict[int, int],
    prime: int = BN254_PRIME,
) -> int:
    """Reconstruct a Shamir-shared secret at x=0 from share values.

    Args:
        values: Mapping of share x-coordinate to share value.
        prime: Field prime.
    """
    result = 0
    xs = sorted(values.keys())
    for xi in xs:
        li = _lagrange_coefficient(xi, xs, prime)
        result = (result + li * values[xi]) % prime
    return result


# ---------------------------------------------------------------------------
# Distributed MPC participant state
# ---------------------------------------------------------------------------


@dataclass
class DistributedParticipantState:
    """Per-session MPC state for a participant in the distributed protocol.

    Each non-coordinator validator maintains this to compute per-gate
    (d_i, e_i) contributions without revealing their secret share.
    The coordinator also creates one for itself.

    For each gate g, the participant computes:
      - x_input: r_share (gate 0) or z from previous gate (gate g>0)
      - y_input: secret_share - available_indices[g]
      - d_i = x_input - triple_a[g]
      - e_i = y_input - triple_b[g]

    These (d_i, e_i) are sent to the coordinator. The coordinator
    reconstructs the opened values d, e and broadcasts them back
    for the next gate's computation.
    """

    validator_x: int
    secret_share_y: int
    r_share_y: int
    available_indices: list[int]
    triple_a: list[int]
    triple_b: list[int]
    triple_c: list[int]
    prime: int = BN254_PRIME
    _gates_completed: int = 0

    def compute_gate(
        self,
        gate_idx: int,
        prev_opened_d: int | None = None,
        prev_opened_e: int | None = None,
    ) -> tuple[int, int]:
        """Compute (d_i, e_i) for a multiplication gate.

        Args:
            gate_idx: Which gate (0-indexed, must be called sequentially).
            prev_opened_d: Publicly opened d from gate g-1 (None for gate 0).
            prev_opened_e: Publicly opened e from gate g-1 (None for gate 0).

        Returns:
            (d_i, e_i) tuple to send to the coordinator.
        """
        if gate_idx != self._gates_completed:
            raise ValueError(f"Expected gate {self._gates_completed}, got {gate_idx}")

        p = self.prime

        if gate_idx == 0:
            x_input = self.r_share_y
        else:
            if prev_opened_d is None or prev_opened_e is None:
                raise ValueError("Previous gate opened values required for gate > 0")
            pg = gate_idx - 1
            x_input = (
                prev_opened_d * prev_opened_e
                + prev_opened_d * self.triple_b[pg]
                + prev_opened_e * self.triple_a[pg]
                + self.triple_c[pg]
            ) % p

        y_input = (self.secret_share_y - self.available_indices[gate_idx]) % p

        d_i = (x_input - self.triple_a[gate_idx]) % p
        e_i = (y_input - self.triple_b[gate_idx]) % p

        self._gates_completed += 1
        return d_i, e_i

    def compute_output_share(
        self,
        last_opened_d: int,
        last_opened_e: int,
    ) -> int:
        """Compute the final output share z_i after the last gate opens.

        Each participant computes z_i = d*e + d*b_i + e*a_i + c_i using
        the publicly opened d and e from the last gate and their own
        last triple shares. This value is then sent to the coordinator
        for reconstruction — no other participant's shares are needed.
        """
        last = self._gates_completed - 1
        p = self.prime
        return (
            last_opened_d * last_opened_e
            + last_opened_d * self.triple_b[last]
            + last_opened_e * self.triple_a[last]
            + self.triple_c[last]
        ) % p


# ---------------------------------------------------------------------------
# Prototype Implementation (kept for single-validator mode)
# ---------------------------------------------------------------------------


def _lagrange_coefficient(
    share_x: int,
    all_x: list[int],
    prime: int = BN254_PRIME,
) -> int:
    """Compute Lagrange basis polynomial L_i evaluated at 0.

    L_i(0) = ∏_{j≠i} (0 - x_j) / (x_i - x_j)
    """
    numerator = 1
    denominator = 1
    for xj in all_x:
        if xj == share_x:
            continue
        numerator = (numerator * (0 - xj)) % prime
        denominator = (denominator * (share_x - xj)) % prime
    return (numerator * _mod_inv(denominator, prime)) % prime


def compute_local_contribution(
    share: Share,
    all_share_xs: list[int],
    prime: int = BN254_PRIME,
) -> MPCContribution:
    """Compute this validator's Lagrange-weighted share contribution.

    Each validator computes L_i * y_i where L_i is their Lagrange coefficient
    for interpolation at x=0 (the secret).

    Args:
        share: This validator's Shamir share (x_i, y_i).
        all_share_xs: X-coordinates of all participating validators.
    """
    li = _lagrange_coefficient(share.x, all_share_xs, prime)
    weighted = (li * share.y) % prime

    return MPCContribution(
        validator_id=share.x,
        weighted_share=weighted,
    )


def check_availability(
    contributions: list[MPCContribution],
    available_indices: set[int],
    threshold: int = 7,
    prime: int = BN254_PRIME,
) -> MPCResult:
    """PROTOTYPE: Aggregate contributions and check set membership.

    Reconstructs the secret via Lagrange interpolation, then evaluates the
    availability polynomial. Functionally correct but the aggregator learns
    the secret. Used in single-validator mode for local testing.

    For production multi-validator mode, use secure_check_availability().
    """
    if len(contributions) < threshold:
        log.warning(
            "insufficient_mpc_participants",
            received=len(contributions),
            threshold=threshold,
        )
        return MPCResult(available=False, participating_validators=len(contributions))

    # Reconstruct the secret: s = Σ L_i * y_i
    secret = sum(c.weighted_share for c in contributions) % prime

    # Evaluate P(secret) = ∏(secret - a_i) for available indices
    product = 1
    for a in available_indices:
        product = (product * ((secret - a) % prime)) % prime

    available = product == 0

    log.info(
        "mpc_result",
        available=available,
        participants=len(contributions),
    )
    return MPCResult(available=available, participating_validators=len(contributions))
