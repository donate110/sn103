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
from djinn_miner.data.provider import SportsDataProvider
from djinn_miner.utils.firewall import firewall_loop
from djinn_miner.utils.watchtower import watch_loop as watchtower_loop

log = structlog.get_logger()


async def bt_sync_loop(neuron: DjinnMiner, health: HealthTracker, telemetry: TelemetryStore | None = None) -> None:
    """Background loop: keep metagraph fresh and check registration.

    Handles deregistration gracefully: keeps running and polls for
    re-registration instead of shutting down. When re-registration is
    detected, re-serves the axon so the miner becomes discoverable again.
    """
    log.info("bt_sync_loop_started")
    consecutive_errors = 0
    _was_registered = health.bt_connected

    while True:
        try:
            neuron.sync_metagraph()

            if not neuron.is_registered():
                if _was_registered:
                    log.warning("miner_deregistered", msg="No longer registered on subnet")
                    if telemetry:
                        telemetry.record("bt_deregistered", "Miner no longer registered on subnet")
                _was_registered = False
                health.set_bt_connected(False)
            else:
                if not _was_registered:
                    # Just (re-)registered. Refresh UID and serve the axon
                    # so validators can discover us on the metagraph.
                    hotkey = neuron.wallet.hotkey.ss58_address
                    try:
                        neuron.uid = list(neuron.metagraph.hotkeys).index(hotkey)
                    except (ValueError, AttributeError):
                        pass
                    log.info("miner_registered", uid=neuron.uid, msg="Registered on subnet, serving axon")
                    try:
                        neuron._setup_axon()
                    except Exception as e:
                        log.warning("axon_serve_failed", error=str(e))
                    if telemetry:
                        telemetry.record("bt_registered", f"Miner registered with UID {neuron.uid}")
                _was_registered = True
                health.set_bt_connected(True)
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

            # After 3 consecutive failures, the subtensor connection is likely
            # stale. Recreate it from scratch to avoid permanent disconnection
            # that leads to deregistration.
            if consecutive_errors >= 3 and consecutive_errors % 3 == 0:
                log.warning(
                    "bt_connection_stale",
                    consecutive=consecutive_errors,
                    msg="Attempting subtensor reconnection",
                )
                if neuron.reconnect_subtensor():
                    log.info("bt_reconnect_success", consecutive=consecutive_errors)
                    consecutive_errors = 0
                    continue
                else:
                    log.error("bt_reconnect_failed", consecutive=consecutive_errors)

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

    data_provider: SportsDataProvider
    odds_api_ok = False

    if config.sports_data_provider == "odds_api":
        data_provider = OddsApiClient(
            api_key=config.odds_api_key,
            base_url=config.odds_api_base_url,
            cache_ttl=config.odds_cache_ttl,
            session_capture=session_capture,
        )

        # Probe odds API at startup to verify key works (costs 0 credits)
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
    else:
        # Load custom provider from module path (e.g. "my_module.MyProvider")
        import importlib

        module_path, _, class_name = config.sports_data_provider.rpartition(".")
        if not module_path:
            raise ValueError(
                f"SPORTS_DATA_PROVIDER must be 'odds_api' or a full module path "
                f"like 'my_module.MyProvider', got {config.sports_data_provider!r}"
            )
        mod = importlib.import_module(module_path)
        provider_cls = getattr(mod, class_name)
        data_provider = provider_cls(config=config, session_capture=session_capture)
        if not isinstance(data_provider, SportsDataProvider):
            raise TypeError(
                f"Custom provider {config.sports_data_provider} does not implement SportsDataProvider protocol"
            )
        odds_api_ok = True  # Custom providers manage their own health
        log.info("custom_provider_loaded", provider=config.sports_data_provider)

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
        odds_client=data_provider,
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
    else:
        # Don't exit on registration failure. The miner should keep running
        # so the API server stays up, the notary sidecar stays alive, and
        # the BT sync loop can detect re-registration automatically.
        # Exiting here causes a PM2 restart loop that wastes resources and
        # prevents the notary sidecar from ever stabilizing.
        log.warning(
            "running_without_bittensor",
            msg="Not registered on subnet. Miner API will start, BT sync loop "
            "will poll for re-registration. Register with: "
            "btcli subnet register --netuid 103",
            network=config.bt_network,
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
            # Check if the notary port is reachable from outside (firewall check).
            # Miners whose port is blocked can't serve as peer notaries.
            import socket
            notary_port = notary_sidecar.info.port
            ext_ip = config.external_ip
            if not ext_ip and neuron and bt_ok:
                try:
                    axon = neuron.get_axon_info(neuron.uid)
                    ext_ip = axon.get("ip", "")
                except Exception:
                    pass
            if ext_ip:
                try:
                    s = socket.socket()
                    s.settimeout(3)
                    s.connect((ext_ip, notary_port))
                    s.close()
                    log.info("notary_port_reachable", port=notary_port, ip=ext_ip)
                except (ConnectionRefusedError, TimeoutError, OSError):
                    log.error(
                        "notary_port_blocked",
                        port=notary_port,
                        ip=ext_ip,
                        msg=f"Port {notary_port}/tcp is not reachable from outside. "
                            f"Run: ufw allow {notary_port}/tcp -- "
                            f"Without this, your miner cannot serve as a peer notary and will lose attestation score.",
                    )
                    s.close()
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

    # Periodic reaper for stuck prover processes (runs every 5 min)
    async def _prover_reaper_loop() -> None:
        while True:
            await asyncio.sleep(300)
            try:
                reap_stale_provers()
            except Exception as e:
                log.debug("prover_reaper_error", error=str(e))

    # Run API server, BT sync loop, and watchtower concurrently
    from pathlib import Path
    running_tasks = [
        asyncio.create_task(run_server(app, config.api_host, config.api_port)),
        asyncio.create_task(watchtower_loop(package_dir=Path(__file__).resolve().parent.parent)),
        asyncio.create_task(_prover_reaper_loop()),
    ]
    # Always run BT sync loop so the miner can detect re-registration
    # even if it started while deregistered.
    running_tasks.append(asyncio.create_task(bt_sync_loop(neuron, health_tracker, telemetry)))
    # Auto-manage firewall: whitelist validator IPs, block everything else
    running_tasks.append(asyncio.create_task(firewall_loop(neuron, config.api_port)))
    if notary_sidecar.enabled:
        running_tasks.append(asyncio.create_task(notary_sidecar.watchdog_loop()))

    # Proactive attestation: periodically prove TLSNotary capability
    # by attesting a simple URL using the local notary sidecar.
    from djinn_miner.core.proactive_attest import ProactiveAttester
    proactive = ProactiveAttester(
        notary_port=notary_sidecar._port if notary_sidecar.enabled else 7047,
        notary_pubkey=notary_sidecar._pubkey_hex if notary_sidecar.enabled else "",
    )
    health_tracker._proactive_attester = proactive
    if notary_sidecar.enabled:
        running_tasks.append(asyncio.create_task(proactive.run_loop()))

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
        await data_provider.close()
    except Exception as e:
        log.warning("data_provider_close_error", error=str(e))
    log.info("shutdown_complete")


def main() -> None:
    """Start the Djinn miner."""
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
