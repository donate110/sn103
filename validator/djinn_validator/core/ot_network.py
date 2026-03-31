"""Network-aware 2-party DH-based OT for distributed Beaver triple generation.

Implements Chou-Orlandi (simplified, semi-honest) oblivious transfer.
Production uses RFC 3526 Group 14 (2048-bit MODP).  Tests can use a
smaller group for speed.

Protocol (per triple, per direction):
  1. Sender generates DH keypair (a, A=g^a mod p), sends A
  2. Receiver, for each bit k of y:
       b_k=0: T_k = g^{r_k}
       b_k=1: T_k = A * g^{r_k}
     Sends n_bits T_k values
  3. Sender derives keys:
       K0_k = H(T_k^a)
       K1_k = H((T_k * A^{-1})^a)
     Encrypts m0_k, m1_k under K0, K1 respectively.  Sends pairs.
  4. Receiver derives K_k = H(A^{r_k}) and decrypts m_{b_k}

Security: CDH in the MODP group.  Semi-honest only — malicious security
via SPDZ MAC verification is a separate module (future work).

After pairwise OT, additive shares are converted to Shamir shares.
Each party serves its polynomial evaluations directly to other validators
so the coordinator never sees the peer's Shamir polynomial.
"""

from __future__ import annotations

import hashlib
import os
import secrets
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from dataclasses import field as dataclass_field

import structlog

from djinn_validator.utils.crypto import BN254_PRIME

log = structlog.get_logger()


# ---------------------------------------------------------------------------
# Parallel modular exponentiation
# ---------------------------------------------------------------------------

# Shared process pool for batch modexp. Lazy-initialized on first use.
_modexp_pool: ProcessPoolExecutor | None = None


def _modexp_worker(args: tuple[int, int, int]) -> int:
    """Worker function for parallel modular exponentiation."""
    base, exp, mod = args
    return pow(base, exp, mod)


