"""On-chain commitment of encrypted tunnel URLs."""

from __future__ import annotations

import asyncio
import time

import structlog

from djinn_tunnel_shield.config import ShieldConfig
from djinn_tunnel_shield.crypto import encrypt_for_validators

log = structlog.get_logger()


class CommitmentManager:
    """Publishes encrypted tunnel URLs on-chain via Bittensor's commitment mechanism."""

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

    def _get_validator_hotkeys(self) -> list[str]:
        """Get current validator hotkeys from the metagraph."""
        try:
            metagraph = self._subtensor.metagraph(self._netuid)
            hotkeys = []
            for uid in range(metagraph.n.item()):
                if metagraph.validator_permit[uid].item():
                    hotkeys.append(metagraph.hotkeys[uid])
            return hotkeys
        except Exception as e:
            log.error("get_validator_hotkeys_failed", error=str(e))
            return []

    def commit(self, tunnel_url: str) -> bool:
        """Encrypt and commit the tunnel URL on-chain.

        Returns True if the commitment was published successfully.
        """
        validator_hotkeys = self._get_validator_hotkeys()
        if not validator_hotkeys:
            log.warning("no_validators_for_commitment")
            return False

        miner_hotkey = self._wallet.hotkey.ss58_address
        data = encrypt_for_validators(tunnel_url, validator_hotkeys, miner_hotkey)

        try:
            # Bittensor commit mechanism: store arbitrary data tied to hotkey+netuid
            self._subtensor.commit(self._wallet, self._netuid, data)
            self._last_commit_time = time.time()
            self._last_committed_url = tunnel_url
            log.info(
                "tunnel_committed",
                validators=len(validator_hotkeys),
                data_size=len(data),
            )
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
            await asyncio.sleep(60)  # Check every minute, commit when needed
