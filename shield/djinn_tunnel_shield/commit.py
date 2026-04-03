"""On-chain commitment of signed tunnel URLs."""

from __future__ import annotations

import asyncio
import time

import structlog

from djinn_tunnel_shield.config import ShieldConfig
from djinn_tunnel_shield.crypto import build_commitment

log = structlog.get_logger()


class CommitmentManager:
    """Publishes signed tunnel URLs on-chain via Bittensor's set_commitment."""

    def __init__(
        self,
        config: ShieldConfig,
        wallet: object,  # bittensor.Wallet
        subtensor: object,  # bittensor.Subtensor
        netuid: int,
    ) -> None:
        self._config = config
        self._wallet = wallet
        self._subtensor = subtensor
        self._netuid = netuid
        self._last_commit_time: float = 0
        self._last_committed_url: str = ""
        self._commit_available: bool | None = None  # None = untested

    def commit(self, tunnel_url: str) -> bool:
        """Sign and commit the tunnel URL on-chain.

        Returns True if the commitment was published successfully.
        """
        if self._wallet is None or self._subtensor is None:
            return False

        # Check once if set_commitment exists
        if self._commit_available is False:
            return False
        if self._commit_available is None:
            self._commit_available = hasattr(self._subtensor, "set_commitment")
            if not self._commit_available:
                log.warning("set_commitment_not_available", msg="Bittensor version too old for on-chain commitments")
                return False

        try:
            miner_hotkey = self._wallet.hotkey.ss58_address
            data = build_commitment(tunnel_url, miner_hotkey, self._wallet)

            self._subtensor.set_commitment(
                wallet=self._wallet,
                netuid=self._netuid,
                data=data,
            )
            self._last_commit_time = time.time()
            self._last_committed_url = tunnel_url
            log.info("tunnel_committed", data_size=len(data))
            return True
        except Exception as e:
            log.error("tunnel_commit_failed", error=str(e))
            return False

    def needs_recommit(self, current_url: str) -> bool:
        """Check if we should re-commit (URL changed or interval elapsed)."""
        if current_url != self._last_committed_url:
            return True
        if time.time() - self._last_commit_time > self._config.recommit_interval:
            return True
        return False

    async def commit_loop(self, get_url: callable) -> None:
        """Periodically re-commit the tunnel URL.

        Args:
            get_url: Callable that returns the current tunnel URL or None.
        """
        while True:
            try:
                url = get_url()
                if url and self.needs_recommit(url):
                    self.commit(url)
            except Exception as e:
                log.error("commit_loop_error", error=str(e))
            await asyncio.sleep(60)
