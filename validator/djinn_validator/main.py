"""Entry point for the Djinn Protocol Bittensor validator.

Starts the FastAPI server and the Bittensor epoch loop concurrently.
"""

from __future__ import annotations

import asyncio
import os
import random
import signal
import time

import httpx
import structlog
import uvicorn

from djinn_validator import __version__
from djinn_validator.log_config import configure_logging

configure_logging()

from djinn_validator.api.server import create_app
from djinn_validator.bt.neuron import DjinnValidator
from djinn_validator.chain.contracts import ChainClient
from djinn_validator.config import Config
from djinn_validator.core.mpc_coordinator import MPCCoordinator
from djinn_validator.core.outcomes import OutcomeAttestor
from djinn_validator.core.purchase import PurchaseOrchestrator
from djinn_validator.core.attestation_log import AttestationLog
from djinn_validator.core.challenges import challenge_miners, challenge_miners_attestation
from djinn_validator.core.espn import ESPNClient
from djinn_validator.core.activity import ActivityBuffer, ActivityCategory
from djinn_validator.core.audit_set import AuditSetStore
from djinn_validator.core.mpc_audit import batch_settle_audit_set
from djinn_validator.core.scoring import MinerScorer
from djinn_validator.core.shares import ShareStore
from djinn_validator.core.telemetry import TelemetryStore
from djinn_validator.core.validator_sync import ValidatorSetSyncer
from djinn_validator.utils.watchtower import watch_loop as watchtower_loop


def _sanitize_url(url: str) -> str:
    """Strip credentials and path from URL for safe logging."""
    from urllib.parse import urlparse

    try:
        parsed = urlparse(url)
        return f"{parsed.scheme}://{parsed.hostname}:{parsed.port or 443}"
    except Exception:
        return "<unparseable>"

log = structlog.get_logger()


