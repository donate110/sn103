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
from djinn_miner.data.odds_api import OddsApiClient
from djinn_miner.utils.watchtower import watch_loop as watchtower_loop

log = structlog.get_logger()


async def bt_sync_loop(neuron: DjinnMiner, health: HealthTracker) -> None:
    """Background loop: keep metagraph fresh and check registration."""
    log.info("bt_sync_loop_started")
    consecutive_errors = 0

    while True:
        try:
            neuron.sync_metagraph()

            if not neuron.is_registered():
                log.warning("miner_deregistered", msg="No longer registered on subnet")
                health.set_bt_connected(False)
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

    health_tracker = HealthTracker(
        odds_api_connected=False,
    )

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

    app = create_app(
        checker=checker,
        proof_gen=proof_gen,
        health_tracker=health_tracker,
        rate_limit_capacity=config.rate_limit_capacity,
        rate_limit_rate=config.rate_limit_rate,
        neuron=neuron if bt_ok else None,
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
        log_format=os.getenv("LOG_FORMAT", "console"),
    )

    # Run API server, BT sync loop, and watchtower concurrently
    from pathlib import Path
    running_tasks = [
        asyncio.create_task(run_server(app, config.api_host, config.api_port)),
        asyncio.create_task(watchtower_loop(package_dir=Path(__file__).resolve().parent.parent)),
    ]
    if bt_ok:
        running_tasks.append(asyncio.create_task(bt_sync_loop(neuron, health_tracker)))

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
        await odds_client.close()
    except Exception as e:
        log.warning("odds_client_close_error", error=str(e))
    log.info("shutdown_complete")


def main() -> None:
    """Start the Djinn miner."""
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
