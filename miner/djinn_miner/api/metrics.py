"""Prometheus metrics for the Djinn miner."""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram, generate_latest

REQUEST_COUNT = Counter(
    "djinn_miner_requests_total",
    "Total HTTP requests",
    ["method", "endpoint", "status"],
)

REQUEST_LATENCY = Histogram(
    "djinn_miner_request_latency_seconds",
    "Request latency in seconds",
    ["endpoint"],
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

CHECKS_PROCESSED = Counter(
    "djinn_miner_checks_processed_total",
    "Total line availability checks processed",
)

LINES_CHECKED = Counter(
    "djinn_miner_lines_checked_total",
    "Total individual lines checked",
    ["result"],  # available, unavailable
)

PROOFS_GENERATED = Counter(
    "djinn_miner_proofs_generated_total",
    "Total proofs generated",
    ["type"],  # tlsnotary, http_attestation, basic
)

ODDS_API_QUERIES = Counter(
    "djinn_miner_odds_api_queries_total",
    "Total queries to The Odds API",
    ["status"],  # success, error, cached
)

CACHE_OPERATIONS = Counter(
    "djinn_miner_cache_operations_total",
    "Cache hit/miss operations",
    ["result"],  # hit, miss
)

RATE_LIMIT_REJECTIONS = Counter(
    "djinn_miner_rate_limit_rejections_total",
    "Total requests rejected by rate limiter",
)

UPTIME_SECONDS = Gauge(
    "djinn_miner_uptime_seconds",
    "Miner uptime in seconds",
)

BT_CONNECTED = Gauge(
    "djinn_miner_bt_connected",
    "Whether connected to Bittensor (1=yes, 0=no)",
)

CIRCUIT_BREAKER_STATE = Gauge(
    "djinn_miner_circuit_breaker_open",
    "Whether a circuit breaker is open (1) or closed (0)",
    ["target"],
)

ATTESTATION_REQUESTS = Counter(
    "djinn_miner_attestation_requests_total",
    "Total web attestation requests",
    ["status"],  # success, error
)

ATTESTATION_DURATION = Histogram(
    "djinn_miner_attestation_duration_seconds",
    "Time to generate TLSNotary attestation proof",
    buckets=(1.0, 5.0, 10.0, 20.0, 30.0, 45.0, 60.0),
)

CENTRALIZED_NOTARY_FALLBACKS = Counter(
    "djinn_miner_centralized_notary_fallbacks_total",
    "Times the miner fell back to the centralized notary.pse.dev instead of a peer notary",
)

NOTARY_ENABLED = Gauge(
    "djinn_miner_notary_enabled",
    "Whether the peer notary sidecar is running (1=yes, 0=no)",
)

NOTARY_SESSIONS = Counter(
    "djinn_miner_notary_sessions_total",
    "Total peer notary MPC sessions handled via WebSocket proxy",
    ["status"],  # connected, completed, error
)


def metrics_response() -> bytes:
    """Generate Prometheus-compatible metrics text."""
    return generate_latest()
