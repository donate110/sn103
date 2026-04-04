"""Pydantic request/response models for the miner REST API."""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

_VALID_MARKETS = {"spreads", "totals", "h2h"}


class CandidateLine(BaseModel):
    """A single candidate line from the 10-line set sent by validators.

    Each line represents a specific bet at a specific event. The miner
    checks if this exact line (within tolerance) is available at any sportsbook.
    """

    index: int = Field(ge=1, le=10, description="Line index (1-10)")
    sport: str = Field(max_length=128, description="Sport key, e.g. 'basketball_nba'")
    event_id: str = Field(max_length=256, description="Unique event identifier")
    home_team: str = Field(max_length=256, description="Home team name")
    away_team: str = Field(max_length=256, description="Away team name")
    market: str = Field(max_length=64, description="Market type: 'spreads', 'totals', or 'h2h'")
    line: float | None = Field(
        default=None,
        description="Line value (e.g. -3.0 for spreads, 218.5 for totals). None for h2h.",
    )
    side: str = Field(
        max_length=256,
        description="Which side: team name for spreads/h2h, 'Over'/'Under' for totals",
    )

    @field_validator("market")
    @classmethod
    def validate_market(cls, v: str) -> str:
        # Accept any market string. Validators send synthetic markets
        # (e.g., "player_prop") as part of challenge scoring. Rejecting
        # them causes 422 and 0% accuracy. The miner should report
        # unknown markets as unavailable, not refuse the request.
        return v


class CheckRequest(BaseModel):
    """POST /v1/check — Receive 10 candidate lines, return availability."""

    lines: list[CandidateLine] = Field(
        min_length=1,
        max_length=10,
        description="Up to 10 candidate lines to check",
    )


class BookmakerAvailability(BaseModel):
    """Availability of a single line at a specific bookmaker."""

    bookmaker: str
    odds: float = Field(description="Decimal odds offered")


class LineResult(BaseModel):
    """Result for a single candidate line."""

    index: int = Field(ge=1, le=10)
    available: bool
    bookmakers: list[BookmakerAvailability] = Field(default_factory=list, max_length=50)
    unavailable_reason: str | None = Field(
        default=None,
        max_length=128,
        description="Why the line is unavailable: 'game_started', 'line_moved', "
        "'market_unavailable', 'no_data'. Null when available=True.",
    )


class CheckResponse(BaseModel):
    """Response to a line availability check."""

    results: list[LineResult]
    available_indices: list[int] = Field(
        description="Indices of lines that are available at 1+ sportsbooks",
    )
    response_time_ms: float = Field(description="Time taken to process the request in ms")
    query_id: str | None = Field(
        default=None,
        max_length=256,
        description="Opaque ID for requesting a TLSNotary proof of this check via /v1/proof",
    )
    api_error: str | None = Field(
        default=None,
        max_length=512,
        description="Set when the upstream odds data source returned an error (e.g. 401, 500). "
        "Distinguishes 'lines not found' from 'data source is broken'.",
    )


class ProofRequest(BaseModel):
    """POST /v1/proof — Request proof generation for a previous check query."""

    query_id: str = Field(max_length=256, description="ID of the original check query")
    session_data: str = Field(default="", max_length=10_000, description="Optional session data for fallback proof")
    notary_host: str | None = Field(default=None, description="Peer notary IP for TLSNotary proof")
    notary_port: int | None = Field(default=None, description="Peer notary TCP port (direct connection)")
    notary_ws: bool = Field(default=False, description="Legacy WS flag; direct TCP tried first")
    notary_ws_port: int | None = Field(default=None, description="API port for WS bridge fallback")
    notary_ticket: str | None = Field(default=None, description="Validator-signed ticket authorizing peer notary connection")


class ProofResponse(BaseModel):
    """Response from proof submission."""

    query_id: str
    proof_hash: str = Field(description="Hash of the generated proof")
    status: str = Field(description="'submitted', 'verified', 'failed'")
    message: str = ""


class MinerCapabilities(BaseModel):
    """System resource advertisement for capability-aware scheduling."""

    memory_total_mb: int = 0
    memory_available_mb: int = 0
    cpu_cores: int = 0
    cpu_load_1m: float = 0.0
    tlsn_max_concurrent: int = 0
    tlsn_active_sessions: int = 0
    notary_max_concurrent: int = 0
    notary_active_sessions: int = 0
    disk_free_gb: float = 0.0


