"""Proof generation with TLSNotary integration.

Supports two proof modes:
1. TLSNotary (production): Calls `djinn-tlsn-prover` Rust binary for an
   MPC-TLS attested session. The resulting Presentation is cryptographically
   bound to the server's TLS certificate and transcript.
2. HTTP attestation (fallback): SHA-256 hash of the captured response with
   parsed summary. Validators re-query the same endpoint for verification.

Architecture:
- Phase 1 (fast): Miner queries The Odds API, captures raw HTTP response
- Phase 2 (async): Miner generates TLSNotary proof or HTTP attestation
- Validators verify the proof using the `djinn-tlsn-verifier` binary

The ProofGenerator auto-detects TLSNotary availability and falls back to
HTTP attestation when the Rust binary is not installed.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

import structlog

from djinn_miner.api.models import ProofResponse
from djinn_miner.core import tlsn as tlsn_module

log = structlog.get_logger()

# Redis session sharing key prefix (must match broadcaster)
SESSION_PREFIX = "djinn:sessions:"


@dataclass
class CapturedSession:
    """Captured HTTP session data from an Odds API query."""

    query_id: str
    request_url: str  # URL without API key
    request_params: dict[str, str] = field(default_factory=dict)
    response_status: int = 0
    response_body: bytes = b""
    response_headers: dict[str, str] = field(default_factory=dict)
    captured_at: float = field(default_factory=time.time)


@dataclass
class AttestationProof:
    """A structured proof of an HTTP query to The Odds API."""

    query_id: str
    request_url: str
    response_hash: str  # SHA-256 of response body
    response_summary: dict[str, Any]  # Parsed key facts for quick verification
    captured_at: float
    proof_hash: str  # SHA-256 of the entire proof payload
    events_found: int = 0
    bookmakers_found: int = 0


class SessionCapture:
    """Captures HTTP session data during Odds API queries.

    Used by the OddsApiClient to record raw responses for proof generation.
    Sessions are evicted after TTL to prevent unbounded memory growth.
    """

    _MAX_SESSIONS = 1000
    _SESSION_TTL = 1800  # 30 minutes (proof requests may come late in a full-proof epoch)

    def __init__(self) -> None:
        self._sessions: dict[str, CapturedSession] = {}
        self._timestamps: dict[str, float] = {}
        self._lock = threading.Lock()

    def record(self, session: CapturedSession) -> None:
        """Record a captured HTTP session."""
        with self._lock:
            self._evict_expired()
            if len(self._sessions) >= self._MAX_SESSIONS and self._timestamps:
                oldest = min(self._timestamps, key=self._timestamps.get)  # type: ignore[arg-type]
                self._sessions.pop(oldest, None)
                self._timestamps.pop(oldest, None)
            self._sessions[session.query_id] = session
            self._timestamps[session.query_id] = time.monotonic()
            log.debug("session_captured", query_id=session.query_id)

    def get(self, query_id: str) -> CapturedSession | None:
        """Retrieve a captured session by query ID."""
        with self._lock:
            self._evict_expired()
            return self._sessions.get(query_id)

    def remove(self, query_id: str) -> None:
        """Remove a session after proof generation."""
        with self._lock:
            self._sessions.pop(query_id, None)
            self._timestamps.pop(query_id, None)

    def _evict_expired(self) -> None:
        now = time.monotonic()
        expired = [k for k, ts in self._timestamps.items() if now - ts > self._SESSION_TTL]
        for k in expired:
            self._sessions.pop(k, None)
            self._timestamps.pop(k, None)

    @property
    def count(self) -> int:
        return len(self._sessions)


class ProofGenerator:
    """Generates proofs from captured HTTP sessions.

    Tries TLSNotary first (Rust binary), falls back to HTTP attestation.
    
    In multi-miner mode with a broadcaster, sessions are stored in Redis.
    The generator checks Redis when the local session cache misses.
    """

    def __init__(
        self,
        session_capture: SessionCapture | None = None,
        redis_url: str | None = None,
    ) -> None:
        self._capture = session_capture or SessionCapture()
        self._generated_count = 0
        self._tlsn_available = tlsn_module.is_available()
        self._redis_url = redis_url or os.getenv("REDIS_URL", "")
        self._redis: Any = None  # Lazy init
        if self._tlsn_available:
            log.info("tlsn_prover_available")
        else:
            log.info("tlsn_prover_not_found_using_http_attestation")

    async def _get_redis(self) -> Any:
        """Lazily initialize Redis connection."""
        if self._redis is None and self._redis_url:
            import redis.asyncio as redis_lib
            self._redis = redis_lib.from_url(self._redis_url, decode_responses=True)
        return self._redis

    async def _get_session_from_redis(self, query_id: str) -> CapturedSession | None:
        """Fetch a session from Redis (stored by broadcaster).
        
        Returns None if Redis is not configured or session not found.
        """
        if not self._redis_url:
            return None
        try:
            r = await self._get_redis()
            if r is None:
                return None
            session_key = f"{SESSION_PREFIX}{query_id}"
            raw = await r.get(session_key)
            if not raw:
                log.debug("redis_session_miss", query_id=query_id)
                return None
            data = json.loads(raw)
            # Decode base64 response body
            response_body = base64.b64decode(data.get("response_body_b64", ""))
            session = CapturedSession(
                query_id=data["query_id"],
                request_url=data["request_url"],
                request_params=data.get("request_params", {}),
                response_status=data.get("response_status", 200),
                response_body=response_body,
                response_headers=data.get("response_headers", {}),
                captured_at=data.get("captured_at", time.time()),
            )
            log.info("redis_session_hit", query_id=query_id, size=len(response_body))
            return session
        except Exception as e:
            log.warning("redis_session_error", query_id=query_id, error=str(e))
            return None

    @property
    def session_capture(self) -> SessionCapture:
        return self._capture

    @property
    def tlsn_available(self) -> bool:
        return self._tlsn_available

    @staticmethod
    async def _spawn_ephemeral_notary() -> tuple[asyncio.subprocess.Process, int] | None:
        """Spawn a short-lived notary on a random port for one proof."""
        from djinn_miner.core.notary_utils import spawn_ephemeral_notary

        return await spawn_ephemeral_notary()

    async def generate(
        self,
        query_id: str,
        session_data: str = "",
        *,
        notary_host: str | None = None,
        notary_port: int | None = None,
        notary_ws: bool = False,
        notary_ws_port: int | None = None,
        notary_ticket: str | None = None,
    ) -> ProofResponse:
        """Generate a proof for a captured HTTP session.

        Priority:
        1. TLSNotary proof (if binary available, session exists, and notary assigned)
        2. HTTP attestation (if captured session exists)
        3. Basic hash proof (fallback)
        
        Sessions are checked in order: local cache -> Redis (broadcaster shared).
        """
        # Check local cache first
        session = self._capture.get(query_id)
        
        # Fall back to Redis (broadcaster stores sessions there in multi-miner mode)
        if session is None:
            session = await self._get_session_from_redis(query_id)

        # Try TLSNotary first
        if self._tlsn_available and session is not None:
            tlsn_result = await self._try_tlsn_proof(
                session,
                notary_host=notary_host,
                notary_port=notary_port,
                notary_ws=notary_ws,
                notary_ws_port=notary_ws_port,
                notary_ticket=notary_ticket,
            )
            if tlsn_result is not None:
                self._capture.remove(query_id)
                self._generated_count += 1
                return tlsn_result

        # Fall back to HTTP attestation
        if session is not None:
            proof = self._create_attestation(session)
            self._capture.remove(query_id)
            self._generated_count += 1

            log.info(
                "attestation_proof_generated",
                query_id=query_id,
                proof_hash=proof.proof_hash[:16],
                events=proof.events_found,
                bookmakers=proof.bookmakers_found,
            )

            return ProofResponse(
                query_id=query_id,
                proof_hash=proof.proof_hash,
                status="submitted",
                message=json.dumps(
                    {
                        "type": "http_attestation",
                        "request_url": proof.request_url,
                        "response_hash": proof.response_hash,
                        "captured_at": proof.captured_at,
                        "events_found": proof.events_found,
                        "bookmakers_found": proof.bookmakers_found,
                    }
                ),
            )

        # Fallback: basic hash proof (no captured session)
        proof_input = f"{query_id}:{session_data}:{time.time()}"
        proof_hash = hashlib.sha256(proof_input.encode()).hexdigest()
        self._generated_count += 1

        log.info(
            "basic_proof_generated",
            query_id=query_id,
            proof_hash=proof_hash[:16],
        )

        return ProofResponse(
            query_id=query_id,
            proof_hash=proof_hash,
            status="unverified",
            message="basic hash proof — not cryptographically verified (no captured session or TLSNotary)",
        )

    async def _try_tlsn_proof(
        self,
        session: CapturedSession,
        *,
        notary_host: str | None = None,
        notary_port: int | None = None,
        notary_ws: bool = False,
        notary_ws_port: int | None = None,
        notary_ticket: str | None = None,
    ) -> ProofResponse | None:
        """Attempt to generate a TLSNotary proof for the session."""
        # Reconstruct the original URL with API key for TLSNotary
        # The session stores URL without key, but we need the full URL for TLS
        url = session.request_url
        if session.request_params:
            sep = "&" if "?" in url else "?"
            url = f"{url}{sep}{urlencode(session.request_params)}"

        # Short timeout on peer notary (45s). If it fails, the ephemeral
        # fallback below needs time within the server's 300s outer timeout.
        _using_peer = notary_host and notary_host not in ("127.0.0.1", "localhost")
        _peer_timeout = 45.0 if _using_peer else 150.0
        result = await tlsn_module.generate_proof(
            url,
            notary_host=notary_host,
            notary_port=notary_port,
            notary_ws=notary_ws,
            notary_ws_port=notary_ws_port,
            notary_ticket=notary_ticket,
            timeout=_peer_timeout,
        )

        if not result.success:
            # Peer notary failed. Restart the local sidecar to clear stale
            # MPC state ("connection is closed" errors), then retry locally
            # before spawning an ephemeral process.
            log.warning(
                "tlsn_proof_failed_trying_sidecar_restart",
                query_id=session.query_id,
                error=result.error,
            )
            try:
                from djinn_miner.core.notary_sidecar import NotarySidecar
                import djinn_miner.api.server as _srv_mod
                _sidecar = getattr(_srv_mod, "_notary_sidecar_ref", None)
                if _sidecar and _sidecar.enabled:
                    await _sidecar.stop()
                    await _sidecar.start()
                    await asyncio.sleep(1)
                    _local_port = _sidecar._port
                    result = await tlsn_module.generate_proof(
                        url,
                        notary_host="127.0.0.1",
                        notary_port=_local_port,
                        timeout=150.0,
                    )
                    if result.success:
                        log.info("tlsn_proof_sidecar_restart_succeeded", query_id=session.query_id)
            except Exception as exc:
                log.warning("tlsn_proof_sidecar_restart_failed", error=str(exc))

            if not result.success:
                # Sidecar restart didn't help. Last resort: ephemeral notary.
                spawned = await self._spawn_ephemeral_notary()
                if spawned is not None:
                    eph_proc, eph_port = spawned
                    try:
                        result = await tlsn_module.generate_proof(
                            url,
                            notary_host="127.0.0.1",
                            notary_port=eph_port,
                            timeout=150.0,
                        )
                        if result.success:
                            log.info("tlsn_proof_ephemeral_succeeded", query_id=session.query_id)
                    finally:
                        eph_proc.kill()
                        try:
                            await eph_proc.wait()
                        except Exception:
                            pass

            if not result.success:
                return None

        # Hash the presentation for the proof_hash field
        proof_hash = hashlib.sha256(result.presentation_bytes).hexdigest()
        presentation_b64 = base64.b64encode(result.presentation_bytes).decode()

        log.info(
            "tlsn_proof_generated",
            query_id=session.query_id,
            proof_hash=proof_hash[:16],
            size=len(result.presentation_bytes),
        )

        return ProofResponse(
            query_id=session.query_id,
            proof_hash=proof_hash,
            status="submitted",
            message=json.dumps(
                {
                    "type": "tlsnotary",
                    "server": result.server,
                    "presentation": presentation_b64,
                    "size": len(result.presentation_bytes),
                }
            ),
        )

    def _create_attestation(self, session: CapturedSession) -> AttestationProof:
        """Create a full attestation proof from a captured session."""
        # Hash the raw response body
        response_hash = hashlib.sha256(session.response_body).hexdigest()

        # Parse response to extract verifiable summary
        summary = self._parse_response_summary(session.response_body)

        # Build the proof payload (deterministic ordering for reproducible hash)
        payload = json.dumps(
            {
                "query_id": session.query_id,
                "request_url": session.request_url,
                "response_hash": response_hash,
                "captured_at": session.captured_at,
                "summary": summary,
            },
            sort_keys=True,
        )
        proof_hash = hashlib.sha256(payload.encode()).hexdigest()

        return AttestationProof(
            query_id=session.query_id,
            request_url=session.request_url,
            response_hash=response_hash,
            response_summary=summary,
            captured_at=session.captured_at,
            proof_hash=proof_hash,
            events_found=summary.get("event_count", 0),
            bookmakers_found=summary.get("bookmaker_count", 0),
        )

    @staticmethod
    def _parse_response_summary(body: bytes) -> dict[str, Any]:
        """Extract verifiable facts from an Odds API response."""
        try:
            data = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {"event_count": 0, "bookmaker_count": 0, "error": "unparseable"}

        if not isinstance(data, list):
            return {"event_count": 0, "bookmaker_count": 0}

        event_ids = []
        bookmaker_keys: set[str] = set()

        for event in data:
            if isinstance(event, dict):
                eid = event.get("id", "")
                if eid:
                    event_ids.append(eid)
                for bk in event.get("bookmakers", []):
                    if isinstance(bk, dict):
                        bk_key = bk.get("key", "")
                        if bk_key:
                            bookmaker_keys.add(bk_key)

        return {
            "event_count": len(event_ids),
            "event_ids": event_ids[:20],  # Cap to prevent huge payloads
            "bookmaker_count": len(bookmaker_keys),
            "bookmaker_keys": sorted(bookmaker_keys)[:10],
        }

    @property
    def generated_count(self) -> int:
        return self._generated_count
