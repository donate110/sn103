"""Pydantic request/response models for the validator REST API."""

from __future__ import annotations

import re

from pydantic import BaseModel, Field, field_validator

_HEX_RE = re.compile(r"^(0x)?[0-9a-fA-F]+$")
_SIGNAL_ID_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,256}$")
_ETH_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_EVENT_ID_RE = re.compile(r"^[a-zA-Z0-9_\-:.]{1,256}$")


def _validate_hex(v: str, field_name: str) -> str:
    if not _HEX_RE.match(v):
        raise ValueError(f"{field_name} must be a hex string")
    return v


def _validate_signal_id(v: str) -> str:
    if not _SIGNAL_ID_RE.match(v):
        raise ValueError("signal_id must be 1-256 alphanumeric chars, hyphens, or underscores")
    return v


class StoreShareRequest(BaseModel):
    """POST /v1/signal — Accept encrypted key share from a Genius."""

    signal_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    genius_address: str = Field(max_length=256)
    share_x: int = Field(ge=1, le=10)
    share_y: str = Field(max_length=66)  # Hex-encoded BN254 field element (64 hex + 0x)
    encrypted_key_share: str = Field(max_length=4096)  # Hex-encoded encrypted AES key share
    encrypted_index_share: str = Field(default="", max_length=4096)  # Hex-encoded index share for MPC

    @field_validator("share_y")
    @classmethod
    def validate_share_y(cls, v: str) -> str:
        return _validate_hex(v, "share_y")

    @field_validator("encrypted_key_share")
    @classmethod
    def validate_encrypted_key_share(cls, v: str) -> str:
        return _validate_hex(v, "encrypted_key_share")

    @field_validator("encrypted_index_share")
    @classmethod
    def validate_encrypted_index_share(cls, v: str) -> str:
        if not v:
            return v
        return _validate_hex(v, "encrypted_index_share")


class StoreShareResponse(BaseModel):
    signal_id: str
    stored: bool


class PurchaseRequest(BaseModel):
    """POST /v1/signal/{id}/purchase — Buyer requests a signal purchase."""

    buyer_address: str = Field(max_length=256)
    sportsbook: str = Field(max_length=256)
    available_indices: list[int] = Field(min_length=1, max_length=10)

    @field_validator("buyer_address")
    @classmethod
    def validate_buyer_address(cls, v: str) -> str:
        if not _ETH_ADDRESS_RE.match(v):
            raise ValueError("buyer_address must be a valid Ethereum address (0x + 40 hex chars)")
        return v

    @field_validator("available_indices")
    @classmethod
    def validate_indices_range(cls, v: list[int]) -> list[int]:
        for idx in v:
            if idx < 1 or idx > 10:
                raise ValueError(f"available_indices values must be 1-10, got {idx}")
        if len(set(v)) != len(v):
            raise ValueError("available_indices must not contain duplicates")
        return v


class PurchaseResponse(BaseModel):
    signal_id: str
    status: str
    available: bool | None = None
    encrypted_key_share: str | None = None  # Hex-encoded Shamir share y-value
    share_x: int | None = None  # Shamir share x-coordinate
    message: str = ""


class OutcomeRequest(BaseModel):
    """POST /v1/signal/{id}/outcome — Submit an outcome attestation."""

    signal_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    event_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-:.]+$")
    outcome: int = Field(ge=0, le=3)  # 0=Pending, 1=Favorable, 2=Unfavorable, 3=Void
    validator_hotkey: str = Field(max_length=256)


class OutcomeResponse(BaseModel):
    signal_id: str
    outcome: int
    consensus_reached: bool
    consensus_outcome: int | None = None


class RegisterSignalRequest(BaseModel):
    """POST /v1/signal/{id}/register — Register for blind outcome tracking.

    Accepts all 10 public decoy lines (already committed on-chain).
    The validator resolves ALL lines against game results, producing 10
    outcomes.  The real outcome is selected later by batch MPC at the
    audit-set level, so no individual signal outcome is ever revealed.
    """

    sport: str = Field(max_length=128, pattern=r"^[a-z][a-z0-9_]*$")
    event_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-:.]+$")
    home_team: str = Field(max_length=256)
    away_team: str = Field(max_length=256)
    lines: list[str] = Field(min_length=10, max_length=10)
    genius_address: str = Field(default="", max_length=256)
    idiot_address: str = Field(default="", max_length=256)
    notional: int = Field(default=0, ge=0)
    odds: int = Field(default=1_000_000, ge=0)
    sla_bps: int = Field(default=10_000, ge=0, le=100_000)
    cycle: int = Field(default=0, ge=0)

    @field_validator("lines")
    @classmethod
    def validate_lines(cls, v: list[str]) -> list[str]:
        for i, line in enumerate(v):
            if len(line) > 512:
                raise ValueError(f"Line {i} exceeds 512 characters")
            if not line.strip():
                raise ValueError(f"Line {i} is empty")
        return v


