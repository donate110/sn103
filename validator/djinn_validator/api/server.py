"""FastAPI server for the Djinn validator REST API.

Endpoints from Appendix A of the whitepaper:
- POST /v1/signal                    — Accept encrypted key shares from Genius
- POST /v1/signal/{id}/purchase      — Handle buyer purchase (MPC + share release)
- POST /v1/signal/{id}/register      — Register purchased signal for outcome tracking
- POST /v1/signal/{id}/outcome       — Submit outcome attestation
- POST /v1/signals/resolve           — Resolve all pending signal outcomes
- POST /v1/attest                    — Web attestation: TLSNotary proof of any URL (§15)
- POST /v1/notary/session            — Assign a notary miner for external provers (browser extensions)
- POST /v1/analytics/attempt         — Fire-and-forget analytics
- GET  /health                       — Health check

Inter-validator MPC endpoints:
- POST /v1/mpc/init                  — Accept MPC session invitation
- POST /v1/mpc/round1               — Submit Round 1 multiplication messages
- POST /v1/mpc/result               — Accept coordinator's final result
- GET  /v1/mpc/{session_id}/status   — Check MPC session status
"""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

import httpx
import structlog
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse as StarletteJSONResponse

from djinn_validator.api.metrics import (
    ACTIVE_SHARES,
    ATTESTATION_DISPATCHED,
    ATTESTATION_DURATION,
    ATTESTATION_VERIFIED,
    BT_CONNECTED,
    MPC_ACTIVE_SESSIONS,
    NOTARY_SESSIONS_ASSIGNED,
    OUTCOMES_ATTESTED,
    PURCHASES_PROCESSED,
    SHARES_STORED,
    UPTIME_SECONDS,
    metrics_response,
)
from djinn_validator.utils.circuit_breaker import CircuitBreaker
from djinn_validator.api.middleware import (
    RateLimiter,
    RateLimitMiddleware,
    RequestIdMiddleware,
    get_cors_origins,
    require_admin_auth,
    validate_signed_request,
)
from djinn_validator.api.models import (
    AnalyticsRequest,
    AttestRequest,
    AttestResponse,
    NotarySessionResponse,
    AuditSetStatusResponse,
    HealthResponse,
    IdentityResponse,
    MPCAbortRequest,
    MPCAbortResponse,
    MPCComputeGateRequest,
    MPCComputeGateResponse,
    MPCFinalizeRequest,
    MPCFinalizeResponse,
    MPCInitRequest,
    MPCInitResponse,
    MPCResultRequest,
    MPCResultResponse,
    MPCRound1Request,
    MPCRound1Response,
    MPCSessionStatusResponse,
    OTChoicesRequest,
    OTChoicesResponse,
    OTCompleteRequest,
    OTCompleteResponse,
    OTSetupRequest,
    OTSetupResponse,
    OTSharesRequest,
    OTSharesResponse,
    OTTransfersRequest,
    OTTransfersResponse,
    OutcomeRequest,
    OutcomeResponse,
    PurchaseRequest,
    PurchaseResponse,
    ReadinessResponse,
    RegisterSignalRequest,
    RegisterSignalResponse,
    ResolveResponse,
    ShareInfoResponse,
    StoreShareRequest,
    StoreShareResponse,
)
from djinn_validator.core.mpc import (
    DistributedParticipantState,
    MPCResult,
    Round1Message,
)
from djinn_validator.core.audit_set import AuditSetStore
from djinn_validator.core.mpc_coordinator import MPCCoordinator, SessionStatus
from djinn_validator.core.mpc_orchestrator import MPCOrchestrator
from djinn_validator.core.outcomes import (
    SUPPORTED_SPORTS,
    Outcome,
    OutcomeAttestor,
    SignalMetadata,
    parse_pick,
)
from djinn_validator.core.purchase import PurchaseOrchestrator, PurchaseStatus
from djinn_validator.core.activity import ActivityBuffer
from djinn_validator.core.telemetry import TelemetryStore
from djinn_validator.core.scoring import MinerScorer
from djinn_validator.core.shares import ShareStore, SignalShareRecord
from djinn_validator.utils.crypto import BN254_PRIME, Share

_SIGNAL_ID_PATH_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,256}$")

# Per-signal asyncio locks for purchase endpoint race-condition prevention (R25-15)
_purchase_locks: dict[str, asyncio.Lock] = {}
_purchase_locks_guard = asyncio.Lock()


def _validate_signal_id_path(signal_id: str) -> None:
    """Validate signal_id path parameter format."""
    if not _SIGNAL_ID_PATH_RE.match(signal_id):
        raise HTTPException(status_code=400, detail="Invalid signal_id format")


def _parse_field_hex(value: str, name: str) -> int:
    """Parse a hex string to int, validating it's a valid BN254 field element."""
    if not isinstance(value, str) or len(value) > 66:
        raise HTTPException(status_code=400, detail=f"{name} must be a hex string of at most 66 chars")
    try:
        v = int(value, 16)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail=f"Invalid hex encoding for {name}")
    if v < 0 or v >= BN254_PRIME:
        raise HTTPException(
            status_code=400,
            detail=f"{name} must be a valid field element (0 <= v < BN254_PRIME)",
        )
    return v


def _signal_id_to_uint256(signal_id: str) -> int:
    """Convert a string signal ID to a uint256 for on-chain lookups.

    Signal IDs are numeric uint256 values assigned by the SignalCommitment
    contract. The web client passes them as decimal strings.
    """
    try:
        v = int(signal_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail=f"Invalid signal ID: {signal_id!r}")
    if v < 0 or v >= 2**256:
        raise HTTPException(status_code=400, detail="Signal ID out of uint256 range")
    return v


if TYPE_CHECKING:
    from djinn_validator.bt.neuron import DjinnValidator
    from djinn_validator.chain.contracts import ChainClient
    from djinn_validator.core.attestation_log import AttestationLog

log = structlog.get_logger()


def _detect_bot_challenge(response_body: str | None) -> bool:
    """Check if a response body looks like a bot protection challenge page."""
    if not response_body:
        return False
    lower = response_body[:4000].lower()
    indicators = [
        "<title>client challenge</title>",
        "<title>just a moment...</title>",
        "<title>attention required</title>",
        "<title>access denied</title>",
        "cf-challenge-running",
        "cf_chl_opt",
        "_cf_chl_tk",
        "jschl_vc",
        "jschl-answer",
        "managed_checking_msg",
        "challenges.cloudflare.com",
        "cdn-cgi/challenge-platform",
        "please verify you are a human",
        "checking your browser",
        "ddos-guard",
        "please wait while we verify",
    ]
    return any(ind in lower for ind in indicators)


