"""Rate limiting, request tracing, and validator auth middleware for the miner API."""

from __future__ import annotations

import hashlib
import re
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import structlog
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

if TYPE_CHECKING:
    from djinn_miner.bt.neuron import DjinnMiner

log = structlog.get_logger()

# Regex patterns for normalizing dynamic path segments in Prometheus metrics
_PATH_NORMALIZERS = [
    (re.compile(r"/v1/signal/[^/]+"), "/v1/signal/{id}"),
]


def _normalize_metric_path(path: str) -> str:
    """Replace dynamic path segments with placeholders to bound metric cardinality."""
    for pattern, replacement in _PATH_NORMALIZERS:
        path = pattern.sub(replacement, path)
    return path


# ---------------------------------------------------------------------------
# Request ID Tracing
# ---------------------------------------------------------------------------


from djinn_miner import __version__ as API_VERSION

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

    - Reads ``X-Request-ID`` from the incoming request or generates a UUID4.
    - Binds the ID to structlog contextvars so all log lines include ``request_id``.
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
                from djinn_miner.api.metrics import REQUEST_COUNT, REQUEST_LATENCY

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


@dataclass
class TokenBucket:
    """Simple token-bucket rate limiter."""

    capacity: float
    refill_rate: float
    tokens: float = 0.0
    last_refill: float = field(default_factory=time.monotonic)

    def __post_init__(self) -> None:
        self.tokens = self.capacity

    def consume(self, n: float = 1.0) -> bool:
        now = time.monotonic()
        elapsed = now - self.last_refill
        self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_rate)
        self.last_refill = now
        if self.tokens >= n:
            self.tokens -= n
            return True
        return False


class RateLimiter:
    """Per-IP rate limiter with stale bucket cleanup."""

    _MAX_BUCKETS = 10_000
    _CLEANUP_INTERVAL = 300  # seconds

    def __init__(self, capacity: float = 30, rate: float = 5) -> None:
        self._capacity = capacity
        self._rate = rate
        self._buckets: dict[str, TokenBucket] = {}
        self._last_cleanup = time.monotonic()

    def allow(self, client_ip: str) -> bool:
        self._maybe_cleanup()
        if client_ip not in self._buckets:
            if len(self._buckets) >= self._MAX_BUCKETS:
                self._evict_oldest()
            self._buckets[client_ip] = TokenBucket(
                capacity=self._capacity,
                refill_rate=self._rate,
            )
        return self._buckets[client_ip].consume()

    def _maybe_cleanup(self) -> None:
        now = time.monotonic()
        if now - self._last_cleanup < self._CLEANUP_INTERVAL:
            return
        self._last_cleanup = now
        stale = [k for k, b in self._buckets.items() if now - b.last_refill > self._CLEANUP_INTERVAL]
        for k in stale:
            del self._buckets[k]

    def _evict_oldest(self) -> None:
        if not self._buckets:
            return
        oldest_key = min(self._buckets, key=lambda k: self._buckets[k].last_refill)
        del self._buckets[oldest_key]


class RateLimitMiddleware(BaseHTTPMiddleware):
    """FastAPI middleware that applies rate limiting."""

    def __init__(self, app: object, limiter: RateLimiter) -> None:
        super().__init__(app)  # type: ignore[arg-type]
        self._limiter = limiter

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        client_ip = request.client.host if request.client else "unknown"

        if request.url.path in ("/health", "/health/ready", "/metrics"):
            return await call_next(request)

        if not self._limiter.allow(client_ip):
            from djinn_miner.api.metrics import RATE_LIMIT_REJECTIONS

            RATE_LIMIT_REJECTIONS.inc()
            log.warning("rate_limited", client_ip=client_ip, path=request.url.path)
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests"},
                headers={"Retry-After": "1"},
            )

        return await call_next(request)


def require_admin_auth(admin_api_key: str) -> object:
    """Create a FastAPI dependency that checks Bearer token auth for admin endpoints.

    If admin_api_key is empty, returns a no-op dependency (endpoints remain open).
    """
    from fastapi import Depends, Header, HTTPException

    if not admin_api_key:
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