class RegisterSignalResponse(BaseModel):
    signal_id: str
    registered: bool
    lines_count: int = 0


class AuditSetStatusResponse(BaseModel):
    """GET /v1/audit/{genius}/{idiot}/status — Audit set status."""

    genius: str
    idiot: str
    cycle: int
    signals_count: int
    resolved_count: int
    ready: bool
    settled: bool


class ResolveResponse(BaseModel):
    """POST /v1/signals/resolve — Resolve all pending signals."""

    resolved_count: int
    results: list[dict] = Field(default_factory=list)


class IdentityResponse(BaseModel):
    """GET /v1/identity — Validator identity for peer discovery."""

    base_address: str = ""
    hotkey: str = ""
    version: str = "0.1.0"


class HealthResponse(BaseModel):
    """GET /health — Validator health check."""

    status: str
    version: str = "0.1.0"
    uid: int | None = None
    shares_held: int = 0
    pending_outcomes: int = 0
    chain_connected: bool = False
    bt_connected: bool = False


class ReadinessResponse(BaseModel):
    """GET /health/ready — Deep readiness probe."""

    ready: bool
    checks: dict[str, bool] = Field(default_factory=dict)


class AnalyticsRequest(BaseModel):
    """POST /v1/analytics/attempt — Fire-and-forget analytics."""

    event_type: str = Field(max_length=128)
    data: dict = Field(default_factory=dict)

    @field_validator("data")
    @classmethod
    def validate_data_size(cls, v: dict) -> dict:
        if len(v) > 50:
            raise ValueError(f"data dict must have at most 50 keys, got {len(v)}")
        return v


# ---------------------------------------------------------------------------
# MPC Coordination Models (inter-validator communication)
# ---------------------------------------------------------------------------


class MPCInitRequest(BaseModel):
    """POST /v1/mpc/init — Coordinator invites this validator to an MPC session."""

    session_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    signal_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    available_indices: list[int] = Field(max_length=10)
    coordinator_x: int = Field(ge=1, le=255)
    participant_xs: list[int] = Field(max_length=20)
    threshold: int = Field(default=7, ge=1, le=20)
    # This validator's Beaver triple shares (one dict per gate)
    triple_shares: list[dict[str, str]] = Field(default_factory=list, max_length=20)  # hex-encoded
    # This validator's share of the random mask r (hex-encoded)
    r_share_y: str | None = None
    # SPDZ authenticated MPC fields (optional — absent for semi-honest mode)
    authenticated: bool = False
    # Authenticated triple shares: [{a: {y: hex, mac: hex}, b: ..., c: ...}]
    auth_triple_shares: list[dict[str, dict[str, str]]] | None = None
    # MAC key share for this validator (hex-encoded)
    alpha_share: str | None = None
    # Authenticated r share: {y: hex, mac: hex}
    auth_r_share: dict[str, str] | None = None
    # Authenticated secret share: {y: hex, mac: hex}
    auth_secret_share: dict[str, str] | None = None

    @field_validator("available_indices")
    @classmethod
    def validate_mpc_indices(cls, v: list[int]) -> list[int]:
        for idx in v:
            if idx < 1 or idx > 10:
                raise ValueError(f"available_indices values must be 1-10, got {idx}")
        return v

    @field_validator("participant_xs")
    @classmethod
    def validate_participant_xs(cls, v: list[int]) -> list[int]:
        for x in v:
            if x < 1 or x > 255:
                raise ValueError(f"participant_xs values must be 1-255, got {x}")
        if len(set(v)) != len(v):
            raise ValueError("participant_xs must not contain duplicates")
        return v


class MPCInitResponse(BaseModel):
    session_id: str
    accepted: bool
    message: str = ""


