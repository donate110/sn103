"""Entry point for the Djinn Protocol Bittensor validator.

Starts the FastAPI server and the Bittensor epoch loop concurrently.
"""

from __future__ import annotations

import asyncio
import os
import random
import signal

import httpx
import structlog
import uvicorn

from djinn_validator import __version__
from djinn_validator.logging import configure_logging

configure_logging()

from djinn_validator.api.server import create_app
from djinn_validator.bt.neuron import DjinnValidator
from djinn_validator.chain.contracts import ChainClient
from djinn_validator.config import Config
from djinn_validator.core.mpc_coordinator import MPCCoordinator
from djinn_validator.core.outcomes import OutcomeAttestor
from djinn_validator.core.purchase import PurchaseOrchestrator
from djinn_validator.core.burn_ledger import BurnLedger
from djinn_validator.core.challenges import challenge_miners, challenge_miners_attestation
from djinn_validator.core.scoring import MinerScorer
from djinn_validator.core.shares import ShareStore


def _sanitize_url(url: str) -> str:
    """Strip credentials and path from URL for safe logging."""
    from urllib.parse import urlparse

    try:
        parsed = urlparse(url)
        return f"{parsed.scheme}://{parsed.hostname}:{parsed.port or 443}"
    except Exception:
        return "<unparseable>"

log = structlog.get_logger()


async def _vote_outcomes(
    outcome_attestor: OutcomeAttestor,
    chain_client: ChainClient,
    resolved: list[object],
    neuron: DjinnValidator,
) -> None:
    """Compute quality scores and submit votes to OutcomeVoting.

    Instead of writing individual outcomes on-chain (which leaks real picks),
    validators compute an aggregate quality score per Genius-Idiot cycle and
    vote on it via OutcomeVoting. When 2/3+ validators agree, settlement is
    triggered automatically on-chain.

    Flow:
    1. For each resolved signal, find the Genius and all Idiot purchasers
    2. Group resolved signals by (Genius, Idiot) pair
    3. For pairs with all cycle signals resolved, compute quality score
    4. Submit vote to OutcomeVoting contract
    """
    from djinn_validator.core.outcomes import OutcomeAttestation

    # Count validators with permits for consensus threshold
    total_validators = 0
    try:
        total_validators = sum(
            1 for uid in range(neuron.metagraph.n.item())
            if neuron.metagraph.validator_permit[uid]
        )
    except Exception:
        total_validators = 1

    # Collect resolved attestations that have consensus
    consensus_attestations: list[OutcomeAttestation] = []
    for attestation in resolved:
        if not isinstance(attestation, OutcomeAttestation):
            continue
        consensus = outcome_attestor.check_consensus(attestation.signal_id, total_validators)
        if consensus is not None:
            consensus_attestations.append(attestation)

    if not consensus_attestations:
        return

    # Group by (genius, idiot) pairs: for each resolved signal, find the
    # genius and all buyers, then check if the full cycle is ready for voting
    from web3 import Web3

    # Track which pairs we've already voted on this round
    voted_pairs: set[tuple[str, str]] = set()

    for attestation in consensus_attestations:
        signal_id_int = int.from_bytes(
            Web3.solidity_keccak(["string"], [attestation.signal_id]), "big"
        )

        signal_data = await chain_client.get_signal(signal_id_int)
        genius = signal_data.get("genius", "")
        if not genius or genius == "0x" + "0" * 40:
            continue

        purchase_ids = await chain_client.get_purchases_by_signal(signal_id_int)
        for pid in purchase_ids:
            purchase = await chain_client.get_purchase(pid)
            if not purchase:
                continue
            idiot = purchase.get("idiot", "")
            if not idiot or idiot == "0x" + "0" * 40:
                continue

            pair_key = (genius.lower(), idiot.lower())
            if pair_key in voted_pairs:
                continue

            # Check if audit cycle is ready (10 signals)
            is_ready = await chain_client.is_audit_ready(genius, idiot)
            if not is_ready:
                continue

            # Check if already finalized on-chain
            cycle = await chain_client.get_current_cycle(genius, idiot)
            is_finalized = await chain_client.is_cycle_finalized(genius, idiot, cycle)
            if is_finalized:
                voted_pairs.add(pair_key)
                continue

            # Get all purchases in this cycle and compute quality score
            cycle_purchase_ids = await chain_client.get_purchase_ids(genius, idiot)
            if not cycle_purchase_ids:
                continue

            # Fetch purchase data and signal data for score computation
            cycle_purchases = []
            for cpid in cycle_purchase_ids:
                p = await chain_client.get_purchase(cpid)
                if p:
                    # Look up signal SLA
                    sig_data = await chain_client.get_signal(p["signalId"])
                    p["slaMultiplierBps"] = sig_data.get("slaMultiplierBps", 10_000)
                    cycle_purchases.append(p)

            # Compute quality score using the consensus outcomes
            score = outcome_attestor.compute_quality_score(
                consensus_attestations, cycle_purchases,
            )

            # Submit vote on-chain
            try:
                tx_hash = await chain_client.submit_vote(genius, idiot, score)
                voted_pairs.add(pair_key)
                log.info(
                    "vote_submitted",
                    genius=genius,
                    idiot=idiot,
                    cycle=cycle,
                    quality_score=score,
                    tx_hash=tx_hash,
                )
            except Exception as e:
                err_str = str(e)
                if "AlreadyVoted" in err_str:
                    log.debug("already_voted", genius=genius, idiot=idiot, cycle=cycle)
                    voted_pairs.add(pair_key)
                elif "CycleAlreadyFinalized" in err_str:
                    log.debug("cycle_already_finalized", genius=genius, idiot=idiot, cycle=cycle)
                    voted_pairs.add(pair_key)
                else:
                    log.error(
                        "vote_submission_failed",
                        genius=genius,
                        idiot=idiot,
                        cycle=cycle,
                        err=err_str,
                    )

    if voted_pairs:
        log.info("votes_submitted", count=len(voted_pairs))


