"""Bittensor neuron integration for the Djinn validator.

Handles:
- Wallet and subtensor connection (without opentensor template)
- Metagraph sync
- Weight setting based on miner scores
- Epoch loop
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


class DjinnValidator:
    """Bittensor validator neuron for Djinn Protocol subnet 103."""

    # Minimum blocks between weight updates (Bittensor tempo is ~100 blocks)
    MIN_WEIGHT_INTERVAL = 100

    def __init__(
        self,
        netuid: int = 103,
        network: str = "finney",
        wallet_name: str = "default",
        hotkey_name: str = "default",
        axon_port: int = 8421,
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
        self._running = False
        self._last_weight_block: int = 0

    def setup(self) -> bool:
        """Initialize wallet, subtensor, and metagraph connections.

        Returns True if setup succeeded, False otherwise.
        """
        if bt is None:
            log.error("bittensor_required")
            return False

        try:
            self.wallet = bt.Wallet(
                name=self._wallet_name,
                hotkey=self._hotkey_name,
            )
            log.info("wallet_loaded", coldkey=self.wallet.coldkeypub.ss58_address)

            self.subtensor = bt.Subtensor(network=self.network)
            log.info("subtensor_connected", network=self.network)

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
                log.info("validator_uid", uid=self.uid)
            except ValueError:
                log.warning("not_registered", hotkey=hotkey, netuid=self.netuid)
                return False

            # Serve axon so web clients can discover us via metagraph
            self._setup_axon()

            return True

        except FileNotFoundError as e:
            log.error("setup_failed_wallet_not_found", error=str(e), wallet=self._wallet_name, hotkey=self._hotkey_name)
            return False
        except Exception as e:
            log.error("setup_failed", error=str(e), error_type=type(e).__name__, exc_info=True)
            return False

    def _setup_axon(self) -> None:
        """Create and serve the Bittensor axon for metagraph discovery.

        Advertises our IP/port on the metagraph so web clients
        can find validators. The actual API is served by FastAPI.
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
            external_port=self._external_port or self._axon_port,
        )

    @staticmethod
    def _safe_item(tensor_or_val: Any) -> int:
        """Safely extract an int from a tensor or raw value."""
        if hasattr(tensor_or_val, "item"):
            return int(tensor_or_val.item())
        return int(tensor_or_val)

    def sync_metagraph(self, timeout: float = 30.0) -> None:
        """Re-sync the metagraph to pick up new registrations/deregistrations.

        Uses a thread with a timeout to prevent the epoch loop from hanging
        if the subtensor WebSocket connection is unresponsive.
        """
        if self.subtensor and self.metagraph:
            import concurrent.futures

            pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            future = pool.submit(self.metagraph.sync, subtensor=self.subtensor)
            try:
                future.result(timeout=timeout)
            except concurrent.futures.TimeoutError:
                log.warning("metagraph_sync_timeout", timeout_s=timeout)
                # Don't wait for the thread — let it dangle and die
                pool.shutdown(wait=False, cancel_futures=True)
                return
            pool.shutdown(wait=False)
            log.debug("metagraph_synced", n=self._safe_item(self.metagraph.n))

    def apply_burn(self, weights: dict[int, float], burn_fraction: float) -> dict[int, float]:
        """Allocate burn_fraction of weight to UID 0, scale miners to the remainder.

        Args:
            weights: Mapping of miner UID -> weight (should sum to ~1.0).
            burn_fraction: Fraction of total weight to assign to UID 0 (e.g. 0.95).

        Returns:
            New weight dict with UID 0 receiving burn_fraction and miners scaled.
        """
        if not weights or burn_fraction >= 1.0:
            return {0: 1.0}

        miner_fraction = 1.0 - burn_fraction
        total = sum(weights.values())
        if total < 1e-12:
            return {0: 1.0}

        scale = miner_fraction / total
        result: dict[int, float] = {0: burn_fraction}
        for uid, w in weights.items():
            if uid == 0:
                continue
            scaled = w * scale
            if scaled > 1e-12:
                result[uid] = scaled

        log.info(
            "burn_applied",
            burn_fraction=burn_fraction,
            miner_count=len(result) - 1,
            miner_weight=round(miner_fraction, 4),
        )
        return result

    def set_weights(self, weights: dict[int, float]) -> bool:
        """Set miner weights on the Bittensor network.

        Args:
            weights: Mapping of miner UID -> weight (0-1, should sum to 1).

        Returns:
            True if weight setting succeeded.
        """
        if self.subtensor is None or self.wallet is None:
            log.warning("cannot_set_weights", reason="not initialized")
            return False

        if not weights:
            log.warning("no_weights_to_set")
            return False

        uids = list(weights.keys())
        vals = [weights[uid] for uid in uids]

        try:
            result = self.subtensor.set_weights(
                netuid=self.netuid,
                wallet=self.wallet,
                uids=uids,
                weights=vals,
                wait_for_inclusion=True,
                wait_for_finalization=False,
            )
            success = bool(result.success if hasattr(result, 'success') else result)
            log.info(
                "weights_set",
                uids=uids,
                success=success,
                error=getattr(result, 'error', None),
                message=getattr(result, 'message', None),
            )
            return success
        except Exception as e:
            log.error("set_weights_failed", error=str(e))
            return False

    def get_miner_uids(self) -> list[int]:
        """Get UIDs of all active miners (non-validators) on the subnet."""
        if self.metagraph is None:
            return []

        miner_uids = []
        for uid in range(self._safe_item(self.metagraph.n)):
            permit = self.metagraph.validator_permit[uid]
            is_validator = bool(permit.item() if hasattr(permit, "item") else permit)
            if not is_validator:
                miner_uids.append(uid)
        return miner_uids

    def get_axon_info(self, uid: int) -> dict[str, Any]:
        """Get connection info for a miner's axon."""
        if self.metagraph is None:
            return {}

        axon = self.metagraph.axons[uid]
        return {
            "ip": axon.ip,
            "port": axon.port,
            "hotkey": axon.hotkey,
        }

    @property
    def block(self) -> int:
        """Current block number."""
        if self.subtensor is None:
            return 0
        try:
            return int(self.subtensor.block)
        except Exception as e:
            log.warning("block_access_failed", error_type=type(e).__name__, error=str(e))
            return 0

    def should_set_weights(self) -> bool:
        """Check if enough blocks have passed since last weight update.

        Uses the on-chain last_update for this UID (which includes serve_axon)
        to avoid the Bittensor SDK's "too soon" rejection.
        """
        if self.subtensor is None or self.uid is None or self.metagraph is None:
            return False
        try:
            current = self.block
            # Use chain-tracked last_update to match SDK's internal check
            last_update = int(self.metagraph.last_update[self.uid].item())
            interval = current - last_update
            return interval >= self.MIN_WEIGHT_INTERVAL
        except Exception:
            # Fall back to local tracking
            return (self.block - self._last_weight_block) >= self.MIN_WEIGHT_INTERVAL

    def record_weight_set(self) -> None:
        """Record the block at which weights were last set."""
        self._last_weight_block = self.block

    def verify_burn(
        self, tx_hash: str, min_amount: float, burn_address: str
    ) -> tuple[bool, str, float, str]:
        """Verify a substrate transfer to the burn address via RPC.

        Scans recent blocks (last ~50) for the extrinsic hash, then validates
        the transfer destination and amount.

        Returns (valid, error_message, amount_tao, sender_ss58).
        """
        if not self.subtensor:
            return True, "", min_amount, "dev-mode"  # Dev mode: skip verification

        try:
            substrate = self.subtensor.substrate

            # Normalize tx hash to raw bytes for comparison
            tx_hash_clean = tx_hash.lower().removeprefix("0x")
            tx_hash_bytes = bytes.fromhex(tx_hash_clean)

            # Scan recent blocks for the extrinsic (burns should be recent)
            current_block = substrate.get_block_number(None)
            search_depth = 300  # ~50 minutes of blocks

            for block_num in range(current_block, max(current_block - search_depth, 0), -1):
                block_hash = substrate.get_block_hash(block_num)
                extrinsics = substrate.get_extrinsics(block_hash=block_hash)
                if not extrinsics:
                    continue

                for ex in extrinsics:
                    ex_hash = ex.extrinsic_hash
                    if ex_hash is None:
                        continue
                    # Compare hash bytes
                    if isinstance(ex_hash, bytes):
                        if ex_hash != tx_hash_bytes:
                            continue
                    elif isinstance(ex_hash, str):
                        if ex_hash.lower().removeprefix("0x") != tx_hash_clean:
                            continue
                    else:
                        continue

                    # Found the extrinsic — validate it
                    call = ex.value.get("call", {})
                    call_module = call.get("call_module", "")
                    call_function = call.get("call_function", "")

                    # Extract sender SS58 address from the extrinsic
                    sender = ""
                    ex_address = ex.value.get("address", "")
                    if isinstance(ex_address, str):
                        sender = ex_address
                    elif isinstance(ex_address, dict):
                        sender = ex_address.get("Id", "")

                    if call_module != "Balances" or call_function not in (
                        "transfer",
                        "transfer_keep_alive",
                        "transfer_allow_death",
                    ):
                        return False, (
                            f"Extrinsic is not a balance transfer "
                            f"(got {call_module}.{call_function})"
                        ), 0.0, sender

                    call_args = {
                        a["name"]: a["value"]
                        for a in call.get("call_args", [])
                    }
                    dest = call_args.get("dest", "")
                    if isinstance(dest, dict):
                        dest = dest.get("Id", "")
                    value = call_args.get("value", 0)

                    # Convert from rao (1 TAO = 1e9 rao)
                    amount_tao = value / 1e9

                    if dest != burn_address:
                        return False, (
                            f"Transfer destination {dest} does not match "
                            f"burn address {burn_address}"
                        ), 0.0, sender

                    if amount_tao < min_amount:
                        return False, (
                            f"Transfer amount {amount_tao} TAO is less than "
                            f"required {min_amount} TAO"
                        ), amount_tao, sender

                    log.info(
                        "burn_verified",
                        tx_hash=tx_hash[:16] + "...",
                        sender=sender,
                        amount_tao=amount_tao,
                    )
                    return True, "", amount_tao, sender

            return False, (
                f"Extrinsic {tx_hash} not found in the last {search_depth} blocks. "
                f"Ensure the burn transaction is confirmed and recent."
            ), 0.0, ""

        except Exception as e:
            log.warning("verify_burn_error", tx_hash=tx_hash, error=str(e))
            return False, f"Failed to verify burn transaction: {e}", 0.0, ""