class MPCRound1Request(BaseModel):
    """POST /v1/mpc/round1 — Submit Round 1 message (d, e values) for a gate."""

    session_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    gate_idx: int = Field(ge=0, le=20)
    validator_x: int = Field(ge=1, le=255)
    d_value: str = Field(max_length=66)  # Hex-encoded BN254 field element
    e_value: str = Field(max_length=66)  # Hex-encoded BN254 field element

    @field_validator("d_value", "e_value")
    @classmethod
    def validate_hex(cls, v: str) -> str:
        return _validate_hex(v, "d_value/e_value")


class MPCRound1Response(BaseModel):
    session_id: str
    gate_idx: int
    accepted: bool


class MPCResultRequest(BaseModel):
    """POST /v1/mpc/result — Coordinator broadcasts the opened result."""

    session_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    signal_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    available: bool
    participating_validators: int = Field(ge=0, le=255)


class MPCResultResponse(BaseModel):
    session_id: str
    acknowledged: bool


class MPCComputeGateRequest(BaseModel):
    """POST /v1/mpc/compute_gate — Coordinator requests gate computation."""

    session_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    gate_idx: int = Field(ge=0, le=20)
    prev_opened_d: str | None = None  # Hex-encoded, None for gate 0
    prev_opened_e: str | None = None  # Hex-encoded, None for gate 0


class MPCComputeGateResponse(BaseModel):
    session_id: str
    gate_idx: int
    d_value: str  # Hex-encoded
    e_value: str  # Hex-encoded
    # SPDZ MAC shares (present only in authenticated mode)
    d_mac: str | None = None  # Hex-encoded
    e_mac: str | None = None  # Hex-encoded


class MPCFinalizeRequest(BaseModel):
    """POST /v1/mpc/finalize — Coordinator requests final output share z_i."""

    session_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    last_opened_d: str  # Hex-encoded
    last_opened_e: str  # Hex-encoded


class MPCFinalizeResponse(BaseModel):
    session_id: str
    z_share: str  # Hex-encoded output share


class MPCAbortRequest(BaseModel):
    """POST /v1/mpc/abort — Coordinator broadcasts abort due to MAC failure."""

    session_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    reason: str = Field(max_length=512)
    gate_idx: int = Field(ge=0, le=20)
    offending_validator_x: int | None = None  # x-coord of suspected cheater, if identifiable


class MPCAbortResponse(BaseModel):
    session_id: str
    acknowledged: bool


class MPCSessionStatusResponse(BaseModel):
    """GET /v1/mpc/{session_id}/status — Check MPC session status."""

    session_id: str
    status: str
    available: bool | None = None
    participants_responded: int = 0
    total_participants: int = 0


# ---------------------------------------------------------------------------
# Share Info (for peer share discovery)
# ---------------------------------------------------------------------------


class ShareInfoResponse(BaseModel):
    """GET /v1/signal/{id}/share_info — Return share coordinates for MPC.

    Requires validator-signed request authentication.
    """

    signal_id: str
    share_x: int


# ---------------------------------------------------------------------------
# OT Network Endpoints (distributed triple generation)
# ---------------------------------------------------------------------------


class OTSetupRequest(BaseModel):
    """POST /v1/mpc/ot/setup — Initialize distributed triple generation."""

    session_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    n_triples: int = Field(ge=1, le=20)
    x_coords: list[int] = Field(max_length=20)
    threshold: int = Field(default=7, ge=1, le=20)
    # Optional field prime for test configurations (default: BN254 prime)
    field_prime: str | None = Field(default=None, max_length=66)
    # Optional DH group prime for test configurations (default: RFC 3526 Group 14)
    dh_prime: str | None = Field(default=None, max_length=1024)

    @field_validator("x_coords")
    @classmethod
    def validate_x_coords(cls, v: list[int]) -> list[int]:
        for x in v:
            if x < 1 or x > 255:
                raise ValueError(f"x_coords values must be 1-255, got {x}")
        return v


class OTSetupResponse(BaseModel):
    session_id: str
    accepted: bool
    sender_public_keys: dict[str, str] = Field(default_factory=dict)  # {triple_idx: hex_pk}


class OTChoicesRequest(BaseModel):
    """POST /v1/mpc/ot/choices — Exchange OT choice commitments."""

    session_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    peer_sender_pks: dict[str, str] = Field(default_factory=dict)  # {triple_idx: hex_pk}
    # Choices are sent in a compact binary format: base64 of concatenated T_k values
    choices: dict[str, list[str]] = Field(default_factory=dict)  # {triple_idx: [hex_Tk]}


