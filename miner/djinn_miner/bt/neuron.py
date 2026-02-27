"""Bittensor neuron integration for the Djinn miner.

Handles:
- Wallet and subtensor connection
- Axon setup and serving (so validators can discover this miner)
- Metagraph sync
"""

from __future__ import annotations

from typing import Any

import structlog

log = structlog.get_logger()

try:
    import bittensor as bt
except ImportError:
    bt = None  # type: ignore[assignment]
    log.warning("bittensor_not_installed", msg="Running without Bittensor SDK")


class DjinnMiner:
    """Bittensor miner neuron for Djinn Protocol subnet 103.

    The miner runs a FastAPI server for line-checking and proof generation.
    This class handles Bittensor registration so validators can discover
    the miner's IP/port via the metagraph.
    """

    def __init__(
        self,
        netuid: int = 103,
        network: str = "finney",
        wallet_name: str = "default",
        hotkey_name: str = "default",
        axon_port: int = 8422,
        external_ip: str | None = None,
        external_port: int | None = None,
    ) -> None:
        self.netuid = netuid
        self.network = network
        self._wallet_name = wallet_name
        self._hotkey_name = hotkey_name
        self._axon_port = axon_port
        self._external_ip = external_ip
        self._external_port = external_port

        self.wallet: Any = None
        self.subtensor: Any = None
        self.metagraph: Any = None
        self.axon: Any = None
        self.uid: int | None = None

    def setup(self) -> bool:
        """Initialize wallet, subtensor, metagraph, and axon.

        Returns True if setup succeeded, False otherwise.
        """
        if bt is None:
            log.error("bittensor_required")
            return False

        try:
            # Wallet
            self.wallet = bt.Wallet(
                name=self._wallet_name,
                hotkey=self._hotkey_name,
            )
            log.info("wallet_loaded", hotkey=self.wallet.hotkey.ss58_address)

            # Subtensor connection
            self.subtensor = bt.Subtensor(network=self.network)
            log.info("subtensor_connected", network=self.network)

            # Metagraph
            self.metagraph = self.subtensor.metagraph(self.netuid)
            log.info(
                "metagraph_synced",
                netuid=self.netuid,
                n=self._safe_item(self.metagraph.n),
            )

            # Find our UID
            hotkey = self.wallet.hotkey.ss58_address
            try:
                self.uid = list(self.metagraph.hotkeys).index(hotkey)
                log.info("miner_uid", uid=self.uid)
            except ValueError:
                log.warning("not_registered", hotkey=hotkey, netuid=self.netuid)
                return False

            # Set up axon so validators can discover us
            self._setup_axon()

            return True

        except FileNotFoundError as e:
            log.error("setup_failed_wallet_not_found", error=str(e), wallet=self._wallet_name, hotkey=self._hotkey_name)
            return False
        except Exception as e:
            log.error("setup_failed", error=str(e), error_type=type(e).__name__, exc_info=True)
            return False

    def _setup_axon(self) -> None:
        """Create and serve the Bittensor axon.

        The axon advertises our IP/port on the metagraph so validators
        know where to send line-check requests. The actual request handling
        is done by the FastAPI server, not the axon — the axon just
        provides discovery.
        """
        if bt is None or self.wallet is None:
            return

        axon_kwargs: dict[str, Any] = {
            "wallet": self.wallet,
            "port": self._axon_port,
        }
        if self._external_ip:
            axon_kwargs["external_ip"] = self._external_ip
        if self._external_port:
            axon_kwargs["external_port"] = self._external_port

        self.axon = bt.Axon(**axon_kwargs)
        self.subtensor.serve_axon(netuid=self.netuid, axon=self.axon)
        log.info(
            "axon_served",
            port=self._axon_port,
            external_ip=self._external_ip or "auto",
        )

    @staticmethod
    def _safe_item(tensor_or_val: Any) -> int:
        """Safely extract an int from a tensor or raw value."""
        if hasattr(tensor_or_val, "item"):
            return int(tensor_or_val.item())
        return int(tensor_or_val)

    def sync_metagraph(self, timeout: float = 30.0) -> None:
        """Re-sync the metagraph with a timeout to prevent hangs."""
        if self.subtensor and self.metagraph:
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(self.metagraph.sync, subtensor=self.subtensor)
                future.result(timeout=timeout)
            log.debug("metagraph_synced", n=self._safe_item(self.metagraph.n))

    def is_registered(self) -> bool:
        """Check if this miner is still registered on the subnet."""
        if self.metagraph is None or self.wallet is None:
            return False
        hotkey = self.wallet.hotkey.ss58_address
        return hotkey in self.metagraph.hotkeys

    @property
    def block(self) -> int:
        if self.subtensor is None:
            return 0
        try:
            return int(self.subtensor.block)
        except Exception as e:
            log.warning("block_access_failed", error_type=type(e).__name__, error=str(e))
            return 0