# ---------------------------------------------------------------------------
# Validator Hotkey Authentication
# ---------------------------------------------------------------------------

# Paths that require validator authentication
_PROTECTED_PATHS = {"/v1/check", "/v1/proof", "/v1/attest"}


def verify_hotkey_signature(
    message: bytes,
    signature: str,
    hotkey_ss58: str,
) -> bool:
    """Verify a Bittensor hotkey sr25519 signature."""
    try:
        import bittensor as bt

        keypair = bt.Keypair(ss58_address=hotkey_ss58)
        return keypair.verify(message, bytes.fromhex(signature))
    except ImportError:
        log.error("signature_verification_impossible", reason="bittensor not installed")
        return False
    except Exception as e:
        log.warning("signature_verification_failed", error=str(e))
        return False


def create_signature_message(
    endpoint: str,
    body_hash: str,
    timestamp: int,
    nonce: str,
) -> bytes:
    """Create the canonical message for signed API requests.

    Format: "{endpoint}:{body_sha256}:{timestamp}:{nonce}"
    Must match the validator's signing format exactly.
    """
    return f"{endpoint}:{body_hash}:{timestamp}:{nonce}".encode()


# Nonce deduplication to prevent replay attacks
_NONCE_CACHE: dict[str, float] = {}
_NONCE_CACHE_MAX = 10_000
_NONCE_TTL = 120  # 2x the timestamp window (60s)
_NONCE_LAST_CLEANUP = 0.0
_NONCE_CLEANUP_INTERVAL = 60.0
_nonce_lock = threading.Lock()


def _check_nonce(nonce: str) -> bool:
    """Return True if nonce is fresh (not seen before), False if replayed."""
    global _NONCE_LAST_CLEANUP
    with _nonce_lock:
        now = time.time()
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


def _get_validator_hotkeys(neuron: Any) -> set[str] | None:
    """Get set of validator hotkeys from miner's metagraph.

    Returns None if metagraph is unavailable (disables auth in dev mode).
    """
    if neuron is None or neuron.metagraph is None:
        return None
    hotkeys: set[str] = set()
    try:
        n = neuron.metagraph.n
        if hasattr(n, "item"):
            n = n.item()
        for uid in range(int(n)):
            permit = neuron.metagraph.validator_permit[uid]
            if hasattr(permit, "item"):
                permit = permit.item()
            if permit:
                hotkeys.add(neuron.metagraph.hotkeys[uid])
    except Exception as e:
        log.warning("get_validator_hotkeys_error", error=str(e))
        return None
    return hotkeys if hotkeys else None


def _get_registered_ips(neuron: Any) -> set[str] | None:
    """Get set of validator IPs from the metagraph.

    Only includes neurons with validator_permit=True. Miners are excluded
    to prevent any registered miner from calling protected endpoints on
    other miners (draining Odds API credits, consuming TLSNotary capacity).

    Returns None if metagraph is unavailable (disables auth in dev mode).
    """
    if neuron is None or neuron.metagraph is None:
        return None
    ips: set[str] = set()
    try:
        n = neuron.metagraph.n
        if hasattr(n, "item"):
            n = n.item()
        for uid in range(int(n)):
            permit = neuron.metagraph.validator_permit[uid]
            if hasattr(permit, "item"):
                permit = permit.item()
            if not permit:
                continue
            axon = neuron.metagraph.axons[uid]
            ip = getattr(axon, "ip", "")
            if ip and ip != "0.0.0.0":
                ips.add(ip)
    except Exception as e:
        log.warning("get_registered_ips_error", error=str(e))
        return None
    return ips if ips else None