async def epoch_loop(
    neuron: DjinnValidator,
    scorer: MinerScorer,
    share_store: ShareStore,
    outcome_attestor: OutcomeAttestor,
    chain_client: ChainClient | None = None,
    activity: ActivityBuffer | None = None,
    audit_set_store: AuditSetStore | None = None,
    burn_fraction: float = 0.80,
    espn_client: ESPNClient | None = None,
    shares_threshold: int = 3,
    telemetry: TelemetryStore | None = None,
) -> None:
    """Main validator epoch loop: sync metagraph, score miners, set weights."""
    log.info(
        "epoch_loop_started",
        settlement_enabled=chain_client is not None and chain_client.can_write,
    )
    consecutive_errors = 0

    # DDoS shield: resolve miner tunnel URLs for fallback routing
    _shield_resolver = None
    try:
        from djinn_tunnel_shield import ShieldResolver
        _shield_resolver = ShieldResolver(wallet=neuron.wallet if neuron else None)
        log.info("shield_resolver_enabled")
    except ImportError:
        pass  # Shield not installed, direct IP only

    # Throttle miner challenges: once every CHALLENGE_INTERVAL_EPOCHS epochs (~10 min)
    CHALLENGE_INTERVAL_EPOCHS = 50  # 50 * 12s = 10 minutes
    ATTESTATION_CHALLENGE_INTERVAL = 100  # 100 * 12s = ~20 min
    epoch_count = 0
    # Time-based fallback: reset scorer if weights haven't been set in MAX_EPOCH_DURATION
    MAX_EPOCH_DURATION = 1800  # 30 minutes
    last_reset_time = time.monotonic()

    while True:
        try:
            # Sync metagraph (with 30s timeout to prevent hanging)
            neuron.sync_metagraph(timeout=30.0)

            # Health-check all miners by pinging their axon /health endpoint
            miner_uids = neuron.get_miner_uids()
            if epoch_count % 50 == 0:
                log.info("epoch_tick", epoch=epoch_count, miners=len(miner_uids))

            # Prune deregistered miner UIDs from scorer
            scorer.prune_absent(set(miner_uids))

            async def _verify_proactive_proof(
                ip: str, port: int, uid: int, metrics: object,
            ) -> None:
                """Fetch and verify a miner's proactive attestation proof.

                Uses its own httpx client because the health check client
                may close before this background task runs.
                """
                try:
                    async with httpx.AsyncClient(timeout=30.0) as proof_client:
                        proof_resp = await proof_client.get(
                            f"http://{ip}:{port}/v1/attestation/latest",
                        )
                    if proof_resp.status_code != 200:
                        return
                    pdata = proof_resp.json()
                    if not pdata.get("available") or not pdata.get("proof_hex"):
                        return

                    proof_bytes = bytes.fromhex(pdata["proof_hex"])
                    notary_key = pdata.get("notary_pubkey", "")

                    from djinn_validator.core import tlsn as tlsn_verifier
                    if not tlsn_verifier.is_available():
                        return
                    verify_result = await asyncio.wait_for(
                        tlsn_verifier.verify_proof(
                            proof_bytes,
                            expected_notary_key=notary_key or None,
                        ),
                        timeout=30.0,
                    )
                    if verify_result.verified:
                        metrics.proactive_proof_verified = True
                        metrics.record_attestation(latency=pdata.get("proof_age_s", 0), proof_valid=True)
                        log.info(
                            "proactive_proof_verified",
                            uid=uid,
                            server=pdata.get("server_name", ""),
                            age_s=round(pdata.get("proof_age_s", 0), 1),
                        )
                    else:
                        log.warning("proactive_proof_invalid", uid=uid, error=verify_result.error)
                except Exception as e:
                    log.warning("proactive_proof_check_error", uid=uid, error=str(e))

            async def _check_health(client: httpx.AsyncClient, uid: int) -> None:
                axon = neuron.get_axon_info(uid)
                hotkey = axon.get("hotkey", f"uid-{uid}")
                ip = axon.get("ip", "")
                port = axon.get("port", 0)
                metrics = scorer.get_or_create(uid, hotkey)
                if not ip or not port:
                    metrics.record_health_check(responded=False)
                    return
                # SSRF protection: skip miners with non-public IPs
                from djinn_validator.core.mpc_orchestrator import _is_public_ip
                if not _is_public_ip(ip):
                    log.debug("health_check_skip_non_public_ip", uid=uid, ip=ip)
                    metrics.record_health_check(responded=False)
                    return
                urls = [f"http://{ip}:{port}/health"]
                if _shield_resolver:
                    urls = _shield_resolver.urls(uid, ip, port, "/health")
                responded = False
                for url in urls:
                    try:
                        resp = await client.get(url)
                        if resp.status_code == 200:
                            responded = True
                            if _shield_resolver:
                                _shield_resolver.record_success(uid)
                            break
                    except httpx.HTTPError:
                        if _shield_resolver:
                            _shield_resolver.record_failure(uid)
                        continue
                if responded:
                    try:
                        data = resp.json()
                        v = data.get("version", "")
                        if v:
                            metrics.reported_version = str(v)
                        caps = data.get("capabilities")
                        if caps and isinstance(caps, dict):
                            metrics.update_capabilities(
                                memory_total_mb=caps.get("memory_total_mb", 0),
                                memory_available_mb=caps.get("memory_available_mb", 0),
                                cpu_cores=caps.get("cpu_cores", 0),
                                cpu_load_1m=caps.get("cpu_load_1m", 0.0),
                                tlsn_max_concurrent=caps.get("tlsn_max_concurrent", 0),
                                tlsn_active_sessions=caps.get("tlsn_active_sessions", 0),
                                notary_max_concurrent=caps.get("notary_max_concurrent", 0),
                                notary_active_sessions=caps.get("notary_active_sessions", 0),
                                disk_free_gb=caps.get("disk_free_gb", 0.0),
                            )
                        # Cache tunnel URL for DDoS fallback
                        if _shield_resolver and data.get("tunnel_url"):
                            _shield_resolver.cache_from_health(uid, data)
                        # Check proactive proof if present.
                        # Do NOT set proactive_proof_verified here.
                        # A malicious miner could fake this health field.
                        # The flag is only set after background TLSNotary
                        # verification succeeds in _verify_proactive_proof.
                        pp = data.get("proactive_proof")
                        if pp:
                            bh = pp.get("binary_hash", "")
                            if bh:
                                metrics.tlsn_binary_hash = bh
                            if (
                                pp.get("proof_age_s", 99999) < 86400
                                and not metrics.proactive_proof_verified
                            ):
                                asyncio.create_task(
                                    _verify_proactive_proof(ip, port, uid, metrics)
                                )
                    except Exception:
                        pass  # Old miners may not return JSON or capabilities
                metrics.record_health_check(responded=responded)

            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                await asyncio.gather(*[_check_health(client, uid) for uid in miner_uids])

            responded = sum(
                1 for uid in miner_uids
                if (m := scorer.get(uid)) is not None and m.health_checks_responded > 0
            ) if miner_uids else 0
            failed_uids = [
                uid for uid in miner_uids
                if (m := scorer.get(uid)) is not None and m.health_checks_responded == 0
            ] if miner_uids else []
            if activity is not None and miner_uids:
                activity.record(
                    ActivityCategory.HEALTH_CHECK,
                    f"{responded}/{len(miner_uids)} miners responded",
                    responded=responded, total=len(miner_uids),
                    failed_uids=failed_uids[:50],
                )
            if telemetry and miner_uids:
                telemetry.record(
                    "health_check",
                    f"{responded}/{len(miner_uids)} miners responded",
                    responded=responded, total=len(miner_uids),
                    failed_uids=failed_uids[:50],
                )

            # Challenge miners for accuracy scoring (throttled)
            epoch_count += 1
            if epoch_count % CHALLENGE_INTERVAL_EPOCHS == 0:
                if miner_uids:
                    miner_axons = []
                    for uid in miner_uids:
                        axon = neuron.get_axon_info(uid)
                        miner_axons.append({
                            "uid": uid,
                            "hotkey": axon.get("hotkey", f"uid-{uid}"),
                            "ip": axon.get("ip", ""),
                            "port": axon.get("port", 0),
                        })
                    try:
                        cr = await challenge_miners(scorer, miner_axons, espn_client=espn_client, wallet=neuron.wallet)
                        if activity and cr.challenged:
                            activity.record(
                                ActivityCategory.CHALLENGE_ROUND,
                                f"Challenged {cr.challenged} miners on {cr.sport}",
                                miners_challenged=cr.challenged,
                                sport=cr.sport,
                                games_found=cr.games_found,
                                lines_used=cr.lines_used,
                                responding=cr.responding,
                                consensus_quorum=cr.consensus_quorum,
                                proofs_requested=cr.proofs_requested,
                                proofs_submitted=cr.proofs_submitted,
                                miners=cr.miner_results[:50],
                                challenge_lines=cr.challenge_lines,
                            )
                        if telemetry and cr.challenged:
                            telemetry.record(
                                "challenge_round",
                                f"Challenged {cr.challenged} miners on {cr.sport}: {cr.responding} responded, {cr.games_found} games, {cr.lines_used} lines",
                                miners_challenged=cr.challenged,
                                sport=cr.sport,
                                games_found=cr.games_found,
                                lines_used=cr.lines_used,
                                responding=cr.responding,
                                consensus_quorum=cr.consensus_quorum,
                                proofs_requested=cr.proofs_requested,
                                proofs_submitted=cr.proofs_submitted,
                                miners=cr.miner_results[:50],
                                challenge_lines=cr.challenge_lines,
                            )
                    except Exception as e:
                        log.warning("challenge_miners_error", err=str(e))
                        if telemetry:
                            telemetry.record("challenge_error", f"Challenge failed: {e}", error=str(e), error_type=type(e).__name__)

            # Attestation challenges: run less frequently than sports (~20 min)
            if epoch_count % ATTESTATION_CHALLENGE_INTERVAL == 0 and miner_uids:
                miner_axons = []
                for uid in miner_uids:
                    axon = neuron.get_axon_info(uid)
                    miner_axons.append({
                        "uid": uid,
                        "hotkey": axon.get("hotkey", f"uid-{uid}"),
                        "ip": axon.get("ip", ""),
                        "port": axon.get("port", 0),
                    })
                try:
                    ar = await challenge_miners_attestation(scorer, miner_axons, wallet=neuron.wallet)
                    if activity and ar.challenged:
                        # Count how many miners used peer notaries vs default
                        peer_notarized = sum(1 for m in ar.miner_results if m.get("peer_notary"))
                        summary = f"Attestation: {ar.verified}/{ar.challenged} verified ({ar.url.split('/')[2]})"
                        if peer_notarized:
                            summary += f" [{peer_notarized} peer-notarized]"
                        activity.record(
                            ActivityCategory.ATTESTATION_CHALLENGE,
                            summary,
                            challenged=ar.challenged,
                            verified=ar.verified,
                            url=ar.url,
                            reachable=ar.reachable,
                            capable=ar.capable,
                            peer_notarized=peer_notarized,
                            miners=ar.miner_results,
                        )
                    if telemetry and ar.challenged:
                        telemetry.record(
                            "attestation_challenge",
                            f"Attestation: {ar.verified}/{ar.challenged} verified for {ar.url}",
                            challenged=ar.challenged,
                            verified=ar.verified,
                            url=ar.url,
                            reachable=ar.reachable,
                            capable=ar.capable,
                            miners=ar.miner_results,
                        )
                except Exception as e:
                    log.warning("attest_challenge_error", err=str(e))
                    if telemetry:
                        telemetry.record("attestation_error", f"Attestation challenge failed: {e}", error=str(e), error_type=type(e).__name__)

            # Phase 1: Resolve games — compute all 10 line outcomes per signal
            # (public ESPN data, no MPC at this stage)
            hotkey = ""
            if neuron.wallet:
                hotkey = neuron.wallet.hotkey.ss58_address

            resolved_ids = await outcome_attestor.resolve_all_pending(hotkey)
            if resolved_ids:
                log.info("outcomes_resolved", count=len(resolved_ids))
                if activity is not None:
                    activity.record(
                        ActivityCategory.OUTCOME_RESOLUTION,
                        f"Resolved {len(resolved_ids)} signal outcomes",
                        count=len(resolved_ids),
                        signal_ids=resolved_ids[:20],
                    )
                if telemetry:
                    telemetry.record(
                        "outcome_resolution",
                        f"Resolved {len(resolved_ids)} signal outcomes",
                        count=len(resolved_ids),
                        signal_ids=resolved_ids[:20],
                    )
                # Record outcomes on audit set store
                if audit_set_store:
                    for signal_id in resolved_ids:
                        meta = outcome_attestor.get_signal(signal_id)
                        if meta and meta.outcomes:
                            audit_set_store.record_outcomes(signal_id, meta.outcomes)

            # Phase 2: Check for ready audit sets → batch MPC → vote aggregates
            if audit_set_store:
                ready_sets = audit_set_store.get_ready_sets()
                for audit_set in ready_sets:
                    result = batch_settle_audit_set(audit_set, share_store, threshold=shares_threshold)
                    if result is None:
                        continue
                    # Phase 3: Submit aggregate quality score vote on-chain
                    if chain_client and chain_client.can_write:
                        try:
                            tx_hash = await chain_client.submit_vote(
                                result.genius, result.idiot, result.quality_score,
                                result.total_notional,
                            )
                            log.info(
                                "audit_vote_submitted",
                                genius=result.genius,
                                idiot=result.idiot,
                                cycle=result.cycle,
                                quality_score=result.quality_score,
                                wins=result.wins,
                                losses=result.losses,
                                voids=result.voids,
                                tx_hash=tx_hash,
                            )
                            if telemetry:
                                telemetry.record(
                                    "audit_vote",
                                    f"Vote submitted: quality={result.quality_score} ({result.wins}W/{result.losses}L/{result.voids}V)",
                                    genius=result.genius, idiot=result.idiot,
                                    cycle=result.cycle, quality_score=result.quality_score,
                                    wins=result.wins, losses=result.losses, voids=result.voids,
                                    tx_hash=tx_hash,
                                )
                        except Exception as e:
                            err_str = str(e)
                            if "AlreadyVoted" in err_str or "CycleAlreadyFinalized" in err_str:
                                log.debug("audit_vote_skipped", reason=err_str[:80])
                            else:
                                log.error("audit_vote_failed", err=err_str)
                                if telemetry:
                                    telemetry.record("audit_vote_error", f"Vote failed: {err_str[:200]}", error=err_str[:500])
                                continue  # Don't mark settled if vote failed
                    else:
                        # No chain client or read-only mode — skip settlement
                        log.debug("audit_vote_skipped_no_writer", genius=result.genius, idiot=result.idiot, cycle=result.cycle)
                        continue
                    audit_set_store.mark_settled(
                        result.genius, result.idiot, result.cycle,
                    )

            # Prune old resolved signals to prevent memory growth
            await outcome_attestor.cleanup_resolved()

            # Active epoch = miners were actually challenged this interval
            is_active = any(
                m.queries_total > 0 or m.attestations_total > 0
                for m in scorer._miners.values()
            )

            # Compute and set weights — only reset metrics AFTER weights are set
            # so that challenge data accumulates across the full interval
            if neuron.should_set_weights():
                weights, breakdowns = scorer.compute_weights_detailed(is_active)
                weights = neuron.apply_burn(weights or {}, burn_fraction)
                n_miners = len(weights) - 1  # exclude UID 0 burn entry
                success = neuron.set_weights(weights)
                if success:
                    neuron.record_weight_set()
                    # All miners by weight (excluding UID 0 burn)
                    sorted_w = sorted(
                        ((uid, w) for uid, w in weights.items() if uid != 0),
                        key=lambda x: x[1], reverse=True,
                    )
                    top_miners = []
                    for uid, w in sorted_w:
                        bd = breakdowns.get(uid, {})
                        top_miners.append({
                            "uid": uid,
                            "weight": round(w, 6),
                            "accuracy": round(bd.get("accuracy", 0), 4),
                            "speed": round(bd.get("speed", 0), 4),
                            "coverage": round(bd.get("coverage", 0), 4),
                            "uptime": round(bd.get("uptime", 0), 4),
                            "attest_validity": round(bd.get("attest_validity", 0), 4),
                            "attest_speed": round(bd.get("attest_speed", 0), 4),
                            "sports_score": round(bd.get("sports_score", 0), 4),
                            "attestation_score": round(bd.get("attestation_score", 0), 4),
                            "queries_total": bd.get("queries_total", 0),
                            "attestations_total": bd.get("attestations_total", 0),
                            "health_responded": bd.get("health_checks_responded", 0),
                            "consecutive_epochs": bd.get("consecutive_epochs", 0),
                        })
                    if activity is not None:
                        activity.record(
                            ActivityCategory.WEIGHT_SET,
                            f"Set weights for {n_miners} miners (burn={burn_fraction})",
                            n_miners=n_miners, is_active=is_active,
                            burn_fraction=burn_fraction,
                            top_miners=top_miners,
                            total_miners=len(sorted_w),
                        )
                    if telemetry:
                        telemetry.record(
                            "weight_set",
                            f"Set weights for {n_miners} miners (burn={burn_fraction})",
                            n_miners=n_miners, is_active=is_active,
                            burn_fraction=burn_fraction,
                            top_miners=top_miners,
                            total_miners=len(sorted_w),
                            success=True,
                        )
                        telemetry.record_miner_weights(top_miners)
                else:
                    weight_error = neuron.last_weight_error or "Unknown error"
                    if activity is not None:
                        activity.record(
                            ActivityCategory.WEIGHT_SET,
                            f"Failed to set weights for {n_miners} miners: {weight_error}",
                            n_miners=n_miners, is_active=is_active,
                            success=False,
                            error=weight_error,
                        )
                    if telemetry:
                        telemetry.record(
                            "weight_set_failed",
                            f"Failed to set weights for {n_miners} miners: {weight_error}",
                            n_miners=n_miners, is_active=is_active,
                            success=False,
                            error=weight_error,
                        )
                log.info("weights_updated", n_miners=n_miners, active=is_active, success=success)
                # Persist scores to SQLite before resetting epoch metrics
                scorer.persist_all()
                # Reset per-epoch metrics after weight setting (increments
                # consecutive_epochs for miners that participated)
                scorer.reset_epoch()
                last_reset_time = time.monotonic()
            elif time.monotonic() - last_reset_time > MAX_EPOCH_DURATION:
                # Fallback: reset scorer even if weights weren't set to prevent
                # unbounded metric accumulation when weight-setting is stuck
                log.warning(
                    "epoch_reset_fallback",
                    seconds_since_reset=round(time.monotonic() - last_reset_time),
                    msg="Resetting scorer metrics. Weight-setting has not fired in 30 min.",
                )
                scorer.persist_all()
                scorer.reset_epoch()
                last_reset_time = time.monotonic()

            consecutive_errors = 0

        except asyncio.CancelledError:
            log.info("epoch_loop_cancelled")
            return
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as e:
            consecutive_errors += 1
            base = min(12 * (2**consecutive_errors), 300)
            backoff = base * (0.5 + random.random())  # jitter: 50-150% of base
            level = "critical" if consecutive_errors >= 10 else "error"
            getattr(log, level)(
                "epoch_error",
                err=str(e),
                error_type=type(e).__name__,
                consecutive=consecutive_errors,
                backoff_s=round(backoff, 1),
                exc_info=True,
            )
            if telemetry:
                telemetry.record(
                    "epoch_error",
                    f"Epoch error ({type(e).__name__}): {e}",
                    error=str(e),
                    error_type=type(e).__name__,
                    consecutive_errors=consecutive_errors,
                    backoff_s=round(backoff, 1),
                )
            await asyncio.sleep(backoff)
            continue

        # Wait for next epoch (~12 seconds per Bittensor block, SN103 tempo = 360 blocks)
        await asyncio.sleep(12)


