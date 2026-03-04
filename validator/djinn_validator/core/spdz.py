"""SPDZ-style MAC verification for malicious security in Beaver triple MPC.

Extends the semi-honest Beaver triple protocol (mpc.py) with information-
theoretic MACs. Each shared value v carries a MAC share γ(v) such that
the reconstructed MAC equals α * v, where α is a global key shared among
all validators.

When values d = x - a and e = y - b are opened during a multiplication
gate, each party checks:

    Σ L_j * (γ(d)_j - α_j * d_opened) = 0

If any party corrupted their share, this check fails with probability
1 - 1/p (overwhelming for BN254_PRIME ~ 2^254).

Commitment scheme prevents adaptive forgery: parties commit to their
MAC check values σ_j before revealing them, so a malicious party cannot
adjust their σ_j after seeing others' values.

Security model:
- Active (malicious) security with abort: a cheating party is detected
  and the protocol aborts, but the adversary might learn whether the
  secret is in the set before detection.
- For guaranteed output delivery (no abort), a threshold honest majority
  is needed. Our 7-of-10 Shamir threshold provides this.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from dataclasses import dataclass, field

import structlog

from djinn_validator.utils.crypto import BN254_PRIME, _mod_inv

log = structlog.get_logger()

# Loud startup warning if simulation mode is enabled
if os.environ.get("DJINN_SPDZ_SIMULATION") == "1":
    import warnings

    _msg = (
        "DJINN_SPDZ_SIMULATION=1 is set. SPDZ MAC key (alpha) will be "
        "reconstructable by the coordinator. This MUST NOT be enabled in "
        "production — it defeats malicious-security guarantees."
    )
    warnings.warn(_msg, stacklevel=1)
    log.warning("spdz_simulation_mode_enabled", detail=_msg)


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MACKeyShare:
    """A validator's Shamir share of the global MAC key α."""

    x: int  # Same x-coordinate as their other Shamir shares
    alpha_share: int  # f_α(x) where f_α is polynomial with secret α


@dataclass(frozen=True)
class AuthenticatedShare:
    """A value share paired with its SPDZ MAC share.

    For a shared value v, the MAC share satisfies:
    reconstruct(mac shares) = α * reconstruct(value shares)
    """

    x: int
    y: int  # The actual Shamir share value
    mac: int  # The MAC share: evaluation of polynomial with secret α*v


@dataclass(frozen=True)
class AuthenticatedBeaverTriple:
    """Beaver triple (a, b, c) where c = a*b, with MAC shares on each component."""

    a_shares: tuple[AuthenticatedShare, ...]
    b_shares: tuple[AuthenticatedShare, ...]
    c_shares: tuple[AuthenticatedShare, ...]


@dataclass(frozen=True)
class MACCheckCommitment:
    """Commitment to a MAC check value for the commit-then-reveal protocol."""

    validator_x: int
    commitment: bytes  # SHA-256(σ || nonce)
    nonce: bytes  # 32-byte random nonce


@dataclass(frozen=True)
class MACCheckReveal:
    """Revealed MAC check value after commitment phase."""

    validator_x: int
    sigma: int  # γ_j - α_j * opened_value
    nonce: bytes  # Must match commitment


class MACVerificationError(Exception):
    """Raised when MAC verification fails, indicating a malicious party."""


# ---------------------------------------------------------------------------
# Key and share generation (trusted dealer model for preprocessing)
# ---------------------------------------------------------------------------


def _split_secret_at_points(
    secret: int,
    x_coords: list[int],
    k: int,
    prime: int = BN254_PRIME,
) -> list[int]:
    """Evaluate a random degree-(k-1) polynomial with given secret at x-coordinates."""
    coeffs = [secret] + [secrets.randbelow(prime) for _ in range(k - 1)]
    values = []
    for x in x_coords:
        y = 0
        for j, c in enumerate(coeffs):
            y = (y + c * pow(x, j, prime)) % prime
        values.append(y)
    return values


