"""MinerShield: top-level orchestrator for miner-side DDoS protection.

Usage:
    shield = MinerShield(wallet, subtensor, netuid, port)
    asyncio.create_task(shield.run())

    # In health endpoint:
    {"tunnel_url": shield.tunnel_url, ...}
"""

from __future__ import annotations

import asyncio
import os

import structlog

from djinn_tunnel_shield.commit import CommitmentManager
from djinn_tunnel_shield.config import ShieldConfig
from djinn_tunnel_shield.detect import PingSilenceDetector
from djinn_tunnel_shield.tunnel import TunnelManager

log = structlog.get_logger()


class MinerShield:
    """Orchestrates tunnel, detection, and commitment for a miner."""

    def __init__(
        self,
        wallet: object,
        subtensor: object,
        netuid: int,
        port: int,
        config: ShieldConfig | None = None,
    ) -> None:
        self._config = config or ShieldConfig(
            cloudflare_token=os.environ.get("CLOUDFLARE_TOKEN", ""),
        )
        self._tunnel = TunnelManager(self._config, port)
        self._notary_tunnel: TunnelManager | None = None
        if self._config.notary_tunnel_enabled and self._config.cloudflare_token:
            self._notary_tunnel = TunnelManager(self._config, self._config.notary_port)
        self._detector = PingSilenceDetector(self._config)
        self._commitment = CommitmentManager(self._config, wallet, subtensor, netuid)
        self._named_tunnel_url: str | None = os.environ.get("CLOUDFLARE_HOSTNAME")
        self._notary_tunnel_url: str | None = os.environ.get("CLOUDFLARE_NOTARY_HOSTNAME")

    @property
    def tunnel_url(self) -> str | None:
        """Current tunnel URL (for health response)."""
        return self._named_tunnel_url or self._tunnel.url

    @property
    def notary_tunnel_url(self) -> str | None:
        """Current notary sidecar tunnel URL (for health response)."""
        if self._notary_tunnel:
            return self._notary_tunnel_url or self._notary_tunnel.url
        return None

    def record_ping(self) -> None:
        """Call on every validator health ping."""
        self._detector.record_ping()

    async def run(self) -> None:
        """Main shield loop. Run as an asyncio task."""
        if not self._config.enabled:
            log.info("shield_disabled")
            return

        has_token = bool(self._config.cloudflare_token)

        if has_token:
            # Named tunnel: start immediately, runs permanently
            url = await self._tunnel.start()
            if url:
                self._named_tunnel_url = url
            elif self._named_tunnel_url:
                log.info("shield_using_configured_hostname", url=self._named_tunnel_url)
            # Start notary tunnel if enabled
            if self._notary_tunnel:
                nurl = await self._notary_tunnel.start()
                if nurl:
                    self._notary_tunnel_url = nurl
                    log.info("notary_tunnel_started", url=nurl)

            # Start monitoring and commitment in parallel
            tasks = [
                self._tunnel.monitor(),
                self._commitment.commit_loop(lambda: self.tunnel_url),
            ]
            if self._notary_tunnel:
                tasks.append(self._notary_tunnel.monitor())
            await asyncio.gather(*tasks)
        else:
            # No token: watch for DDoS, activate quick tunnel on detection
            log.info("shield_standby", msg="No CLOUDFLARE_TOKEN set. Emergency tunnel will activate on DDoS detection.")
            await self._emergency_loop()

    async def _emergency_loop(self) -> None:
        """Monitor for DDoS and activate/deactivate emergency tunnel."""
        tunnel_active = False

        while True:
            ddos = self._detector.is_ddos_detected

            if ddos and not tunnel_active:
                log.warning("shield_activating_emergency_tunnel")
                url = await self._tunnel.start()
                if url:
                    tunnel_active = True
                    self._commitment.commit(url)

            elif not ddos and tunnel_active:
                log.info("shield_deactivating_emergency_tunnel")
                await self._tunnel.stop()
                tunnel_active = False

            # Re-commit if URL changed (tunnel restart)
            if tunnel_active and self._tunnel.url:
                if self._commitment.needs_recommit(self._tunnel.url):
                    self._commitment.commit(self._tunnel.url)

            await asyncio.sleep(5)
