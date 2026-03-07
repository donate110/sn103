"""Prometheus metrics for the Djinn validator.

Exposes key operational metrics via a /metrics endpoint.
"""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram, generate_latest

# --- Request metrics ---
REQUEST_COUNT = Counter(
    "djinn_validator_requests_total",
    "Total HTTP requests",
    ["method", "endpoint", "status"],
)

REQUEST_LATENCY = Histogram(
    "djinn_validator_request_latency_seconds",
    "Request latency in seconds",
    ["endpoint"],
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

# --- Business metrics ---
SHARES_STORED = Counter(
    "djinn_validator_shares_stored_total",
    "Total key shares stored",
)

PURCHASES_PROCESSED = Counter(
    "djinn_validator_purchases_processed_total",
    "Total signal purchases processed",
    ["result"],  # available, unavailable, error
)

MPC_SESSIONS = Counter(
    "djinn_validator_mpc_sessions_total",
    "Total MPC sessions initiated",
    ["mode"],  # single_validator, distributed
)

MPC_DURATION = Histogram(
    "djinn_validator_mpc_duration_seconds",
    "End-to-end MPC availability check duration",
    ["mode"],  # single_validator, distributed
    buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 15.0, 30.0),
)

MPC_ERRORS = Counter(
    "djinn_validator_mpc_errors_total",
    "MPC errors by reason",
    ["reason"],  # timeout, network, mac_failure, ot_setup_failure, insufficient_peers
)

RPC_FAILOVERS = Counter(
    "djinn_validator_rpc_failovers_total",
    "RPC endpoint failover events",
)

CIRCUIT_BREAKER_STATE = Gauge(
    "djinn_validator_circuit_breaker_open",
    "Whether a circuit breaker is open (1) or closed (0)",
    ["target"],  # rpc, peer_{uid}
)

OUTCOMES_ATTESTED = Counter(
    "djinn_validator_outcomes_attested_total",
    "Total outcomes attested",
    ["outcome"],  # favorable, unfavorable, void
)

# --- State metrics ---
ACTIVE_SHARES = Gauge(
    "djinn_validator_active_shares",
    "Number of key shares currently stored",
)

MPC_ACTIVE_SESSIONS = Gauge(
    "djinn_validator_mpc_active_sessions",
    "Number of active MPC sessions",
)

ATTESTATION_DISPATCHED = Counter(
    "djinn_validator_attestation_dispatched_total",
    "Total web attestation requests dispatched to miners",
)

ATTESTATION_VERIFIED = Counter(
    "djinn_validator_attestation_verified_total",
    "Total web attestation proofs verified",
    ["valid"],  # true, false
)

ATTESTATION_GATED = Counter(
    "djinn_validator_attestation_gated_total",
    "Attestation requests rejected by burn gate",
    ["reason"],  # invalid_tx, already_consumed, insufficient_amount
)

ATTESTATION_DURATION = Histogram(
    "djinn_validator_attestation_duration_seconds",
    "End-to-end attestation round-trip time",
    buckets=(1.0, 5.0, 10.0, 20.0, 30.0, 60.0, 120.0),
)

NOTARY_SESSIONS_ASSIGNED = Counter(
    "djinn_validator_notary_sessions_assigned_total",
    "External notary sessions assigned to miners",
    ["status"],  # ok, no_miners, auth_failed
)

RATE_LIMIT_REJECTIONS = Counter(
    "djinn_validator_rate_limit_rejections_total",
    "Total requests rejected by rate limiter",
)

UPTIME_SECONDS = Gauge(
    "djinn_validator_uptime_seconds",
    "Validator uptime in seconds",
)

BT_CONNECTED = Gauge(
    "djinn_validator_bt_connected",
    "Whether connected to Bittensor (1=yes, 0=no)",
)


def metrics_response() -> bytes:
    """Generate Prometheus-compatible metrics text."""
    return generate_latest()
