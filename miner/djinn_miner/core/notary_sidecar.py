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
import time
from dataclasses import dataclass

import structlog

from djinn_miner.core.tlsn_bootstrap import ensure_binary

log = structlog.get_logger()

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

    def _kill_orphaned_notary(self) -> None:
        """Kill any djinn-tlsn-notary process listening on our port.

        After os.execv (watchtower restart), the old notary child becomes
        an orphan under PID 1. It still holds the port, preventing the
        new notary from binding. Find it by matching the process name and
        port argument, then SIGKILL it.
        """
        import subprocess
        try:
            result = subprocess.run(
                ["pgrep", "-f", f"djinn-tlsn-notary.*--port {self._port}"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0:
                for line in result.stdout.strip().split("\n"):
                    pid = int(line.strip())
                    if self._process and pid == self._process.pid:
                        continue  # Don't kill our own managed process
                    if pid == os.getpid():
                        continue
                    log.info("killing_orphaned_notary", pid=pid, port=self._port)
                    os.kill(pid, signal.SIGKILL)
                    time.sleep(0.5)  # Let the port release
        except Exception as e:
            log.debug("orphan_cleanup_error", error=str(e))

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

        # Kill any orphaned notary processes on our port. When the watchtower
        # restarts the miner via os.execv, the old notary child becomes an
        # orphan that still holds the port. Without this cleanup, the new
        # notary fails with "Address already in use" and crash-loops.
        self._kill_orphaned_notary()

        # Re-resolve on every start so the watchdog picks up upgraded binaries
        # without requiring a process restart.
        resolved = ensure_binary("djinn-tlsn-notary")
        binary = shutil.which(resolved)
        if not binary:
            if os.path.isfile(resolved) and os.access(resolved, os.X_OK):
                binary = resolved
            else:
                log.warning("notary_binary_not_found", binary=resolved)
                return False

        # Ensure key directory exists with restrictive permissions (owner-only)
        key_dir = os.path.dirname(self._key_path)
        if key_dir:
            os.makedirs(key_dir, mode=0o700, exist_ok=True)

        cmd = [
            binary,
            "--port", str(self._port),
            "--key", self._key_path,
        ]

        env = os.environ.copy()
        env.setdefault("RUST_LOG", "debug")

        try:
            self._process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
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
        # Drain stderr in the background to prevent the notary binary
        # from blocking on a full pipe buffer
        asyncio.create_task(self._drain_stderr())
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

    async def _drain_stderr(self) -> None:
        """Read stderr lines and log them to prevent pipe buffer from filling."""
        if not self._process or not self._process.stderr:
            return
        try:
            while True:
                line = await self._process.stderr.readline()
                if not line:
                    break
                text = line.decode(errors="replace").strip()
                if text:
                    log.debug("notary_stderr", line=text)
        except Exception:
            pass

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
            # Capture stderr to diagnose why the binary crashed
            stderr_text = ""
            if self._process.stderr:
                try:
                    raw = await asyncio.wait_for(self._process.stderr.read(4096), timeout=1.0)
                    stderr_text = raw.decode(errors="replace").strip()
                except Exception:
                    pass
            log.warning(
                "notary_sidecar_exited",
                returncode=self._process.returncode,
                stderr=stderr_text[:500] if stderr_text else "",
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

    # Periodic forced restart interval. MPC notary sidecars accumulate
    # stale session state over time without crashing, causing new MPC
    # handshakes to fail with "connection is closed". Restarting clears
    # the state. Default: every 2 hours.
    _MAX_UPTIME_S = int(os.getenv("NOTARY_MAX_UPTIME", "7200"))

    async def watchdog_loop(self, interval: float = 30.0) -> None:
        """Periodically check sidecar health and restart if crashed.

        Checks process state, TCP liveness, and uptime. Notary sidecars
        accumulate stale MPC state and degrade without crashing. A forced
        restart every _MAX_UPTIME_S clears this state.
        """
        _started_at = time.monotonic()
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
                elif time.monotonic() - _started_at > self._MAX_UPTIME_S:
                    log.info("notary_watchdog_max_uptime", uptime_s=round(time.monotonic() - _started_at))
                    needs_restart = True
                if needs_restart:
                    await self.stop()
                    restarted = await self.restart_if_needed()
                    if restarted:
                        _started_at = time.monotonic()
                    else:
                        log.error("notary_watchdog_restart_failed")
            except asyncio.CancelledError:
                return
            except Exception as e:
                log.error("notary_watchdog_error", error=str(e))