async def epoch_loop(
    neuron: DjinnValidator,
    scorer: MinerScorer,
    share_store: ShareStore,
    outcome_attestor: OutcomeAttestor,
    chain_client: ChainClient | None = None,
) -> None:
    """Main validator epoch loop: sync metagraph, score miners, set weights."""
    log.info(
        "epoch_loop_started",
        settlement_enabled=chain_client is not None and chain_client.can_write,
    )
    consecutive_errors = 0
    # Throttle miner challenges: once every CHALLENGE_INTERVAL_EPOCHS epochs (~10 min)
    CHALLENGE_INTERVAL_EPOCHS = 50  # 50 * 12s = 10 minutes
    epoch_count = 0

    while True:
        try:
            # Sync metagraph
            neuron.sync_metagraph()

            # Health-check all miners by pinging their axon /health endpoint
            miner_uids = neuron.get_miner_uids()

            # Prune deregistered miner UIDs from scorer
            scorer.prune_absent(set(miner_uids))
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                for uid in miner_uids:
                    axon = neuron.get_axon_info(uid)
                    hotkey = axon.get("hotkey", f"uid-{uid}")
                    ip = axon.get("ip", "")
                    port = axon.get("port", 0)
                    metrics = scorer.get_or_create(uid, hotkey)

                    if not ip or not port:
                        metrics.record_health_check(responded=False)
                        log.debug("miner_no_axon", uid=uid, hotkey=hotkey)
                        continue

                    url = f"http://{ip}:{port}/health"
                    try:
                        resp = await client.get(url)
                        responded = resp.status_code == 200
                    except httpx.HTTPError:
                        responded = False

                    metrics.record_health_check(responded=responded)
                    log.debug(
                        "miner_health_check",
                        uid=uid,
                        hotkey=hotkey,
                        url=url,
                        responded=responded,
                    )

            # Challenge miners for accuracy scoring (throttled)
            epoch_count += 1
            ATTESTATION_CHALLENGE_INTERVAL = 100  # 100 * 12s = ~20 min
            if epoch_count % CHALLENGE_INTERVAL_EPOCHS == 0:
                sports_api_key = os.environ.get("SPORTS_API_KEY", "")
                if sports_api_key and miner_uids:
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
                        await challenge_miners(scorer, miner_axons, sports_api_key)
                    except Exception as e:
                        log.warning("challenge_miners_error", err=str(e))

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
                    await challenge_miners_attestation(scorer, miner_axons)
                except Exception as e:
                    log.warning("attest_challenge_error", err=str(e))

            # Resolve any pending signal outcomes
            hotkey = ""
            if neuron.wallet:
                hotkey = neuron.wallet.hotkey.ss58_address
            resolved = await outcome_attestor.resolve_all_pending(hotkey)
            if resolved:
                log.info("outcomes_resolved", count=len(resolved))

            # Submit voted outcomes on-chain (aggregate quality scores, no individual outcomes)
            if resolved and chain_client and chain_client.can_write:
                await _vote_outcomes(
                    outcome_attestor, chain_client, resolved, neuron,
                )

            # Prune old resolved signals to prevent memory growth
            await outcome_attestor.cleanup_resolved()

            # Determine if this is an active epoch (any signals being processed)
            is_active = share_store.count > 0

            # Compute and set weights — only reset metrics AFTER weights are set
            # so that challenge data accumulates across the full interval
            if neuron.should_set_weights():
                weights = scorer.compute_weights(is_active)
                if weights:
                    success = neuron.set_weights(weights)
                    if success:
                        neuron.record_weight_set()
                    log.info("weights_updated", n_miners=len(weights), active=is_active, success=success)
                # Reset per-epoch metrics after weight setting (increments
                # consecutive_epochs for miners that participated)
                scorer.reset_epoch()

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
            await asyncio.sleep(backoff)
            continue

        # Wait for next epoch (~12 seconds per Bittensor block, tempo ~100 blocks)
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

    # Initialize components — SQLite persistence for key shares and burn ledger
    from pathlib import Path

    data_dir = Path(config.data_dir).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    share_store = ShareStore(db_path=str(data_dir / "shares.db"))
    burn_ledger = BurnLedger(db_path=str(data_dir / "burns.db"))
    purchase_orch = PurchaseOrchestrator(share_store, db_path=str(data_dir / "purchases.db"))
    outcome_attestor = OutcomeAttestor(sports_api_key=config.sports_api_key)
    scorer = MinerScorer()

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
    if not bt_ok:
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
        burn_ledger=burn_ledger,
        attest_burn_amount=config.attest_burn_amount,
        attest_burn_address=config.attest_burn_address,
        scorer=scorer,
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

    # Run API server, epoch loop, and MPC cleanup concurrently
    running_tasks = [
        asyncio.create_task(run_server(app, config.api_host, config.api_port)),
        asyncio.create_task(mpc_cleanup_loop(mpc_coordinator)),
    ]
    if bt_ok:
        running_tasks.append(asyncio.create_task(
            epoch_loop(neuron, scorer, share_store, outcome_attestor, chain_client)
        ))

    shutdown_event = asyncio.Event()

    def _shutdown(sig: signal.Signals) -> None:
        log.info("shutdown_signal", signal=sig.name)
        shutdown_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _shutdown, sig)

    await shutdown_event.wait()
    log.info("shutting_down")
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
        purchase_orch.close()
    except Exception as e:
        log.warning("purchase_orch_close_error", error=str(e))
    try:
        share_store.close()
    except Exception as e:
        log.warning("share_store_close_error", error=str(e))
    try:
        burn_ledger.close()
    except Exception as e:
        log.warning("burn_ledger_close_error", error=str(e))
    log.info("shutdown_complete")


def main() -> None:
    """Start the Djinn validator."""
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