class ProactiveProof(BaseModel):
    """Cached proactive attestation proof for capability verification."""

    url: str = ""
    server_name: str = ""
    notary_pubkey: str = ""
    proof_hex: str = ""
    proof_age_s: float = 0.0
    date_header: str = ""
    binary_hash: str = ""  # SHA256 prefix of the TLSNotary binary (for version matching)


class HealthResponse(BaseModel):
    """GET /health — Miner health check."""

    status: str
    version: str = ""  # Overridden by HealthTracker at runtime
    uid: int | None = None
    odds_api_connected: bool = False
    bt_connected: bool = False
    uptime_seconds: float = 0.0
    capabilities: MinerCapabilities | None = None
    proactive_proof: ProactiveProof | None = None
    tunnel_url: str | None = None
    notary_tunnel_url: str | None = None
    shield_installed: bool = False


class ReadinessResponse(BaseModel):
    """GET /health/ready — Deep readiness probe."""

    ready: bool
    checks: dict[str, bool] = Field(default_factory=dict)


class NotaryInfoResponse(BaseModel):
    """GET /v1/notary/info — Notary sidecar status for peer discovery."""

    enabled: bool = Field(description="Whether this miner is running a notary sidecar")
    pubkey_hex: str = Field(default="", description="secp256k1 public key (hex) of the notary")
    port: int = Field(default=0, description="TCP port the notary listens on")


class AttestRequest(BaseModel):
    """POST /v1/attest — Request TLSNotary attestation of a web page."""

    url: str = Field(max_length=2048, description="HTTPS URL to attest")
    request_id: str = Field(max_length=256, description="Unique request ID for tracking")
    notary_host: str | None = Field(
        default=None, max_length=256,
        description="Peer notary hostname (assigned by validator). Uses default if omitted.",
    )
    notary_port: int | None = Field(
        default=None, ge=1, le=65535,
        description="Peer notary TCP port (direct connection). Uses default if omitted.",
    )
    notary_ws: bool = Field(
        default=False,
        description="Legacy: if True and direct TCP fails, use WS bridge on notary_port.",
    )
    notary_ws_port: int | None = Field(
        default=None, ge=1, le=65535,
        description="API port for WebSocket bridge fallback (ws://host:port/v1/notary/ws).",
    )
    notary_ticket: str | None = Field(
        default=None, max_length=4096,
        description="Validator-signed ticket authorizing peer notary connection.",
    )

    @field_validator("url")
    @classmethod
    def validate_https(cls, v: str) -> str:
        if not v.startswith("https://"):
            raise ValueError("URL must use HTTPS")
        import ipaddress
        import socket
        from urllib.parse import urlparse

        parsed = urlparse(v)
        if not parsed.hostname:
            raise ValueError("URL must have a valid hostname")
        hostname = parsed.hostname.lower()
        # Block well-known internal hostnames. Note: DNS rebinding can still
        # bypass the is_global check below because DNS may resolve differently
        # between validation time and the prover binary's connection. The full
        # fix requires passing the resolved IP to the Rust binary.
        _BLOCKED_HOSTS = {
            "localhost", "ip6-localhost", "ip6-loopback", "0.0.0.0", "[::]",
            "metadata.google.internal",
            "metadata.google.internal.",
            "169.254.169.254",
            "metadata",
            "metadata.internal",
        }
        if hostname in _BLOCKED_HOSTS:
            raise ValueError("URL must not point to private/internal addresses")

        # Check IP literal directly
        try:
            addr = ipaddress.ip_address(hostname)
        except ValueError:
            # Domain name — resolve to IP and check
            try:
                resolved = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
                for family, _, _, _, sockaddr in resolved:
                    ip_str = sockaddr[0]
                    addr = ipaddress.ip_address(ip_str)
                    if not addr.is_global:
                        raise ValueError("URL must not point to private/internal addresses")
            except socket.gaierror:
                raise ValueError("URL hostname could not be resolved")
        else:
            if not addr.is_global:
                raise ValueError("URL must not point to private/internal addresses")
        return v


class AttestResponse(BaseModel):
    """Response from web attestation proof generation."""

    request_id: str
    url: str
    success: bool
    proof_hex: str | None = Field(default=None, description="TLSNotary presentation bytes (hex-encoded)")
    server_name: str | None = Field(default=None, description="TLS server identity")
    timestamp: int = Field(description="Unix timestamp of attestation")
    error: str | None = None
    busy: bool = False
    retry_after: int | None = Field(default=None, description="Seconds to wait before retrying")
