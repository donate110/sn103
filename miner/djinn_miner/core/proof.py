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

import base64
import hashlib
import json
import threading
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

import structlog

from djinn_miner.api.models import ProofResponse
from djinn_miner.core import tlsn as tlsn_module

log = structlog.get_logger()


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
    """

    def __init__(self, session_capture: SessionCapture | None = None) -> None:
        self._capture = session_capture or SessionCapture()
        self._generated_count = 0
        self._tlsn_available = tlsn_module.is_available()
        if self._tlsn_available:
            log.info("tlsn_prover_available")
        else:
            log.info("tlsn_prover_not_found_using_http_attestation")

    @property
    def session_capture(self) -> SessionCapture:
        return self._capture

    @property
    def tlsn_available(self) -> bool:
        return self._tlsn_available

    async def generate(
        self,
        query_id: str,
        session_data: str = "",
        *,
        notary_host: str | None = None,
        notary_port: int | None = None,
        notary_ws: bool = False,
    ) -> ProofResponse:
        """Generate a proof for a captured HTTP session.

        Priority:
        1. TLSNotary proof (if binary available, session exists, and notary assigned)
        2. HTTP attestation (if captured session exists)
        3. Basic hash proof (fallback)
        """
        session = self._capture.get(query_id)

        # Try TLSNotary first
        if self._tlsn_available and session is not None:
            tlsn_result = await self._try_tlsn_proof(
                session,
                notary_host=notary_host,
                notary_port=notary_port,
                notary_ws=notary_ws,
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
    ) -> ProofResponse | None:
        """Attempt to generate a TLSNotary proof for the session."""
        # Reconstruct the original URL with API key for TLSNotary
        # The session stores URL without key, but we need the full URL for TLS
        url = session.request_url
        if session.request_params:
            sep = "&" if "?" in url else "?"
            url = f"{url}{sep}{urlencode(session.request_params)}"

        result = await tlsn_module.generate_proof(
            url,
            notary_host=notary_host,
            notary_port=notary_port,
            notary_ws=notary_ws,
        )

        if not result.success:
            log.warning(
                "tlsn_proof_failed_falling_back",
                query_id=session.query_id,
                error=result.error,
            )
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
