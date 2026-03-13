"""MPC orchestration for the purchase flow.

Coordinates the full secure MPC protocol across multiple validators:
1. Discovers peer validators from the Bittensor metagraph
2. Creates an MPC session with Beaver triples
3. Distributes triple shares to peers via HTTP
4. Collects contributions and computes the result
5. Broadcasts the result to all participants

Falls back to single-validator prototype mode when:
- Bittensor is not connected (dev mode)
- Fewer than threshold validators are reachable
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import secrets
import time
from typing import TYPE_CHECKING, Any

import httpx
import structlog

from djinn_validator.core.mpc import (
    BeaverTriple,
    DistributedParticipantState,
    MPCResult,
    _split_secret_at_points,
    check_availability,
    compute_local_contribution,
    reconstruct_at_zero,
    secure_check_availability,
)
from djinn_validator.core.mpc_coordinator import MPCCoordinator, SessionStatus
from djinn_validator.core.ot_network import (
    OTTripleGenState,
    deserialize_choices,
    deserialize_dh_public_key,
    deserialize_transfers,
    serialize_choices,
    serialize_dh_public_key,
    serialize_transfers,
)
from djinn_validator.core.spdz import (
    AuthenticatedParticipantState,
    AuthenticatedShare,
    authenticate_value,
    verify_mac_opening,
)
from djinn_validator.utils.circuit_breaker import CircuitBreaker
from djinn_validator.utils.crypto import BN254_PRIME, Share

if TYPE_CHECKING:
    from djinn_validator.bt.neuron import DjinnValidator

log = structlog.get_logger()

# Timeout for inter-validator HTTP calls (configurable via env)
PEER_TIMEOUT = float(os.getenv("MPC_PEER_TIMEOUT", "10.0"))


def _is_public_ip(ip_str: str) -> bool:
    """Reject private, loopback, reserved, and link-local addresses (SSRF protection)."""
    try:
        addr = ipaddress.ip_address(ip_str)
        return addr.is_global
    except ValueError:
        return False
# Timeout for gather operations (covers retries + backoff for concurrent peers)
GATHER_TIMEOUT = PEER_TIMEOUT * 3

# Minimum peer validator version for MPC compatibility.
# Validators below this version have incompatible MPC implementations
# (missing x-coordinate fix, unsigned peer requests, broken gate computation).
_MIN_PEER_VERSION = 617


class MPCOrchestrator:
    """Orchestrates MPC sessions for signal availability checks.

    Used by the purchase endpoint to run the secure MPC protocol
    across multiple validators, falling back to single-validator
    prototype mode when necessary.
    """

    _PEER_RETRIES = 2
    _RETRY_BACKOFF = 0.3  # seconds, doubles each attempt

    def __init__(
        self,
        coordinator: MPCCoordinator,
        neuron: DjinnValidator | None = None,
        threshold: int = 7,
        ot_dh_group: Any | None = None,
        ot_field_prime: int | None = None,
    ) -> None:
        self._coordinator = coordinator
        self._neuron = neuron
        self._threshold = threshold
        self._ot_dh_group = ot_dh_group
        self._ot_field_prime = ot_field_prime
        limits = httpx.Limits(max_keepalive_connections=20, max_connections=100)
        self._http = httpx.AsyncClient(timeout=PEER_TIMEOUT, limits=limits)
        self._peer_breakers: dict[int, CircuitBreaker] = {}
        self._peer_versions: dict[int, int] = {}  # UID -> parsed version number

    async def close(self) -> None:
        """Release the shared HTTP client."""
        await self._http.aclose()

    def prune_stale_breakers(self, active_uids: set[int]) -> int:
        """Remove circuit breakers for UIDs no longer on the metagraph."""
        stale = [uid for uid in self._peer_breakers if uid not in active_uids]
        for uid in stale:
            del self._peer_breakers[uid]
        return len(stale)

    def _mark_session_failed(self, session: Any) -> None:
        """Mark an MPC session as FAILED to prevent resource leaks."""
        if session.status not in (SessionStatus.COMPLETE, SessionStatus.FAILED):
            with self._coordinator._lock:
                session.status = SessionStatus.FAILED
            log.info("mpc_session_failed_cleanup", session_id=session.session_id)

    def _get_peer_breaker(self, peer_uid: int) -> CircuitBreaker:
        """Get or create a circuit breaker for a peer validator."""
        if peer_uid not in self._peer_breakers:
            self._peer_breakers[peer_uid] = CircuitBreaker(
                name=f"peer_{peer_uid}",
                failure_threshold=3,
                recovery_timeout=20.0,
            )
        return self._peer_breakers[peer_uid]

    async def _peer_request(
        self,
        method: str,
        url: str,
        *,
        peer_uid: int | None = None,
        **kwargs: Any,
    ) -> httpx.Response:
        """HTTP request with circuit breaker, retry, and exponential backoff.

        Retries on transport errors and 5xx server errors.
        Propagates request_id for distributed tracing.
        """
        # Check circuit breaker for this peer
        if peer_uid is not None:
            breaker = self._get_peer_breaker(peer_uid)
            if not breaker.allow_request():
                raise httpx.ConnectError(f"Circuit breaker open for peer {peer_uid}")

        # Propagate request ID for distributed tracing
        headers = kwargs.pop("headers", {})
        try:
            ctx = structlog.contextvars.get_contextvars()
            if "request_id" in ctx:
                headers["X-Request-ID"] = ctx["request_id"]
        except Exception as e:
            log.debug("request_id_propagation_failed", error=str(e))

        # Pre-serialize JSON body so the bytes we sign match the bytes sent.
        # Previously we signed json.dumps(kwargs["json"]) but httpx's json=
        # parameter may serialize differently, causing signature mismatch (401).
        if "json" in kwargs:
            serialized = json.dumps(kwargs.pop("json"), separators=(",", ":")).encode()
            kwargs["content"] = serialized
            headers["Content-Type"] = "application/json"

        # Sign requests with validator hotkey for peer authentication
        if self._neuron is not None and hasattr(self._neuron, "wallet") and self._neuron.wallet is not None:
            try:
                from djinn_validator.api.middleware import create_signed_headers
                from urllib.parse import urlparse

                parsed = urlparse(url)
                endpoint = parsed.path
                body = b""
                if "content" in kwargs:
                    body = kwargs["content"] if isinstance(kwargs["content"], bytes) else str(kwargs["content"]).encode()
                elif "data" in kwargs:
                    body = kwargs["data"] if isinstance(kwargs["data"], bytes) else str(kwargs["data"]).encode()
                auth_headers = create_signed_headers(endpoint, body, self._neuron.wallet)
                headers.update(auth_headers)
            except Exception as e:
                log.debug("peer_request_signing_failed", error=str(e))

        kwargs["headers"] = headers

        last_exc: Exception | None = None
        for attempt in range(self._PEER_RETRIES + 1):
            try:
                resp = await getattr(self._http, method)(url, **kwargs)
                if resp.status_code < 500:
                    if peer_uid is not None:
                        self._get_peer_breaker(peer_uid).record_success()
                    return resp
                last_exc = httpx.HTTPStatusError(
                    f"Server error {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            except httpx.HTTPError as e:
                last_exc = e
            if attempt < self._PEER_RETRIES:
                await asyncio.sleep(self._RETRY_BACKOFF * (2**attempt))
        if peer_uid is not None:
            self._get_peer_breaker(peer_uid).record_failure()
        raise last_exc  # type: ignore[misc]

    def _get_peer_validators(self) -> list[dict[str, Any]]:
        """Discover peer validator addresses from the metagraph.

        Returns list of {uid, hotkey, ip, port, url} for each validator.
        Filters to validators with compatible MPC implementations.
        """
        if self._neuron is None or self._neuron.metagraph is None:
            return []

        peers = []
        metagraph = self._neuron.metagraph
        for uid in range(metagraph.n.item()):
            if not metagraph.validator_permit[uid].item():
                continue
            if uid == self._neuron.uid:
                continue  # Skip ourselves

            axon = metagraph.axons[uid]
            if not axon.ip or axon.ip == "0.0.0.0":
                continue
            if not _is_public_ip(axon.ip):
                log.warning("peer_private_ip_skipped", uid=uid, ip=axon.ip)
                continue

            # Skip validators known to be incompatible via cached health
            cached_ver = self._peer_versions.get(uid)
            if cached_ver is not None and cached_ver < _MIN_PEER_VERSION:
                continue

            peers.append(
                {
                    "uid": uid,
                    "hotkey": metagraph.hotkeys[uid],
                    "ip": axon.ip,
                    "port": axon.port,
                    "url": f"http://{axon.ip}:{axon.port}",
                }
            )

        return peers

    async def _collect_peer_share_xs(
        self,
        peers: list[dict[str, Any]],
        signal_id: str,
    ) -> list[int]:
        """Request share x-coordinates from peer validators for a signal.

        Returns the list of peer share x-values (evaluation points) for
        validators that hold a share of this signal. The y-values are
        never transmitted — they stay local to each validator and are
        used only within the MPC protocol.
        """
        xs = []
        for peer in peers:
            try:
                resp = await self._peer_request(
                    "get",
                    f"{peer['url']}/v1/signal/{signal_id}/share_info",
                    peer_uid=peer["uid"],
                )
                if resp.status_code == 200:
                    data = resp.json()
                    xs.append(data["share_x"])
            except (httpx.HTTPError, KeyError, ValueError, json.JSONDecodeError) as e:
                log.warning(
                    "peer_share_request_failed",
                    peer_uid=peer["uid"],
                    error=str(e),
                )
        return xs

    async def check_availability(
        self,
        signal_id: str,
        local_share: Share,
        available_indices: set[int],
        local_shares: list[Share] | None = None,
        threshold_override: int | None = None,
    ) -> MPCResult:
        """Run the MPC availability check.

        If enough shares are available locally (e.g. shared DB on testnet),
        uses secure_check_availability directly. Otherwise attempts multi-
        validator MPC, falling back to single-validator prototype.

        Args:
            threshold_override: Per-signal threshold declared at creation time.
                Overrides the global default to handle signals created during
                bootstrap with lower thresholds.
        """
        from djinn_validator.api.metrics import MPC_DURATION, MPC_ERRORS, MPC_SESSIONS

        start = time.monotonic()
        threshold = threshold_override if threshold_override is not None else self._threshold

        # If we have enough shares locally, use them directly for a secure check.
        # This handles testnet setups where all shares are co-located in one DB.
        all_local = local_shares or [local_share]
        if len(all_local) >= threshold:
            log.info(
                "mpc_local_shares_mode",
                signal_id=signal_id,
                local_shares=len(all_local),
                threshold=threshold,
            )
            MPC_SESSIONS.labels(mode="local_shares").inc()
            result = secure_check_availability(
                shares=all_local,
                available_indices=available_indices,
                threshold=threshold,
            )
            MPC_DURATION.labels(mode="local_shares").observe(time.monotonic() - start)
            return result

        peers = self._get_peer_validators()

        if not peers:
            # Dev/single-validator mode: no peers discovered.
            # This path is ONLY reached when neuron is None (dev) or no validators
            # are on the metagraph. The single-validator prototype check uses
            # threshold=1 reconstruction — acceptable here because there is no
            # multi-party trust boundary (only one party holds a share).
            # The secrecy guarantee applies to the DISTRIBUTED path where
            # the coordinator must never access peer triple shares or z_i.
            log.info(
                "mpc_single_validator_mode",
                signal_id=signal_id,
                reason="no peers discovered",
            )
            MPC_SESSIONS.labels(mode="single_validator").inc()
            result = self._single_validator_check(local_share, available_indices)
            MPC_DURATION.labels(mode="single_validator").observe(time.monotonic() - start)
            return result

        # Not enough local shares — run distributed protocol via HTTP
        MPC_SESSIONS.labels(mode="distributed").inc()
        result = await self._distributed_mpc(
            signal_id,
            local_share,
            available_indices,
            peers,
            threshold=threshold,
        )
        if result is not None:
            MPC_DURATION.labels(mode="distributed").observe(time.monotonic() - start)
            return result

        # Distributed MPC failed — return unavailable as a fail-safe.
        # In production, we never fall back to secret reconstruction because
        # the coordinator must not learn the secret index.
        log.error(
            "mpc_distributed_failed",
            signal_id=signal_id,
            reason="distributed MPC failed — returning unavailable as fail-safe",
        )
        MPC_ERRORS.labels(reason="distributed_failed").inc()
        MPC_DURATION.labels(mode="distributed_failed").observe(time.monotonic() - start)
        return MPCResult(available=False, participating_validators=0)

    async def _distributed_mpc(
        self,
        signal_id: str,
        local_share: Share,
        available_indices: set[int],
        peers: list[dict[str, Any]],
        threshold: int | None = None,
    ) -> MPCResult | None:
        """Run the distributed MPC protocol via HTTP.

        Supports both semi-honest (basic Beaver) and malicious (SPDZ authenticated)
        modes. The mode is determined by USE_AUTHENTICATED_MPC env var or the
        coordinator's create_session() call.

        Full protocol:
        1. Generate random mask r and split into shares
        2. Create session with Beaver triples (optionally with MAC authentication)
        3. Send /v1/mpc/init to all peers with their triple shares + r shares
        4. For each multiplication gate, collect (d_i, e_i) from all peers
        5. In authenticated mode: verify MACs on opened d, e values
        6. Reconstruct opened d, e and feed into next gate
        7. Open final result and broadcast to peers
        """
        p = BN254_PRIME
        my_x = local_share.x
        sorted_avail = sorted(available_indices)
        n_gates = len(sorted_avail)
        t = threshold if threshold is not None else self._threshold

        if n_gates == 0:
            return MPCResult(available=False, participating_validators=1, failure_reason="no_available_indices")

        # Collect actual Shamir share x-coordinates from peers in parallel.
        # The share_x values are assigned at signal creation time (1, 2, 3, ...)
        # and differ from metagraph UIDs. Using UID+1 would break Lagrange
        # interpolation since the secret was split at different evaluation points.
        peer_x_map: dict[int, int] = {}  # peer UID -> share_x

        async def _lookup_share_x(peer: dict[str, Any]) -> tuple[int, int] | None:
            try:
                resp = await self._peer_request(
                    "get",
                    f"{peer['url']}/v1/signal/{signal_id}/share_info",
                    peer_uid=peer["uid"],
                )
                if resp is not None and resp.status_code == 200:
                    data = resp.json()
                    # Cache peer version from response header for future filtering
                    ver_str = resp.headers.get("x-api-version", "")
                    try:
                        ver = int(ver_str)
                        self._peer_versions[peer["uid"]] = ver
                        if ver < _MIN_PEER_VERSION:
                            log.info(
                                "peer_version_incompatible",
                                peer_uid=peer["uid"],
                                version=ver,
                                min_required=_MIN_PEER_VERSION,
                            )
                            return None
                    except (ValueError, TypeError):
                        pass
                    return peer["uid"], data["share_x"]
            except (httpx.HTTPError, KeyError, ValueError, AttributeError) as e:
                log.debug("peer_share_x_lookup_failed", peer_uid=peer["uid"], error=str(e))
            return None

        # Terminate early once we have enough peers (t-1 needed since we are one).
        # This avoids waiting 30s for unreachable validators when 2 fast ones respond.
        needed_peers = t - 1  # we (coordinator) count as one participant
        tasks = [asyncio.create_task(_lookup_share_x(p)) for p in peers]
        if tasks:
            deadline = asyncio.get_running_loop().time() + GATHER_TIMEOUT
            pending = set(tasks)
            while pending:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    break
                done_batch, pending = await asyncio.wait(
                    pending, timeout=remaining, return_when=asyncio.FIRST_COMPLETED,
                )
                for dtask in done_batch:
                    try:
                        res = dtask.result()
                        if isinstance(res, tuple) and res is not None:
                            peer_x_map[res[0]] = res[1]
                    except Exception:
                        pass
                if len(peer_x_map) >= needed_peers:
                    break
            # Cancel any still-running lookups
            for ptask in pending:
                ptask.cancel()
            if pending:
                log.info(
                    "peer_share_x_early_termination",
                    found=len(peer_x_map),
                    needed=needed_peers,
                    cancelled=len(pending),
                )

        # Only keep peers that hold a share for this signal
        peers = [p for p in peers if p["uid"] in peer_x_map]

        raw_xs = [my_x] + [peer_x_map[p["uid"]] for p in peers]
        if len(raw_xs) != len(set(raw_xs)):
            log.warning("duplicate_participant_x", raw=raw_xs, unique=list(set(raw_xs)))
        participant_xs = sorted(set(x for x in raw_xs if 1 <= x <= 255))

        log.info(
            "mpc_participant_summary",
            signal_id=signal_id[:20],
            my_x=my_x,
            peer_x_map=peer_x_map,
            participant_xs=participant_xs,
            threshold=t,
            total_peers_discovered=len(self._get_peer_validators()),
        )

        if len(participant_xs) < t:
            from djinn_validator.api.metrics import MPC_ERRORS

            MPC_ERRORS.labels(reason="insufficient_peers").inc()
            breaker_info = {uid: self._get_peer_breaker(uid).allow_request() for uid in list(self._peer_breakers.keys())[:10]}
            log.warning(
                "insufficient_mpc_participants",
                available=len(participant_xs),
                threshold=t,
                my_x=my_x,
                peer_x_map=peer_x_map,
                n_peers_checked=len(peers) if 'peers' in dir() else 0,
                breaker_sample=breaker_info,
            )
            return MPCResult(
                available=False,
                participating_validators=len(participant_xs),
                failure_reason=f"insufficient_peers:{len(participant_xs)}/{t}",
            )

        # Generate random mask r (nonzero)
        r = secrets.randbelow(p - 1) + 1
        r_shares = _split_secret_at_points(r, participant_xs, t, p)
        r_share_map = {s.x: s.y for s in r_shares}

        # Attempt distributed OT triple generation if enabled
        use_network_ot = os.getenv("USE_NETWORK_OT", "").lower() in ("1", "true", "yes")
        pre_generated_triples: list[BeaverTriple] | None = None
        if use_network_ot and len(peers) == 1:
            ot_session_id = f"ot-{signal_id}-{secrets.token_hex(4)}"
            pre_generated_triples = await self._generate_ot_triples_via_network(
                session_id=ot_session_id,
                peer=peers[0],
                n_triples=n_gates,
                participant_xs=participant_xs,
                my_x=my_x,
                dh_group=self._ot_dh_group,
                field_prime=self._ot_field_prime or BN254_PRIME,
            )
            if pre_generated_triples is None:
                from djinn_validator.api.metrics import MPC_ERRORS

                MPC_ERRORS.labels(reason="ot_setup_failure").inc()
                log.warning(
                    "network_ot_failed_fallback",
                    signal_id=signal_id,
                    reason="distributed OT triple generation failed, using local generation",
                )

        # Create MPC session with Beaver triples
        session = self._coordinator.create_session(
            signal_id=signal_id,
            available_indices=sorted_avail,
            coordinator_x=my_x,
            participant_xs=participant_xs,
            threshold=t,
            pre_generated_triples=pre_generated_triples,
        )

        is_auth = session.is_authenticated

        # For authenticated mode: create authenticated r shares and secret shares
        auth_r_map: dict[int, AuthenticatedShare] = {}
        auth_secret_map: dict[int, AuthenticatedShare] = {}
        if is_auth:
            alpha = session.mac_alpha
            r_auth = authenticate_value(r, alpha, participant_xs, t, p)
            auth_r_map = {s.x: s for s in r_auth}
            # Authenticated MPC requires pre-authenticated shares created at
            # signal submission time. The coordinator must NOT reconstruct
            # the secret — doing so defeats the purpose of MPC. Until the
            # Genius creates authenticated shares during signal commitment,
            # the authenticated mode is not available.
            log.error(
                "authenticated_mpc_not_supported",
                signal_id=signal_id,
                reason="coordinator must not reconstruct secret; pre-authenticated shares required",
            )
            self._mark_session_failed(session)
            return None

        # Build our own participant state
        if is_auth:
            my_auth_triples = self._coordinator.get_authenticated_triple_shares(
                session.session_id,
                my_x,
            )
            my_mac_key = self._coordinator.get_mac_key_share(session.session_id, my_x)
            if my_auth_triples is None or my_mac_key is None:
                self._mark_session_failed(session)
                return None
            my_state_auth = AuthenticatedParticipantState(
                validator_x=my_x,
                secret_share=auth_secret_map[my_x],
                r_share=auth_r_map[my_x],
                alpha_share=my_mac_key,
                available_indices=sorted_avail,
                triple_a=[AuthenticatedShare(x=my_x, y=ts["a"]["y"], mac=ts["a"]["mac"]) for ts in my_auth_triples],
                triple_b=[AuthenticatedShare(x=my_x, y=ts["b"]["y"], mac=ts["b"]["mac"]) for ts in my_auth_triples],
                triple_c=[AuthenticatedShare(x=my_x, y=ts["c"]["y"], mac=ts["c"]["mac"]) for ts in my_auth_triples],
            )
        else:
            my_triples = self._coordinator.get_triple_shares_for_participant(
                session.session_id,
                my_x,
            )
            if my_triples is None:
                self._mark_session_failed(session)
                return None
            my_state_basic = DistributedParticipantState(
                validator_x=my_x,
                secret_share_y=local_share.y,
                r_share_y=r_share_map[my_x],
                available_indices=sorted_avail,
                triple_a=[ts["a"] for ts in my_triples],
                triple_b=[ts["b"] for ts in my_triples],
                triple_c=[ts["c"] for ts in my_triples],
            )

        # Distribute session invitations with triple shares + r shares
        accepted_peers: list[dict[str, Any]] = []

        async def _init_peer(
            peer: dict[str, Any],
        ) -> dict[str, Any] | None:
            peer_x = peer_x_map[peer["uid"]]
            init_payload: dict[str, Any] = {
                "session_id": session.session_id,
                "signal_id": signal_id,
                "available_indices": sorted_avail,
                "coordinator_x": my_x,
                "participant_xs": participant_xs,
                "threshold": t,
                "authenticated": is_auth,
            }

            if is_auth:
                auth_ts = self._coordinator.get_authenticated_triple_shares(
                    session.session_id,
                    peer_x,
                )
                mac_key = self._coordinator.get_mac_key_share(session.session_id, peer_x)
                peer_r_auth = auth_r_map.get(peer_x)
                peer_secret_auth = auth_secret_map.get(peer_x)
                if auth_ts is None or mac_key is None or peer_r_auth is None or peer_secret_auth is None:
                    return None
                init_payload["auth_triple_shares"] = [
                    {comp: {k: hex(v) for k, v in share.items()} for comp, share in ts.items()} for ts in auth_ts
                ]
                init_payload["alpha_share"] = hex(mac_key.alpha_share)
                init_payload["auth_r_share"] = {"y": hex(peer_r_auth.y), "mac": hex(peer_r_auth.mac)}
                init_payload["auth_secret_share"] = {"y": hex(peer_secret_auth.y), "mac": hex(peer_secret_auth.mac)}
                init_payload["r_share_y"] = hex(peer_r_auth.y)
                init_payload["triple_shares"] = []  # Empty for auth mode
            else:
                triple_shares = self._coordinator.get_triple_shares_for_participant(
                    session.session_id,
                    peer_x,
                )
                peer_r = r_share_map.get(peer_x)
                if triple_shares is None or peer_r is None:
                    return None
                init_payload["triple_shares"] = [{k: hex(v) for k, v in ts.items()} for ts in triple_shares]
                init_payload["r_share_y"] = hex(peer_r)

            try:
                t0 = time.monotonic()
                resp = await self._peer_request(
                    "post",
                    f"{peer['url']}/v1/mpc/init",
                    peer_uid=peer["uid"],
                    json=init_payload,
                )
                elapsed = time.monotonic() - t0
                if resp.status_code == 200 and resp.json().get("accepted"):
                    log.info("mpc_init_accepted", peer_uid=peer["uid"], elapsed_ms=round(elapsed * 1000))
                    return peer
                else:
                    log.warning(
                        "mpc_init_rejected",
                        peer_uid=peer["uid"],
                        status=resp.status_code,
                        body=resp.text[:200],
                        elapsed_ms=round(elapsed * 1000),
                    )
            except (httpx.HTTPError, KeyError, ValueError, json.JSONDecodeError) as e:
                log.warning(
                    "mpc_init_failed",
                    peer_uid=peer["uid"],
                    error_type=type(e).__name__,
                    error=str(e)[:200],
                    elapsed_ms=round((time.monotonic() - t0) * 1000) if 't0' in dir() else -1,
                )
            return None

        init_tasks = [asyncio.create_task(_init_peer(peer)) for peer in peers]
        results: list[Any] = []
        if init_tasks:
            done, pending = await asyncio.wait(init_tasks, timeout=GATHER_TIMEOUT)
            for t_task in pending:
                t_task.cancel()
            if pending:
                from djinn_validator.api.metrics import MPC_ERRORS
                MPC_ERRORS.labels(reason="peer_init_timeout").inc()
                log.warning("mpc_peer_init_timeout", n_timed_out=len(pending), n_completed=len(done))
            for t_task in done:
                try:
                    results.append(t_task.result())
                except Exception:
                    results.append(None)

        init_failures = sum(1 for r in results if r is None or isinstance(r, BaseException))
        if init_failures > 0:
            from djinn_validator.api.metrics import MPC_ERRORS

            MPC_ERRORS.labels(reason="peer_init_failure").inc()
            log.info("mpc_peer_init_failures", count=init_failures, total=len(peers))

        accepted_peers = [r for r in results if r is not None and not isinstance(r, BaseException)]

        # CRITICAL: Purge all peer triple shares from coordinator memory.
        # After distribution, the coordinator should only have its own shares.
        # This ensures no single validator can reconstruct intermediate values.
        self._coordinator.purge_peer_triple_shares(session.session_id, my_x)

        if len(accepted_peers) + 1 < t:
            log.warning(
                "mpc_insufficient_accepted",
                accepted=len(accepted_peers) + 1,
                threshold=t,
                init_results=[str(type(r).__name__) if r is None or isinstance(r, BaseException) else r.get("uid", "?") for r in results],
            )
            self._mark_session_failed(session)
            return MPCResult(
                available=False,
                participating_validators=len(accepted_peers) + 1,
                failure_reason=f"init_failed:{len(accepted_peers)+1}/{t}",
            )

        log.info(
            "mpc_distributed_session",
            session_id=session.session_id,
            accepted_peers=len(accepted_peers),
            authenticated=is_auth,
        )

        # Run per-gate protocol
        active_peers = list(accepted_peers)
        prev_d: int | None = None
        prev_e: int | None = None

        for gate_idx in range(n_gates):
            # Compute our own (d_i, e_i)
            if is_auth:
                # Finalize previous gate BEFORE computing the next one,
                # because compute_gate reads _prev_z which finalize_gate sets.
                if gate_idx > 0 and prev_d is not None and prev_e is not None:
                    my_state_auth.finalize_gate(prev_d, prev_e)
                my_d, my_e, my_d_mac, my_e_mac = my_state_auth.compute_gate(gate_idx, prev_d, prev_e)
            else:
                my_d, my_e = my_state_basic.compute_gate(gate_idx, prev_d, prev_e)

            d_vals: dict[int, int] = {my_x: my_d}
            e_vals: dict[int, int] = {my_x: my_e}
            # MAC share maps (authenticated mode only)
            d_mac_vals: dict[int, int] = {}
            e_mac_vals: dict[int, int] = {}
            if is_auth:
                d_mac_vals[my_x] = my_d_mac
                e_mac_vals[my_x] = my_e_mac

            # Collect from peers in parallel
            async def _collect_gate(
                peer: dict[str, Any],
                g_idx: int,
                p_d: int | None,
                p_e: int | None,
            ) -> tuple[int, int, int, int | None, int | None] | None:
                try:
                    resp = await self._peer_request(
                        "post",
                        f"{peer['url']}/v1/mpc/compute_gate",
                        peer_uid=peer["uid"],
                        json={
                            "session_id": session.session_id,
                            "gate_idx": g_idx,
                            "prev_opened_d": hex(p_d) if p_d is not None else None,
                            "prev_opened_e": hex(p_e) if p_e is not None else None,
                        },
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        px = peer_x_map[peer["uid"]]
                        d_mac = int(data["d_mac"], 16) if data.get("d_mac") else None
                        e_mac = int(data["e_mac"], 16) if data.get("e_mac") else None
                        return px, int(data["d_value"], 16), int(data["e_value"], 16), d_mac, e_mac
                except (httpx.HTTPError, KeyError, ValueError, json.JSONDecodeError) as e:
                    log.warning(
                        "mpc_gate_failed",
                        peer_uid=peer["uid"],
                        gate_idx=g_idx,
                        error_type=type(e).__name__,
                        error=str(e),
                    )
                return None

            gate_tasks = [asyncio.create_task(_collect_gate(peer, gate_idx, prev_d, prev_e)) for peer in active_peers]
            results: list[Any] = [None] * len(active_peers)
            if gate_tasks:
                done_g, pending_g = await asyncio.wait(gate_tasks, timeout=GATHER_TIMEOUT)
                for gt in pending_g:
                    gt.cancel()
                if pending_g:
                    from djinn_validator.api.metrics import MPC_ERRORS
                    MPC_ERRORS.labels(reason="gate_collect_timeout").inc()
                    log.warning("mpc_gate_collect_timeout", gate_idx=gate_idx, n_timed_out=len(pending_g), n_completed=len(done_g))
                # Map results back by task index
                task_list = list(gate_tasks)
                for i, gt in enumerate(task_list):
                    if gt in done_g:
                        try:
                            results[i] = gt.result()
                        except Exception:
                            results[i] = None

            failed = []
            for i, result in enumerate(results):
                if result is None or isinstance(result, BaseException):
                    failed.append(active_peers[i])
                else:
                    peer_x, d_val, e_val, d_mac, e_mac = result
                    d_vals[peer_x] = d_val
                    e_vals[peer_x] = e_val
                    if d_mac is not None:
                        d_mac_vals[peer_x] = d_mac
                    if e_mac is not None:
                        e_mac_vals[peer_x] = e_mac

            for fp in failed:
                active_peers.remove(fp)

            if len(d_vals) < t:
                log.warning(
                    "mpc_gate_insufficient",
                    gate_idx=gate_idx,
                    remaining=len(d_vals),
                    threshold=t,
                )
                self._mark_session_failed(session)
                return MPCResult(
                    available=False,
                    participating_validators=len(d_vals),
                    failure_reason=f"gate_{gate_idx}_insufficient:{len(d_vals)}/{t}",
                )

            # Reconstruct publicly opened d and e
            prev_d = reconstruct_at_zero(d_vals, p)
            prev_e = reconstruct_at_zero(e_vals, p)

            # SPDZ MAC verification on opened d and e
            if is_auth and d_mac_vals and e_mac_vals:
                mac_key_shares = [
                    self._coordinator.get_mac_key_share(session.session_id, vx) for vx in sorted(d_mac_vals.keys())
                ]
                # Verify d
                d_auth_shares = [
                    AuthenticatedShare(x=vx, y=d_vals[vx], mac=d_mac_vals[vx]) for vx in sorted(d_mac_vals.keys())
                ]
                if not verify_mac_opening(prev_d, d_auth_shares, [m for m in mac_key_shares if m], p):
                    from djinn_validator.api.metrics import MPC_ERRORS

                    MPC_ERRORS.labels(reason="mac_failure").inc()
                    log.error("mac_verification_failed", gate_idx=gate_idx, value="d")
                    await self._broadcast_abort(
                        session.session_id,
                        active_peers,
                        gate_idx,
                        "d_mac_check_failed",
                    )
                    return None
                # Verify e
                e_auth_shares = [
                    AuthenticatedShare(x=vx, y=e_vals[vx], mac=e_mac_vals[vx]) for vx in sorted(e_mac_vals.keys())
                ]
                if not verify_mac_opening(prev_e, e_auth_shares, [m for m in mac_key_shares if m], p):
                    from djinn_validator.api.metrics import MPC_ERRORS

                    MPC_ERRORS.labels(reason="mac_failure").inc()
                    log.error("mac_verification_failed", gate_idx=gate_idx, value="e")
                    await self._broadcast_abort(
                        session.session_id,
                        active_peers,
                        gate_idx,
                        "e_mac_check_failed",
                    )
                    return None
                log.debug("mac_verified", gate_idx=gate_idx)

        # Finalize last gate for authenticated mode
        if is_auth and prev_d is not None and prev_e is not None:
            my_state_auth.finalize_gate(prev_d, prev_e)

        # Compute final output shares z_i.
        # CRITICAL: Each participant computes its own z_i locally.
        # The coordinator never accesses peer triple shares — this is the
        # secrecy guarantee. Peers return only the scalar z_i value.
        z_vals: dict[int, int] = {}

        # Coordinator computes its own z_i
        if is_auth:
            out = my_state_auth.get_output_share()
            if out:
                z_vals[my_x] = out.y
        else:
            z_vals[my_x] = my_state_basic.compute_output_share(prev_d, prev_e)

        # Collect z_i from each peer via /v1/mpc/finalize
        async def _collect_z(peer: dict[str, Any]) -> tuple[int, int] | None:
            try:
                resp = await self._peer_request(
                    "post",
                    f"{peer['url']}/v1/mpc/finalize",
                    peer_uid=peer["uid"],
                    json={
                        "session_id": session.session_id,
                        "last_opened_d": hex(prev_d),
                        "last_opened_e": hex(prev_e),
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    px = peer_x_map[peer["uid"]]
                    return px, int(data["z_share"], 16)
            except (httpx.HTTPError, KeyError, ValueError, json.JSONDecodeError) as e:
                log.warning("mpc_finalize_failed", peer_uid=peer["uid"], error=str(e))
            return None

        z_tasks = [asyncio.create_task(_collect_z(p)) for p in active_peers]
        z_results: list[Any] = []
        if z_tasks:
            done_z, pending_z = await asyncio.wait(z_tasks, timeout=GATHER_TIMEOUT)
            for zt in pending_z:
                zt.cancel()
            if pending_z:
                log.warning("mpc_finalize_timeout", n_timed_out=len(pending_z), n_completed=len(done_z))
            for zt in done_z:
                try:
                    z_results.append(zt.result())
                except Exception:
                    z_results.append(None)

        for result in z_results:
            if result is not None and not isinstance(result, BaseException):
                peer_x, z_i = result
                z_vals[peer_x] = z_i

        if len(z_vals) < t:
            log.warning("mpc_finalize_insufficient", collected=len(z_vals), threshold=t)
            self._mark_session_failed(session)
            return MPCResult(
                available=False,
                participating_validators=len(z_vals),
                failure_reason=f"finalize_insufficient:{len(z_vals)}/{t}",
            )

        # Reconstruct the final result: r * P(s) — zero iff s ∈ available set
        result_value = reconstruct_at_zero(z_vals, p)
        available = result_value == 0

        mpc_result = MPCResult(
            available=available,
            participating_validators=len(z_vals),
        )

        # Update session state
        with self._coordinator._lock:
            session.result = mpc_result
            session.status = SessionStatus.COMPLETE

        log.info(
            "mpc_distributed_result",
            session_id=session.session_id,
            available=available,
            participants=len(z_vals),
            gates=n_gates,
            authenticated=is_auth,
        )

        # Broadcast result to peers (parallel, best-effort with timeout)
        async def _broadcast_result(peer: dict[str, Any]) -> None:
            try:
                await self._peer_request(
                    "post",
                    f"{peer['url']}/v1/mpc/result",
                    peer_uid=peer["uid"],
                    json={
                        "session_id": session.session_id,
                        "signal_id": signal_id,
                        "available": available,
                        "participating_validators": len(z_vals),
                    },
                )
            except httpx.HTTPError as e:
                log.warning(
                    "mpc_result_broadcast_failed",
                    peer_uid=peer["uid"],
                    error_type=type(e).__name__,
                    error=str(e),
                )

        try:
            await asyncio.wait_for(
                asyncio.gather(
                    *(_broadcast_result(p) for p in active_peers),
                    return_exceptions=True,
                ),
                timeout=GATHER_TIMEOUT,
            )
        except asyncio.TimeoutError:
            log.warning(
                "mpc_result_broadcast_timeout",
                timeout=GATHER_TIMEOUT,
                n_peers=len(active_peers),
            )

        return mpc_result

    async def _broadcast_abort(
        self,
        session_id: str,
        peers: list[dict[str, Any]],
        gate_idx: int,
        reason: str,
        offending_x: int | None = None,
    ) -> None:
        """Broadcast an abort message to all peers when MAC verification fails.

        Marks the local session as FAILED and notifies all active peers
        so they can clean up their participant state.
        """
        # Mark local session as failed
        session = self._coordinator.get_session(session_id)
        if session is not None:
            with self._coordinator._lock:
                session.status = SessionStatus.FAILED

        log.warning(
            "mpc_abort_broadcast",
            session_id=session_id,
            gate_idx=gate_idx,
            reason=reason,
            offending_x=offending_x,
            n_peers=len(peers),
        )

        payload = {
            "session_id": session_id,
            "reason": reason,
            "gate_idx": gate_idx,
            "offending_validator_x": offending_x,
        }

        for peer in peers:
            try:
                await self._peer_request("post", f"{peer['url']}/v1/mpc/abort", peer_uid=peer.get("uid"), json=payload)
            except (httpx.HTTPError, Exception) as e:
                log.warning(
                    "mpc_abort_send_failed",
                    peer_uid=peer.get("uid"),
                    error=str(e),
                )

    async def _generate_ot_triples_via_network(
        self,
        session_id: str,
        peer: dict[str, Any],
        n_triples: int,
        participant_xs: list[int],
        my_x: int,
        dh_group: Any | None = None,
        field_prime: int = BN254_PRIME,
    ) -> list[BeaverTriple] | None:
        """Generate Beaver triples via 2-party OT over HTTP.

        Runs the 4-phase Gilboa OT protocol with a single peer:
        1. Setup — both parties initialize OT state, exchange sender PKs
        2. Choices — exchange receiver choice commitments
        3. Transfers — exchange encrypted OT messages
        4. Complete — decrypt, accumulate, compute Shamir evaluations
        5. Collect partial Shamir evaluations and combine into BeaverTriples

        Neither party learns the other's additive shares. The coordinator
        collects Shamir evaluations at all x_coords to form the final
        BeaverTriple objects for distribution.

        Currently supports 2-party case only (coordinator + 1 peer).
        For n > 2, peer-to-peer connections are needed.
        """
        from djinn_validator.core.ot_network import DEFAULT_DH_GROUP

        if dh_group is None:
            dh_group = DEFAULT_DH_GROUP
        p = field_prime

        # Create coordinator's local OT state
        coord_state = OTTripleGenState(
            session_id=session_id,
            party_role="coordinator",
            n_triples=n_triples,
            x_coords=participant_xs,
            threshold=self._threshold,
            prime=p,
            dh_group=dh_group,
        )
        coord_state.initialize()

        try:
            # Phase 1: Setup — initialize peer's OT state
            setup_payload: dict[str, Any] = {
                "session_id": session_id,
                "n_triples": n_triples,
                "x_coords": participant_xs,
                "threshold": self._threshold,
            }
            # Pass custom field prime / DH group if non-default
            if p != BN254_PRIME:
                setup_payload["field_prime"] = hex(p)
            if dh_group is not DEFAULT_DH_GROUP:
                setup_payload["dh_prime"] = hex(dh_group.prime)

            setup_resp = await self._peer_request(
                "post",
                f"{peer['url']}/v1/mpc/ot/setup",
                peer_uid=peer.get("uid"),
                json=setup_payload,
            )
            if setup_resp.status_code != 200 or not setup_resp.json().get("accepted"):
                log.warning("ot_setup_failed", peer_uid=peer.get("uid"), status=setup_resp.status_code)
                return None

            peer_sender_pks = {
                int(t): deserialize_dh_public_key(pk_hex)
                for t, pk_hex in setup_resp.json()["sender_public_keys"].items()
            }

            # Phase 2: Exchange choices (bidirectional)
            # Direction A: coordinator is sender → get peer's receiver choices
            coord_sender_pks_ser = {
                str(t): serialize_dh_public_key(pk, dh_group) for t, pk in coord_state.get_sender_public_keys().items()
            }
            choices_resp = await self._peer_request(
                "post",
                f"{peer['url']}/v1/mpc/ot/choices",
                peer_uid=peer.get("uid"),
                json={"session_id": session_id, "peer_sender_pks": coord_sender_pks_ser},
            )
            if choices_resp.status_code != 200:
                log.warning("ot_choices_failed", peer_uid=peer.get("uid"), status=choices_resp.status_code)
                return None

            peer_choices = {int(t): deserialize_choices(c) for t, c in choices_resp.json()["choices"].items()}

            # Direction B: peer is sender → coordinator generates receiver choices
            coord_choices = coord_state.generate_receiver_choices(peer_sender_pks)

            # Phase 3: Exchange transfers (bidirectional)
            # Direction A: coordinator processes peer's choices using coordinator's sender
            coord_transfers, coord_sender_shares = coord_state.process_sender_choices(peer_choices)

            # Direction B: send coordinator's choices to peer's sender
            coord_choices_ser = {str(t): serialize_choices(c, dh_group) for t, c in coord_choices.items()}
            transfers_resp = await self._peer_request(
                "post",
                f"{peer['url']}/v1/mpc/ot/transfers",
                peer_uid=peer.get("uid"),
                json={"session_id": session_id, "peer_choices": coord_choices_ser},
            )
            if transfers_resp.status_code != 200:
                log.warning("ot_transfers_failed", peer_uid=peer.get("uid"), status=transfers_resp.status_code)
                return None

            transfer_data = transfers_resp.json()
            peer_transfers = {int(t): deserialize_transfers(pairs) for t, pairs in transfer_data["transfers"].items()}
            peer_sender_shares_hex = transfer_data["sender_shares"]

            # Phase 4: Decrypt & accumulate (both directions)
            # Coordinator decrypts peer's transfers (direction B: peer is sender)
            coord_receiver_shares = coord_state.decrypt_receiver_transfers(peer_transfers)
            coord_state.accumulate_ot_shares(coord_sender_shares, coord_receiver_shares)
            coord_state.compute_shamir_evaluations()

            # Send coordinator's transfers to peer for decryption (direction A)
            coord_transfers_ser = {str(t): serialize_transfers(pairs) for t, pairs in coord_transfers.items()}
            complete_resp = await self._peer_request(
                "post",
                f"{peer['url']}/v1/mpc/ot/complete",
                peer_uid=peer.get("uid"),
                json={
                    "session_id": session_id,
                    "peer_transfers": coord_transfers_ser,
                    "own_sender_shares": peer_sender_shares_hex,
                },
            )
            if complete_resp.status_code != 200 or not complete_resp.json().get("completed"):
                log.warning("ot_complete_failed", peer_uid=peer.get("uid"), status=complete_resp.status_code)
                return None

            # Phase 5: Collect Shamir evaluations and combine
            # Get peer's evaluations at each x_coord
            peer_evals: dict[int, list[dict[str, int]]] = {}
            for x in participant_xs:
                shares_resp = await self._peer_request(
                    "post",
                    f"{peer['url']}/v1/mpc/ot/shares",
                    peer_uid=peer.get("uid"),
                    json={"session_id": session_id, "party_x": x},
                )
                if shares_resp.status_code != 200:
                    log.warning("ot_shares_failed", peer_uid=peer.get("uid"), party_x=x)
                    return None
                peer_evals[x] = [
                    {"a": int(s["a"], 16), "b": int(s["b"], 16), "c": int(s["c"], 16)}
                    for s in shares_resp.json()["triple_shares"]
                ]

        except (httpx.HTTPError, KeyError, ValueError, json.JSONDecodeError) as e:
            log.warning(
                "ot_network_error",
                peer_uid=peer.get("uid"),
                error_type=type(e).__name__,
                error=str(e),
            )
            return None

        # Combine coordinator + peer Shamir evaluations into BeaverTriples
        triples: list[BeaverTriple] = []
        for t_idx in range(n_triples):
            a_shares = []
            b_shares = []
            c_shares = []
            for x in participant_xs:
                coord_s = coord_state.get_shamir_shares_for_party(x)
                if coord_s is None:
                    return None
                peer_s = peer_evals[x]
                a_val = (coord_s[t_idx]["a"] + peer_s[t_idx]["a"]) % p
                b_val = (coord_s[t_idx]["b"] + peer_s[t_idx]["b"]) % p
                c_val = (coord_s[t_idx]["c"] + peer_s[t_idx]["c"]) % p
                a_shares.append(Share(x=x, y=a_val))
                b_shares.append(Share(x=x, y=b_val))
                c_shares.append(Share(x=x, y=c_val))
            triples.append(
                BeaverTriple(
                    a_shares=tuple(a_shares),
                    b_shares=tuple(b_shares),
                    c_shares=tuple(c_shares),
                )
            )

        log.info(
            "ot_triples_generated_via_network",
            n_triples=n_triples,
            peer_uid=peer.get("uid"),
        )
        return triples

    def _single_validator_check(
        self,
        share: Share,
        available_indices: set[int],
    ) -> MPCResult:
        """Prototype single-validator availability check.

        Uses threshold=1 reconstruction for dev/testing mode.
        NOT used in production — the distributed path with /v1/mpc/finalize
        ensures no single validator can reconstruct the secret.
        """
        all_xs = [share.x]
        contrib = compute_local_contribution(share, all_xs)
        return check_availability([contrib], available_indices, threshold=1)