def _batch_modexp(base: int, exponents: list[int], modulus: int) -> list[int]:
    """Compute pow(base, exp, modulus) for each exp in parallel.

    Uses a process pool to bypass the GIL. On a 4-core machine, this gives
    ~4x speedup for 2048-bit modexps (measured: 6s -> 1.5s for 254 ops).
    Falls back to sequential if the process pool fails.
    """
    global _modexp_pool
    n = len(exponents)
    if n == 0:
        return []
    # For small batches, sequential is faster (avoids IPC overhead)
    if n < 32:
        return [pow(base, e, modulus) for e in exponents]
    try:
        if _modexp_pool is None:
            import multiprocessing as mp
            # Use forkserver to avoid fork-in-multithreaded-process warnings.
            # forkserver is safe with asyncio event loops (unlike fork).
            try:
                mp.set_start_method("forkserver", force=False)
            except (RuntimeError, ValueError):
                pass  # Already set or not available
            workers = min(os.cpu_count() or 4, 8)
            _modexp_pool = ProcessPoolExecutor(max_workers=workers)
        args = [(base, e, modulus) for e in exponents]
        return list(_modexp_pool.map(_modexp_worker, args, chunksize=max(1, n // (os.cpu_count() or 4))))
    except Exception:
        log.warning("batch_modexp_fallback", reason="process pool failed, using sequential")
        return [pow(base, e, modulus) for e in exponents]


# ---------------------------------------------------------------------------
# DH group abstraction
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DHGroup:
    """Diffie-Hellman group parameters for OT key exchange."""

    prime: int
    generator: int
    byte_length: int  # Fixed byte length for serialization

    def rand_scalar(self) -> int:
        """Generate a random non-zero scalar in [1, p-2]."""
        return secrets.randbelow(self.prime - 2) + 1


# RFC 3526 Group 14 — 2048-bit MODP (production)
DH_GROUP_2048 = DHGroup(
    prime=int(
        "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1"
        "29024E088A67CC74020BBEA63B139B22514A08798E3404DD"
        "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245"
        "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED"
        "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D"
        "C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F"
        "83655D23DCA3AD961C62F356208552BB9ED529077096966D"
        "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B"
        "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9"
        "DE2BCBF6955817183995497CEA956AE515D2261898FA0510"
        "15728E5A8AACAA68FFFFFFFFFFFFFFFF",
        16,
    ),
    generator=2,
    byte_length=256,
)

# Small safe prime (p=1223, q=611) — fast tests only, NOT secure
DH_GROUP_TEST = DHGroup(prime=1223, generator=2, byte_length=2)

# Module-level defaults (production)
DEFAULT_DH_GROUP = DH_GROUP_2048

# Legacy aliases
DH_PRIME = DH_GROUP_2048.prime
DH_GENERATOR = DH_GROUP_2048.generator
DH_BYTES = DH_GROUP_2048.byte_length

# Byte length of a BN254 field element
FIELD_BYTES = 32


# ---------------------------------------------------------------------------
# Low-level OT primitives
# ---------------------------------------------------------------------------


def _ot_key(dh_result: int, bit_idx: int, choice: int, dh_bytes: int = 256) -> bytes:
    """Derive 32-byte OT encryption key from a DH result via SHA-256."""
    h = hashlib.sha256()
    byte_len = dh_bytes
    h.update(dh_result.to_bytes(byte_len, "big"))
    h.update(bit_idx.to_bytes(4, "big"))
    h.update(choice.to_bytes(1, "big"))
    return h.digest()


def _xor_bytes(a: bytes, b: bytes) -> bytes:
    """XOR two equal-length byte strings."""
    return bytes(x ^ y for x, y in zip(a, b))


def _int_to_field_bytes(v: int, field_prime: int = BN254_PRIME) -> bytes:
    """Encode a field element as fixed-width 32 bytes (big-endian)."""
    return (v % field_prime).to_bytes(FIELD_BYTES, "big")


def _field_bytes_to_int(b: bytes) -> int:
    """Decode a 32-byte big-endian field element."""
    return int.from_bytes(b, "big")


def _n_bits_for_prime(p: int) -> int:
    """Number of bits needed to represent elements of Z_p."""
    return p.bit_length()


# ---------------------------------------------------------------------------
# Sender / receiver state for one Gilboa multiplication
# ---------------------------------------------------------------------------


@dataclass
class GilboaSenderSetup:
    """Sender-side state for one Gilboa OT multiplication.

    The sender holds private input *x* and wants to compute additive shares
    of x * y with the receiver (who holds y) without learning y.
    """

    x: int
    prime: int = BN254_PRIME
    dh_group: DHGroup = dataclass_field(default_factory=lambda: DEFAULT_DH_GROUP)
    dh_secret: int = 0
    dh_public: int = 0
    _r_values: list[int] = dataclass_field(default_factory=list)
    _n_bits: int = 0

    def __post_init__(self) -> None:
        if self.dh_secret == 0:
            self.dh_secret = self.dh_group.rand_scalar()
        self.dh_public = pow(self.dh_group.generator, self.dh_secret, self.dh_group.prime)
        self._n_bits = _n_bits_for_prime(self.prime)
        self._r_values = [secrets.randbelow(self.prime) for _ in range(self._n_bits)]

    def get_public_key(self) -> int:
        return self.dh_public

    def process_choices(
        self,
        t_values: list[int],
    ) -> tuple[list[tuple[bytes, bytes]], int]:
        """Process receiver's choice commitments.

        Returns:
            (encrypted_pairs, sender_share) where encrypted_pairs[k] = (E0, E1).
        """
        dhp = self.dh_group.prime
        fp = self.prime
        dh_bytes = self.dh_group.byte_length
        a_inv = pow(self.dh_public, dhp - 2, dhp)
        dh_secret = self.dh_secret

        # Batch the 2*n_bits modexps in parallel (biggest bottleneck).
        # t_values[k]^dh_secret and (t_values[k]*a_inv)^dh_secret for each k.
        bases_for_modexp: list[int] = []
        for k in range(self._n_bits):
            bases_for_modexp.append(t_values[k])
            bases_for_modexp.append((t_values[k] * a_inv) % dhp)

        # All modexps use the same exponent (dh_secret) and modulus (dhp)
        exponents = [dh_secret] * len(bases_for_modexp)
        n = len(bases_for_modexp)
        if n >= 32:
            # Use process pool for parallel modexp
            global _modexp_pool
            try:
                if _modexp_pool is None:
                    import multiprocessing as mp
                    try:
                        mp.set_start_method("forkserver", force=False)
                    except (RuntimeError, ValueError):
                        pass
                    workers = min(os.cpu_count() or 4, 8)
                    _modexp_pool = ProcessPoolExecutor(max_workers=workers)
                args = [(b, dh_secret, dhp) for b in bases_for_modexp]
                modexp_results = list(_modexp_pool.map(_modexp_worker, args, chunksize=max(1, n // (os.cpu_count() or 4))))
            except Exception:
                modexp_results = [pow(b, dh_secret, dhp) for b in bases_for_modexp]
        else:
            modexp_results = [pow(b, dh_secret, dhp) for b in bases_for_modexp]

        sender_share = 0
        pairs: list[tuple[bytes, bytes]] = []

        for k in range(self._n_bits):
            r_k = self._r_values[k]
            x_shifted = (self.x * pow(2, k, fp)) % fp
            m0 = r_k
            m1 = (r_k + x_shifted) % fp

            k0 = _ot_key(modexp_results[k * 2], k, 0, dh_bytes)
            k1 = _ot_key(modexp_results[k * 2 + 1], k, 1, dh_bytes)

            e0 = _xor_bytes(_int_to_field_bytes(m0, fp), k0)
            e1 = _xor_bytes(_int_to_field_bytes(m1, fp), k1)

            sender_share = (sender_share - r_k) % fp
            pairs.append((e0, e1))

        return pairs, sender_share


@dataclass
class GilboaReceiverSetup:
    """Receiver-side state for one Gilboa OT multiplication.

    The receiver holds private input *y* and wants to compute additive shares
    of x * y with the sender (who holds x) without learning x.
    """

    y: int
    prime: int = BN254_PRIME
    dh_group: DHGroup = dataclass_field(default_factory=lambda: DEFAULT_DH_GROUP)
    _r_values: list[int] = dataclass_field(default_factory=list)
    _g_r_bases: list[int] = dataclass_field(default_factory=list)
    _bits: list[int] = dataclass_field(default_factory=list)
    _sender_pk: int = 0
    _n_bits: int = 0

    def __post_init__(self) -> None:
        self._n_bits = _n_bits_for_prime(self.prime)
        self._r_values = [self.dh_group.rand_scalar() for _ in range(self._n_bits)]
        self._bits = [(self.y >> k) & 1 for k in range(self._n_bits)]
        # Pre-compute g^r_k mod p for each bit.
        # Defer to batch_modexp for parallel computation when available.
        g = self.dh_group.generator
        dhp = self.dh_group.prime
        self._g_r_bases = _batch_modexp(g, self._r_values, dhp)

    def generate_choices(self, sender_public_key: int) -> list[int]:
        """Generate T_k choice commitments given sender's DH public key.

        Uses pre-computed g^r_k bases (from __post_init__) so this method
        only does cheap multiplications, not modular exponentiations.
        """
        self._sender_pk = sender_public_key
        a = sender_public_key
        dhp = self.dh_group.prime
        t_values: list[int] = []
        for k in range(self._n_bits):
            base = self._g_r_bases[k]
            if self._bits[k] == 1:
                t_values.append((a * base) % dhp)
            else:
                t_values.append(base)
        return t_values

    def decrypt_transfers(
        self,
        encrypted_pairs: list[tuple[bytes, bytes]],
    ) -> int:
        """Decrypt OT messages and return receiver's accumulated share."""
        a = self._sender_pk
        dhp = self.dh_group.prime
        fp = self.prime
        dh_bytes = self.dh_group.byte_length

        # Batch all modexps: a^r_k mod dhp for each bit
        dh_results = _batch_modexp(a, self._r_values, dhp)

        receiver_share = 0
        for k in range(self._n_bits):
            key = _ot_key(dh_results[k], k, self._bits[k], dh_bytes)
            ciphertext = encrypted_pairs[k][self._bits[k]]
            plaintext = _xor_bytes(ciphertext, key)
            m = _field_bytes_to_int(plaintext)
            receiver_share = (receiver_share + m) % fp

        return receiver_share


# ---------------------------------------------------------------------------
# 2-party distributed triple generation
# ---------------------------------------------------------------------------


@dataclass
class TwoPartyTripleResult:
    """Result of 2-party OT triple generation for one triple.

    Party 0 (coordinator) holds additive shares (a0, b0, c0).
    Party 1 (peer)        holds additive shares (a1, b1, c1).
    a0+a1 = a, b0+b1 = b, c0+c1 = c = a*b mod p.
    """

    a0: int
    b0: int
    c0: int
    a1: int
    b1: int
    c1: int


def generate_two_party_triple_local(
    prime: int = BN254_PRIME,
    dh_group: DHGroup | None = None,
) -> TwoPartyTripleResult:
    """Generate one Beaver triple via 2-party OT (local simulation for testing).

    Both parties' logic runs locally.  For network deployment, the OT
    messages are exchanged via HTTP using the OT endpoints.
    """
    if dh_group is None:
        dh_group = DEFAULT_DH_GROUP

    a0 = secrets.randbelow(prime)
    b0 = secrets.randbelow(prime)
    a1 = secrets.randbelow(prime)
    b1 = secrets.randbelow(prime)

    c0 = (a0 * b0) % prime
    c1 = (a1 * b1) % prime

    # Cross-term 1: coordinator sends a0, peer receives with b1
    sender1 = GilboaSenderSetup(x=a0, prime=prime, dh_group=dh_group)
    receiver1 = GilboaReceiverSetup(y=b1, prime=prime, dh_group=dh_group)
    choices1 = receiver1.generate_choices(sender1.get_public_key())
    pairs1, s_share1 = sender1.process_choices(choices1)
    r_share1 = receiver1.decrypt_transfers(pairs1)
    c0 = (c0 + s_share1) % prime
    c1 = (c1 + r_share1) % prime

    # Cross-term 2: peer sends a1, coordinator receives with b0
    sender2 = GilboaSenderSetup(x=a1, prime=prime, dh_group=dh_group)
    receiver2 = GilboaReceiverSetup(y=b0, prime=prime, dh_group=dh_group)
    choices2 = receiver2.generate_choices(sender2.get_public_key())
    pairs2, s_share2 = sender2.process_choices(choices2)
    r_share2 = receiver2.decrypt_transfers(pairs2)
    c1 = (c1 + s_share2) % prime
    c0 = (c0 + r_share2) % prime

    return TwoPartyTripleResult(a0=a0, b0=b0, c0=c0, a1=a1, b1=b1, c1=c1)


def verify_two_party_triple(t: TwoPartyTripleResult, prime: int = BN254_PRIME) -> bool:
    """Verify a 2-party triple: (a0+a1)*(b0+b1) == c0+c1 mod p."""
    a = (t.a0 + t.a1) % prime
    b = (t.b0 + t.b1) % prime
    c = (t.c0 + t.c1) % prime
    return c == (a * b) % prime


# ---------------------------------------------------------------------------
# Serialization helpers for HTTP transport
# ---------------------------------------------------------------------------


def serialize_dh_public_key(pk: int, dh_group: DHGroup | None = None) -> str:
    """Serialize a DH public key as hex."""
    bl = (dh_group or DEFAULT_DH_GROUP).byte_length
    return pk.to_bytes(bl, "big").hex()


def deserialize_dh_public_key(hex_str: str) -> int:
    """Deserialize a DH public key from hex (handles 0x prefix)."""
    return int(hex_str, 16)


def serialize_choices(t_values: list[int], dh_group: DHGroup | None = None) -> list[str]:
    """Serialize choice commitments as hex strings."""
    bl = (dh_group or DEFAULT_DH_GROUP).byte_length
    return [v.to_bytes(bl, "big").hex() for v in t_values]


def deserialize_choices(hex_list: list[str]) -> list[int]:
    """Deserialize choice commitments from hex strings (handles 0x prefix)."""
    return [int(h, 16) for h in hex_list]


def serialize_transfers(pairs: list[tuple[bytes, bytes]]) -> list[list[str]]:
    """Serialize encrypted OT pairs as [hex(E0), hex(E1)] lists."""
    return [[e0.hex(), e1.hex()] for e0, e1 in pairs]


def deserialize_transfers(data: list[list[str]]) -> list[tuple[bytes, bytes]]:
    """Deserialize encrypted OT pairs from [hex(E0), hex(E1)] lists."""
    return [(bytes.fromhex(pair[0]), bytes.fromhex(pair[1])) for pair in data]


# ---------------------------------------------------------------------------
# Shamir polynomial for additive-to-Shamir conversion
# ---------------------------------------------------------------------------


def create_shamir_polynomial(
    constant: int,
    degree: int,
    prime: int = BN254_PRIME,
) -> list[int]:
    """Create a random polynomial with given constant term (degree = k-1)."""
    return [constant] + [secrets.randbelow(prime) for _ in range(degree)]


def evaluate_polynomial(
    coeffs: list[int],
    x: int,
    prime: int = BN254_PRIME,
) -> int:
    """Evaluate polynomial at point x in the field."""
    result = 0
    for j, c in enumerate(coeffs):
        result = (result + c * pow(x, j, prime)) % prime
    return result


# ---------------------------------------------------------------------------
# Per-party OT session state (stored on each validator during triple gen)
# ---------------------------------------------------------------------------


@dataclass
class OTTripleGenState:
    """State held by one party during distributed triple generation.

    Created when the coordinator initiates OT triple gen and maintained
    until all triples are generated and Shamir shares are served.
    """

    session_id: str
    party_role: str  # "coordinator" or "peer"
    n_triples: int
    x_coords: list[int]
    threshold: int
    prime: int = BN254_PRIME
    dh_group: DHGroup = dataclass_field(default_factory=lambda: DEFAULT_DH_GROUP)

    # Private random values (generated locally, never transmitted)
    a_values: list[int] = dataclass_field(default_factory=list)
    b_values: list[int] = dataclass_field(default_factory=list)

    # Accumulated c shares (from local product + OT cross-terms)
    c_values: list[int] = dataclass_field(default_factory=list)

    # Shamir polynomial evaluations: {triple_idx: {x_coord: value}}
    shamir_evals_a: dict[int, dict[int, int]] = dataclass_field(default_factory=dict)
    shamir_evals_b: dict[int, dict[int, int]] = dataclass_field(default_factory=dict)
    shamir_evals_c: dict[int, dict[int, int]] = dataclass_field(default_factory=dict)

    # OT sender/receiver states (keyed by triple index)
    senders: dict[int, GilboaSenderSetup] = dataclass_field(default_factory=dict)
    receivers: dict[int, GilboaReceiverSetup] = dataclass_field(default_factory=dict)

    completed: bool = False

    def initialize(self) -> None:
        """Generate private random (a_i, b_i) values for all triples."""
        self.a_values = [secrets.randbelow(self.prime) for _ in range(self.n_triples)]
        self.b_values = [secrets.randbelow(self.prime) for _ in range(self.n_triples)]
        self.c_values = [(self.a_values[t] * self.b_values[t]) % self.prime for t in range(self.n_triples)]
        for t in range(self.n_triples):
            self.senders[t] = GilboaSenderSetup(
                x=self.a_values[t],
                prime=self.prime,
                dh_group=self.dh_group,
            )
        for t in range(self.n_triples):
            self.receivers[t] = GilboaReceiverSetup(
                y=self.b_values[t],
                prime=self.prime,
                dh_group=self.dh_group,
            )

    def get_sender_public_keys(self) -> dict[int, int]:
        """Return DH public keys for all sender OT instances."""
        return {t: self.senders[t].get_public_key() for t in range(self.n_triples)}

    def generate_receiver_choices(
        self,
        peer_sender_pks: dict[int, int],
    ) -> dict[int, list[int]]:
        """Generate choice commitments for all triples where this party is receiver."""
        choices: dict[int, list[int]] = {}
        for t in range(self.n_triples):
            choices[t] = self.receivers[t].generate_choices(peer_sender_pks[t])
        return choices

    def process_sender_choices(
        self,
        peer_choices: dict[int, list[int]],
    ) -> tuple[dict[int, list[tuple[bytes, bytes]]], dict[int, int]]:
        """Process peer's choices and return encrypted transfers + sender shares."""
        transfers: dict[int, list[tuple[bytes, bytes]]] = {}
        sender_shares: dict[int, int] = {}
        for t in range(self.n_triples):
            pairs, s_share = self.senders[t].process_choices(peer_choices[t])
            transfers[t] = pairs
            sender_shares[t] = s_share
        return transfers, sender_shares

    def decrypt_receiver_transfers(
        self,
        peer_transfers: dict[int, list[tuple[bytes, bytes]]],
    ) -> dict[int, int]:
        """Decrypt encrypted OT messages and return receiver shares."""
        receiver_shares: dict[int, int] = {}
        for t in range(self.n_triples):
            receiver_shares[t] = self.receivers[t].decrypt_transfers(peer_transfers[t])
        return receiver_shares

    def accumulate_ot_shares(
        self,
        sender_shares: dict[int, int],
        receiver_shares: dict[int, int],
    ) -> None:
        """Add OT cross-term shares to c values."""
        for t in range(self.n_triples):
            self.c_values[t] = (self.c_values[t] + sender_shares[t] + receiver_shares[t]) % self.prime

    def compute_shamir_evaluations(self) -> None:
        """Create Shamir polynomials and evaluate at all x-coordinates."""
        degree = self.threshold - 1
        for t in range(self.n_triples):
            poly_a = create_shamir_polynomial(self.a_values[t], degree, self.prime)
            poly_b = create_shamir_polynomial(self.b_values[t], degree, self.prime)
            poly_c = create_shamir_polynomial(self.c_values[t], degree, self.prime)

            self.shamir_evals_a[t] = {x: evaluate_polynomial(poly_a, x, self.prime) for x in self.x_coords}
            self.shamir_evals_b[t] = {x: evaluate_polynomial(poly_b, x, self.prime) for x in self.x_coords}
            self.shamir_evals_c[t] = {x: evaluate_polynomial(poly_c, x, self.prime) for x in self.x_coords}
        self.completed = True

    def get_shamir_shares_for_party(
        self,
        party_x: int,
    ) -> list[dict[str, int]] | None:
        """Return this party's Shamir polynomial evaluations at party_x.

        Returns list of {a, b, c} values (one per triple) for the requesting party
        to add to the coordinator's partial shares.
        """
        if not self.completed:
            return None
        result = []
        for t in range(self.n_triples):
            a_val = self.shamir_evals_a.get(t, {}).get(party_x)
            b_val = self.shamir_evals_b.get(t, {}).get(party_x)
            c_val = self.shamir_evals_c.get(t, {}).get(party_x)
            if a_val is None or b_val is None or c_val is None:
                return None
            result.append({"a": a_val, "b": b_val, "c": c_val})
        return result
