"""Manage the TLSNotary notary server sidecar process.

Every miner launches djinn-tlsn-notary as a background process so it can
serve as a peer notary for other miners. The notary's secp256k1 public key
is exposed via /v1/notary/info so the validator can discover and pair miners.

Enabled by default. Set NOTARY_ENABLED=false to disable (not recommended).
The notary listens on localhost only — external access goes through the
WebSocket proxy at /v1/notary/ws on the existing API port.
"""

from __future__ import annotations

import asyncio
import os
import re
import signal
import shutil
from dataclasses import dataclass

import structlog

from djinn_miner.core.tlsn_bootstrap import ensure_binary

log = structlog.get_logger()

NOTARY_BINARY = ensure_binary("djinn-tlsn-notary")
NOTARY_PORT = int(os.getenv("NOTARY_PORT", "7047"))
NOTARY_KEY_PATH = os.getenv("NOTARY_KEY_PATH", os.path.expanduser("~/.local/share/djinn/notary-key.bin"))
NOTARY_ENABLED = os.getenv("NOTARY_ENABLED", "true").lower() in ("true", "1", "yes")


@dataclass
class NotaryInfo:
    """Public info about this miner's notary service."""

    enabled: bool = False
    pubkey_hex: str = ""
    port: int = 0
    pid: int | None = None


class NotarySidecar:
    """Lifecycle manager for the djinn-tlsn-notary background process."""

    def __init__(
        self,
        *,
        port: int = NOTARY_PORT,
        key_path: str = NOTARY_KEY_PATH,
        enabled: bool = NOTARY_ENABLED,
    ) -> None:
        self._port = port
        self._key_path = key_path
        self._enabled = enabled
        self._process: asyncio.subprocess.Process | None = None
        self._pubkey_hex: str = ""
        self._started = False

    @property
    def info(self) -> NotaryInfo:
        return NotaryInfo(
            enabled=self.is_running(),
            pubkey_hex=self._pubkey_hex if self.is_running() else "",
            port=self._port if self.is_running() else 0,
            pid=self._process.pid if self._process else None,
        )

    @property
    def enabled(self) -> bool:
        return self._enabled

    def is_running(self) -> bool:
        if self._process is None or self._process.returncode is not None:
            return False
        # Check if the process is actually a zombie (defunct)
        try:
            pid = self._process.pid
            status_path = f"/proc/{pid}/status"
            with open(status_path) as f:
                for line in f:
                    if line.startswith("State:"):
                        state = line.split(":")[1].strip()
                        if state.startswith("Z"):
                            log.warning("notary_sidecar_zombie", pid=pid)
                            return False
                        break
        except (FileNotFoundError, OSError):
            # /proc not available (e.g. non-Linux or mock process).
            # Fall back to returncode check, which already passed above.
            pass
        return True

    async def start(self) -> bool:
        """Start the notary sidecar. Returns True if started successfully."""
        if not self._enabled:
            log.debug("notary_sidecar_disabled")
            return False

        binary = shutil.which(NOTARY_BINARY)
        if not binary:
            if os.path.isfile(NOTARY_BINARY) and os.access(NOTARY_BINARY, os.X_OK):
                binary = NOTARY_BINARY
            else:
                log.warning("notary_binary_not_found", binary=NOTARY_BINARY)
                return False

        # Ensure key directory exists
        key_dir = os.path.dirname(self._key_path)
        if key_dir:
            os.makedirs(key_dir, exist_ok=True)

        cmd = [
            binary,
            "--port", str(self._port),
            "--key", self._key_path,
        ]

        try:
            self._process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            log.error("notary_sidecar_binary_missing", binary=binary)
            return False

        # Read the first few lines of stdout to capture the pubkey log line.
        # The notary server logs "Notary public key" with the hex key on startup.
        pubkey = await self._read_pubkey(timeout=10.0)
        if not pubkey:
            log.error("notary_sidecar_no_pubkey", hint="notary may have crashed on start")
            await self.stop()
            return False

        self._pubkey_hex = pubkey
        self._started = True
        log.info(
            "notary_sidecar_started",
            port=self._port,
            pid=self._process.pid,
            pubkey=self._pubkey_hex[:16] + "...",
        )
        return True

    async def _read_pubkey(self, timeout: float = 10.0) -> str:
        """Read stdout lines until we find the notary public key, or timeout."""
        if not self._process or not self._process.stdout:
            return ""

        try:
            async with asyncio.timeout(timeout):
                while True:
                    line = await self._process.stdout.readline()
                    if not line:
                        break
                    raw = line.decode(errors="replace").strip()
                    # Strip ANSI escape codes (the notary uses tracing-subscriber
                    # which emits colored output with \x1b[...m sequences)
                    text = re.sub(r"\x1b\[[0-9;]*m", "", raw)
                    log.debug("notary_sidecar_log", line=text)
                    # The notary logs: pubkey=<hex> "Notary public key"
                    if "pubkey=" in text.lower() or "notary public key" in text.lower():
                        # Extract hex key from structured log
                        for part in text.split():
                            if part.startswith("pubkey="):
                                return part.split("=", 1)[1].strip('"')
                            # Also handle: Notary public key: <hex>
                            if len(part) >= 64 and all(c in "0123456789abcdefABCDEF" for c in part):
                                return part
                    # If "Listening" appears, the key was already printed
                    if "listening" in text.lower():
                        break
        except TimeoutError:
            log.warning("notary_sidecar_pubkey_timeout")
        return ""

    async def stop(self) -> None:
        """Gracefully stop the notary sidecar."""
        if self._process is None:
            return

        self._started = False
        try:
            self._process.send_signal(signal.SIGTERM)
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5.0)
            except TimeoutError:
                log.warning("notary_sidecar_force_kill")
                self._process.kill()
                await self._process.wait()
        except (ProcessLookupError, OSError) as e:
            log.debug("notary_sidecar_stop_error", error=str(e))

        log.info("notary_sidecar_stopped")
        self._process = None

    async def health_check(self) -> bool:
        """Check if the notary sidecar is still running."""
        if not self._started or self._process is None:
            return False
        if self._process.returncode is not None:
            log.warning(
                "notary_sidecar_exited",
                returncode=self._process.returncode,
            )
            self._started = False
            return False
        return True

    async def restart_if_needed(self) -> bool:
        """Restart the sidecar if it has exited."""
        if not self._enabled:
            return False
        if await self.health_check():
            return True
        log.info("notary_sidecar_restarting")
        return await self.start()

    async def _tcp_probe(self) -> bool:
        """Check if the notary port is actually accepting connections."""
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection("127.0.0.1", self._port),
                timeout=3.0,
            )
            writer.close()
            await writer.wait_closed()
            return True
        except (ConnectionRefusedError, TimeoutError, OSError):
            return False

    async def watchdog_loop(self, interval: float = 30.0) -> None:
        """Periodically check sidecar health and restart if crashed.

        Checks both process state (zombie detection) and TCP liveness
        (port accepting connections). Runs forever until cancelled.
        """
        while True:
            try:
                await asyncio.sleep(interval)
                if not self._enabled:
                    continue
                needs_restart = False
                if not self.is_running():
                    log.warning("notary_watchdog_detected_crash")
                    needs_restart = True
                elif not await self._tcp_probe():
                    log.warning("notary_watchdog_port_dead", port=self._port)
                    needs_restart = True
                if needs_restart:
                    await self.stop()
                    restarted = await self.restart_if_needed()
                    if not restarted:
                        log.error("notary_watchdog_restart_failed")
            except asyncio.CancelledError:
                return
            except Exception as e:
                log.error("notary_watchdog_error", error=str(e))