def generate_mac_key(
    x_coords: list[int],
    threshold: int,
    prime: int = BN254_PRIME,
) -> tuple[int, list[MACKeyShare]]:
    """Generate a random global MAC key α and its Shamir shares.

    Returns:
        (alpha, shares) where alpha is the MAC key and shares are Shamir shares.
    """
    alpha = secrets.randbelow(prime - 1) + 1  # α ∈ [1, p-1]
    alpha_values = _split_secret_at_points(alpha, x_coords, threshold, prime)
    shares = [MACKeyShare(x=x, alpha_share=v) for x, v in zip(x_coords, alpha_values)]
    return alpha, shares


def authenticate_value(
    secret: int,
    alpha: int,
    x_coords: list[int],
    threshold: int,
    prime: int = BN254_PRIME,
) -> list[AuthenticatedShare]:
    """Create Shamir shares of a secret value with corresponding MAC shares.

    The MAC of the secret is α * secret. Both the value and MAC are
    independently Shamir-shared (different random polynomials).
    """
    value_shares = _split_secret_at_points(secret, x_coords, threshold, prime)
    mac_secret = (alpha * secret) % prime
    mac_shares = _split_secret_at_points(mac_secret, x_coords, threshold, prime)

    return [AuthenticatedShare(x=x, y=v, mac=m) for x, v, m in zip(x_coords, value_shares, mac_shares)]


def generate_authenticated_triples(
    count: int,
    alpha: int,
    x_coords: list[int],
    threshold: int,
    prime: int = BN254_PRIME,
) -> list[AuthenticatedBeaverTriple]:
    """Generate Beaver triples with SPDZ MAC shares.

    Each triple (a, b, c) where c = a*b has authenticated shares:
    each component carries both value shares and MAC shares.
    """
    triples = []
    for _ in range(count):
        a = secrets.randbelow(prime)
        b = secrets.randbelow(prime)
        c = (a * b) % prime

        a_auth = tuple(authenticate_value(a, alpha, x_coords, threshold, prime))
        b_auth = tuple(authenticate_value(b, alpha, x_coords, threshold, prime))
        c_auth = tuple(authenticate_value(c, alpha, x_coords, threshold, prime))

        triples.append(AuthenticatedBeaverTriple(a_auth, b_auth, c_auth))

    return triples


# ---------------------------------------------------------------------------
# MAC verification
# ---------------------------------------------------------------------------


def _lagrange_coefficient(
    xi: int,
    all_xs: list[int],
    prime: int = BN254_PRIME,
) -> int:
    """Compute Lagrange basis polynomial L_i evaluated at 0."""
    numerator = 1
    denominator = 1
    for xj in all_xs:
        if xj == xi:
            continue
        numerator = (numerator * (0 - xj)) % prime
        denominator = (denominator * (xi - xj)) % prime
    return (numerator * _mod_inv(denominator, prime)) % prime


def compute_mac_check(
    opened_value: int,
    mac_share: int,
    alpha_share: int,
    prime: int = BN254_PRIME,
) -> int:
    """Compute this party's MAC check value σ = γ - α_i * opened_value."""
    return (mac_share - alpha_share * opened_value) % prime


def create_mac_commitment(
    validator_x: int,
    sigma: int,
) -> tuple[MACCheckCommitment, MACCheckReveal]:
    """Create a commitment to σ for the commit-then-reveal protocol."""
    nonce = secrets.token_bytes(32)
    payload = sigma.to_bytes(32, "big") + nonce
    commitment = hashlib.sha256(payload).digest()
    return (
        MACCheckCommitment(validator_x=validator_x, commitment=commitment, nonce=nonce),
        MACCheckReveal(validator_x=validator_x, sigma=sigma, nonce=nonce),
    )


def verify_mac_commitment(commitment: MACCheckCommitment, reveal: MACCheckReveal) -> bool:
    """Verify that a reveal matches its commitment."""
    if commitment.validator_x != reveal.validator_x:
        return False
    payload = reveal.sigma.to_bytes(32, "big") + reveal.nonce
    expected = hashlib.sha256(payload).digest()
    return hmac.compare_digest(commitment.commitment, expected)