class ValidatorAuthMiddleware(BaseHTTPMiddleware):
    """Verify that requests to protected endpoints come from registered validators.

    Enabled by setting REQUIRE_VALIDATOR_AUTH=true in the environment.
    Defaults to off so miners can opt in without breaking existing setups.

    Two auth modes (either passes):
    1. IP-based: caller IP matches any registered neuron's axon IP in the metagraph
    2. Signature-based: X-Hotkey/X-Signature headers with sr25519 sig from a validator

    IP-based auth allows existing validators to work without code changes.
    Signature-based auth is stronger (IP can be spoofed) and is used by
    validators that adopt the signed request protocol.
    """

    def __init__(self, app: object, neuron: Any = None) -> None:
        super().__init__(app)  # type: ignore[arg-type]
        self._neuron = neuron
        import os
        env_val = os.getenv("REQUIRE_VALIDATOR_AUTH", "").lower()
        bt_network = os.getenv("BT_NETWORK", "").lower()
        if env_val in ("1", "true", "yes"):
            self._enabled = True
        elif env_val in ("0", "false", "no"):
            self._enabled = False
            if bt_network in ("finney", "mainnet"):
                log.warning("validator_auth_disabled_production", msg="REQUIRE_VALIDATOR_AUTH=false on production network — miners are exposed to unauthenticated queries")
        else:
            # Not explicitly set — default to on for production
            self._enabled = bt_network in ("finney", "mainnet")
            if self._enabled:
                log.info("validator_auth_auto_enabled", msg="REQUIRE_VALIDATOR_AUTH defaulting to true on production network")

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        path = request.url.path

        if path not in _PROTECTED_PATHS:
            return await call_next(request)

        if not self._enabled:
            return await call_next(request)

        # In dev mode (no metagraph), skip auth
        registered_ips = _get_registered_ips(self._neuron)
        if registered_ips is None:
            return await call_next(request)

        client_ip = request.client.host if request.client else "unknown"

        # Auth mode 1: IP-based — caller IP matches any registered neuron on the subnet
        if client_ip in registered_ips:
            log.debug("auth_ok_ip", client=client_ip, path=path)
            return await call_next(request)

        # Auth mode 2: Signature-based — signed headers from a validator hotkey
        hotkey = request.headers.get("X-Hotkey")
        signature = request.headers.get("X-Signature")
        timestamp_str = request.headers.get("X-Timestamp")
        nonce = request.headers.get("X-Nonce")

        if hotkey and signature and timestamp_str and nonce:
            allowed_hotkeys = _get_validator_hotkeys(self._neuron)
            if allowed_hotkeys is not None:
                # Check timestamp freshness (60-second window)
                try:
                    timestamp = int(timestamp_str)
                except (ValueError, TypeError):
                    return JSONResponse(status_code=401, content={"detail": "Invalid timestamp"})

                now = int(time.time())
                if abs(now - timestamp) > 60:
                    log.warning("auth_stale_timestamp", hotkey=hotkey, drift=abs(now - timestamp))
                    return JSONResponse(status_code=401, content={"detail": "Request timestamp too old"})

                if not _check_nonce(nonce):
                    log.warning("auth_replay", hotkey=hotkey, nonce=nonce)
                    return JSONResponse(status_code=401, content={"detail": "Nonce already used"})

                if hotkey not in allowed_hotkeys:
                    log.warning("auth_forbidden", hotkey=hotkey, path=path)
                    return JSONResponse(status_code=403, content={"detail": "Hotkey not authorized"})

                body = await request.body()
                body_hash = hashlib.sha256(body).hexdigest()
                message = create_signature_message(path, body_hash, timestamp, nonce)

                if verify_hotkey_signature(message, signature, hotkey):
                    log.debug("auth_ok_sig", hotkey=hotkey, path=path)
                    return await call_next(request)
                else:
                    log.warning("auth_invalid_signature", hotkey=hotkey, path=path)
                    return JSONResponse(status_code=401, content={"detail": "Invalid signature"})

        # Neither IP nor signature matched
        log.warning("auth_rejected", path=path, client=client_ip)
        return JSONResponse(
            status_code=403,
            content={"detail": "Not authorized — caller IP is not registered on subnet"},
        )
