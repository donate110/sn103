"""Health check handler — tracks uptime and responds to validator pings."""

from __future__ import annotations

import os
import shutil
import time

import structlog

from djinn_miner import __version__
from djinn_miner.api.models import HealthResponse, MinerCapabilities

log = structlog.get_logger()


class HealthTracker:
    """Tracks miner health metrics for validator health checks.

    Uptime accounts for 15% of miner scoring (PDF v9), so responsiveness
    to health pings directly affects emissions.

    Thread safety: Not needed. All callers run on the asyncio event loop
    (single-threaded). Python's GIL protects the simple attribute assignments
    regardless.
    """

    CONSECUTIVE_FAILURE_THRESHOLD = 3

    def __init__(
        self,
        uid: int | None = None,
        odds_api_connected: bool = False,
        bt_connected: bool = False,
    ) -> None:
        self._uid = uid
        self._odds_api_connected = odds_api_connected
        self._bt_connected = bt_connected
        self._start_time = time.monotonic()
        self._ping_count = 0
        self._consecutive_api_failures = 0
        self._consecutive_bt_failures = 0
        self._tlsn_max_concurrent = 0
        self._tlsn_active_sessions = 0
        self._notary_max_concurrent = 0
        self._notary_active_sessions = 0
        self._proactive_attester: object | None = None

    def record_ping(self) -> None:
        """Record a health check ping from a validator."""
        self._ping_count += 1

    def set_uid(self, uid: int) -> None:
        self._uid = uid

    def set_odds_api_connected(self, connected: bool) -> None:
        self._odds_api_connected = connected

    def set_bt_connected(self, connected: bool) -> None:
        self._bt_connected = connected
        if connected:
            self._consecutive_bt_failures = 0

    def record_bt_failure(self) -> None:
        """Record failed BT sync — degrade health after threshold."""
        self._consecutive_bt_failures += 1
        if self._consecutive_bt_failures >= self.CONSECUTIVE_FAILURE_THRESHOLD:
            if self._bt_connected:
                log.warning(
                    "bt_connection_degraded",
                    consecutive_failures=self._consecutive_bt_failures,
                )
                self._bt_connected = False

    def record_api_success(self) -> None:
        """Record successful Odds API call — reset failure counter."""
        self._consecutive_api_failures = 0
        if not self._odds_api_connected:
            log.info("odds_api_recovered")
            self._odds_api_connected = True

    def record_api_failure(self) -> None:
        """Record failed Odds API call — degrade health after threshold."""
        self._consecutive_api_failures += 1
        if self._consecutive_api_failures >= self.CONSECUTIVE_FAILURE_THRESHOLD:
            if self._odds_api_connected:
                log.warning(
                    "odds_api_degraded",
                    consecutive_failures=self._consecutive_api_failures,
                )
                self._odds_api_connected = False

    def set_tlsn_capacity(self, max_concurrent: int, active: int) -> None:
        """Update TLSNotary attestation session counts."""
        self._tlsn_max_concurrent = max_concurrent
        self._tlsn_active_sessions = active

    def set_notary_capacity(self, max_concurrent: int, active: int) -> None:
        """Update notary sidecar session counts."""
        self._notary_max_concurrent = max_concurrent
        self._notary_active_sessions = active

    def _collect_capabilities(self) -> MinerCapabilities:
        """Collect current system resource metrics."""
        caps = MinerCapabilities()

        # Memory from /proc/meminfo (no dependency needed)
        try:
            with open("/proc/meminfo") as f:
                meminfo: dict[str, int] = {}
                for line in f:
                    parts = line.split()
                    if len(parts) >= 2:
                        meminfo[parts[0].rstrip(":")] = int(parts[1])
                caps.memory_total_mb = meminfo.get("MemTotal", 0) // 1024
                caps.memory_available_mb = meminfo.get("MemAvailable", 0) // 1024
        except (OSError, ValueError):
            pass

        # CPU cores and load
        try:
            caps.cpu_cores = os.cpu_count() or 0
            load1, _, _ = os.getloadavg()
            caps.cpu_load_1m = round(load1, 2)
        except OSError:
            pass

        # Disk free space
        try:
            usage = shutil.disk_usage("/")
            caps.disk_free_gb = round(usage.free / (1024**3), 1)
        except OSError:
            pass

        # TLSNotary and notary session capacity (set externally)
        caps.tlsn_max_concurrent = self._tlsn_max_concurrent
        caps.tlsn_active_sessions = self._tlsn_active_sessions
        caps.notary_max_concurrent = self._notary_max_concurrent
        caps.notary_active_sessions = self._notary_active_sessions

        return caps

    def get_status(self) -> HealthResponse:
        """Return current health status."""
        uptime = time.monotonic() - self._start_time
        if self._odds_api_connected and self._bt_connected:
            status = "ok"
        elif self._odds_api_connected or self._bt_connected:
            status = "degraded"
        else:
            status = "degraded"
        # Build proactive proof summary if available
        proactive = None
        if self._proactive_attester is not None:
            cached = self._proactive_attester.latest
            if cached:
                from djinn_miner.api.models import ProactiveProof
                proactive = ProactiveProof(
                    url=cached.url,
                    server_name=cached.server_name,
                    notary_pubkey=cached.notary_pubkey,
                    proof_hex="",  # Don't include full proof in health (too large)
                    proof_age_s=round(cached.age_seconds, 1),
                    date_header=cached.date_header,
                    binary_hash=cached.binary_hash,
                )

        return HealthResponse(
            status=status,
            version=__version__,
            uid=self._uid,
            odds_api_connected=self._odds_api_connected,
            bt_connected=self._bt_connected,
            uptime_seconds=round(uptime, 1),
            capabilities=self._collect_capabilities(),
            proactive_proof=proactive,
        )

    @property
    def ping_count(self) -> int:
        return self._ping_count