def verify_mac_opening(
    opened_value: int,
    auth_shares: list[AuthenticatedShare],
    alpha_shares: list[MACKeyShare],
    prime: int = BN254_PRIME,
) -> bool:
    """Verify that an opened value is consistent with its MAC shares.

    Computes σ_j = γ_j - α_j * opened_value for each party,
    then checks Σ L_j * σ_j = 0.

    Returns True if MAC is valid, False if a party cheated.
    """
    if len(auth_shares) != len(alpha_shares):
        return False

    xs = [s.x for s in auth_shares]
    alpha_map = {s.x: s.alpha_share for s in alpha_shares}

    total = 0
    for s in auth_shares:
        sigma = compute_mac_check(opened_value, s.mac, alpha_map[s.x], prime)
        li = _lagrange_coefficient(s.x, xs, prime)
        total = (total + li * sigma) % prime

    return total == 0


def verify_mac_opening_with_commitments(
    opened_value: int,
    commitments: list[MACCheckCommitment],
    reveals: list[MACCheckReveal],
    prime: int = BN254_PRIME,
) -> bool:
    """Verify MAC opening with commit-then-reveal for malicious security.

    1. Check each reveal matches its commitment
    2. Check Σ L_j * σ_j = 0
    """
    if len(commitments) != len(reveals):
        return False

    commit_map = {c.validator_x: c for c in commitments}

    for reveal in reveals:
        comm = commit_map.get(reveal.validator_x)
        if comm is None:
            return False
        if not verify_mac_commitment(comm, reveal):
            return False

    xs = [r.validator_x for r in reveals]
    total = 0
    for r in reveals:
        li = _lagrange_coefficient(r.validator_x, xs, prime)
        total = (total + li * r.sigma) % prime

    return total == 0


# ---------------------------------------------------------------------------
# Authenticated MPC session
# ---------------------------------------------------------------------------


@dataclass
class AuthenticatedMultiplicationGate:
    """State for a single authenticated multiplication."""

    triple: AuthenticatedBeaverTriple
    x_shares: dict[int, AuthenticatedShare] = field(default_factory=dict)
    y_shares: dict[int, AuthenticatedShare] = field(default_factory=dict)
    d_opened: int | None = None
    e_opened: int | None = None
    z_shares: dict[int, AuthenticatedShare] = field(default_factory=dict)


