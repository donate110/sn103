"""Entry point for the Djinn Protocol Bittensor miner.

Starts the FastAPI server and Bittensor metagraph sync loop concurrently.
The FastAPI server handles validator queries for line availability and proofs.
The BT loop keeps the metagraph fresh and re-serves the axon if needed.
"""

from __future__ import annotations

import asyncio
import os
import random
import signal

import httpx
import structlog
import uvicorn

from djinn_miner import __version__
from djinn_miner.log_config import configure_logging

configure_logging()

from djinn_miner.api.server import create_app
from djinn_miner.bt.neuron import DjinnMiner
from djinn_miner.config import Config
from djinn_miner.core.checker import LineChecker
from djinn_miner.core.health import HealthTracker
from djinn_miner.core.proof import ProofGenerator, SessionCapture
from djinn_miner.core.notary_sidecar import NotarySidecar
from djinn_miner.core.telemetry import TelemetryStore
from djinn_miner.data.odds_api import OddsApiClient
from djinn_miner.utils.watchtower import watch_loop as watchtower_loop

log = structlog.get_logger()


async def bt_sync_loop(neuron: DjinnMiner, health: HealthTracker, telemetry: TelemetryStore | None = None) -> None:
    """Background loop: keep metagraph fresh and check registration."""
    log.info("bt_sync_loop_started")
    consecutive_errors = 0

    while True:
        try:
            neuron.sync_metagraph()

            if not neuron.is_registered():
                log.warning("miner_deregistered", msg="No longer registered on subnet")
                health.set_bt_connected(False)
                if telemetry:
                    telemetry.record("bt_deregistered", "Miner no longer registered on subnet")
            else:
                health.set_bt_connected(True)
                # Refresh UID in case it changed after re-registration
                if neuron.uid is not None:
                    health.set_uid(neuron.uid)

            consecutive_errors = 0

        except asyncio.CancelledError:
            log.info("bt_sync_loop_cancelled")
            return
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as e:
            consecutive_errors += 1
            health.record_bt_failure()
            base = min(60 * (2**consecutive_errors), 600)
            backoff = base * (0.5 + random.random())  # jitter: 50-150% of base
            level = "critical" if consecutive_errors >= 10 else "error"
            getattr(log, level)(
                "bt_sync_error",
                err=str(e),
                error_type=type(e).__name__,
                consecutive=consecutive_errors,
                backoff_s=round(backoff, 1),
            )
            await asyncio.sleep(backoff)
            continue

        await asyncio.sleep(60)  # Sync every 60 seconds


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
    """Start miner with concurrent API server and BT sync."""
    config = Config()
    warnings = config.validate()
    for w in warnings:
        log.warning("config_warning", msg=w)

    # Session capture for proof generation
    session_capture = SessionCapture()

    odds_client = OddsApiClient(
        api_key=config.odds_api_key,
        base_url=config.odds_api_base_url,
        cache_ttl=config.odds_cache_ttl,
        session_capture=session_capture,
    )

    # Probe odds API at startup to verify key works (costs 0 credits)
    odds_api_ok = False
    try:
        async with httpx.AsyncClient(timeout=10.0) as probe:
            resp = await probe.get(
                f"{config.odds_api_base_url}/v4/sports",
                params={"apiKey": config.odds_api_key},
            )
            odds_api_ok = resp.status_code == 200
            if not odds_api_ok:
                log.warning("odds_api_probe_failed", status=resp.status_code)
    except Exception as e:
        log.warning("odds_api_probe_error", err=str(e))

    # Persistent telemetry — stores all events to SQLite
    telemetry_path = os.getenv("TELEMETRY_DB", "miner_telemetry.db")
    telemetry = TelemetryStore(telemetry_path)
    telemetry.record("startup", f"Miner v{__version__} starting", version=__version__, network=config.bt_network, netuid=config.bt_netuid, odds_api_configured=bool(config.odds_api_key), odds_api_ok=odds_api_ok)

    health_tracker = HealthTracker(
        odds_api_connected=odds_api_ok,
    )

    # Kill orphaned prover processes from previous runs (watchtower restarts
    # via os.execv leave children running as orphans under PID 1).
    from djinn_miner.core.tlsn import reap_stale_provers
    reap_stale_provers()

    checker = LineChecker(
        odds_client=odds_client,
        line_tolerance=config.line_tolerance,
        health_tracker=health_tracker,
    )
    proof_gen = ProofGenerator(session_capture=session_capture)

    # Initialize Bittensor neuron
    neuron = DjinnMiner(
        netuid=config.bt_netuid,
        network=config.bt_network,
        wallet_name=config.bt_wallet_name,
        hotkey_name=config.bt_wallet_hotkey,
        axon_port=config.api_port,
        external_ip=config.external_ip or None,
        external_port=config.external_port or None,
    )

    bt_ok = neuron.setup()
    if bt_ok:
        health_tracker.set_uid(neuron.uid)  # type: ignore[arg-type]
        health_tracker.set_bt_connected(True)
    elif config.bt_network in ("finney", "mainnet"):
        log.error(
            "bt_setup_failed_production",
            msg="Wallet/subtensor setup failed on production network — refusing to start. "
            "Check that your coldkeypub.txt is valid JSON: {\"ss58Address\": \"5Your...\"}",
        )
        raise SystemExit(1)
    else:
        log.warning(
            "running_without_bittensor",
            msg="Miner API will start but won't be discoverable on subnet",
        )

    # Peer notary sidecar (enabled by default, disable with NOTARY_ENABLED=false)
    from djinn_miner.api.metrics import NOTARY_ENABLED as NOTARY_ENABLED_GAUGE
    notary_sidecar = NotarySidecar()
    if notary_sidecar.enabled:
        started = await notary_sidecar.start()
        if started:
            NOTARY_ENABLED_GAUGE.set(1)
            telemetry.record("notary_sidecar_started", "Peer notary sidecar running",
                             port=notary_sidecar.info.port,
                             pubkey=notary_sidecar.info.pubkey_hex[:16] + "...")
        else:
            log.warning("notary_sidecar_failed", msg="Could not start peer notary sidecar")

    app = create_app(
        checker=checker,
        proof_gen=proof_gen,
        health_tracker=health_tracker,
        rate_limit_capacity=config.rate_limit_capacity,
        rate_limit_rate=config.rate_limit_rate,
        neuron=neuron if bt_ok else None,
        telemetry=telemetry,
        notary_sidecar=notary_sidecar if notary_sidecar.enabled else None,
    )

    log.info(
        "miner_starting",
        version=__version__,
        host=config.api_host,
        port=config.api_port,
        netuid=config.bt_netuid,
        bt_network=config.bt_network,
        bt_connected=bt_ok,
        odds_api_configured=bool(config.odds_api_key),
        notary_enabled=notary_sidecar.enabled,
        log_format=os.getenv("LOG_FORMAT", "console"),
    )

    # Run API server, BT sync loop, and watchtower concurrently
    from pathlib import Path
    running_tasks = [
        asyncio.create_task(run_server(app, config.api_host, config.api_port)),
        asyncio.create_task(watchtower_loop(package_dir=Path(__file__).resolve().parent.parent)),
    ]
    if bt_ok:
        running_tasks.append(asyncio.create_task(bt_sync_loop(neuron, health_tracker, telemetry)))
    if notary_sidecar.enabled:
        running_tasks.append(asyncio.create_task(notary_sidecar.watchdog_loop()))

    shutdown_event = asyncio.Event()

    def _shutdown(sig: signal.Signals) -> None:
        log.info("shutdown_signal", signal=sig.name)
        shutdown_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _shutdown, sig)

    await shutdown_event.wait()
    log.info("shutting_down")
    telemetry.record("shutdown", "Miner shutting down")
    for t in running_tasks:
        t.cancel()
    try:
        await asyncio.wait_for(
            asyncio.gather(*running_tasks, return_exceptions=True),
            timeout=15.0,
        )
    except TimeoutError:
        log.warning("shutdown_timeout", msg="Tasks did not finish within 15s")
    if notary_sidecar.enabled:
        await notary_sidecar.stop()
    try:
        await odds_client.close()
    except Exception as e:
        log.warning("odds_client_close_error", error=str(e))
    log.info("shutdown_complete")


def main() -> None:
    """Start the Djinn miner."""
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
