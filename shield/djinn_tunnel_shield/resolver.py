"""Validator-side tunnel URL resolution and smart fallback.

This is the only file validators need to understand. It:
1. Caches tunnel URLs from miner health responses
2. Reads encrypted commitments from the chain
3. Routes requests: direct IP first, tunnel on failure
4. Tracks per-miner failure state for smart routing
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import structlog

from djinn_tunnel_shield.config import ShieldConfig
from djinn_tunnel_shield.crypto import decrypt_tunnel_url

log = structlog.get_logger()


@dataclass
class _MinerEntry:
    """Per-miner routing state."""
    tunnel_url: str | None = None
    tunnel_source: str = ""  # "health" or "commitment"
    consecutive_direct_failures: int = 0
    last_direct_probe: float = 0
    use_tunnel: bool = False


class ShieldResolver:
    """Resolves miner URLs with smart direct-IP/tunnel fallback.

    Validator integration (complete example):

        resolver = ShieldResolver(config, wallet)

        # On health check response:
        resolver.cache_from_health(uid, health_data)

        # On metagraph sync:
        resolver.sync_commitments(subtensor, netuid)

        # When connecting to a miner:
        for url in resolver.urls(uid, ip, port, "/health"):
            try:
                resp = await client.get(url)
                resolver.record_success(uid)
                break
            except Exception:
                resolver.record_failure(uid)
    """

    def __init__(self, config: ShieldConfig | None = None, wallet: object = None) -> None:
        self._config = config or ShieldConfig()
        self._wallet = wallet
        self._miners: dict[int, _MinerEntry] = {}

    def _entry(self, uid: int) -> _MinerEntry:
        if uid not in self._miners:
            self._miners[uid] = _MinerEntry()
        return self._miners[uid]

    # -- Data ingestion --

    def cache_from_health(self, uid: int, health_data: dict) -> None:
        """Cache a tunnel URL from a miner's health response.

        Only used if no on-chain commitment exists (commitment is more trusted).
        """
        url = health_data.get("tunnel_url")
        if not url or not isinstance(url, str):
            return
        entry = self._entry(uid)
        if entry.tunnel_source != "commitment":
            entry.tunnel_url = url
            entry.tunnel_source = "health"

    def cache_from_commitment(self, uid: int, tunnel_url: str) -> None:
        """Cache a tunnel URL from an on-chain commitment (higher trust)."""
        entry = self._entry(uid)
        entry.tunnel_url = tunnel_url
        entry.tunnel_source = "commitment"

    def sync_commitments(self, subtensor: object, netuid: int) -> int:
        """Read and decrypt tunnel commitments from the chain.

        Returns the number of tunnel URLs discovered.
        """
        if not self._wallet:
            return 0

        count = 0
        try:
            metagraph = subtensor.metagraph(netuid)
            validator_ss58 = self._wallet.hotkey.ss58_address
            validator_private = self._wallet.hotkey.private_key

            for uid in range(metagraph.n.item()):
                if metagraph.validator_permit[uid].item():
                    continue  # Skip validators, only miners have tunnels
                try:
                    commitment = subtensor.get_commitment(metagraph.hotkeys[uid], netuid)
                    if not commitment:
                        continue
                    data = commitment if isinstance(commitment, bytes) else commitment.encode()
                    url = decrypt_tunnel_url(
                        data, validator_ss58, validator_private,
                        max_age=self._config.commitment_max_age,
                    )
                    if url:
                        self.cache_from_commitment(uid, url)
                        count += 1
                except Exception:
                    continue
        except Exception as e:
            log.warning("sync_commitments_failed", error=str(e))
        return count

    # -- URL resolution --

    def urls(self, uid: int, ip: str, port: int, path: str) -> list[str]:
        """Return URLs to try in priority order.

        Normally: [direct, tunnel]. Under active DDoS (after consecutive
        direct failures): [tunnel, direct] with periodic direct probes.
        """
        entry = self._entry(uid)
        direct = f"http://{ip}:{port}{path}"
        tunnel = f"{entry.tunnel_url}{path}" if entry.tunnel_url else None

        if not tunnel:
            return [direct]

        if not entry.use_tunnel:
            return [direct, tunnel]

        # In tunnel mode: try tunnel first, periodically probe direct
        now = time.monotonic()
        if now - entry.last_direct_probe >= self._config.direct_probe_interval:
            entry.last_direct_probe = now
            return [direct, tunnel]  # Probe direct first this time

        return [tunnel, direct]

    def get_tunnel_url(self, uid: int) -> str | None:
        """Get the cached tunnel URL for a miner, if any."""
        entry = self._miners.get(uid)
        return entry.tunnel_url if entry else None

    # -- Failure tracking --

    def record_success(self, uid: int) -> None:
        """Record a successful connection to a miner."""
        entry = self._entry(uid)
        entry.consecutive_direct_failures = 0
        if entry.use_tunnel:
            entry.use_tunnel = False
            log.info("miner_switched_to_direct", uid=uid)

    def record_failure(self, uid: int) -> None:
        """Record a failed direct-IP connection."""
        entry = self._entry(uid)
        entry.consecutive_direct_failures += 1
        if (
            not entry.use_tunnel
            and entry.tunnel_url
            and entry.consecutive_direct_failures >= self._config.direct_failure_threshold
        ):
            entry.use_tunnel = True
            entry.last_direct_probe = time.monotonic()
            log.info(
                "miner_switched_to_tunnel",
                uid=uid,
                failures=entry.consecutive_direct_failures,
            )