class AuthenticatedMPCSession:
    """SPDZ-style MPC with MAC verification for malicious security.

    Same protocol as SecureMPCSession but with MAC checks on every opening.
    If any party tampers with their share, the MAC check will fail and the
    protocol aborts.
    """

    _SIMULATION_MODE: bool = os.environ.get("DJINN_SPDZ_SIMULATION") == "1"

    def __init__(
        self,
        available_indices: set[int],
        shares: list[AuthenticatedShare],
        alpha_shares: list[MACKeyShare],
        triples: list[AuthenticatedBeaverTriple],
        threshold: int = 7,
        prime: int = BN254_PRIME,
    ) -> None:
        self._available = sorted(available_indices)
        self._shares = {s.x: s for s in shares}
        self._alpha_shares = {s.x: s for s in alpha_shares}
        self._triples = list(triples)
        self._triple_idx = 0
        self._threshold = threshold
        self._prime = prime
        self._validator_xs = sorted(self._shares.keys())
        self._n_validators = len(shares)

    def _next_triple(self) -> AuthenticatedBeaverTriple:
        if self._triple_idx >= len(self._triples):
            raise ValueError("Not enough Beaver triples for this computation")
        t = self._triples[self._triple_idx]
        self._triple_idx += 1
        return t

    def _reconstruct_from_values(self, values: dict[int, int]) -> int:
        p = self._prime
        xs = sorted(values.keys())
        result = 0
        for xi in xs:
            li = _lagrange_coefficient(xi, xs, p)
            result = (result + li * values[xi]) % p
        return result

    def _verify_opening(
        self,
        opened_value: int,
        auth_shares: list[AuthenticatedShare],
    ) -> None:
        """Verify a MAC on an opened value. Raises MACVerificationError on failure."""
        alpha_list = [self._alpha_shares[s.x] for s in auth_shares]
        if not verify_mac_opening(opened_value, auth_shares, alpha_list, self._prime):
            raise MACVerificationError(f"MAC verification failed for opened value {opened_value}")

    def _authenticated_subtract_constant(
        self,
        shares: dict[int, AuthenticatedShare],
        constant: int,
    ) -> dict[int, AuthenticatedShare]:
        """Subtract a public constant from authenticated shares.

        In Shamir sharing, to get shares of v - c from shares of v:
        - ALL parties subtract c from their value share
        - ALL parties subtract α_j * c from their MAC share
        This preserves the MAC invariant: reconstruct(mac') = α * (v - c)
        """
        p = self._prime
        result = {}
        for vx in sorted(shares.keys()):
            s = shares[vx]
            alpha_j = self._alpha_shares[vx].alpha_share
            new_y = (s.y - constant) % p
            new_mac = (s.mac - alpha_j * constant) % p
            result[vx] = AuthenticatedShare(x=vx, y=new_y, mac=new_mac)
        return result

    def _multiply_shares(
        self,
        x_by_validator: dict[int, AuthenticatedShare],
        y_by_validator: dict[int, AuthenticatedShare],
        triple: AuthenticatedBeaverTriple,
    ) -> dict[int, AuthenticatedShare]:
        """Execute one Beaver triple multiplication with MAC verification.

        Opens d = x - a and e = y - b, verifies their MACs, then computes
        z = d*e + d*b + e*a + c with proper MAC propagation.
        """
        p = self._prime

        a_map = {s.x: s for s in triple.a_shares}
        b_map = {s.x: s for s in triple.b_shares}
        c_map = {s.x: s for s in triple.c_shares}

        # Compute d_i = x_i - a_i and e_i = y_i - b_i (with MACs)
        d_auth_shares: list[AuthenticatedShare] = []
        e_auth_shares: list[AuthenticatedShare] = []
        d_values: dict[int, int] = {}
        e_values: dict[int, int] = {}

        for vx in self._validator_xs:
            x_s = x_by_validator[vx]
            y_s = y_by_validator[vx]
            a_s = a_map[vx]
            b_s = b_map[vx]

            d_y = (x_s.y - a_s.y) % p
            d_mac = (x_s.mac - a_s.mac) % p
            d_auth = AuthenticatedShare(x=vx, y=d_y, mac=d_mac)
            d_auth_shares.append(d_auth)
            d_values[vx] = d_y

            e_y = (y_s.y - b_s.y) % p
            e_mac = (y_s.mac - b_s.mac) % p
            e_auth = AuthenticatedShare(x=vx, y=e_y, mac=e_mac)
            e_auth_shares.append(e_auth)
            e_values[vx] = e_y

        # Reconstruct d, e
        d = self._reconstruct_from_values(d_values)
        e = self._reconstruct_from_values(e_values)

        # MAC verification on opened values
        self._verify_opening(d, d_auth_shares)
        self._verify_opening(e, e_auth_shares)

        # Compute z_i = d*e + d*b_i + e*a_i + c_i
        # MAC of z: γ(z)_i = d*γ(e)_i + e*γ(a)_i + γ(c)_i + d*e*α_i
        # But since d and e are public constants, z = d*e + d*b + e*a + c
        # and MAC(z) = d*e*α + d*MAC(b) + e*MAC(a) + MAC(c)
        # Per-share: γ(z)_j = d*e*α_j + d*γ(b)_j + e*γ(a)_j + γ(c)_j
        z_shares: dict[int, AuthenticatedShare] = {}
        for vx in self._validator_xs:
            a_s = a_map[vx]
            b_s = b_map[vx]
            c_s = c_map[vx]
            alpha_j = self._alpha_shares[vx].alpha_share

            z_y = (d * e + d * b_s.y + e * a_s.y + c_s.y) % p
            z_mac = (d * e * alpha_j + d * b_s.mac + e * a_s.mac + c_s.mac) % p

            z_shares[vx] = AuthenticatedShare(x=vx, y=z_y, mac=z_mac)

        return z_shares

    def run(self) -> tuple[bool, int]:
        """Run the full authenticated MPC protocol.

        Returns:
            (available, n_participants) tuple. Raises MACVerificationError
            if any MAC check fails.
        """
        if self._n_validators < self._threshold:
            log.warning(
                "insufficient_mpc_participants",
                received=self._n_validators,
                threshold=self._threshold,
            )
            return False, self._n_validators

        p = self._prime

        if not self._available:
            return False, self._n_validators

        # Step 1: Compute authenticated shares of (s - a_i) for each available index
        factors: list[dict[int, AuthenticatedShare]] = []
        for a in self._available:
            factor_shares = self._authenticated_subtract_constant(self._shares, a)
            factors.append(factor_shares)

        # Step 2: Generate authenticated shared random mask r
        #
        # SIMULATION ONLY (R25-07): The block below reconstructs alpha to
        # authenticate a fresh random r.  This is acceptable in test /
        # simulation mode (DJINN_SPDZ_SIMULATION=1) but MUST NOT run in
        # production — the coordinator learning alpha breaks SPDZ malicious
        # security.  Production must supply pre-distributed r_auth shares
        # from an offline preprocessing phase so alpha is never revealed.
        if not self._SIMULATION_MODE:
            raise RuntimeError(
                "AuthenticatedMPCSession.run() requires simulation mode. "
                "Production must use the distributed orchestrator with "
                "pre-authenticated r shares from offline preprocessing."
            )
        r = secrets.randbelow(p - 1) + 1
        r_auth = authenticate_value(
            r,
            self._reconstruct_alpha(),
            self._validator_xs,
            self._threshold,
            p,
        )
        r_by_validator = {s.x: s for s in r_auth}

        # Step 3: Tree multiplication with MAC verification
        layer: list[dict[int, AuthenticatedShare]] = [
            self._multiply_shares(r_by_validator, factors[0], self._next_triple())
        ]

        for i in range(1, len(factors)):
            layer.append(factors[i])

        while len(layer) > 1:
            next_layer: list[dict[int, AuthenticatedShare]] = []
            i = 0
            while i < len(layer):
                if i + 1 < len(layer):
                    product = self._multiply_shares(layer[i], layer[i + 1], self._next_triple())
                    next_layer.append(product)
                    i += 2
                else:
                    next_layer.append(layer[i])
                    i += 1
            layer = next_layer

        current = layer[0]

        # Step 4: Open and verify the result
        result_values = {vx: s.y for vx, s in current.items()}
        result_value = self._reconstruct_from_values(result_values)

        # Final MAC check on the opened result
        result_auth = list(current.values())
        self._verify_opening(result_value, result_auth)

        available = result_value == 0

        log.info(
            "authenticated_mpc_result",
            available=available,
            participants=self._n_validators,
            multiplications=len(self._available),
        )

        return available, self._n_validators

    def _reconstruct_alpha(self) -> int:
        """Reconstruct the MAC key (only valid in simulation/trusted dealer mode).

        R25-07: Reconstructing alpha in production defeats SPDZ malicious
        security because the coordinator learns the global MAC key and can
        forge MACs. This method is gated behind DJINN_SPDZ_SIMULATION=1.
        Production must use pre-distributed authenticated r shares from the
        preprocessing phase so that alpha is never reconstructed.
        """
        if not self._SIMULATION_MODE:
            raise RuntimeError(
                "Cannot reconstruct alpha in production — use pre-distributed authenticated shares"
            )
        values = {x: s.alpha_share for x, s in self._alpha_shares.items()}
        return self._reconstruct_from_values(values)


