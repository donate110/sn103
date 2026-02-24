"""FastAPI axon server for the Djinn miner."""

from __future__ import annotations

import asyncio
import os
import time
from typing import TYPE_CHECKING

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from djinn_miner.api.metrics import (
    ATTESTATION_DURATION,
    ATTESTATION_REQUESTS,
    CHECKS_PROCESSED,
    LINES_CHECKED,
    PROOFS_GENERATED,
    metrics_response,
)
from djinn_miner.api.middleware import (
    RateLimiter,
    RateLimitMiddleware,
    RequestIdMiddleware,
    ValidatorAuthMiddleware,
    get_cors_origins,
)
from djinn_miner.api.models import (
    AttestRequest,
    AttestResponse,
    CheckRequest,
    CheckResponse,
    HealthResponse,
    ProofRequest,
    ProofResponse,
    ReadinessResponse,
)

if TYPE_CHECKING:
    from djinn_miner.bt.neuron import DjinnMiner
    from djinn_miner.core.checker import LineChecker
    from djinn_miner.core.health import HealthTracker
    from djinn_miner.core.proof import ProofGenerator

log = structlog.get_logger()


def create_app(
    checker: LineChecker,
    proof_gen: ProofGenerator,
    health_tracker: HealthTracker,
    rate_limit_capacity: int = 30,
    rate_limit_rate: int = 5,
    neuron: DjinnMiner | None = None,
) -> FastAPI:
    """Build the FastAPI application with all routes wired."""

    from djinn_miner import __version__

    app = FastAPI(title="Djinn Miner", version=__version__)

    # Catch unhandled exceptions — never leak stack traces to clients
    @app.exception_handler(Exception)
    async def _unhandled_error(request: Request, exc: Exception) -> JSONResponse:
        log.error(
            "unhandled_exception",
            error=str(exc),
            path=request.url.path,
            method=request.method,
            exc_info=True,
        )
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error"},
        )

    cors_origins = get_cors_origins(os.getenv("CORS_ORIGINS", ""), os.getenv("BT_NETWORK", ""))
    allow_creds = "*" not in cors_origins
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=allow_creds,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    _BODY_LIMIT = 1_048_576  # 1 MB

    @app.middleware("http")
    async def limit_body_size(request: Request, call_next):  # type: ignore[no-untyped-def]
        """Enforce 1 MB body limit on both Content-Length header and actual body."""
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > _BODY_LIMIT:
                    return JSONResponse(status_code=413, content={"detail": "Request body too large (max 1MB)"})
            except (ValueError, OverflowError):
                return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length header"})
        elif request.method in ("POST", "PUT", "PATCH"):
            # No Content-Length (e.g. chunked encoding) — read and check actual body
            body = await request.body()
            if len(body) > _BODY_LIMIT:
                return JSONResponse(status_code=413, content={"detail": "Request body too large (max 1MB)"})
        return await call_next(request)

    app.add_middleware(RateLimitMiddleware, limiter=RateLimiter(capacity=rate_limit_capacity, rate=rate_limit_rate))

    # Validator authentication (runs after rate limiting, before route handlers)
    app.add_middleware(ValidatorAuthMiddleware, neuron=neuron)

    # Request ID tracing (outermost — must be added last)
    app.add_middleware(RequestIdMiddleware)

    @app.post("/v1/check", response_model=CheckResponse)
    async def check_lines(request: CheckRequest) -> CheckResponse:
        """Phase 1: Check availability of candidate lines at sportsbooks.

        Receives up to 10 candidate lines. For each, queries the odds data
        source and returns which lines are currently available and at which
        bookmakers.
        """
        start = time.perf_counter()
        try:
            check_result = await asyncio.wait_for(
                checker.check(request.lines),
                timeout=10.0,
            )
        except TimeoutError:
            log.error("check_lines_timeout", lines=len(request.lines))
            return JSONResponse(
                status_code=504,
                content={"detail": "Line check timed out"},
            )
        except asyncio.CancelledError:
            log.info("check_lines_cancelled")
            return JSONResponse(
                status_code=503,
                content={"detail": "Service shutting down"},
            )
        elapsed_ms = (time.perf_counter() - start) * 1000

        results = check_result.results
        available_indices = [r.index for r in results if r.available]

        CHECKS_PROCESSED.inc()
        for r in results:
            LINES_CHECKED.labels(result="available" if r.available else "unavailable").inc()

        log.info(
            "check_complete",
            total=len(request.lines),
            available=len(available_indices),
            time_ms=round(elapsed_ms, 1),
            api_error=check_result.api_error,
        )

        return CheckResponse(
            results=results,
            available_indices=available_indices,
            response_time_ms=round(elapsed_ms, 1),
            query_id=checker.last_query_id,
            api_error=check_result.api_error,
        )

    @app.post("/v1/proof", response_model=ProofResponse)
    async def submit_proof(request: ProofRequest) -> ProofResponse:
        """Phase 2: Generate and submit a TLSNotary proof (stub).

        In production, this generates a TLSNotary proof of the TLS session
        used during Phase 1. Currently returns a mock proof.
        """
        try:
            result = await asyncio.wait_for(
                proof_gen.generate(request.query_id, request.session_data),
                timeout=30.0,
            )
        except TimeoutError:
            log.error("proof_generation_timeout", query_id=request.query_id)
            return JSONResponse(
                status_code=504,
                content={"detail": "Proof generation timed out"},
            )
        except asyncio.CancelledError:
            log.info("proof_generation_cancelled", query_id=request.query_id)
            return JSONResponse(
                status_code=503,
                content={"detail": "Service shutting down"},
            )
        proof_type = "tlsnotary" if "tlsnotary" in (result.message or "") else "http_attestation"
        PROOFS_GENERATED.labels(type=proof_type).inc()
        log.info("proof_generated", query_id=request.query_id, status=result.status, type=proof_type)
        return result

    @app.post("/v1/attest", response_model=AttestResponse)
    async def attest_url(request: AttestRequest) -> AttestResponse:
        """Web Attestation: generate a TLSNotary proof for an arbitrary HTTPS URL.

        Part of the Web Attestation Service (whitepaper §15). Miners
        use the same TLSNotary infrastructure as sports proofs to attest
        arbitrary web content.
        """
        from djinn_miner.core import tlsn as tlsn_module

        start = time.perf_counter()
        timestamp = int(time.time())

        if not tlsn_module.is_available():
            ATTESTATION_REQUESTS.labels(status="error").inc()
            log.warning("attest_tlsn_unavailable", url=request.url)
            return AttestResponse(
                request_id=request.request_id,
                url=request.url,
                success=False,
                timestamp=timestamp,
                error="TLSNotary prover binary not available",
            )

        try:
            result = await asyncio.wait_for(
                tlsn_module.generate_proof(request.url, timeout=90.0),
                timeout=120.0,
            )
        except TimeoutError:
            ATTESTATION_REQUESTS.labels(status="error").inc()
            ATTESTATION_DURATION.observe(time.perf_counter() - start)
            log.error("attest_timeout", url=request.url, request_id=request.request_id)
            return AttestResponse(
                request_id=request.request_id,
                url=request.url,
                success=False,
                timestamp=timestamp,
                error="Attestation timed out",
            )
        except asyncio.CancelledError:
            ATTESTATION_REQUESTS.labels(status="cancelled").inc()
            ATTESTATION_DURATION.observe(time.perf_counter() - start)
            log.info("attest_cancelled", request_id=request.request_id)
            return JSONResponse(
                status_code=503,
                content={"detail": "Service shutting down"},
            )

        elapsed = time.perf_counter() - start
        ATTESTATION_DURATION.observe(elapsed)

        if not result.success:
            ATTESTATION_REQUESTS.labels(status="error").inc()
            log.warning(
                "attest_failed",
                url=request.url,
                request_id=request.request_id,
                error=result.error,
            )
            return AttestResponse(
                request_id=request.request_id,
                url=request.url,
                success=False,
                timestamp=timestamp,
                error=result.error,
            )

        proof_hex = result.presentation_bytes.hex() if result.presentation_bytes else None
        ATTESTATION_REQUESTS.labels(status="success").inc()
        log.info(
            "attest_complete",
            url=request.url,
            request_id=request.request_id,
            server=result.server,
            proof_size=len(result.presentation_bytes or b""),
            elapsed_s=round(elapsed, 1),
        )

        return AttestResponse(
            request_id=request.request_id,
            url=request.url,
            success=True,
            proof_hex=proof_hex,
            server_name=result.server or None,
            timestamp=timestamp,
        )

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        """Health check endpoint for validator pings."""
        health_tracker.record_ping()
        return health_tracker.get_status()

    # Cache Config for readiness checks (avoid re-loading dotenv on every probe)
    from djinn_miner.config import Config as _ConfigCls

    _readiness_config = _ConfigCls()

    @app.get("/health/ready", response_model=ReadinessResponse)
    async def readiness() -> ReadinessResponse:
        """Deep readiness probe — checks API key and dependencies."""
        checks: dict[str, bool] = {}
        try:
            cfg = _readiness_config
            checks["odds_api_key"] = bool(cfg.odds_api_key)
        except Exception as e:
            log.warning("readiness_config_error", error=str(e))
            checks["odds_api_key"] = False
        checks["odds_api_connected"] = health_tracker.get_status().odds_api_connected

        ready = all(checks.values())
        return ReadinessResponse(ready=ready, checks=checks)

    @app.get("/metrics")
    async def metrics() -> bytes:
        """Prometheus metrics endpoint."""
        from fastapi.responses import Response

        return Response(
            content=metrics_response(),
            media_type="text/plain; version=0.0.4; charset=utf-8",
        )

    return app
