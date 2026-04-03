"""Cloudflare Tunnel lifecycle management."""

from __future__ import annotations

import asyncio
import re

import structlog

from djinn_tunnel_shield.binary import locate_or_download
from djinn_tunnel_shield.config import ShieldConfig

log = structlog.get_logger()

# Quick tunnel prints the URL to stderr like:
#   INF +-------------------------------------------+
#   INF |  https://xxx-yyy-zzz.trycloudflare.com    |
#   INF +-------------------------------------------+
_URL_RE = re.compile(r"https://[a-zA-Z0-9_-]+\.trycloudflare\.com")
# Named tunnel URL comes from the configured hostname
_NAMED_URL_RE = re.compile(r"https?://\S+")


class TunnelManager:
    """Manages a cloudflared tunnel subprocess."""

    def __init__(self, config: ShieldConfig, local_port: int) -> None:
        self._config = config
        self._port = local_port
        self._process: asyncio.subprocess.Process | None = None
        self._url: str | None = None
        self._binary: str | None = None
        self._running = False

    @property
    def url(self) -> str | None:
        return self._url

    @property
    def is_running(self) -> bool:
        return self._running and self._process is not None and self._process.returncode is None

    async def start(self) -> str | None:
        """Start the tunnel. Returns the tunnel URL or None on failure."""
        self._binary = locate_or_download(
            preferred_path=self._config.cloudflared_path,
            expected_checksum=self._config.cloudflared_checksum,
        )
        if not self._binary:
            log.error("tunnel_no_binary")
            return None

        if self._config.cloudflare_token:
            return await self._start_named()
        return await self._start_quick()

    async def _start_quick(self) -> str | None:
        """Start a quick tunnel (no account required, emergency only)."""
        log.warning(
            "tunnel_quick_mode",
            msg="Emergency quick tunnel activated. Quick tunnels are for temporary "
            "use only. Set CLOUDFLARE_TOKEN for permanent TOS-compliant protection.",
        )
        cmd = [self._binary, "tunnel", "--url", f"http://localhost:{self._port}"]
        return await self._spawn(cmd, parse_url=True)

    async def _start_named(self) -> str | None:
        """Start a named tunnel with a Cloudflare account token."""
        cmd = [
            self._binary, "tunnel", "run",
            "--token", self._config.cloudflare_token,
        ]
        # Named tunnels have a pre-configured hostname; we get it from
        # the cloudflared connector output or the user's DNS config.
        return await self._spawn(cmd, parse_url=False)

    async def _spawn(self, cmd: list[str], parse_url: bool) -> str | None:
        """Spawn the cloudflared process and optionally parse the URL from output."""
        try:
            self._process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self._running = True
        except Exception as e:
            log.error("tunnel_spawn_failed", error=str(e))
            return None

        if not parse_url:
            # Named tunnel: URL is the configured hostname, not in output.
            # Wait briefly for startup, then return.
            await asyncio.sleep(3)
            if self._process.returncode is not None:
                stderr = await self._process.stderr.read() if self._process.stderr else b""
                log.error("tunnel_exited_early", stderr=stderr.decode(errors="replace")[:500])
                self._running = False
                return None
            log.info("tunnel_named_started")
            return None  # Caller sets URL from their DNS config

        # Quick tunnel: parse URL from stderr
        url = await self._read_url(timeout=15.0)
        if url:
            self._url = url
            log.info("tunnel_started", url=url)
        else:
            log.error("tunnel_url_not_found")
            await self.stop()
        return url

    async def _read_url(self, timeout: float) -> str | None:
        """Read stderr until we find the tunnel URL or timeout."""
        if not self._process or not self._process.stderr:
            return None
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            try:
                line = await asyncio.wait_for(
                    self._process.stderr.readline(),
                    timeout=max(0.1, deadline - asyncio.get_event_loop().time()),
                )
            except (asyncio.TimeoutError, TimeoutError):
                break
            if not line:
                break
            text = line.decode(errors="replace")
            match = _URL_RE.search(text)
            if match:
                return match.group(0)
        return None

    async def stop(self) -> None:
        """Stop the tunnel process."""
        self._running = False
        self._url = None
        if self._process and self._process.returncode is None:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5.0)
            except (asyncio.TimeoutError, TimeoutError):
                self._process.kill()
            log.info("tunnel_stopped")

    async def monitor(self, restart_delay: float = 5.0) -> None:
        """Monitor the tunnel process and restart on crash.

        Run this as a long-lived asyncio task.
        """
        while self._running:
            if self._process and self._process.returncode is not None:
                log.warning("tunnel_crashed", returncode=self._process.returncode)
                await asyncio.sleep(restart_delay)
                if self._running:
                    await self.start()
            await asyncio.sleep(2)