# ---------------------------------------------------------------------------
# Distributed participant state with MAC support
# ---------------------------------------------------------------------------


@dataclass
class AuthenticatedParticipantState:
    """Per-session MPC state for a participant with SPDZ MAC support.

    Extends DistributedParticipantState with MAC shares for verification.
    """

    validator_x: int
    secret_share: AuthenticatedShare  # Share of the signal index
    r_share: AuthenticatedShare  # Share of the random mask
    alpha_share: MACKeyShare  # This validator's MAC key share
    available_indices: list[int]
    triple_a: list[AuthenticatedShare]  # Per-gate a shares
    triple_b: list[AuthenticatedShare]  # Per-gate b shares
    triple_c: list[AuthenticatedShare]  # Per-gate c shares
    prime: int = BN254_PRIME
    _gates_completed: int = 0
    _prev_z: AuthenticatedShare | None = None

    def compute_gate(
        self,
        gate_idx: int,
        prev_opened_d: int | None = None,
        prev_opened_e: int | None = None,
    ) -> tuple[int, int, int, int]:
        """Compute (d_i, e_i, d_mac_i, e_mac_i) for a multiplication gate.

        Returns both the values and MAC shares so the coordinator can
        verify MACs after reconstruction.
        """
        if gate_idx != self._gates_completed:
            raise ValueError(f"Expected gate {self._gates_completed}, got {gate_idx}")

        p = self.prime

        if gate_idx == 0:
            x_input = self.r_share
        else:
            if prev_opened_d is None or prev_opened_e is None:
                raise ValueError("Previous gate opened values required for gate > 0")
            if self._prev_z is None:
                raise ValueError("No previous gate output")
            x_input = self._prev_z

        # y_input = secret_share - available_indices[gate_idx]
        a_idx = self.available_indices[gate_idx]
        y_val = (self.secret_share.y - a_idx) % p
        y_mac = (self.secret_share.mac - self.alpha_share.alpha_share * a_idx) % p
        y_input = AuthenticatedShare(x=self.validator_x, y=y_val, mac=y_mac)

        # d_i = x_input - a[gate_idx], with MAC
        a_share = self.triple_a[gate_idx]
        d_val = (x_input.y - a_share.y) % p
        d_mac = (x_input.mac - a_share.mac) % p

        b_share = self.triple_b[gate_idx]
        e_val = (y_input.y - b_share.y) % p
        e_mac = (y_input.mac - b_share.mac) % p

        # Pre-compute z for next gate (needs d, e from coordinator)
        # We'll compute this lazily when the next gate is called
        # Store what we need for the computation
        self._gate_x_input = x_input
        self._gate_y_input = y_input
        self._gate_a = a_share
        self._gate_b = b_share
        self._gate_c = self.triple_c[gate_idx]

        self._gates_completed += 1
        return d_val, e_val, d_mac, e_mac

    def finalize_gate(self, opened_d: int, opened_e: int) -> None:
        """Compute this gate's output z share using the opened d, e values.

        Must be called after compute_gate and before the next gate.
        """
        p = self.prime
        alpha_j = self.alpha_share.alpha_share

        z_val = (opened_d * opened_e + opened_d * self._gate_b.y + opened_e * self._gate_a.y + self._gate_c.y) % p

        z_mac = (
            opened_d * opened_e * alpha_j + opened_d * self._gate_b.mac + opened_e * self._gate_a.mac + self._gate_c.mac
        ) % p

        self._prev_z = AuthenticatedShare(x=self.validator_x, y=z_val, mac=z_mac)

    def get_output_share(self) -> AuthenticatedShare | None:
        """Get the final output share after all gates are computed."""
        return self._prev_z

    def compute_mac_sigma(self, opened_value: int, mac_share: int) -> int:
        """Compute σ = γ - α_j * opened_value for MAC verification."""
        return compute_mac_check(opened_value, mac_share, self.alpha_share.alpha_share, self.prime)