def create_app(
    share_store: ShareStore,
    purchase_orch: PurchaseOrchestrator,
    outcome_attestor: OutcomeAttestor,
    chain_client: ChainClient | None = None,
    neuron: DjinnValidator | None = None,
    mpc_coordinator: MPCCoordinator | None = None,
    rate_limit_capacity: int = 60,
    rate_limit_rate: int = 10,
    mpc_availability_timeout: float = 60.0,
    shares_threshold: int = 7,
    attestation_log: AttestationLog | None = None,
    fallback_miner_url: str | None = None,
    scorer: MinerScorer | None = None,
    activity_buffer: ActivityBuffer | None = None,
    audit_set_store: AuditSetStore | None = None,
    telemetry: TelemetryStore | None = None,
) -> FastAPI:
    """Create the FastAPI application with injected dependencies."""
    bt_network = os.environ.get("BT_NETWORK", "")
    _is_production = bt_network in ("finney", "mainnet")

    # Warn loudly if chain client is missing in production (hard guard is on
    # the purchase endpoint — shares will never be released without payment
    # verification in production mode).
    if chain_client is None and _is_production:
        log.error(
            "chain_client_missing_production",
            bt_network=bt_network,
            msg="No chain client configured. Share release will be BLOCKED "
            "until BASE_RPC_URL is set and chain_client is provided.",
        )

    # Resources that need cleanup on shutdown
    _cleanup_resources: list = []
    _shutdown_event = asyncio.Event()
    # Mutable container for last-cleanup timestamp (throttle purchase-path cleanup)
    _last_cleanup = [0.0]

    import time as _startup_time_mod

    _startup_monotonic = _startup_time_mod.monotonic()

    async def _periodic_state_cleanup() -> None:
        """Background task to evict stale participant/OT states every 60s."""
        while not _shutdown_event.is_set():
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                return
            try:
                with _participant_lock:
                    _cleanup_stale_participants_locked()
                with _ot_lock:
                    _cleanup_stale_ot_states_locked()
                _mpc.cleanup_expired()
                # Prune purchase locks to prevent unbounded growth
                async with _purchase_locks_guard:
                    to_remove = [k for k, lock in _purchase_locks.items() if not lock.locked()]
                    for k in to_remove:
                        del _purchase_locks[k]
                    if to_remove:
                        log.debug("purchase_locks_pruned", count=len(to_remove))
                # Update operational gauges
                MPC_ACTIVE_SESSIONS.set(_mpc.active_session_count)
                UPTIME_SECONDS.set(_startup_time_mod.monotonic() - _startup_monotonic)
                BT_CONNECTED.set(1 if neuron and neuron.metagraph is not None else 0)
            except Exception:
                log.warning("periodic_cleanup_error", exc_info=True)

    @asynccontextmanager
    async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
        if os.environ.get("DJINN_REQUIRE_BUYER_AUTH", "0") != "1":
            log.warning(
                "buyer_auth_disabled",
                detail="DJINN_REQUIRE_BUYER_AUTH is not '1'. "
                "Purchase endpoint will accept unsigned requests. "
                "Set DJINN_REQUIRE_BUYER_AUTH=1 for production.",
            )
        cleanup_task = asyncio.create_task(_periodic_state_cleanup())
        yield
        _shutdown_event.set()
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
        for resource in _cleanup_resources:
            try:
                await resource.close()
            except Exception as e:
                log.warning("resource_cleanup_error", resource=type(resource).__name__, error=str(e))

    from djinn_validator import __version__

    app = FastAPI(
        title="Djinn Validator",
        version=__version__,
        description="Djinn Protocol Bittensor Validator API",
        lifespan=_lifespan,
    )

    # Catch unhandled exceptions — never leak stack traces to clients
    @app.exception_handler(Exception)
    async def _unhandled_error(request: Request, exc: Exception) -> StarletteJSONResponse:
        log.error(
            "unhandled_exception",
            error=str(exc),
            path=request.url.path,
            method=request.method,
            exc_info=True,
        )
        return StarletteJSONResponse(
            status_code=500,
            content={"detail": "Internal server error"},
        )

    # CORS — restricted in production, open in dev
    cors_origins = get_cors_origins(os.getenv("CORS_ORIGINS", ""), os.getenv("BT_NETWORK", ""))
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Request body size limit (1MB default, 5MB for OT endpoints)
    @app.middleware("http")
    async def limit_body_size(request: Request, call_next):  # type: ignore[no-untyped-def]
        from starlette.responses import JSONResponse

        max_size = 5_242_880 if request.url.path.startswith("/v1/mpc/ot/") else 1_048_576
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > max_size:
                    return JSONResponse(
                        status_code=413, content={"detail": f"Request body too large (max {max_size // 1048576}MB)"}
                    )
            except (ValueError, OverflowError):
                return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length header"})
        elif request.method in ("POST", "PUT", "PATCH"):
            # Reject requests without Content-Length to prevent chunked encoding bypass
            te = request.headers.get("transfer-encoding", "").lower()
            if "chunked" in te:
                return JSONResponse(
                    status_code=411, content={"detail": "Content-Length header required"}
                )
        return await call_next(request)

    # Rate limiting
    limiter = RateLimiter(default_capacity=rate_limit_capacity, default_rate=rate_limit_rate)
    limiter.set_path_limit("/v1/signal", capacity=20, rate=2)  # Share storage: 2/sec
    limiter.set_path_limit("/v1/signals/resolve", capacity=10, rate=1)  # Resolution: 1/sec
    limiter.set_path_limit("/v1/mpc/", capacity=100, rate=50)  # MPC: higher for multi-round
    limiter.set_path_limit("/v1/analytics", capacity=30, rate=5)  # Analytics: 5/sec
    app.add_middleware(RateLimitMiddleware, limiter=limiter)

    # Request ID tracing (outermost — must be added last)
    app.add_middleware(RequestIdMiddleware)

    # Admin auth dependency — if ADMIN_API_KEY is set, require Bearer token
    _admin_auth = require_admin_auth(os.getenv("ADMIN_API_KEY", ""))

    _ETH_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")

    # Shamir threshold bounds. Floor of 2 during bootstrap (not all validators
    # updated yet). Raise to 3 once the network stabilizes. Cap of 7.
    # The client computes clamp(ceil(2/3 * healthy), 2, 7).
    _MIN_SHAMIR_THRESHOLD = 2
    _MAX_SHAMIR_THRESHOLD = 7

    @app.post("/v1/signal", response_model=StoreShareResponse)
    async def store_share(req: StoreShareRequest) -> StoreShareResponse:
        """Accept and store an encrypted key share from a Genius."""
        # Log threshold for monitoring but don't reject. The threshold is
        # enforced by Shamir math (can't reconstruct with fewer shares).
        # Rejecting here causes backward-compatibility issues when the
        # client and validator disagree on the minimum.
        if req.shamir_threshold < _MIN_SHAMIR_THRESHOLD:
            log.warning(
                "low_shamir_threshold",
                threshold=req.shamir_threshold,
                min_expected=_MIN_SHAMIR_THRESHOLD,
                genius=req.genius_address,
                signal_id=req.signal_id,
            )

        # Validate Ethereum address format at the API boundary
        if not _ETH_ADDR_RE.match(req.genius_address):
            raise HTTPException(
                status_code=400,
                detail="genius_address must be a valid Ethereum address (0x + 40 hex chars)",
            )

        try:
            share_y = int(req.share_y, 16)
            encrypted = bytes.fromhex(req.encrypted_key_share)
            encrypted_index = bytes.fromhex(req.encrypted_index_share) if req.encrypted_index_share else b""
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="Invalid hex encoding in share data")

        if share_y < 0:
            raise HTTPException(status_code=400, detail="share_y must be non-negative")
        if share_y >= BN254_PRIME:
            raise HTTPException(status_code=400, detail="share_y must be less than BN254 prime")

        share = Share(x=req.share_x, y=share_y)

        # Verify signal exists on-chain and genius address matches (non-blocking on chain errors)
        if chain_client is not None:
            try:
                on_chain = await chain_client.get_signal(int(req.signal_id))
                if on_chain and on_chain.get("genius"):
                    if on_chain["genius"].lower() != req.genius_address.lower():
                        raise HTTPException(
                            status_code=403,
                            detail=f"genius_address mismatch: on-chain={on_chain['genius']}, request={req.genius_address}",
                        )
            except HTTPException:
                raise
            except Exception as e:
                log.warning("on_chain_signal_verification_failed", signal_id=req.signal_id, err=str(e))

        try:
            share_store.store(
                signal_id=req.signal_id,
                genius_address=req.genius_address,
                share=share,
                encrypted_key_share=encrypted,
                encrypted_index_share=encrypted_index,
                shamir_threshold=req.shamir_threshold,
            )
        except ValueError as e:
            detail = str(e)
            if "already stored" in detail:
                raise HTTPException(status_code=409, detail=detail)
            raise HTTPException(status_code=400, detail=detail)

        SHARES_STORED.inc()
        ACTIVE_SHARES.set(share_store.count)

        return StoreShareResponse(signal_id=req.signal_id, stored=True)

    @app.post("/v1/signal/{signal_id}/purchase", response_model=PurchaseResponse)
    async def purchase_signal(signal_id: str, req: PurchaseRequest) -> PurchaseResponse:
        """Handle a buyer's purchase request.

        Flow:
        1. Verify buyer owns buyer_address (EIP-191 signature)
        2. Verify signal exists and is active
        3. Run MPC to check if real index ∈ available indices
        4. If available, release encrypted key share

        Uses per-signal locking to prevent concurrent purchases for the
        same signal from racing through payment verification and share release.
        """
        _validate_signal_id_path(signal_id)

        # Verify buyer owns the claimed address via EIP-191 signature
        if req.buyer_signature:
            try:
                from eth_account.messages import encode_defunct
                from eth_account import Account as EthAccount

                msg = encode_defunct(text=f"djinn:purchase:{signal_id}")
                recovered = EthAccount.recover_message(msg, signature=req.buyer_signature)
                if recovered.lower() != req.buyer_address.lower():
                    raise HTTPException(
                        status_code=403,
                        detail=f"Signature does not match buyer_address (recovered {recovered})",
                    )
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Invalid buyer_signature: {e}")
        else:
            # Require signature in production; allow unsigned in dev mode for backwards compat
            if os.environ.get("DJINN_REQUIRE_BUYER_AUTH", "0") == "1":
                raise HTTPException(
                    status_code=401,
                    detail="buyer_signature is required. Sign 'djinn:purchase:{signal_id}' with your wallet.",
                )

        # Acquire per-signal lock to prevent concurrent purchase races (R25-15)
        async with _purchase_locks_guard:
            if signal_id not in _purchase_locks:
                _purchase_locks[signal_id] = asyncio.Lock()
            signal_lock = _purchase_locks[signal_id]

        async with signal_lock:
            # Throttle cleanup to at most once per 60 seconds
            import time as _time

            _now = _time.monotonic()
            if _now - _last_cleanup[0] > 60:
                _mpc.cleanup_expired()
                purchase_orch.cleanup_stale()
                purchase_orch.cleanup_completed()
                _last_cleanup[0] = _now

            # Check we hold a share for this signal
            all_records = share_store.get_all(signal_id)
            if not all_records:
                raise HTTPException(status_code=404, detail="Signal not found on this validator")
            record = all_records[0]

            # Initiate purchase
            purchase = purchase_orch.initiate(signal_id, req.buyer_address, req.sportsbook)
            if purchase.status == PurchaseStatus.FAILED:
                raise HTTPException(status_code=500, detail="Purchase initiation failed")

            # Run MPC availability check (multi-validator or single-validator fallback)
            # The MPC checks if realIndex ∈ available_indices. The Shamir shares
            # of the real index are stored in encrypted_index_share (as big-endian
            # bytes), NOT in share_y (which holds the AES key share).
            available_set = set(req.available_indices)

            def _index_share(rec: SignalShareRecord) -> Share:
                """Extract the real-index Shamir share from a record."""
                if rec.encrypted_index_share and len(rec.encrypted_index_share) > 0:
                    return Share(x=rec.share.x, y=int.from_bytes(rec.encrypted_index_share, "big"))
                # Legacy: no index share stored; fall back to share_y (will give wrong results)
                return rec.share

            local_index_share = _index_share(record)
            all_local_index_shares = [_index_share(r) for r in all_records]
            # Use the per-signal threshold declared at creation time, not the
            # global default. This is critical because signals created during
            # bootstrap may have threshold=2 while the orchestrator default is 7.
            signal_threshold = record.shamir_threshold
            try:
                mpc_result = await asyncio.wait_for(
                    _orchestrator.check_availability(
                        signal_id=signal_id,
                        local_share=local_index_share,
                        available_indices=available_set,
                        local_shares=all_local_index_shares,
                        threshold_override=signal_threshold,
                    ),
                    timeout=mpc_availability_timeout,
                )
            except TimeoutError:
                from djinn_validator.api.metrics import MPC_ERRORS

                MPC_ERRORS.labels(reason="timeout").inc()
                PURCHASES_PROCESSED.labels(result="error").inc()
                raise HTTPException(status_code=504, detail="MPC availability check timed out")

            purchase_orch.set_mpc_result(signal_id, req.buyer_address, mpc_result)

            if not mpc_result.available:
                PURCHASES_PROCESSED.labels(result="unavailable").inc()
                return PurchaseResponse(
                    signal_id=signal_id,
                    status="unavailable",
                    available=False,
                    message="Signal not available at this sportsbook",
                    mpc_participants=mpc_result.participating_validators,
                    mpc_failure_reason=mpc_result.failure_reason,
                )

            # Check for payment replay (TOCTOU prevention)
            if purchase_orch.is_payment_consumed(signal_id, req.buyer_address):
                PURCHASES_PROCESSED.labels(result="already_purchased").inc()
                # Return the previously released share if available
                record = share_store.get(signal_id)
                if record and req.buyer_address in record.released_to:
                    return PurchaseResponse(
                        signal_id=signal_id,
                        status="complete",
                        available=True,
                        encrypted_key_share=record.encrypted_key_share.hex(),
                        share_x=record.share.x,
                        message="Share already released (idempotent)",
                    )
                return PurchaseResponse(
                    signal_id=signal_id,
                    status="already_purchased",
                    available=True,
                    message="Payment already processed for this signal",
                )

            # Verify on-chain payment before releasing share
            if chain_client is not None:
                try:
                    on_chain_id = _signal_id_to_uint256(signal_id)
                    purchase_record = await asyncio.wait_for(
                        chain_client.verify_purchase(on_chain_id, req.buyer_address),
                        timeout=10.0,
                    )
                    if purchase_record.get("pricePaid", 0) == 0:
                        PURCHASES_PROCESSED.labels(result="payment_required").inc()
                        return PurchaseResponse(
                            signal_id=signal_id,
                            status="payment_required",
                            available=True,
                            message="On-chain payment not found. Call Escrow.purchase() first.",
                        )
                    tx_hash = f"verified-{on_chain_id}"
                except TimeoutError:
                    log.error("payment_verification_timeout", signal_id=signal_id)
                    raise HTTPException(
                        status_code=504,
                        detail="Payment verification timed out",
                    )
                except Exception as e:
                    log.error("payment_verification_error", signal_id=signal_id, err=str(e))
                    raise HTTPException(
                        status_code=502,
                        detail="Payment verification failed",
                    )
            else:
                # In production, refuse to release shares without payment verification
                if _is_production:
                    log.error(
                        "share_release_blocked",
                        signal_id=signal_id,
                        reason="No chain client in production — cannot verify payment",
                    )
                    raise HTTPException(
                        status_code=503,
                        detail="Payment verification unavailable. Validator misconfigured.",
                    )
                # Dev mode: no chain client configured — skip payment check
                log.warning(
                    "payment_check_skipped",
                    signal_id=signal_id,
                    reason="no chain client configured",
                )
                tx_hash = "dev-mode-no-verification"

            # Record the payment to prevent replay attacks
            if not purchase_orch.record_payment(signal_id, req.buyer_address, tx_hash, "PAYMENT_CONFIRMED"):
                log.warning("concurrent_payment_race", signal_id=signal_id, buyer=req.buyer_address)
                # Another concurrent request already recorded — wait briefly for share release
                for _retry in range(5):
                    record = share_store.get(signal_id)
                    if record and record.encrypted_key_share and req.buyer_address in record.released_to:
                        return PurchaseResponse(
                            signal_id=signal_id,
                            status="complete",
                            available=True,
                            encrypted_key_share=record.encrypted_key_share.hex(),
                            share_x=record.share.x,
                            message="Share already released (concurrent request)",
                        )
                    await asyncio.sleep(0.5)
                raise HTTPException(status_code=409, detail="Payment already processed — share not yet available, retry shortly")

            result = purchase_orch.confirm_payment(signal_id, req.buyer_address, tx_hash)
            if result is None or result.status == PurchaseStatus.FAILED:
                raise HTTPException(status_code=500, detail="Share release failed")

            # confirm_payment already released the share; read the encrypted key share
            record = share_store.get(signal_id)
            if record is None or record.encrypted_key_share is None:
                raise HTTPException(status_code=500, detail="Share release failed")
            share_data = record.encrypted_key_share

            # Mark payment as fully consumed (share released)
            purchase_orch.update_payment_status(signal_id, req.buyer_address, "SHARES_RELEASED")

            PURCHASES_PROCESSED.labels(result="available").inc()
            ACTIVE_SHARES.set(share_store.count)

            return PurchaseResponse(
                signal_id=signal_id,
                status="complete",
                available=True,
                encrypted_key_share=share_data.hex(),
                share_x=record.share.x,
                message="Key share released",
            )

    @app.post("/v1/signal/{signal_id}/register", response_model=RegisterSignalResponse)
    async def register_signal(signal_id: str, req: RegisterSignalRequest) -> RegisterSignalResponse:
        """Register a purchased signal for blind outcome tracking.

        Accepts all 10 public decoy lines (already committed on-chain).
        The validator resolves every line, producing 10 outcomes.  The real
        outcome is selected later by batch MPC at the audit-set level.
        """
        _validate_signal_id_path(signal_id)
        if req.sport not in SUPPORTED_SPORTS:
            raise HTTPException(status_code=400, detail="Unsupported sport key")
        parsed_lines = [parse_pick(line) for line in req.lines]
        metadata = SignalMetadata(
            signal_id=signal_id,
            sport=req.sport,
            event_id=req.event_id,
            home_team=req.home_team,
            away_team=req.away_team,
            lines=parsed_lines,
        )
        outcome_attestor.register_signal(metadata)

        # Add to audit set if genius/idiot addresses are provided
        if audit_set_store and req.genius_address and req.idiot_address:
            audit_set_store.add_signal(
                genius=req.genius_address,
                idiot=req.idiot_address,
                cycle=req.cycle,
                signal_id=signal_id,
                notional=req.notional,
                odds=req.odds,
                sla_bps=req.sla_bps,
            )

        return RegisterSignalResponse(
            signal_id=signal_id,
            registered=True,
            lines_count=len(parsed_lines),
        )

    @app.post("/v1/signals/resolve", response_model=ResolveResponse)
    async def resolve_signals() -> ResolveResponse:
        """Check all pending signals and resolve any with completed games.

        Resolution stores 10 line outcomes on each signal's metadata.
        Settlement happens later at the audit-set level via batch MPC.
        """
        hotkey = ""
        if neuron:
            hotkey = neuron.wallet.hotkey.ss58_address if neuron.wallet else ""

        try:
            resolved_ids = await asyncio.wait_for(
                outcome_attestor.resolve_all_pending(hotkey),
                timeout=30.0,
            )
        except TimeoutError:
            log.error("resolve_all_pending_timeout")
            raise HTTPException(status_code=504, detail="Signal resolution timed out")

        # Record outcomes on audit set store
        results = []
        for signal_id in resolved_ids:
            meta = outcome_attestor.get_signal(signal_id)
            if meta and meta.outcomes:
                if audit_set_store:
                    audit_set_store.record_outcomes(
                        signal_id, meta.outcomes,
                    )
                results.append({
                    "signal_id": signal_id,
                    "outcomes_count": len(meta.outcomes),
                })
        return ResolveResponse(resolved_count=len(resolved_ids), results=results)

    @app.get("/v1/audit/{genius}/{idiot}/status", response_model=AuditSetStatusResponse)
    async def audit_set_status(genius: str, idiot: str, cycle: int = 0) -> AuditSetStatusResponse:
        """Check the status of an audit set for a genius-idiot pair."""
        if audit_set_store is None:
            raise HTTPException(status_code=503, detail="Audit set store not configured")
        audit_set = audit_set_store.get_set(genius, idiot, cycle)
        if audit_set is None:
            raise HTTPException(status_code=404, detail="Audit set not found")
        resolved_count = sum(
            1 for s in audit_set.signals.values() if s.outcomes is not None
        )
        return AuditSetStatusResponse(
            genius=audit_set.genius_address,
            idiot=audit_set.idiot_address,
            cycle=audit_set.cycle,
            signals_count=len(audit_set.signals),
            resolved_count=resolved_count,
            ready=audit_set.ready_for_settlement,
            settled=audit_set.settled,
        )

    @app.post("/v1/signal/{signal_id}/outcome", response_model=OutcomeResponse)
    async def attest_outcome(signal_id: str, req: OutcomeRequest) -> OutcomeResponse:
        """Submit an outcome attestation for a signal."""
        _validate_signal_id_path(signal_id)
        try:
            event_result = await asyncio.wait_for(
                outcome_attestor.fetch_event_result(req.event_id),
                timeout=10.0,
            )
        except TimeoutError:
            log.error("fetch_event_result_timeout", event_id=req.event_id)
            raise HTTPException(status_code=504, detail="Event result fetch timed out")
        outcome = Outcome(req.outcome)

        outcome_attestor.attest(
            signal_id=signal_id,
            validator_hotkey=req.validator_hotkey,
            outcome=outcome,
            event_result=event_result,
        )
        OUTCOMES_ATTESTED.labels(outcome=outcome.value).inc()

        # Check if consensus is reached
        if neuron and neuron.metagraph:
            total_validators = sum(
                1 for uid in range(neuron.metagraph.n.item()) if neuron.metagraph.validator_permit[uid].item()
            )
        else:
            total_validators = 1  # Single-validator dev mode
            log.warning("no_metagraph", msg="Using total_validators=1 (no metagraph available)")

        consensus = outcome_attestor.check_consensus(signal_id, total_validators)

        return OutcomeResponse(
            signal_id=signal_id,
            outcome=req.outcome,
            consensus_reached=consensus is not None,
            consensus_outcome=consensus.value if consensus else None,
        )

    # ------------------------------------------------------------------
    # Web Attestation (whitepaper §15 — pure Bittensor)
    # ------------------------------------------------------------------

    import os as _os
    _ATTEST_MAX_CONCURRENT = int(_os.environ.get("ATTEST_MAX_CONCURRENT", "15"))
    _attest_semaphore = asyncio.Semaphore(_ATTEST_MAX_CONCURRENT)

    # Per-miner circuit breakers: 3 consecutive failures -> open for 60s.
    # Prevents wasting parallel fan-out slots on miners whose sidecar is down.
    _miner_breakers: dict[int, CircuitBreaker] = {}

    def _get_miner_breaker(uid: int, _active_uids: set[int] | None = None) -> CircuitBreaker:
        if uid not in _miner_breakers:
            # Prune stale entries when dict grows too large
            if len(_miner_breakers) > 500 and _active_uids:
                stale = [u for u in _miner_breakers if u not in _active_uids]
                for u in stale:
                    del _miner_breakers[u]
                if stale:
                    log.info("miner_breakers_pruned", count=len(stale))
            _miner_breakers[uid] = CircuitBreaker(
                name=f"miner_{uid}",
                failure_threshold=3,
                recovery_timeout=60.0,
            )
        return _miner_breakers[uid]

    @app.get("/v1/attest/capacity")
    async def attest_capacity() -> dict:
        """Return current attestation capacity for admission control."""
        inflight = _ATTEST_MAX_CONCURRENT - _attest_semaphore._value
        return {
            "inflight": inflight,
            "max": _ATTEST_MAX_CONCURRENT,
            "available": _attest_semaphore._value,
        }

    @app.post("/v1/attest", response_model=AttestResponse)
    async def attest_url(req: AttestRequest) -> AttestResponse:
        """Dispatch a TLSNotary attestation request to a miner and verify the proof.

        Flow:
        1. Check admission control — reject immediately if at capacity
        2. Rank miners by attestation track record (proven > unproven > failed)
        3. Try up to 3 miners sequentially with short timeouts
        4. Verify the returned TLSNotary proof
        5. Return the verified proof to the caller
        """
        import json as _json
        import time as _t
        import httpx

        # Admission control: reject immediately if at capacity
        if _attest_semaphore._value <= 0:
            return AttestResponse(
                request_id=req.request_id,
                url=req.url,
                success=False,
                error="Validator at capacity -- try another validator",
                busy=True,
                retry_after=30,
            )

        async with _attest_semaphore:
            return await _attest_url_inner(req)

    async def _attest_url_inner(req: AttestRequest) -> AttestResponse:
        import json as _json
        import time as _t
        import httpx
        from djinn_validator.core.challenges import (
            assign_peer_notary,
            discover_peer_notaries,
        )

        start = _t.perf_counter()
        ATTESTATION_DISPATCHED.inc()

        # Resolve redirects to get the canonical URL so the TLS server_name
        # in the proof matches what we verify against (e.g. hackernews.com → news.ycombinator.com)
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=10.0) as client:
                head = await client.head(req.url)
                resolved_url = str(head.url)
                if resolved_url != req.url:
                    log.info("attest_url_resolved", original=req.url, resolved=resolved_url)
                    req = AttestRequest(url=resolved_url, request_id=req.request_id)
        except Exception as e:
            log.debug("attest_redirect_check_failed", url=req.url, error=str(e))

        # Build axon lookup by UID
        axon_by_uid: dict[int, dict] = {}
        if neuron:
            for uid in neuron.get_miner_uids():
                try:
                    axon = neuron.get_axon_info(uid)
                    ip = axon.get("ip", "")
                    port = axon.get("port", 0)
                    if ip and port:
                        axon_by_uid[uid] = {
                            "uid": uid, "ip": ip, "port": port,
                            "hotkey": axon.get("hotkey", ""),
                        }
                except (IndexError, KeyError, AttributeError) as exc:
                    log.warning("attest_axon_lookup_failed", uid=uid, error=str(exc))

        # Discover peer notaries from the metagraph, then filter to only
        # notaries whose miners have a verified proactive proof. This ensures
        # we only assign notaries with working TLSNotary binaries, not v726
        # miners that pass WebSocket handshake but have broken MPC.
        peer_notaries = []
        if axon_by_uid:
            try:
                all_notaries = await discover_peer_notaries(
                    _attest_client, list(axon_by_uid.values())
                )
                # Filter notaries by binary version compatibility.
                # MPC requires matching binary versions. Different builds of
                # the TLSNotary library are not interoperable.
                if scorer is not None:
                    verified = [
                        n for n in all_notaries
                        if (m := scorer.get(n.uid)) is not None and m.proactive_proof_verified
                    ]
                    if not verified:
                        peer_notaries = all_notaries
                        log.info("attest_peer_notaries_no_verified", total=len(all_notaries))
                    else:
                        # Group verified notaries by binary hash
                        by_hash: dict[str, list] = {}
                        for n in verified:
                            m = scorer.get(n.uid)
                            bh = m.tlsn_binary_hash if m else ""
                            by_hash.setdefault(bh or "unknown", []).append(n)

                        # Find the binary hash of the candidate miners (provers).
                        # Prefer notaries matching the prover's binary hash.
                        # Collect all prover binary hashes from the candidate pool.
                        prover_hashes: set[str] = set()
                        for uid_key in axon_by_uid:
                            pm = scorer.get(uid_key)
                            if pm and pm.tlsn_binary_hash:
                                prover_hashes.add(pm.tlsn_binary_hash)

                        # Select notaries matching any prover's binary hash
                        compatible = []
                        for bh in prover_hashes:
                            compatible.extend(by_hash.get(bh, []))

                        if compatible:
                            peer_notaries = compatible
                            log.info("attest_peer_notaries_version_matched",
                                     matched=len(compatible), verified=len(verified),
                                     total=len(all_notaries), hashes=list(prover_hashes))
                        else:
                            # No version match; fall back to all verified
                            peer_notaries = verified
                            log.info("attest_peer_notaries_no_version_match",
                                     verified=len(verified), total=len(all_notaries))
                else:
                    peer_notaries = all_notaries
                log.info("attest_peer_notaries_discovered", count=len(peer_notaries))
            except Exception as e:
                log.warning("attest_peer_notary_discovery_failed", error=str(e))

        # Smart miner selection: proven miners first, then unproven.
        # Skip miners whose circuit breaker is open (known-down sidecars).
        candidates: list[tuple[dict, str]] = []  # (axon_info, tier)
        breaker_deferred: list[tuple[dict, str]] = []  # circuit-broken, appended last
        if scorer is not None and axon_by_uid:
            ranked = scorer.select_attest_miners(list(axon_by_uid.keys()))
            for uid, tier in ranked:
                if uid in axon_by_uid:
                    breaker = _get_miner_breaker(uid)
                    if breaker.allow_request():
                        candidates.append((axon_by_uid[uid], tier))
                    else:
                        breaker_deferred.append((axon_by_uid[uid], tier))
            candidates.extend(breaker_deferred)

        # Fallback: if scorer has no data yet, try all miners with health responses
        if not candidates and axon_by_uid:
            for uid, axon in list(axon_by_uid.items())[:5]:
                breaker = _get_miner_breaker(uid)
                if breaker.allow_request():
                    candidates.append((axon, "unproven"))

        # Last resort: configured fallback miner URL
        if not candidates and fallback_miner_url:
            candidates.append((
                {"uid": -1, "ip": "", "port": 0, "hotkey": "fallback",
                 "_url": fallback_miner_url.rstrip("/") + "/v1/attest"},
                "fallback",
            ))

        if not candidates:
            if attestation_log is not None:
                attestation_log.log_attestation(
                    url=req.url, request_id=req.request_id,
                    success=False, verified=False,
                    error="No reachable miners available",
                )
            return AttestResponse(
                request_id=req.request_id,
                url=req.url,
                success=False,
                error="No reachable miners available",
            )

        log.info(
            "attest_candidates",
            url=req.url,
            request_id=req.request_id,
            candidates=[(c[0]["uid"], c[1]) for c in candidates],
        )

        # Fan out to up to 5 miners in parallel, first success wins
        last_error = "No miners attempted"
        miner_data: dict | None = None
        selected: dict | None = None
        proof_hex: str | None = None
        selected_notary_uid: int | None = None
        selected_notary_pubkey: str | None = None
        _failed_notary_uids: set[int] = set()
        _notary_assignment_counts: dict[int, int] = {}

        async def _try_miner(axon: dict, tier: str) -> tuple[dict, dict, str, float, int | None, str | None] | None:
            """Try one miner. Returns (axon, data, proof_hex, elapsed_s, notary_uid, notary_pubkey) on success."""
            attempt_start = _t.perf_counter()
            miner_url = axon.get("_url") or f"http://{axon['ip']}:{axon['port']}/v1/attest"
            tier_timeout = 210.0 if tier == "proven" else 60.0 if tier == "redemption" else 120.0
            timeout = min(req.timeout or tier_timeout, 600.0)
            breaker = _get_miner_breaker(axon["uid"]) if axon["uid"] >= 0 else None

            # Assign a peer notary, using pair history to prefer compatible notaries
            _prover_metrics = scorer.get(axon["uid"]) if scorer else None
            assigned_notary = assign_peer_notary(
                axon["uid"], peer_notaries, prover_ip=axon.get("ip"),
                assignment_counts=_notary_assignment_counts,
                max_per_notary=2,
                exclude_uids=_failed_notary_uids,
                pair_successes=_prover_metrics.notary_pair_successes if _prover_metrics else None,
                pair_failures=_prover_metrics.notary_pair_failures if _prover_metrics else None,
            )

            payload: dict = {"url": req.url, "request_id": req.request_id}
            if assigned_notary:
                payload["notary_host"] = assigned_notary.ip
                payload["notary_port"] = assigned_notary.port
                payload["notary_ws"] = True

            _body = _json.dumps(payload).encode()
            _auth_hdrs: dict[str, str] = {}
            if neuron and neuron.wallet:
                from djinn_validator.api.middleware import create_signed_headers
                _auth_hdrs = create_signed_headers("/v1/attest", _body, neuron.wallet)

            log.info(
                "attest_dispatching",
                url=req.url,
                request_id=req.request_id,
                miner_uid=axon["uid"],
                tier=tier,
                timeout_s=timeout,
                peer_notary=assigned_notary.uid if assigned_notary else None,
            )

            try:
                resp = await _attest_client.post(
                    miner_url,
                    content=_body,
                    headers={"Content-Type": "application/json", **_auth_hdrs},
                    timeout=timeout,
                )
            except httpx.HTTPError as e:
                elapsed = _t.perf_counter() - attempt_start
                log.warning("attest_miner_unreachable", miner_uid=axon["uid"], tier=tier, err=str(e), elapsed_s=round(elapsed, 1))
                if breaker:
                    breaker.record_failure()
                if scorer is not None and axon["uid"] >= 0:
                    m = scorer.get_or_create(axon["uid"], axon.get("hotkey", ""))
                    m.record_attestation(latency=elapsed, proof_valid=False)
                if assigned_notary:
                    _failed_notary_uids.add(assigned_notary.uid)
                return None

            if resp.status_code != 200:
                log.warning("attest_miner_error", miner_uid=axon["uid"], status=resp.status_code)
                if breaker:
                    breaker.record_failure()
                if scorer is not None and axon["uid"] >= 0:
                    m = scorer.get_or_create(axon["uid"], axon.get("hotkey", ""))
                    m.record_attestation(latency=_t.perf_counter() - attempt_start, proof_valid=False)
                if assigned_notary:
                    _failed_notary_uids.add(assigned_notary.uid)
                return None

            try:
                data = resp.json()
            except Exception:
                log.error("miner_malformed_json", miner_uid=axon["uid"])
                if breaker:
                    breaker.record_failure()
                if scorer is not None and axon["uid"] >= 0:
                    m = scorer.get_or_create(axon["uid"], axon.get("hotkey", ""))
                    m.record_attestation(latency=_t.perf_counter() - attempt_start, proof_valid=False)
                return None

            # Miner busy -- skip without penalising (not a notary failure)
            if data.get("busy"):
                log.info("attest_miner_busy", miner_uid=axon["uid"])
                return None

            if not data.get("success"):
                err = data.get("error", f"Miner {axon['uid']} attestation failed")
                if breaker:
                    breaker.record_failure()
                if scorer is not None and axon["uid"] >= 0:
                    m = scorer.get_or_create(axon["uid"], axon.get("hotkey", ""))
                    m.record_attestation(latency=_t.perf_counter() - attempt_start, proof_valid=False)
                # If the error mentions notary/WebSocket, mark that notary as failed
                if assigned_notary and ("notary" in err.lower() or "websocket" in err.lower() or "bridge" in err.lower()):
                    _failed_notary_uids.add(assigned_notary.uid)
                log.warning("attest_miner_failed", miner_uid=axon["uid"], error=err)
                return None

            phex = data.get("proof_hex")
            if not phex:
                log.warning("attest_miner_no_proof_hex", miner_uid=axon["uid"])
                if breaker:
                    breaker.record_failure()
                if scorer is not None and axon["uid"] >= 0:
                    m = scorer.get_or_create(axon["uid"], axon.get("hotkey", ""))
                    m.record_attestation(latency=_t.perf_counter() - attempt_start, proof_valid=False)
                return None

            # Miner produced a proof -- record circuit breaker success
            if breaker:
                breaker.record_success()

            return (
                axon, data, phex, _t.perf_counter() - attempt_start,
                assigned_notary.uid if assigned_notary else None,
                assigned_notary.pubkey_hex if assigned_notary else None,
            )

        # Launch parallel tasks for all candidates (up to 5)
        import asyncio as _aio

        pick = candidates[:5]
        tasks = [_aio.create_task(_try_miner(axon, tier)) for axon, tier in pick]

        async def _score_runner_ups(
            remaining: list[_aio.Task],
            _scorer: object,
            _url: str,
        ) -> None:
            """Background: let remaining miners finish and credit them."""
            for t in remaining:
                try:
                    result = await t
                except Exception:
                    continue
                if result is not None:
                    axon, _data, _phex, elapsed = result
                    if _scorer is not None and axon["uid"] >= 0:
                        m = _scorer.get_or_create(axon["uid"], axon.get("hotkey", ""))
                        m.record_attestation(latency=elapsed, proof_valid=True)
                        log.info(
                            "attest_runner_up_credited",
                            miner_uid=axon["uid"],
                            elapsed_s=round(elapsed, 1),
                            url=_url,
                        )

        # Process results as they complete — first success wins
        for coro in _aio.as_completed(tasks):
            try:
                result = await coro
            except Exception as e:
                log.warning("attest_miner_task_error", error=str(e))
                continue
            if result is not None:
                selected, miner_data, proof_hex = result[0], result[1], result[2]
                selected_notary_uid = result[4]
                selected_notary_pubkey = result[5]
                # Let remaining miners finish in background — they deserve credit
                remaining = [t for t in tasks if not t.done()]
                if remaining and scorer is not None:
                    _aio.create_task(_score_runner_ups(remaining, scorer, req.url))
                break
            else:
                last_error = "All attempted miners failed or were busy"

        # All attempts failed
        if selected is None or miner_data is None or proof_hex is None:
            elapsed = _t.perf_counter() - start
            ATTESTATION_DURATION.observe(elapsed)
            ATTESTATION_VERIFIED.labels(valid="false").inc()
            if attestation_log is not None:
                attestation_log.log_attestation(
                    url=req.url, request_id=req.request_id,
                    success=False, verified=False,
                    elapsed_s=round(elapsed, 2),
                    error=last_error,
                )
            return AttestResponse(
                request_id=req.request_id,
                url=req.url,
                success=False,
                error=last_error,
                busy=True,
                retry_after=15,
            )

        # Verify the TLSNotary proof
        from djinn_validator.core import tlsn as tlsn_verifier
        from urllib.parse import urlparse

        try:
            proof_bytes = bytes.fromhex(proof_hex)
        except (ValueError, TypeError):
            elapsed = _t.perf_counter() - start
            ATTESTATION_DURATION.observe(elapsed)
            ATTESTATION_VERIFIED.labels(valid="false").inc()
            if scorer is not None and selected["uid"] >= 0:
                miner_metrics = scorer.get_or_create(selected["uid"], selected.get("hotkey", ""))
                miner_metrics.record_attestation(latency=elapsed, proof_valid=False)
            if attestation_log is not None:
                attestation_log.log_attestation(
                    url=req.url, request_id=req.request_id,
                    success=False, verified=False,
                    miner_uid=selected["uid"], notary_uid=selected_notary_uid,
                    elapsed_s=round(elapsed, 2),
                    error="Miner returned invalid proof hex",
                )
            return AttestResponse(
                request_id=req.request_id,
                url=req.url,
                success=False,
                error="Miner returned invalid proof hex",
            )
        expected_server = urlparse(req.url).hostname

        try:
            verify_result = await asyncio.wait_for(
                tlsn_verifier.verify_proof(
                    proof_bytes,
                    expected_server=expected_server,
                    expected_notary_key=selected_notary_pubkey,
                ),
                timeout=30.0,
            )
        except TimeoutError:
            elapsed = _t.perf_counter() - start
            ATTESTATION_DURATION.observe(elapsed)
            ATTESTATION_VERIFIED.labels(valid="false").inc()
            # Miner DID generate a proof — credit the attempt even though verification timed out
            if scorer is not None and selected["uid"] >= 0:
                miner_metrics = scorer.get_or_create(selected["uid"], selected.get("hotkey", ""))
                miner_metrics.record_attestation(latency=elapsed, proof_valid=False)
            if attestation_log is not None:
                attestation_log.log_attestation(
                    url=req.url, request_id=req.request_id,
                    success=True, verified=False,
                    server_name=miner_data.get("server_name"),
                    miner_uid=selected["uid"], notary_uid=selected_notary_uid,
                    elapsed_s=round(elapsed, 2),
                    error="Proof verification timed out",
                )
            return AttestResponse(
                request_id=req.request_id,
                url=req.url,
                success=True,
                verified=False,
                proof_hex=proof_hex,
                server_name=miner_data.get("server_name"),
                timestamp=miner_data.get("timestamp", 0),
                miner_uid=selected["uid"] if selected else None,
                notary_uid=selected_notary_uid,
                error="Proof verification timed out",
            )

        elapsed = _t.perf_counter() - start
        ATTESTATION_DURATION.observe(elapsed)
        ATTESTATION_VERIFIED.labels(valid=str(verify_result.verified).lower()).inc()

        # Record attestation performance in scorer for weight setting
        if scorer is not None and selected["uid"] >= 0:
            miner_metrics = scorer.get_or_create(
                selected["uid"], selected.get("hotkey", "")
            )
            miner_metrics.record_attestation(
                latency=elapsed, proof_valid=verify_result.verified
            )
            # Track pair success/failure for future notary assignment
            if selected_notary_uid is not None:
                if verify_result.verified:
                    miner_metrics.notary_pair_successes[selected_notary_uid] = \
                        miner_metrics.notary_pair_successes.get(selected_notary_uid, 0) + 1
                else:
                    miner_metrics.notary_pair_failures[selected_notary_uid] = \
                        miner_metrics.notary_pair_failures.get(selected_notary_uid, 0) + 1

        # Detect bot challenge / protection walls in the response
        is_blocked = _detect_bot_challenge(verify_result.response_body)

        log.info(
            "attest_complete",
            url=req.url,
            request_id=req.request_id,
            verified=verify_result.verified,
            blocked=is_blocked,
            server=verify_result.server_name,
            elapsed_s=round(elapsed, 1),
        )

        if attestation_log is not None:
            attestation_log.log_attestation(
                url=req.url,
                request_id=req.request_id,
                success=True,
                verified=verify_result.verified,
                server_name=verify_result.server_name,
                miner_uid=selected["uid"],
                notary_uid=selected_notary_uid,
                elapsed_s=round(elapsed, 2),
                error="Site served bot challenge" if is_blocked else (verify_result.error if not verify_result.verified else None),
            )

        return AttestResponse(
            request_id=req.request_id,
            url=req.url,
            success=True,
            verified=verify_result.verified,
            proof_hex=proof_hex,
            response_body=verify_result.response_body or None,
            server_name=verify_result.server_name or miner_data.get("server_name"),
            timestamp=miner_data.get("timestamp", 0),
            miner_uid=selected["uid"] if selected else None,
            notary_uid=selected_notary_uid,
            blocked=is_blocked,
            error=verify_result.error if not verify_result.verified else None,
        )

    @app.get("/v1/admin/attestations", dependencies=[_admin_auth])
    async def admin_attestations(limit: int = 50) -> dict:
        """Recent attestation requests with full details."""
        if attestation_log is None:
            return {"attestations": []}
        return {"attestations": attestation_log.recent_attestations(max(1, min(limit, 200)))}

    @app.get("/v1/admin/metrics/timeseries", dependencies=[_admin_auth])
    async def admin_timeseries(hours: int = 168, bucket: int = 3600) -> dict:
        """Time-series metrics for the admin dashboard.

        Args:
            hours: How many hours of history (default 168 = 7 days).
            bucket: Bucket width in seconds (default 3600 = 1 hour).
        """
        import time as _ts
        since = _ts.time() - max(1, min(hours, 720)) * 3600
        bucket_s = max(300, min(bucket, 86400))  # 5min to 1day

        # Attestation time-series
        attest_buckets: list[dict] = []
        if attestation_log is not None:
            attest_buckets = attestation_log.timeseries(
                since=int(since), bucket_seconds=bucket_s,
            )

        # Challenge / weight telemetry time-series
        challenge_buckets: list[dict] = []
        weight_buckets: list[dict] = []
        if telemetry is not None:
            raw = telemetry.timeseries(
                categories=[
                    "challenge_round", "attestation_challenge",
                    "weight_set", "weight_set_failed",
                ],
                since=since,
                bucket_seconds=bucket_s,
            )
            # Aggregate challenge rounds
            for b in raw.get("challenge_round", []):
                challenged = sum(d.get("miners_challenged", d.get("challenged", 0)) for d in b["details"])
                responded = sum(d.get("responding", d.get("responded", 0)) for d in b["details"])
                correct = sum(
                    sum(1 for mr in d.get("miners", []) if mr.get("correct"))
                    for d in b["details"]
                )
                challenge_buckets.append({
                    "t": b["t"],
                    "rounds": b["count"],
                    "challenged": challenged,
                    "responded": responded,
                    "correct": correct,
                })
            # Aggregate weight setting
            ws_by_t: dict[int, dict] = {}
            for b in raw.get("weight_set", []):
                ws_by_t.setdefault(b["t"], {"t": b["t"], "attempts": 0, "success": 0, "failed": 0})
                ws_by_t[b["t"]]["attempts"] += b["count"]
                ws_by_t[b["t"]]["success"] += b["count"]
            for b in raw.get("weight_set_failed", []):
                ws_by_t.setdefault(b["t"], {"t": b["t"], "attempts": 0, "success": 0, "failed": 0})
                ws_by_t[b["t"]]["attempts"] += b["count"]
                ws_by_t[b["t"]]["failed"] += b["count"]
            weight_buckets = sorted(ws_by_t.values(), key=lambda x: x["t"])

        return {
            "attestations": attest_buckets,
            "challenges": challenge_buckets,
            "weights": weight_buckets,
            "bucket_seconds": bucket_s,
        }

    @app.post("/v1/check")
    async def check_lines(request: Request) -> dict:
        """Proxy a line-check request to a miner with signed auth.

        The web client cannot call miners directly because miner auth
        requires the caller IP to be a registered subnet neuron or
        a signed request from a validator hotkey.  This endpoint lets
        buyers verify lines by routing through the validator.
        """
        import json as _json
        import random as _random
        from djinn_validator.api.middleware import create_signed_headers

        body = await request.body()

        # Validate payload is JSON with a "lines" array
        try:
            payload = _json.loads(body)
            if not isinstance(payload.get("lines"), list):
                raise HTTPException(status_code=400, detail="Missing 'lines' array")
            if len(payload["lines"]) > 20:
                raise HTTPException(status_code=400, detail="Too many lines (max 20)")
        except _json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid JSON")

        # Find a reachable miner
        if not neuron:
            raise HTTPException(status_code=503, detail="Validator not connected to network")

        miner_uids = neuron.get_miner_uids()
        if not miner_uids:
            raise HTTPException(status_code=503, detail="No miners available")

        _random.shuffle(miner_uids)
        last_error = ""
        for uid in miner_uids[:5]:  # try up to 5 miners
            axon = neuron.get_axon_info(uid)
            ip = axon.get("ip", "")
            port = axon.get("port", 0)
            if not ip or not port or ip in ("0.0.0.0", "127.0.0.1"):
                continue

            check_url = f"http://{ip}:{port}/v1/check"
            auth_headers: dict[str, str] = {}
            if neuron.wallet:
                auth_headers = create_signed_headers("/v1/check", body, neuron.wallet)

            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.post(
                        check_url,
                        content=body,
                        headers={"Content-Type": "application/json", **auth_headers},
                        timeout=10.0,
                    )
                    if resp.status_code == 200:
                        log.info("check_proxy_ok", miner_uid=uid)
                        return resp.json()
                    last_error = f"Miner {uid} returned HTTP {resp.status_code}"
                    log.warning("check_proxy_error", miner_uid=uid, status=resp.status_code)
            except Exception as e:
                last_error = f"Miner {uid}: {e}"
                log.warning("check_proxy_failed", miner_uid=uid, error=str(e))

        raise HTTPException(status_code=502, detail=f"All miners unreachable: {last_error}")

    @app.post("/v1/analytics/attempt")
    async def analytics(req: AnalyticsRequest) -> dict:
        """Fire-and-forget analytics endpoint."""
        truncated = {k: v for k, v in list(req.data.items())[:20]}
        log.info("analytics", event_type=req.event_type, data=truncated)
        return {"received": True}

    @app.get("/v1/identity", response_model=IdentityResponse)
    async def identity() -> IdentityResponse:
        """Return this validator's identity for peer discovery.

        Used by other validators running metagraph sync to discover
        this validator's Base (EVM) address.
        """
        from djinn_validator import __version__

        base_addr = chain_client.validator_address if chain_client else ""
        hotkey = ""
        if neuron and neuron.wallet:
            hotkey = neuron.wallet.hotkey.ss58_address
        return IdentityResponse(
            base_address=base_addr or "",
            hotkey=hotkey,
            version=__version__,
        )

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        """Health check endpoint."""
        chain_ok = False
        if chain_client:
            try:
                chain_ok = await chain_client.is_connected()
            except Exception as e:
                log.warning("chain_health_check_failed", error=str(e))

        from djinn_validator import __version__
        from djinn_validator.core import tlsn as _tlsn_mod
        return HealthResponse(
            status="ok",
            version=__version__,
            uid=neuron.uid if neuron else None,
            shares_held=share_store.count,
            pending_outcomes=len(outcome_attestor.get_pending_signals()),
            chain_connected=chain_ok,
            bt_connected=neuron is not None and neuron.uid is not None,
            attest_capable=_tlsn_mod.is_available(),
        )

    # Cache Config for readiness checks (avoid re-loading dotenv on every probe)
    from djinn_validator.config import Config as _ConfigCls

    _readiness_config = _ConfigCls()

    @app.get("/health/ready", response_model=ReadinessResponse)
    async def readiness() -> ReadinessResponse:
        """Deep readiness probe — checks RPC, contracts, and dependencies."""
        checks: dict[str, bool] = {}

        # Check RPC connectivity
        if chain_client:
            try:
                checks["rpc"] = await chain_client.is_connected()
            except Exception as e:
                log.warning("readiness_check_failed", check="rpc", error=str(e))
                checks["rpc"] = False
        else:
            checks["rpc"] = False

        # Check contract addresses are configured (non-zero)
        try:
            cfg = _readiness_config
            zero = "0" * 40
            checks["escrow_configured"] = bool(cfg.escrow_address) and zero not in cfg.escrow_address
            checks["signal_configured"] = (
                bool(cfg.signal_commitment_address) and zero not in cfg.signal_commitment_address
            )
            checks["account_configured"] = bool(cfg.account_address) and zero not in cfg.account_address
            checks["collateral_configured"] = bool(cfg.collateral_address) and zero not in cfg.collateral_address
        except Exception as e:
            log.warning("readiness_config_error", error=str(e))
            checks["escrow_configured"] = False
            checks["signal_configured"] = False
            checks["account_configured"] = False
            checks["collateral_configured"] = False

        # Bittensor connectivity
        checks["bt_connected"] = neuron is not None and neuron.uid is not None

        # Database accessibility
        try:
            _ = share_store.count
            checks["database"] = True
        except Exception as e:
            log.warning("readiness_check_failed", check="database", error=str(e))
            checks["database"] = False

        ready = all(checks.values())
        return ReadinessResponse(ready=ready, checks=checks)

    # ------------------------------------------------------------------
    # Signal status (lightweight share availability check)
    # ------------------------------------------------------------------

    @app.get("/v1/signal/{signal_id}/status")
    async def signal_status(signal_id: str) -> dict:
        """Check if this validator holds shares for a signal (no auth required)."""
        _validate_signal_id_path(signal_id)
        records = share_store.get_all(signal_id)
        return {"signal_id": signal_id, "has_shares": len(records) > 0}

    # ------------------------------------------------------------------
    # Activity log
    # ------------------------------------------------------------------

    @app.get("/v1/activity", dependencies=[_admin_auth])
    async def get_activity(
        limit: int = 100,
        category: str | None = None,
    ) -> dict:
        """Return recent validator activity events for admin dashboard."""
        if activity_buffer is None:
            return {"events": [], "total": 0}
        safe_limit = max(1, min(500, limit))
        events = activity_buffer.recent(limit=safe_limit, category=category)
        return {"events": events, "total": len(events)}

    @app.get("/v1/telemetry", dependencies=[_admin_auth])
    async def get_telemetry(
        limit: int = 200,
        since: float | None = None,
        category: str | None = None,
        offset: int = 0,
    ) -> dict:
        """Query persistent telemetry events. Full history, newest first."""
        if telemetry is None:
            return {"events": [], "total": 0}
        events = telemetry.query(limit=limit, since=since, category=category, offset=offset)
        total = telemetry.count(category=category)
        return {"events": events, "total": total}

    # ------------------------------------------------------------------
    # Miner score lookup
    # ------------------------------------------------------------------

    @app.get("/v1/miner/{uid}/scores", dependencies=[_admin_auth])
    async def miner_scores(uid: int) -> dict:
        """Return current live scoring metrics for a specific miner UID."""
        if scorer is None:
            return {"uid": uid, "found": False}
        m = scorer.get(uid)
        if m is None:
            return {"uid": uid, "found": False}
        return {
            "uid": uid,
            "found": True,
            "hotkey": m.hotkey,
            "accuracy": round(m.accuracy_score(), 4),
            "coverage": round(m.coverage_score(), 4),
            "uptime": round(m.uptime_score(), 4),
            "attest_validity": round(m.attestation_validity_score(), 4),
            "queries_total": m.queries_total,
            "queries_correct": m.queries_correct,
            "proofs_submitted": m.proofs_submitted,
            "proofs_verified": m.proofs_verified,
            "proofs_requested": m.proofs_requested,
            "attestations_total": m.attestations_total,
            "attestations_valid": m.attestations_valid,
            "health_checks_total": m.health_checks_total,
            "health_checks_responded": m.health_checks_responded,
            "consecutive_epochs": m.consecutive_epochs,
            "notary_duties_assigned": m.notary_duties_assigned,
            "notary_duties_completed": m.notary_duties_completed,
            "notary_reliability": round(m.notary_reliability(), 4),
            "proactive_proof_verified": m.proactive_proof_verified,
        }

    # ------------------------------------------------------------------
    # Shared HTTP client for attestation dispatch (connection reuse)
    # ------------------------------------------------------------------
    _attest_client = httpx.AsyncClient(
        timeout=120.0,
        limits=httpx.Limits(max_keepalive_connections=10, max_connections=50),
    )
    _cleanup_resources.append(_attest_client)

    # ------------------------------------------------------------------
    # MPC orchestration
    # ------------------------------------------------------------------
    _mpc = mpc_coordinator or MPCCoordinator()
    _orchestrator = MPCOrchestrator(
        coordinator=_mpc,
        neuron=neuron,
        threshold=shares_threshold,
    )
    _cleanup_resources.append(_orchestrator)

    # Per-session participant state for the distributed MPC protocol.
    # Keyed by session_id. Stores either DistributedParticipantState (semi-honest)
    # or AuthenticatedParticipantState (SPDZ malicious security).
    import threading as _threading
    import time as _time

    from djinn_validator.core.spdz import AuthenticatedParticipantState, AuthenticatedShare, MACKeyShare

    _participant_states: dict[str, DistributedParticipantState | AuthenticatedParticipantState] = {}
    _participant_created: dict[str, float] = {}  # session_id -> monotonic timestamp
    _participant_lock = _threading.Lock()

    _PARTICIPANT_TTL = 120  # seconds before stale participant states are cleaned up
    _MAX_PARTICIPANT_STATES = 500

    def _cleanup_stale_participants_locked() -> int:
        """Remove participant states older than _PARTICIPANT_TTL. Caller holds _participant_lock."""
        now = _time.monotonic()
        stale = [sid for sid, ts in _participant_created.items() if now - ts > _PARTICIPANT_TTL]
        for sid in stale:
            _participant_states.pop(sid, None)
            _participant_created.pop(sid, None)
        if stale:
            log.info("participant_state_cleanup", evicted=len(stale))
        return len(stale)

    # Collect validator hotkeys from metagraph for auth
    def _get_validator_hotkeys() -> set[str] | None:
        """Get set of validator hotkeys from metagraph for MPC auth."""
        if neuron is None or neuron.metagraph is None:
            return None  # No auth in dev mode
        hotkeys = set()
        for uid in range(neuron.metagraph.n.item()):
            if neuron.metagraph.validator_permit[uid].item():
                hotkeys.add(neuron.metagraph.hotkeys[uid])
        return hotkeys if hotkeys else None

    @app.post("/v1/mpc/init", response_model=MPCInitResponse)
    async def mpc_init(req: MPCInitRequest, request: Request) -> MPCInitResponse:
        """Accept an MPC session invitation from the coordinator."""
        await validate_signed_request(request, _get_validator_hotkeys())

        # Clean up expired sessions to prevent memory leak
        _mpc.cleanup_expired()
        with _participant_lock:
            _cleanup_stale_participants_locked()
        with _ot_lock:
            _cleanup_stale_ot_states_locked()

        session = _mpc.get_session(req.session_id)
        if session is not None:
            return MPCInitResponse(
                session_id=req.session_id,
                accepted=True,
                message="Session already exists",
            )

        # Create session locally (participant mirrors coordinator state).
        # Pass empty pre_generated_triples to skip wasteful OT triple
        # generation. The peer uses the coordinator's triple shares (from
        # req.triple_shares), not locally-generated ones.
        session = _mpc.create_session(
            signal_id=req.signal_id,
            available_indices=req.available_indices,
            coordinator_x=req.coordinator_x,
            participant_xs=req.participant_xs,
            threshold=req.threshold,
            pre_generated_triples=[],
        )
        # Override the session_id to match coordinator's
        if not _mpc.replace_session_id(session.session_id, req.session_id):
            raise HTTPException(status_code=409, detail="Session ID conflict")

        # Create distributed participant state if r_share provided
        if req.r_share_y is not None:
            # Look up our local share for this signal
            record = share_store.get(req.signal_id)
            if record is None:
                log.warning("mpc_init_no_share", signal_id=req.signal_id)
                return MPCInitResponse(
                    session_id=req.session_id,
                    accepted=False,
                    message="No share held for this signal",
                )

            # Use the real-index share for MPC (not the AES key share)
            if record.encrypted_index_share and len(record.encrypted_index_share) > 0:
                index_share_y = int.from_bytes(record.encrypted_index_share, "big")
            else:
                index_share_y = record.share.y  # Legacy fallback

            try:
                if req.authenticated and req.auth_triple_shares and req.alpha_share and req.auth_r_share:
                    # SPDZ authenticated mode — validate all field elements
                    alpha_val = _parse_field_hex(req.alpha_share, "alpha_share")
                    r_y = _parse_field_hex(req.auth_r_share["y"], "auth_r_share.y")
                    r_mac = _parse_field_hex(req.auth_r_share["mac"], "auth_r_share.mac")

                    # Use auth_secret_share if provided, otherwise create from local index share
                    if req.auth_secret_share:
                        s_y = _parse_field_hex(req.auth_secret_share["y"], "auth_secret_share.y")
                        s_mac = _parse_field_hex(req.auth_secret_share["mac"], "auth_secret_share.mac")
                    else:
                        s_y = index_share_y
                        s_mac = 0  # Will fail MAC check if actually used

                    auth_ta = []
                    auth_tb = []
                    auth_tc = []
                    for i, ts in enumerate(req.auth_triple_shares):
                        auth_ta.append(
                            AuthenticatedShare(
                                x=record.share.x,
                                y=_parse_field_hex(ts["a"]["y"], f"triple[{i}].a.y"),
                                mac=_parse_field_hex(ts["a"]["mac"], f"triple[{i}].a.mac"),
                            )
                        )
                        auth_tb.append(
                            AuthenticatedShare(
                                x=record.share.x,
                                y=_parse_field_hex(ts["b"]["y"], f"triple[{i}].b.y"),
                                mac=_parse_field_hex(ts["b"]["mac"], f"triple[{i}].b.mac"),
                            )
                        )
                        auth_tc.append(
                            AuthenticatedShare(
                                x=record.share.x,
                                y=_parse_field_hex(ts["c"]["y"], f"triple[{i}].c.y"),
                                mac=_parse_field_hex(ts["c"]["mac"], f"triple[{i}].c.mac"),
                            )
                        )

                    state: DistributedParticipantState | AuthenticatedParticipantState = AuthenticatedParticipantState(
                        validator_x=record.share.x,
                        secret_share=AuthenticatedShare(x=record.share.x, y=s_y, mac=s_mac),
                        r_share=AuthenticatedShare(x=record.share.x, y=r_y, mac=r_mac),
                        alpha_share=MACKeyShare(x=record.share.x, alpha_share=alpha_val),
                        available_indices=req.available_indices,
                        triple_a=auth_ta,
                        triple_b=auth_tb,
                        triple_c=auth_tc,
                    )
                else:
                    # Semi-honest mode — validate all field elements
                    r_share = _parse_field_hex(req.r_share_y, "r_share_y")
                    triple_a = [
                        _parse_field_hex(ts.get("a", "0"), f"triple[{i}].a") for i, ts in enumerate(req.triple_shares)
                    ]
                    triple_b = [
                        _parse_field_hex(ts.get("b", "0"), f"triple[{i}].b") for i, ts in enumerate(req.triple_shares)
                    ]
                    triple_c = [
                        _parse_field_hex(ts.get("c", "0"), f"triple[{i}].c") for i, ts in enumerate(req.triple_shares)
                    ]

                    state = DistributedParticipantState(
                        validator_x=record.share.x,
                        secret_share_y=index_share_y,
                        r_share_y=r_share,
                        available_indices=req.available_indices,
                        triple_a=triple_a,
                        triple_b=triple_b,
                        triple_c=triple_c,
                    )
            except (ValueError, TypeError, KeyError) as e:
                log.warning("mpc_init_parse_error", error=str(e), session_id=req.session_id)
                raise HTTPException(status_code=400, detail="Invalid MPC init data format")

            with _participant_lock:
                # Evict oldest if at capacity
                if len(_participant_states) >= _MAX_PARTICIPANT_STATES:
                    _cleanup_stale_participants_locked()
                if len(_participant_states) >= _MAX_PARTICIPANT_STATES:
                    raise HTTPException(status_code=503, detail="Too many active MPC sessions")
                _participant_states[req.session_id] = state
                _participant_created[req.session_id] = _time.monotonic()

        return MPCInitResponse(
            session_id=req.session_id,
            accepted=True,
        )

    @app.post("/v1/mpc/round1", response_model=MPCRound1Response)
    async def mpc_round1(req: MPCRound1Request, request: Request) -> MPCRound1Response:
        """Accept a Round 1 message for a multiplication gate."""
        await validate_signed_request(request, _get_validator_hotkeys())
        d_val = _parse_field_hex(req.d_value, "d_value")
        e_val = _parse_field_hex(req.e_value, "e_value")
        msg = Round1Message(
            validator_x=req.validator_x,
            d_value=d_val,
            e_value=e_val,
        )
        ok = _mpc.submit_round1(req.session_id, req.gate_idx, msg)
        return MPCRound1Response(
            session_id=req.session_id,
            gate_idx=req.gate_idx,
            accepted=ok,
        )

    @app.post("/v1/mpc/compute_gate", response_model=MPCComputeGateResponse)
    async def mpc_compute_gate(req: MPCComputeGateRequest, request: Request) -> MPCComputeGateResponse:
        """Compute this validator's (d_i, e_i) for a multiplication gate."""
        await validate_signed_request(request, _get_validator_hotkeys())

        # Reject if session has been aborted
        session = _mpc.get_session(req.session_id)
        if session is not None and session.status == SessionStatus.FAILED:
            raise HTTPException(status_code=409, detail="Session aborted")

        with _participant_lock:
            state = _participant_states.get(req.session_id)
        if state is None:
            raise HTTPException(status_code=404, detail="No participant state for this session")

        prev_d = _parse_field_hex(req.prev_opened_d, "prev_opened_d") if req.prev_opened_d else None
        prev_e = _parse_field_hex(req.prev_opened_e, "prev_opened_e") if req.prev_opened_e else None

        try:
            if isinstance(state, AuthenticatedParticipantState):
                # Finalize previous gate if we have opened values
                if prev_d is not None and prev_e is not None and req.gate_idx > 0:
                    state.finalize_gate(prev_d, prev_e)
                d_i, e_i, d_mac, e_mac = state.compute_gate(req.gate_idx, prev_d, prev_e)
                return MPCComputeGateResponse(
                    session_id=req.session_id,
                    gate_idx=req.gate_idx,
                    d_value=hex(d_i),
                    e_value=hex(e_i),
                    d_mac=hex(d_mac),
                    e_mac=hex(e_mac),
                )
            else:
                d_i, e_i = state.compute_gate(req.gate_idx, prev_d, prev_e)
                return MPCComputeGateResponse(
                    session_id=req.session_id,
                    gate_idx=req.gate_idx,
                    d_value=hex(d_i),
                    e_value=hex(e_i),
                )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @app.post("/v1/mpc/finalize", response_model=MPCFinalizeResponse)
    async def mpc_finalize(req: MPCFinalizeRequest, request: Request) -> MPCFinalizeResponse:
        """Compute and return this validator's final output share z_i.

        Called by the coordinator after the last gate's (d, e) are opened.
        Each peer computes z_i locally using only its own triple shares
        and the publicly opened d, e values. The coordinator never sees
        the peer's raw triple shares.
        """
        await validate_signed_request(request, _get_validator_hotkeys())

        with _participant_lock:
            state = _participant_states.get(req.session_id)
        if state is None:
            raise HTTPException(status_code=404, detail="No participant state for this session")

        last_d = _parse_field_hex(req.last_opened_d, "last_opened_d")
        last_e = _parse_field_hex(req.last_opened_e, "last_opened_e")

        try:
            if isinstance(state, DistributedParticipantState):
                z_i = state.compute_output_share(last_d, last_e)
            elif isinstance(state, AuthenticatedParticipantState):
                state.finalize_gate(last_d, last_e)
                out = state.get_output_share()
                if out is None:
                    raise HTTPException(status_code=500, detail="No output share")
                z_i = out.y
            else:
                raise HTTPException(status_code=400, detail="Unknown participant state type")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        return MPCFinalizeResponse(
            session_id=req.session_id,
            z_share=hex(z_i),
        )

    @app.post("/v1/mpc/result", response_model=MPCResultResponse)
    async def mpc_result(req: MPCResultRequest, request: Request) -> MPCResultResponse:
        """Accept the coordinator's final MPC result broadcast."""
        await validate_signed_request(request, _get_validator_hotkeys())
        result = MPCResult(
            available=req.available,
            participating_validators=req.participating_validators,
        )
        if not _mpc.set_result(req.session_id, result):
            log.warning(
                "mpc_result_rejected",
                session_id=req.session_id,
                signal_id=req.signal_id,
                reason="session not found or result already set",
            )
            return MPCResultResponse(
                session_id=req.session_id,
                acknowledged=False,
            )

        log.info(
            "mpc_result_received",
            session_id=req.session_id,
            signal_id=req.signal_id,
            available=req.available,
        )

        # Clean up participant state
        with _participant_lock:
            _participant_states.pop(req.session_id, None)
            _participant_created.pop(req.session_id, None)

        return MPCResultResponse(
            session_id=req.session_id,
            acknowledged=True,
        )

    @app.post("/v1/mpc/abort", response_model=MPCAbortResponse)
    async def mpc_abort(req: MPCAbortRequest, request: Request) -> MPCAbortResponse:
        """Accept an abort notification from the coordinator.

        When a validator detects MAC verification failure during an
        authenticated MPC session, the coordinator broadcasts an abort
        to all participants. Each participant marks the session as FAILED
        and cleans up participant state.
        """
        await validate_signed_request(request, _get_validator_hotkeys())
        session = _mpc.get_session(req.session_id)
        if session is None:
            return MPCAbortResponse(session_id=req.session_id, acknowledged=False)

        # Mark session as failed
        with _mpc._lock:
            session.status = SessionStatus.FAILED
        log.warning(
            "mpc_abort_received",
            session_id=req.session_id,
            reason=req.reason,
            gate_idx=req.gate_idx,
            offending_x=req.offending_validator_x,
        )

        # Clean up participant state
        with _participant_lock:
            _participant_states.pop(req.session_id, None)
            _participant_created.pop(req.session_id, None)

        return MPCAbortResponse(session_id=req.session_id, acknowledged=True)

    @app.get("/v1/mpc/{session_id}/status", response_model=MPCSessionStatusResponse)
    async def mpc_status(session_id: str) -> MPCSessionStatusResponse:
        """Check the status of an MPC session."""
        _validate_signal_id_path(session_id)
        session = _mpc.get_session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="MPC session not found")

        # Count Round 1 responses for the first gate as a proxy
        responded = len(session.round1_messages.get(0, []))

        return MPCSessionStatusResponse(
            session_id=session_id,
            status=session.status.name.lower(),
            available=session.result.available if session.result else None,
            participants_responded=responded,
            total_participants=len(session.participant_xs),
        )

    # ------------------------------------------------------------------
    # Signal share info (for peer share discovery)
    # ------------------------------------------------------------------

    @app.get("/v1/signal/{signal_id}/share_info", response_model=ShareInfoResponse)
    async def share_info(signal_id: str, request: Request) -> ShareInfoResponse:
        """Return this validator's share x-coordinate for MPC peer discovery.

        No auth required: share_x is a public evaluation point, not a secret.
        Peers need this to set up correct Lagrange interpolation coordinates.
        """
        _validate_signal_id_path(signal_id)

        record = share_store.get(signal_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Signal not found on this validator")

        return ShareInfoResponse(
            signal_id=signal_id,
            share_x=record.share.x,
            shamir_threshold=record.shamir_threshold,
        )

    @app.get("/v1/signal/{signal_id}/mpc_diagnostic")
    async def mpc_diagnostic(signal_id: str) -> dict:
        """Diagnostic endpoint: check MPC readiness for a signal.

        Returns peer discovery info, circuit breaker state, and whether
        the MPC protocol can run. Does NOT run the actual MPC.
        """
        _validate_signal_id_path(signal_id)
        record = share_store.get(signal_id)
        if record is None:
            return {"error": "Signal not found", "signal_id": signal_id}

        has_index_share = bool(record.encrypted_index_share and len(record.encrypted_index_share) > 0)
        my_x = record.share.x
        threshold = record.shamir_threshold

        # Peer discovery
        peers = _orchestrator._get_peer_validators()
        peer_summary = [{"uid": p["uid"], "ip": p["ip"], "port": p["port"]} for p in peers[:20]]

        # Circuit breaker state
        breaker_state = {}
        for uid, breaker in list(_orchestrator._peer_breakers.items())[:20]:
            breaker_state[uid] = {
                "allow_request": breaker.allow_request(),
                "failure_count": breaker._failure_count,
                "state": breaker._state.name if hasattr(breaker._state, "name") else str(breaker._state),
            }

        # Version cache
        version_cache = dict(list(_orchestrator._peer_versions.items())[:20])

        # Try share_x lookup on known good peers (unsigned)
        share_x_results = {}
        import httpx as _httpx_diag
        for peer in peers[:5]:
            try:
                resp = await _orchestrator._http.get(
                    f"{peer['url']}/v1/signal/{signal_id}/share_info",
                    timeout=5.0,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    share_x_results[peer["uid"]] = {"share_x": data.get("share_x"), "status": 200}
                else:
                    share_x_results[peer["uid"]] = {"status": resp.status_code}
            except Exception as e:
                share_x_results[peer["uid"]] = {"error": str(e)[:200]}

        # Test signed GET and POST to peers that hold shares
        import time as _t_diag
        signed_test = {}
        peers_with_shares = [p for p in peers if p["uid"] in share_x_results and share_x_results[p["uid"]].get("status") == 200]
        for peer in peers_with_shares[:3]:
            tests = {}
            # GET test (signed, but share_info doesn't validate auth)
            t0 = _t_diag.monotonic()
            try:
                resp = await _orchestrator._peer_request(
                    "get",
                    f"{peer['url']}/v1/signal/{signal_id}/share_info",
                    peer_uid=peer["uid"],
                )
                tests["get"] = {"status": resp.status_code, "ms": round((_t_diag.monotonic() - t0) * 1000)}
            except Exception as e:
                tests["get"] = {"error": str(e)[:100], "ms": round((_t_diag.monotonic() - t0) * 1000)}

            # POST test (signed, mpc_init validates auth)
            # Send a minimal init payload to test the full signed POST flow
            sx = share_x_results[peer["uid"]].get("share_x", 1)
            import secrets as _secrets_diag
            test_init = {
                "session_id": f"diag-test-{_secrets_diag.token_hex(4)}",
                "signal_id": signal_id,
                "available_indices": [1],
                "coordinator_x": my_x,
                "participant_xs": [my_x, sx],
                "threshold": 2,
            }
            t0 = _t_diag.monotonic()
            try:
                resp = await _orchestrator._peer_request(
                    "post",
                    f"{peer['url']}/v1/mpc/init",
                    peer_uid=peer["uid"],
                    json=test_init,
                )
                body = resp.text[:200]
                tests["post_init"] = {"status": resp.status_code, "ms": round((_t_diag.monotonic() - t0) * 1000), "body": body}
            except Exception as e:
                tests["post_init"] = {"error": str(e)[:200], "ms": round((_t_diag.monotonic() - t0) * 1000)}

            signed_test[peer["uid"]] = tests

        # Check signing capability
        signing_ok = False
        signing_error = None
        if neuron is not None and hasattr(neuron, "wallet") and neuron.wallet is not None:
            try:
                from djinn_validator.api.middleware import create_signed_headers
                test_headers = create_signed_headers("/v1/test", b"test", neuron.wallet)
                signing_ok = "X-Signature" in test_headers
            except Exception as e:
                signing_error = str(e)[:200]
        else:
            signing_error = "no_wallet"

        return {
            "signal_id": signal_id[:40],
            "my_x": my_x,
            "threshold": threshold,
            "has_index_share": has_index_share,
            "my_uid": neuron.uid if neuron else None,
            "peers_discovered": len(peers),
            "peer_sample": peer_summary,
            "breaker_state": breaker_state,
            "version_cache": version_cache,
            "share_x_lookup": share_x_results,
            "signed_request_test": signed_test,
            "signing_ok": signing_ok,
            "signing_error": signing_error,
        }

    # ------------------------------------------------------------------
    # OT network endpoints (distributed triple generation)
    # ------------------------------------------------------------------

    from djinn_validator.core.ot_network import (
        DEFAULT_DH_GROUP,
        DHGroup,
        OTTripleGenState,
        serialize_dh_public_key,
    )

    _ot_states: dict[str, OTTripleGenState] = {}
    _ot_created: dict[str, float] = {}  # session_id -> monotonic timestamp
    _ot_lock = _threading.Lock()

    _OT_TTL = 180  # seconds before stale OT states are cleaned up
    _MAX_OT_STATES = 200

    def _cleanup_stale_ot_states_locked() -> int:
        """Remove OT states older than _OT_TTL. Caller holds _ot_lock."""
        now = _time.monotonic()
        stale = [sid for sid, ts in _ot_created.items() if now - ts > _OT_TTL]
        for sid in stale:
            _ot_states.pop(sid, None)
            _ot_created.pop(sid, None)
        if stale:
            log.info("ot_state_cleanup", evicted=len(stale))
        return len(stale)

    # Maximum allowed bit length for DH group primes (4096 bits)
    _MAX_DH_PRIME_BITS = 4096

    def _resolve_ot_params(
        field_prime_hex: str | None,
        dh_prime_hex: str | None,
    ) -> tuple[int, DHGroup]:
        """Resolve OT parameters from request, falling back to defaults."""
        if field_prime_hex:
            try:
                fp = int(field_prime_hex, 16)
            except (ValueError, TypeError):
                raise HTTPException(status_code=400, detail="Invalid hex for field_prime")
            if fp < 2 or fp >= 2**256:
                raise HTTPException(status_code=400, detail="field_prime out of range")
        else:
            fp = BN254_PRIME

        if dh_prime_hex:
            try:
                dhp = int(dh_prime_hex, 16)
            except (ValueError, TypeError):
                raise HTTPException(status_code=400, detail="Invalid hex for dh_prime")
            if dhp < 2 or dhp.bit_length() > _MAX_DH_PRIME_BITS:
                raise HTTPException(status_code=400, detail="dh_prime out of range")
            bl = (dhp.bit_length() + 7) // 8
            dh_group = DHGroup(prime=dhp, generator=2, byte_length=bl)
        else:
            dh_group = DEFAULT_DH_GROUP
        return fp, dh_group

    @app.post("/v1/mpc/ot/setup", response_model=OTSetupResponse)
    async def ot_setup(req: OTSetupRequest, request: Request) -> OTSetupResponse:
        """Initialize distributed triple generation on this peer."""
        await validate_signed_request(request, _get_validator_hotkeys())

        with _ot_lock:
            if req.session_id in _ot_states:
                state = _ot_states[req.session_id]
                return OTSetupResponse(
                    session_id=req.session_id,
                    accepted=True,
                    sender_public_keys={
                        str(t): serialize_dh_public_key(pk, state.dh_group)
                        for t, pk in state.get_sender_public_keys().items()
                    },
                )

            # Evict stale OT states before creating new ones
            if len(_ot_states) >= _MAX_OT_STATES:
                _cleanup_stale_ot_states_locked()
            if len(_ot_states) >= _MAX_OT_STATES:
                raise HTTPException(status_code=503, detail="Too many active OT sessions")

            fp, dh_group = _resolve_ot_params(req.field_prime, req.dh_prime)
            state = OTTripleGenState(
                session_id=req.session_id,
                party_role="peer",
                n_triples=req.n_triples,
                x_coords=req.x_coords,
                threshold=req.threshold,
                prime=fp,
                dh_group=dh_group,
            )
            state.initialize()
            _ot_states[req.session_id] = state
            _ot_created[req.session_id] = _time.monotonic()

        return OTSetupResponse(
            session_id=req.session_id,
            accepted=True,
            sender_public_keys={
                str(t): serialize_dh_public_key(pk, state.dh_group) for t, pk in state.get_sender_public_keys().items()
            },
        )

    @app.post("/v1/mpc/ot/choices", response_model=OTChoicesResponse)
    async def ot_choices(req: OTChoicesRequest, request: Request) -> OTChoicesResponse:
        """Generate and exchange OT choice commitments."""
        await validate_signed_request(request, _get_validator_hotkeys())

        with _ot_lock:
            state = _ot_states.get(req.session_id)
        if state is None:
            raise HTTPException(status_code=404, detail="OT session not found")

        from djinn_validator.core.ot_network import (
            deserialize_dh_public_key,
            serialize_choices,
        )

        # Deserialize peer's sender public keys
        peer_pks = {int(t): deserialize_dh_public_key(pk_hex) for t, pk_hex in req.peer_sender_pks.items()}

        # Generate this party's receiver choices
        our_choices = state.generate_receiver_choices(peer_pks)

        return OTChoicesResponse(
            session_id=req.session_id,
            choices={str(t): serialize_choices(c) for t, c in our_choices.items()},
        )

    @app.post("/v1/mpc/ot/transfers", response_model=OTTransfersResponse)
    async def ot_transfers(req: OTTransfersRequest, request: Request) -> OTTransfersResponse:
        """Process peer choices and return encrypted OT transfers."""
        await validate_signed_request(request, _get_validator_hotkeys())

        with _ot_lock:
            state = _ot_states.get(req.session_id)
        if state is None:
            raise HTTPException(status_code=404, detail="OT session not found")

        from djinn_validator.core.ot_network import (
            deserialize_choices,
            serialize_transfers,
        )

        # Deserialize peer's choices for our sender instances
        peer_choices_deserialized = {int(t): deserialize_choices(c) for t, c in req.peer_choices.items()}

        # Process: encrypt OT messages using our sender states
        transfers, sender_shares = state.process_sender_choices(peer_choices_deserialized)

        return OTTransfersResponse(
            session_id=req.session_id,
            transfers={str(t): serialize_transfers(pairs) for t, pairs in transfers.items()},
            sender_shares={str(t): hex(s) for t, s in sender_shares.items()},
        )

    @app.post("/v1/mpc/ot/complete", response_model=OTCompleteResponse)
    async def ot_complete(req: OTCompleteRequest, request: Request) -> OTCompleteResponse:
        """Decrypt peer transfers and compute Shamir polynomial evaluations."""
        await validate_signed_request(request, _get_validator_hotkeys())

        with _ot_lock:
            state = _ot_states.get(req.session_id)
        if state is None:
            raise HTTPException(status_code=404, detail="OT session not found")

        from djinn_validator.core.ot_network import deserialize_transfers

        # Decrypt the peer's encrypted transfers (where this party is receiver)
        peer_transfers_deserialized = {int(t): deserialize_transfers(pairs) for t, pairs in req.peer_transfers.items()}
        receiver_shares = state.decrypt_receiver_transfers(peer_transfers_deserialized)

        # Parse this party's own sender shares
        own_sender_shares = {int(t): int(s, 16) for t, s in req.own_sender_shares.items()}

        # Accumulate cross-term shares into c values
        state.accumulate_ot_shares(own_sender_shares, receiver_shares)

        # Compute Shamir polynomial evaluations for distribution
        state.compute_shamir_evaluations()

        return OTCompleteResponse(
            session_id=req.session_id,
            completed=True,
        )

    @app.post("/v1/mpc/ot/shares", response_model=OTSharesResponse)
    async def ot_shares(req: OTSharesRequest, request: Request) -> OTSharesResponse:
        """Serve Shamir polynomial evaluations to a requesting party.

        Each party contacts the OT peer directly to get the peer's partial
        triple shares.  This prevents the coordinator from seeing the peer's
        polynomial evaluations.
        """
        await validate_signed_request(request, _get_validator_hotkeys())

        with _ot_lock:
            state = _ot_states.get(req.session_id)
        if state is None:
            raise HTTPException(status_code=404, detail="OT session not found")

        shares = state.get_shamir_shares_for_party(req.party_x)
        if shares is None:
            raise HTTPException(
                status_code=425,
                detail="OT triple generation not yet complete",
            )

        return OTSharesResponse(
            session_id=req.session_id,
            triple_shares=[{k: hex(v) for k, v in ts.items()} for ts in shares],
        )

    # ------------------------------------------------------------------
    # External Notary Session Assignment (for browser extension provers)
    # ------------------------------------------------------------------

    @app.post("/v1/notary/session", response_model=NotarySessionResponse)
    async def notary_session(request: Request) -> NotarySessionResponse:
        """Assign a random notary miner for an external prover.

        Auth: burn-gate. Caller provides three headers:
          - X-Coldkey: SS58 coldkey address (the burn_alpha extrinsic signer)
          - X-Burn-Tx: hex tx hash of the burn_alpha extrinsic
          - X-Signature: sr25519 signature of the tx hash bytes by the coldkey

        The validator verifies the signature, looks up the burn on-chain
        (cached), and confirms >= 1 alpha burned on SN103 within 30 days.

        Dedup (optional request body):
          - exclude_miners: hotkeys to skip (previously assigned)
          - exclude_ips: IPs to skip (same operator dedup)
        """
        import time as _time
        import uuid as _uuid

        from djinn_validator.api import burn_gate
        from djinn_validator.core.challenges import assign_peer_notary, discover_peer_notaries

        # Extract burn-gate headers
        coldkey_ss58 = request.headers.get("x-coldkey", "")
        tx_hash = request.headers.get("x-burn-tx", "")
        signature = request.headers.get("x-signature", "")

        if not coldkey_ss58 or not tx_hash or not signature:
            NOTARY_SESSIONS_ASSIGNED.labels(status="auth_failed").inc()
            raise HTTPException(
                status_code=401,
                detail="Missing required headers: X-Coldkey, X-Burn-Tx, X-Signature",
            )

        # Get substrate connection for on-chain verification
        substrate = None
        if neuron and neuron.subtensor:
            substrate = neuron.subtensor.substrate

        valid, error = burn_gate.authenticate_request(
            coldkey_ss58, tx_hash, signature, substrate,
        )
        if not valid:
            # On-chain lookup failed (likely pruned). Try peer validators.
            if neuron and neuron.metagraph is not None:
                from djinn_validator.core.mpc_orchestrator import _is_public_ip
                peer_urls = []
                mg = neuron.metagraph
                for uid in range(mg.n.item()):
                    if not mg.validator_permit[uid].item():
                        continue
                    if uid == neuron.uid:
                        continue
                    axon = mg.axons[uid]
                    if axon.ip and axon.ip != "0.0.0.0" and _is_public_ip(axon.ip):
                        peer_urls.append(f"http://{axon.ip}:{axon.port}")
                if peer_urls:
                    valid, _ = await burn_gate.verify_burn_via_peers(
                        tx_hash, coldkey_ss58, peer_urls,
                    )
            if not valid:
                NOTARY_SESSIONS_ASSIGNED.labels(status="auth_failed").inc()
                raise HTTPException(status_code=401, detail=error)

        exclude_hotkeys: set[str] = set()
        exclude_coldkeys: set[str] = set()

        # Per-call dedup: exclude previously assigned miners/IPs from this batch
        try:
            body = await request.json()
        except Exception:
            body = {}
        exclude_ips: set[str] = set()
        if isinstance(body, dict):
            for hk in body.get("exclude_miners") or []:
                if isinstance(hk, str):
                    exclude_hotkeys.add(hk)
            for ip in body.get("exclude_ips") or []:
                if isinstance(ip, str):
                    exclude_ips.add(ip)

        # Build miner axon list from metagraph
        if not neuron:
            NOTARY_SESSIONS_ASSIGNED.labels(status="no_miners").inc()
            raise HTTPException(status_code=503, detail="Validator not connected to network")

        miner_uids = neuron.get_miner_uids()
        if not miner_uids:
            NOTARY_SESSIONS_ASSIGNED.labels(status="no_miners").inc()
            raise HTTPException(status_code=503, detail="No miners available")

        axons = []
        for uid in miner_uids:
            try:
                axon = neuron.get_axon_info(uid)
                ip = axon.get("ip", "")
                port = axon.get("port", 0)
                hotkey = axon.get("hotkey", "")
                if not ip or not port or ip in ("0.0.0.0", "127.0.0.1"):
                    continue
                # Exclude by IP (dedup across calls in a batch)
                if ip in exclude_ips:
                    continue
                # Exclude by hotkey
                if hotkey in exclude_hotkeys:
                    continue
                # Exclude by coldkey (look up from metagraph)
                if exclude_coldkeys and neuron.metagraph is not None:
                    coldkey = neuron.metagraph.coldkeys[uid]
                    if coldkey in exclude_coldkeys:
                        continue
                axons.append({"uid": uid, "ip": ip, "port": port, "hotkey": hotkey})
            except (IndexError, KeyError, AttributeError):
                continue

        if not axons:
            NOTARY_SESSIONS_ASSIGNED.labels(status="no_miners").inc()
            raise HTTPException(status_code=503, detail="No reachable miners (after exclusions)")

        # Pre-filter to miners known to be notary-capable from scorer data.
        # Probing all 245 miners takes 30-60s (WS handshake per miner).
        # Narrowing to known-capable miners cuts this to <5s.
        if scorer is not None:
            capable_uids: set[int] = set()
            for a in axons:
                m = scorer.get(a["uid"])
                if m is not None and m.notary_capable:
                    capable_uids.add(a["uid"])
            if capable_uids:
                # Keep only capable miners for discovery, but fall back to
                # full probe if none are known (cold start / fresh epoch).
                axons_for_discovery = [a for a in axons if a["uid"] in capable_uids]
                log.info(
                    "notary_session_prefilter",
                    total_axons=len(axons),
                    capable=len(axons_for_discovery),
                )
            else:
                axons_for_discovery = axons
        else:
            axons_for_discovery = axons

        # Discover which miners have live notary sidecars
        async with httpx.AsyncClient() as client:
            peer_notaries = await discover_peer_notaries(client, axons_for_discovery)

        if not peer_notaries:
            NOTARY_SESSIONS_ASSIGNED.labels(status="no_miners").inc()
            raise HTTPException(status_code=503, detail="No miners with active notary sidecars")

        # Filter out miners whose circuit breaker is open (repeated failures)
        breaker_open_uids: set[int] = set()
        for pn in peer_notaries:
            breaker = _get_miner_breaker(pn.uid)
            if not breaker.allow_request():
                breaker_open_uids.add(pn.uid)
        if breaker_open_uids:
            log.info(
                "notary_session_breaker_filtered",
                filtered_uids=sorted(breaker_open_uids),
                remaining=len(peer_notaries) - len(breaker_open_uids),
            )

        # Rank notaries by proven MPC reliability instead of random selection.
        # The scorer tracks which miners successfully complete attestation
        # challenges and notary duties, so proven miners float to the top.
        candidate_uids = [pn.uid for pn in peer_notaries]
        ranked_uids = scorer.rank_notary_candidates(candidate_uids) if scorer is not None else None

        chosen = assign_peer_notary(
            prover_uid=-1,
            notaries=peer_notaries,
            exclude_uids=breaker_open_uids or None,
            ranked_uids=ranked_uids,
        )
        if chosen is None:
            NOTARY_SESSIONS_ASSIGNED.labels(status="no_miners").inc()
            raise HTTPException(status_code=503, detail="No eligible notary miners")

        # Look up the reliability score for logging and response metadata
        chosen_score = 0.0
        chosen_tier = "unknown"
        if ranked_uids:
            for uid, score in ranked_uids:
                if uid == chosen.uid:
                    chosen_score = round(score, 4)
                    m = scorer.get(uid) if scorer is not None else None
                    if m and m.attestations_valid > 0:
                        chosen_tier = "proven"
                    elif m and m.health_checks_responded > 0:
                        chosen_tier = "unproven"
                    break

        session_id = _uuid.uuid4().hex[:16]
        expires_at = int(_time.time()) + 120  # 2 minute window to connect

        NOTARY_SESSIONS_ASSIGNED.labels(status="ok").inc()
        log.info(
            "notary_session_assigned",
            session_id=session_id,
            miner_uid=chosen.uid,
            miner_ip=chosen.ip,
            tier=chosen_tier,
            reliability=chosen_score,
            caller_coldkey=coldkey_ss58[:16] + "...",
            excluded_hotkeys=len(exclude_hotkeys),
            breaker_filtered=len(breaker_open_uids),
        )

        return NotarySessionResponse(
            session_id=session_id,
            miner_ip=chosen.ip,
            miner_port=chosen.port,
            miner_hotkey=next((a["hotkey"] for a in axons if a["uid"] == chosen.uid), ""),
            notary_public_key=chosen.pubkey_hex,
            expires_at=expires_at,
            miner_uid=chosen.uid,
            tier=chosen_tier,
            reliability_score=chosen_score,
        )

    @app.post("/v1/notary/session/feedback", dependencies=[_admin_auth])
    async def notary_session_feedback(request: Request) -> dict:
        """Report success or failure of a notary session back to the validator.

        Feeds the circuit breaker so future assignments skip broken miners.
        Requires admin auth to prevent unauthenticated users from sending
        fake feedback that trips circuit breakers.

        Body: {"session_id": str, "miner_uid": int, "success": bool, "error": str}
        """
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="JSON body required")

        miner_uid = body.get("miner_uid")
        success = body.get("success", False)
        error_msg = body.get("error", "")

        if not isinstance(miner_uid, int) or miner_uid < 0:
            raise HTTPException(status_code=400, detail="miner_uid (int >= 0) required")

        breaker = _get_miner_breaker(miner_uid)
        if success:
            breaker.record_success()
        else:
            breaker.record_failure()

        log.info(
            "notary_session_feedback",
            miner_uid=miner_uid,
            success=success,
            error=error_msg[:200] if error_msg else "",
            breaker_state=breaker.state.value,
            session_id=body.get("session_id", ""),
        )
        return {"ok": True}

    @app.get("/v1/burn/verify")
    async def burn_verify(tx_hash: str = "", coldkey: str = "") -> dict:
        """Check if a burn tx is in this validator's verified cache.

        Used by peer validators when their local chain lookup fails (pruned
        block state). Returns the cached verification result if available.
        """
        from djinn_validator.api.burn_gate import _cache_get

        if not tx_hash or not coldkey:
            raise HTTPException(status_code=400, detail="tx_hash and coldkey required")

        cached = _cache_get(tx_hash)
        if cached is None or not cached.get("valid"):
            return {"valid": False}

        if cached.get("coldkey") != coldkey:
            return {"valid": False}

        import time as _time
        age = _time.time() - cached.get("block_ts", 0)
        from djinn_validator.api.burn_gate import BURN_WINDOW_SECONDS
        if age > BURN_WINDOW_SECONDS:
            return {"valid": False}

        return {
            "valid": True,
            "amount": cached.get("amount", 0),
            "block_ts": cached.get("block_ts", 0),
        }

    @app.get("/metrics")
    async def metrics() -> bytes:
        """Prometheus metrics endpoint."""
        from fastapi.responses import Response

        return Response(
            content=metrics_response(),
            media_type="text/plain; version=0.0.4; charset=utf-8",
        )

    return app
