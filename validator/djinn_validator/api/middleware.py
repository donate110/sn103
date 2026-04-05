"""Security middleware for the validator API.

Provides:
- Request ID tracing (binds UUID to structlog contextvars)
- Token-bucket rate limiting per IP
- Bittensor hotkey signature verification for inter-validator endpoints
- CORS configuration helper
"""

from __future__ import annotations

import hashlib
import os
import re
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

import structlog
from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

log = structlog.get_logger()

# Regex patterns for normalizing dynamic path segments in Prometheus metrics
# Prevents unbounded cardinality from attacker-controlled path params
_PATH_NORMALIZERS = [
    (re.compile(r"/v1/signal/[^/]+"), "/v1/signal/{id}"),
    (re.compile(r"/v1/mpc/[^/]+/status"), "/v1/mpc/{id}/status"),
]


def _normalize_metric_path(path: str) -> str:
    """Replace dynamic path segments with placeholders to bound metric cardinality."""
    for pattern, replacement in _PATH_NORMALIZERS:
        path = pattern.sub(replacement, path)
    return path


# ---------------------------------------------------------------------------
# Request ID Tracing
# ---------------------------------------------------------------------------


from djinn_validator import __version__ as API_VERSION

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cache-Control": "no-store",
    "X-API-Version": API_VERSION,
}


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Assign a unique request ID, add security headers, and log every request.

    - Reads ``X-Request-ID`` from the incoming request (forwarded by a
      reverse-proxy) or generates a new UUID4.
    - Binds the ID to structlog contextvars so every log line emitted
      during the request includes ``request_id``.
    - Returns the ID in the ``X-Request-ID`` response header.
    - Adds standard security headers to every response.
    - Logs method, path, status code, and duration for every request.
    """

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        raw_id = request.headers.get("x-request-id") or ""
        request_id = re.sub(r"[\x00-\x1f\x7f]", "", raw_id)[:128] if raw_id else uuid.uuid4().hex
        structlog.contextvars.bind_contextvars(request_id=request_id)
        start = time.monotonic()
        try:
            response = await call_next(request)
            response.headers["X-Request-ID"] = request_id
            for header, value in _SECURITY_HEADERS.items():
                response.headers.setdefault(header, value)
            duration_s = time.monotonic() - start
            duration_ms = round(duration_s * 1000, 1)
            path = _normalize_metric_path(request.url.path)
            if path not in ("/health", "/health/ready", "/metrics"):
                from djinn_validator.api.metrics import REQUEST_COUNT, REQUEST_LATENCY

                REQUEST_COUNT.labels(
                    method=request.method,
                    endpoint=path,
                    status=response.status_code,
                ).inc()
                REQUEST_LATENCY.labels(endpoint=path).observe(duration_s)
                log.info(
                    "request",
                    method=request.method,
                    path=path,
                    status=response.status_code,
                    duration_ms=duration_ms,
                    client=request.client.host if request.client else "unknown",
                )
            return response
        finally:
            structlog.contextvars.unbind_contextvars("request_id")


# ---------------------------------------------------------------------------
# Rate Limiting
# ---------------------------------------------------------------------------


@dataclass
class TokenBucket:
    """Simple token-bucket rate limiter."""

    capacity: float
    refill_rate: float  # tokens per second
    tokens: float = 0.0
    last_refill: float = field(default_factory=time.monotonic)

    def __post_init__(self) -> None:
        self.tokens = self.capacity

    def consume(self, n: float = 1.0) -> bool:
        """Try to consume n tokens. Returns True if allowed."""
        now = time.monotonic()
        elapsed = now - self.last_refill
        self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_rate)
        self.last_refill = now

        if self.tokens >= n:
            self.tokens -= n
            return True
        return False


class RateLimiter:
    """Per-IP rate limiter with configurable limits per path prefix."""

    _MAX_BUCKETS = 10_000

    def __init__(
        self,
        default_capacity: float = 60,
        default_rate: float = 10,  # 10 req/sec
    ) -> None:
        self._default_capacity = default_capacity
        self._default_rate = default_rate
        self._path_limits: dict[str, tuple[float, float]] = {}
        self._buckets: dict[str, TokenBucket] = {}
        self._last_cleanup = time.monotonic()
        self._cleanup_interval = 300  # Clean stale buckets every 5 min

    def set_path_limit(self, prefix: str, capacity: float, rate: float) -> None:
        """Set custom rate limit for a path prefix."""
        self._path_limits[prefix] = (capacity, rate)

    def _get_bucket(self, key: str, path: str) -> TokenBucket:
        """Get or create a token bucket for this client+path."""
        bucket_key = f"{key}:{path}"
        if bucket_key not in self._buckets:
            capacity, rate = self._default_capacity, self._default_rate
            for prefix, (cap, r) in self._path_limits.items():
                if path.startswith(prefix):
                    capacity, rate = cap, r
                    break
            self._buckets[bucket_key] = TokenBucket(capacity=capacity, refill_rate=rate)
        return self._buckets[bucket_key]

    def allow(self, client_ip: str, path: str) -> bool:
        """Check if request is allowed."""
        self._maybe_cleanup()
        bucket = self._get_bucket(client_ip, path)
        return bucket.consume()

    def _maybe_cleanup(self) -> None:
        """Remove stale buckets periodically or when limit exceeded."""
        now = time.monotonic()
        force = len(self._buckets) > self._MAX_BUCKETS
        if not force and now - self._last_cleanup < self._cleanup_interval:
            return
        self._last_cleanup = now
        stale = [k for k, b in self._buckets.items() if now - b.last_refill > self._cleanup_interval]
        for k in stale:
            del self._buckets[k]
        if force and len(self._buckets) > self._MAX_BUCKETS:
            # Evict oldest until under limit
            while len(self._buckets) > self._MAX_BUCKETS and self._buckets:
                oldest = min(self._buckets, key=lambda k: self._buckets[k].last_refill)
                del self._buckets[oldest]
            log.warning("rate_limiter_bucket_overflow_evicted", count=len(self._buckets))


class RateLimitMiddleware(BaseHTTPMiddleware):
    """FastAPI middleware that applies rate limiting."""

    def __init__(self, app: object, limiter: RateLimiter) -> None:
        super().__init__(app)  # type: ignore[arg-type]
        self._limiter = limiter

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        client_ip = request.client.host if request.client else "unknown"
        path = request.url.path

        # Skip rate limiting for health checks and metrics
        if path in ("/health", "/health/ready", "/metrics"):
            return await call_next(request)

        if not self._limiter.allow(client_ip, path):
            from djinn_validator.api.metrics import RATE_LIMIT_REJECTIONS

            RATE_LIMIT_REJECTIONS.inc()
            log.warning("rate_limited", client_ip=client_ip, path=path)
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests"},
                headers={"Retry-After": "1"},
            )

        return await call_next(request)


# ---------------------------------------------------------------------------
# Signature Verification
# ---------------------------------------------------------------------------


def verify_hotkey_signature(
    message: bytes,
    signature: str,
    hotkey_ss58: str,
) -> bool:
    """Verify a Bittensor hotkey signature.

    In production, uses the sr25519 signature scheme via the bittensor SDK.
    Falls back to HMAC-SHA256 for testing when bittensor isn't available.
    """
    try:
        import bittensor as bt

        keypair = bt.Keypair(ss58_address=hotkey_ss58)
        return keypair.verify(message, bytes.fromhex(signature))
    except ImportError:
        # Bittensor not available — default deny. Only skip verification
        # when explicitly opted in via DEV_SKIP_SIG_VERIFY=1 on non-production networks.
        import os

        if os.getenv("DEV_SKIP_SIG_VERIFY") == "1":
            if os.getenv("BT_NETWORK", "") in ("finney", "mainnet"):
                log.error("dev_skip_sig_verify_blocked", reason="DEV_SKIP_SIG_VERIFY=1 is not allowed on production networks")
                return False
            log.warning("signature_verification_skipped", reason="bittensor not installed, DEV_SKIP_SIG_VERIFY=1")
            return True
        log.error(
            "signature_verification_impossible",
            reason="bittensor not installed — set DEV_SKIP_SIG_VERIFY=1 to bypass in local dev",
        )
        return False
    except Exception as e:
        log.warning("signature_verification_failed", error=str(e))
        return False


# Nonce deduplication to prevent replay attacks (bounded, auto-evicting)
_NONCE_CACHE: dict[str, float] = {}
_NONCE_CACHE_MAX = 10_000
_NONCE_TTL = 120  # 2x the timestamp window
_NONCE_LAST_CLEANUP = 0.0
_NONCE_CLEANUP_INTERVAL = 60.0  # Evict stale nonces at most once per minute
_nonce_lock = threading.Lock()


def _check_nonce(nonce: str) -> bool:
    """Return True if nonce is fresh (not seen before), False if replayed."""
    global _NONCE_LAST_CLEANUP
    with _nonce_lock:
        now = time.time()
        # Evict stale nonces periodically (every 60s) or when cache overflows
        if now - _NONCE_LAST_CLEANUP > _NONCE_CLEANUP_INTERVAL or len(_NONCE_CACHE) > _NONCE_CACHE_MAX:
            stale = [k for k, ts in _NONCE_CACHE.items() if now - ts > _NONCE_TTL]
            for k in stale:
                del _NONCE_CACHE[k]
            _NONCE_LAST_CLEANUP = now
        if nonce in _NONCE_CACHE:
            return False
        # After cleanup, if cache is still at capacity, reject to prevent
        # unbounded growth (possible under sustained high-rate traffic).
        if len(_NONCE_CACHE) >= _NONCE_CACHE_MAX:
            return False
        _NONCE_CACHE[nonce] = now
        return True


def create_signature_message(
    endpoint: str,
    body_hash: str,
    timestamp: int,
    nonce: str,
) -> bytes:
    """Create the canonical message to sign for API requests.

    Format: "{endpoint}:{body_sha256}:{timestamp}:{nonce}"
    """
    return f"{endpoint}:{body_hash}:{timestamp}:{nonce}".encode()


async def validate_signed_request(
    request: Request,
    allowed_hotkeys: set[str] | None = None,
) -> str | None:
    """Validate a signed API request.

    Expects headers:
    - X-Hotkey: ss58 address of the signer
    - X-Signature: hex-encoded signature
    - X-Timestamp: unix timestamp (must be within 60s of now)
    - X-Nonce: random nonce to prevent replay

    Returns the verified hotkey ss58 address, or None if validation fails.
    Raises HTTPException on auth failure.
    """
    hotkey = request.headers.get("X-Hotkey")
    signature = request.headers.get("X-Signature")
    timestamp_str = request.headers.get("X-Timestamp")
    nonce = request.headers.get("X-Nonce")

    # Reject unauthenticated requests. Even when the metagraph is unavailable
    # (allowed_hotkeys=None), we still require valid signatures to prevent
    # unauthenticated access to MPC endpoints during connectivity outages.
    if not hotkey and not signature:
        if allowed_hotkeys is not None or os.getenv("BT_NETWORK", "test") != "test":
            raise HTTPException(
                status_code=401,
                detail="Authentication required (missing X-Hotkey header)",
            )
        # Only skip auth in explicit test mode with no metagraph
        return None

    if not all([hotkey, signature, timestamp_str, nonce]):
        raise HTTPException(
            status_code=401,
            detail="Missing authentication headers (X-Hotkey, X-Signature, X-Timestamp, X-Nonce)",
        )

    # Check timestamp freshness (60-second window)
    try:
        timestamp = int(timestamp_str)  # type: ignore[arg-type]
    except (ValueError, TypeError):
        raise HTTPException(status_code=401, detail="Invalid timestamp")

    now = int(time.time())
    if abs(now - timestamp) > 60:
        raise HTTPException(status_code=401, detail="Request timestamp too old")

    # Prevent replay attacks
    if not _check_nonce(nonce):  # type: ignore[arg-type]
        raise HTTPException(status_code=401, detail="Nonce already used")

    # Check hotkey allowlist
    if allowed_hotkeys and hotkey not in allowed_hotkeys:
        raise HTTPException(status_code=403, detail="Hotkey not authorized")

    # Read and hash the body
    body = await request.body()
    body_hash = hashlib.sha256(body).hexdigest()

    # Verify signature
    message = create_signature_message(
        request.url.path,
        body_hash,
        timestamp,
        nonce,  # type: ignore[arg-type]
    )
    if not verify_hotkey_signature(message, signature, hotkey):  # type: ignore[arg-type]
        raise HTTPException(status_code=401, detail="Invalid signature")

    return hotkey


def create_signed_headers(
    endpoint: str,
    body: bytes,
    wallet: object,
) -> dict[str, str]:
    """Create signed authentication headers for outbound requests to miners.

    Uses the validator's hotkey to sign the request so miners can verify
    the caller is a registered validator.

    Args:
        endpoint: The URL path (e.g. "/v1/check")
        body: The raw request body bytes
        wallet: A bittensor Wallet object with a hotkey keypair

    Returns:
        Dict of headers: X-Hotkey, X-Signature, X-Timestamp, X-Nonce
    """
    import uuid

    timestamp = int(time.time())
    nonce = uuid.uuid4().hex
    body_hash = hashlib.sha256(body).hexdigest()
    message = create_signature_message(endpoint, body_hash, timestamp, nonce)

    hotkey_ss58 = wallet.hotkey.ss58_address
    signature = wallet.hotkey.sign(message).hex()

    return {
        "X-Hotkey": hotkey_ss58,
        "X-Signature": signature,
        "X-Timestamp": str(timestamp),
        "X-Nonce": nonce,
    }


def require_admin_auth(admin_api_key: str) -> Callable:
    """Create a FastAPI dependency that checks Bearer token auth for admin endpoints.

    If admin_api_key is empty on a production network, admin endpoints are blocked.
    On dev/test networks without a key, endpoints remain open for convenience.
    """
    from fastapi import Depends, Header
    import os

    if not admin_api_key:
        bt_network = os.getenv("BT_NETWORK", "").lower()
        if bt_network in ("finney", "mainnet"):
            log.warning("admin_auth_blocked", msg="ADMIN_API_KEY not set on production network; admin endpoints will return 403")
            async def _deny() -> None:
                raise HTTPException(status_code=403, detail="Admin endpoints disabled (ADMIN_API_KEY not configured)")
            return Depends(_deny)
        async def _noop() -> None:
            return None
        return Depends(_noop)

    async def _check_admin_token(authorization: str = Header(default="")) -> None:
        if not authorization:
            raise HTTPException(status_code=401, detail="Admin API key required")
        parts = authorization.split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            raise HTTPException(status_code=401, detail="Expected 'Bearer <token>' format")
        import hmac
        if not hmac.compare_digest(parts[1], admin_api_key):
            raise HTTPException(status_code=403, detail="Invalid admin API key")

    return Depends(_check_admin_token)


def create_notary_ticket(
    prover_uid: int,
    notary_uid: int,
    wallet: object,
    ttl_seconds: int = 300,
) -> str:
    """Create a signed notary ticket authorizing a prover to connect to a peer notary.

    The ticket is a base64-encoded JSON payload signed by the validator's hotkey.
    Miners present this ticket when connecting to /v1/notary/ws so the notary
    can verify the connection was authorized by a validator.

    Args:
        prover_uid: UID of the miner that will generate the proof (the prover).
        notary_uid: UID of the miner serving as peer notary.
        wallet: Bittensor Wallet with hotkey keypair.
        ttl_seconds: Ticket validity window (default 5 minutes).

    Returns:
        Base64-encoded ticket string containing JSON payload + validator signature.
    """
    import base64
    import json
    import uuid

    nonce = uuid.uuid4().hex
    expires = int(time.time()) + ttl_seconds

    payload = {
        "prover_uid": prover_uid,
        "notary_uid": notary_uid,
        "expires": expires,
        "nonce": nonce,
        "validator": wallet.hotkey.ss58_address,
    }
    payload_bytes = json.dumps(payload, sort_keys=True).encode()
    signature = wallet.hotkey.sign(payload_bytes).hex()

    ticket = {
        "payload": payload,
        "signature": signature,
    }
    return base64.b64encode(json.dumps(ticket).encode()).decode()


def verify_notary_ticket(
    ticket_b64: str,
    expected_notary_uid: int | None = None,
    validator_hotkeys: set[str] | None = None,
) -> tuple[bool, str, dict]:
    """Verify a notary ticket signed by a validator.

    Args:
        ticket_b64: Base64-encoded ticket string.
        expected_notary_uid: If set, verify the ticket is for this notary.
        validator_hotkeys: If set, verify the signer is in this set.

    Returns:
        (valid, error_message, payload_dict)
    """
    import base64
    import json

    try:
        ticket_json = base64.b64decode(ticket_b64)
        ticket = json.loads(ticket_json)
    except Exception:
        return False, "malformed ticket", {}

    payload = ticket.get("payload")
    signature = ticket.get("signature")
    if not payload or not signature:
        return False, "missing payload or signature", {}

    # Check expiry
    expires = payload.get("expires", 0)
    if int(time.time()) > expires:
        return False, "ticket expired", payload

    # Verify validator hotkey is allowed
    validator_ss58 = payload.get("validator", "")
    if validator_hotkeys and validator_ss58 not in validator_hotkeys:
        return False, "validator not authorized", payload

    # Verify notary UID matches
    if expected_notary_uid is not None and payload.get("notary_uid") != expected_notary_uid:
        return False, "notary_uid mismatch", payload

    # Verify signature
    payload_bytes = json.dumps(payload, sort_keys=True).encode()
    if not verify_hotkey_signature(payload_bytes, signature, validator_ss58):
        return False, "invalid signature", payload

    return True, "", payload


def get_cors_origins(env_value: str = "", bt_network: str = "") -> list[str]:
    """Parse CORS origins from environment variable.

    Returns ["*"] in dev mode (empty env). In production (finney/mainnet),
    raises ValueError if CORS_ORIGINS is not set.
    """
    if not env_value:
        if bt_network in ("finney", "mainnet"):
            raise ValueError(
                "CORS_ORIGINS must be set when BT_NETWORK is production. "
                "Set CORS_ORIGINS to a comma-separated list of allowed origins."
            )
        log.warning("cors_wildcard", msg="CORS_ORIGINS not set — using wildcard. Set CORS_ORIGINS in production.")
        return ["*"]
    origins = [o.strip() for o in env_value.split(",") if o.strip()]
    if bt_network in ("finney", "mainnet") and "*" in origins:
        raise ValueError("Wildcard CORS origin ('*') is not allowed in production")
    return origins