async def mpc_cleanup_loop(mpc_coordinator: MPCCoordinator) -> None:
    """Periodically remove expired MPC sessions to prevent memory growth."""
    log.info("mpc_cleanup_loop_started")
    while True:
        try:
            await asyncio.sleep(300)  # Every 5 minutes
            removed = mpc_coordinator.cleanup_expired()
            if removed > 0:
                log.info("mpc_sessions_cleaned", count=removed)
        except asyncio.CancelledError:
            log.info("mpc_cleanup_loop_cancelled")
            return
        except Exception as e:
            log.error("mpc_cleanup_error", error=str(e))


async def validator_sync_loop(syncer: ValidatorSetSyncer) -> None:
    """Periodically sync the on-chain validator set with the Bittensor metagraph."""
    log.info("validator_sync_loop_started")
    while True:
        try:
            await asyncio.sleep(60)  # Check every 60 seconds
            await syncer.sync_once()
        except asyncio.CancelledError:
            log.info("validator_sync_loop_cancelled")
            return
        except Exception as e:
            log.error("validator_sync_error", error=str(e))


async def run_server(app: object, host: str, port: int) -> None:
    """Run uvicorn as an async task."""
    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level="info",
        timeout_graceful_shutdown=10,
        timeout_keep_alive=65,
    )
    server = uvicorn.Server(config)
    await server.serve()