class OTChoicesResponse(BaseModel):
    session_id: str
    choices: dict[str, list[str]] = Field(default_factory=dict)  # {triple_idx: [hex_Tk]}


class OTTransfersRequest(BaseModel):
    """POST /v1/mpc/ot/transfers — Exchange encrypted OT messages."""

    session_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    # Peer's choices for this party's sender instances
    peer_choices: dict[str, list[str]] = Field(default_factory=dict)  # {triple_idx: [hex_Tk]}


class OTTransfersResponse(BaseModel):
    session_id: str
    # Encrypted pairs: {triple_idx: [[hex_E0, hex_E1], ...]}
    transfers: dict[str, list[list[str]]] = Field(default_factory=dict)
    # Sender shares accumulated (hex-encoded): {triple_idx: hex}
    sender_shares: dict[str, str] = Field(default_factory=dict)


class OTCompleteRequest(BaseModel):
    """POST /v1/mpc/ot/complete — Finalize OT and compute Shamir evaluations."""

    session_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    # Encrypted transfers from the peer's sender instances
    peer_transfers: dict[str, list[list[str]]] = Field(default_factory=dict)
    # Sender shares from this party's sender instances (hex-encoded)
    own_sender_shares: dict[str, str] = Field(default_factory=dict)


class OTCompleteResponse(BaseModel):
    session_id: str
    completed: bool


class OTSharesRequest(BaseModel):
    """GET /v1/mpc/ot/shares — Fetch Shamir evaluations for a party."""

    session_id: str = Field(max_length=256, pattern=r"^[a-zA-Z0-9_\-]+$")
    party_x: int = Field(ge=1, le=255)


class OTSharesResponse(BaseModel):
    session_id: str
    # Partial triple shares: [{a: hex, b: hex, c: hex}, ...]
    triple_shares: list[dict[str, str]] = Field(default_factory=list)


# ------------------------------------------------------------------
# Web Attestation (whitepaper §15 — pure Bittensor, no Base chain)
# ------------------------------------------------------------------


_REQUEST_ID_RE = re.compile(r"^[a-zA-Z0-9_\-.:]{1,256}$")
class AttestRequest(BaseModel):
    """POST /v1/attest — Request TLSNotary attestation of a web page."""

    url: str = Field(max_length=2048, description="HTTPS URL to attest")
    request_id: str = Field(max_length=256, description="Unique request ID for tracking")

    @field_validator("url")
    @classmethod
    def validate_https(cls, v: str) -> str:
        if not v.startswith("https://"):
            raise ValueError("URL must use HTTPS")
        from urllib.parse import urlparse
        import ipaddress
        import socket

        parsed = urlparse(v)
        if not parsed.hostname:
            raise ValueError("URL must have a valid hostname")
        hostname = parsed.hostname.lower()
        # Block localhost by name
        if hostname in ("localhost", "ip6-localhost", "ip6-loopback"):
            raise ValueError("URL must not point to private/internal addresses")
        # Check if hostname is an IP literal and block non-global addresses
        try:
            addr = ipaddress.ip_address(hostname)
        except ValueError:
            # Domain name — resolve to IP and check for private/internal addresses
            try:
                resolved = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
                for family, _, _, _, sockaddr in resolved:
                    ip_str = sockaddr[0]
                    addr = ipaddress.ip_address(ip_str)
                    if not addr.is_global:
                        raise ValueError("URL must not point to private/internal addresses")
            except socket.gaierror:
                pass  # DNS resolution failed — will fail at request time anyway
        else:
            if not addr.is_global:
                raise ValueError("URL must not point to private/internal addresses")
        return v

    @field_validator("request_id")
    @classmethod
    def validate_request_id(cls, v: str) -> str:
        if not _REQUEST_ID_RE.match(v):
            raise ValueError("request_id must be 1-256 alphanumeric chars, hyphens, underscores, dots, or colons")
        return v



class AttestResponse(BaseModel):
    """Response from web attestation proof generation and verification."""

    request_id: str
    url: str
    success: bool
    verified: bool = False
    proof_hex: str | None = Field(default=None, description="TLSNotary presentation bytes (hex)")
    response_body: str | None = Field(default=None, description="HTTP response body extracted from the verified proof")
    server_name: str | None = None
    timestamp: int = Field(default=0, description="Unix timestamp of attestation")
    error: str | None = None
    busy: bool = False
    retry_after: int | None = Field(default=None, description="Seconds to wait before retrying")