async def async_main() -> None:
    """Start validator with concurrent API server and epoch loop."""
    config = Config()
    warnings = config.validate()
    for w in warnings:
        log.warning("config_warning", msg=w)

    # Initialize components — SQLite persistence for key shares and attestation log
    from pathlib import Path

    data_dir = Path(config.data_dir).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    share_store = ShareStore(db_path=str(data_dir / "shares.db"))
    attestation_log = AttestationLog(db_path=str(data_dir / "attestations.db"))
    purchase_orch = PurchaseOrchestrator(share_store, db_path=str(data_dir / "purchases.db"))
    espn_client = ESPNClient()
    outcome_attestor = OutcomeAttestor(
        espn_client=espn_client,
        db_path=str(data_dir / "signal_registrations.db"),
    )
    audit_set_store = AuditSetStore()
    scorer = MinerScorer(db_path=str(data_dir / "miner_scores.db"))
    activity = ActivityBuffer()

    # Persistent telemetry — stores all events to SQLite
    telemetry_path = os.getenv("TELEMETRY_DB", str(data_dir / "validator_telemetry.db"))
    telemetry = TelemetryStore(telemetry_path)
    telemetry.record(
        "startup",
        f"Validator v{__version__} starting",
        version=__version__,
        network=config.bt_network,
        netuid=config.bt_netuid,
    )

    chain_client = ChainClient(
        rpc_url=config.base_rpc_url,
        escrow_address=config.escrow_address,
        signal_address=config.signal_commitment_address,
        account_address=config.account_address,
        outcome_voting_address=config.outcome_voting_address,
        private_key=config.base_validator_private_key,
        chain_id=config.base_chain_id,
    )

    # Initialize Bittensor neuron
    neuron = DjinnValidator(
        netuid=config.bt_netuid,
        network=config.bt_network,
        wallet_name=config.bt_wallet_name,
        hotkey_name=config.bt_wallet_hotkey,
        axon_port=config.api_port,
        external_ip=config.external_ip or None,
        external_port=config.external_port or None,
    )

    bt_ok = neuron.setup()
    if not bt_ok and config.bt_network in ("finney", "mainnet"):
        log.error(
            "bt_setup_failed_production",
            msg="Wallet/subtensor setup failed on production network — refusing to start. "
            "Check that your coldkeypub.txt is valid JSON: {\"ss58Address\": \"5Your...\"}",
        )
        raise SystemExit(1)
    elif not bt_ok:
        log.warning(
            "running_without_bittensor",
            msg="Validator API will start but no weights will be set",
        )

    mpc_coordinator = MPCCoordinator()

    # Create FastAPI app
    app = create_app(
        share_store=share_store,
        purchase_orch=purchase_orch,
        outcome_attestor=outcome_attestor,
        chain_client=chain_client,
        neuron=neuron if bt_ok else None,
        mpc_coordinator=mpc_coordinator,
        rate_limit_capacity=config.rate_limit_capacity,
        rate_limit_rate=config.rate_limit_rate,
        mpc_availability_timeout=config.mpc_availability_timeout,
        shares_threshold=config.shares_threshold,
        attestation_log=attestation_log,
        fallback_miner_url=config.fallback_miner_url or None,
        scorer=scorer,
        activity_buffer=activity,
        audit_set_store=audit_set_store,
        telemetry=telemetry,
    )

    log.info(
        "validator_starting",
        version=__version__,
        host=config.api_host,
        port=config.api_port,
        netuid=config.bt_netuid,
        bt_network=config.bt_network,
        bt_connected=bt_ok,
        rpc_url=_sanitize_url(config.base_rpc_url),
        shares_held=share_store.count,
        settlement_enabled=chain_client.can_write,
        settlement_address=chain_client.validator_address or "none",
        log_format=os.getenv("LOG_FORMAT", "console"),
    )

    # Bootstrap audit sets from on-chain state in the background.
    # This takes ~5 minutes to scan 1200+ shares so we don't block startup.
    async def _run_bootstrap() -> None:
        try:
            from djinn_validator.core.audit_bootstrap import bootstrap_audit_sets

            pairs_loaded = await bootstrap_audit_sets(
                chain_client=chain_client,
                share_store=share_store,
                audit_set_store=audit_set_store,
                outcome_attestor=outcome_attestor,
            )
            if pairs_loaded:
                log.info("audit_bootstrap_done", pairs=pairs_loaded)
        except Exception as e:
            log.warning("audit_bootstrap_failed", err=str(e)[:200])

    # Run API server, epoch loop, MPC cleanup, watchtower, and validator sync concurrently
    running_tasks = [
        asyncio.create_task(run_server(app, config.api_host, config.api_port)),
        asyncio.create_task(mpc_cleanup_loop(mpc_coordinator)),
        asyncio.create_task(watchtower_loop(package_dir=Path(__file__).resolve().parent.parent)),
        asyncio.create_task(_run_bootstrap()),  # Background: ~5 min, doesn't block startup
    ]
    if bt_ok:
        running_tasks.append(asyncio.create_task(
            epoch_loop(
                neuron, scorer, share_store, outcome_attestor,
                chain_client, activity, audit_set_store, config.bt_burn_fraction,
                espn_client=espn_client, shares_threshold=config.shares_threshold,
                telemetry=telemetry,
            )
        ))
        # Validator set sync: discover peers via metagraph, propose on-chain changes
        if chain_client.can_write:
            syncer = ValidatorSetSyncer(chain_client, neuron)
            running_tasks.append(asyncio.create_task(validator_sync_loop(syncer)))

    shutdown_event = asyncio.Event()

    def _shutdown(sig: signal.Signals) -> None:
        log.info("shutdown_signal", signal=sig.name)
        shutdown_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _shutdown, sig)

    await shutdown_event.wait()
    log.info("shutting_down")
    telemetry.record("shutdown", "Validator shutting down")
    for t in running_tasks:
        t.cancel()
    try:
        await asyncio.wait_for(
            asyncio.gather(*running_tasks, return_exceptions=True),
            timeout=15.0,
        )
    except TimeoutError:
        log.warning("shutdown_timeout", msg="Tasks did not finish within 15s")
    try:
        scorer.persist_all()
        log.info("scorer_persisted_on_shutdown")
    except Exception as e:
        log.warning("scorer_persist_error", error=str(e))
    try:
        await outcome_attestor.close()
    except Exception as e:
        log.warning("outcome_attestor_close_error", error=str(e))
    try:
        await chain_client.close()
    except Exception as e:
        log.warning("chain_client_close_error", error=str(e))
    try:
        removed = mpc_coordinator.cleanup_expired()
        if removed:
            log.info("mpc_sessions_cleaned_on_shutdown", removed=removed)
    except Exception as e:
        log.warning("mpc_cleanup_error", error=str(e))
    try:
        from djinn_validator.core.ot_network import shutdown_modexp_pool
        shutdown_modexp_pool()
    except Exception as e:
        log.warning("modexp_pool_shutdown_error", error=str(e))
    try:
        purchase_orch.close()
    except Exception as e:
        log.warning("purchase_orch_close_error", error=str(e))
    try:
        share_store.close()
    except Exception as e:
        log.warning("share_store_close_error", error=str(e))
    try:
        attestation_log.close()
    except Exception as e:
        log.warning("attestation_log_close_error", error=str(e))
    log.info("shutdown_complete")


def main() -> None:
    """Start the Djinn validator."""
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
