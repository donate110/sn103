"""On-chain interaction layer for Base chain smart contracts.

Provides typed wrappers around contract calls used by the validator:
- Escrow.getPurchase/getPurchasesBySignal — read purchase data
- SignalCommitment.getSignal() — read signal metadata
- Account.recordOutcome() — write attested outcomes
- Escrow.setOutcome() — write purchase outcomes

Supports multiple RPC URLs with automatic failover on connection errors.
Optionally supports transaction signing when a private key is provided.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import structlog
from eth_account import Account as EthAccount
from web3 import AsyncWeb3
from web3.contract import AsyncContract

from djinn_validator.utils.circuit_breaker import CircuitBreaker

log = structlog.get_logger()


def _sanitize_url(url: str) -> str:
    """Strip credentials and path from URL for safe logging."""
    from urllib.parse import urlparse

    try:
        parsed = urlparse(url)
        return f"{parsed.scheme}://{parsed.hostname}:{parsed.port or 443}"
    except Exception:
        return "<unparseable>"


# Minimal ABIs — only the functions the validator needs
ESCROW_ABI = [
    {
        "inputs": [{"name": "signalId", "type": "uint256"}],
        "name": "getPurchasesBySignal",
        "outputs": [{"name": "", "type": "uint256[]"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [{"name": "purchaseId", "type": "uint256"}],
        "name": "getPurchase",
        "outputs": [
            {
                "components": [
                    {"name": "idiot", "type": "address"},
                    {"name": "signalId", "type": "uint256"},
                    {"name": "notional", "type": "uint256"},
                    {"name": "feePaid", "type": "uint256"},
                    {"name": "creditUsed", "type": "uint256"},
                    {"name": "usdcPaid", "type": "uint256"},
                    {"name": "odds", "type": "uint256"},
                    {"name": "outcome", "type": "uint8"},
                    {"name": "purchasedAt", "type": "uint256"},
                ],
                "name": "",
                "type": "tuple",
            },
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "purchaseId", "type": "uint256"},
            {"name": "outcome", "type": "uint8"},
        ],
        "name": "setOutcome",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
]

SIGNAL_COMMITMENT_ABI = [
    {
        "inputs": [{"name": "signalId", "type": "uint256"}],
        "name": "getSignal",
        "outputs": [
            {
                "components": [
                    {"name": "genius", "type": "address"},
                    {"name": "encryptedBlob", "type": "bytes"},
                    {"name": "commitHash", "type": "bytes32"},
                    {"name": "sport", "type": "string"},
                    {"name": "maxPriceBps", "type": "uint256"},
                    {"name": "slaMultiplierBps", "type": "uint256"},
                    {"name": "maxNotional", "type": "uint256"},
                    {"name": "minNotional", "type": "uint256"},
                    {"name": "expiresAt", "type": "uint256"},
                    {"name": "decoyLines", "type": "string[]"},
                    {"name": "availableSportsbooks", "type": "string[]"},
                    {"name": "status", "type": "uint8"},
                    {"name": "createdAt", "type": "uint256"},
                ],
                "name": "",
                "type": "tuple",
            },
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [{"name": "signalId", "type": "uint256"}],
        "name": "isActive",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function",
    },
]

ACCOUNT_ABI = [
    {
        "inputs": [
            {"name": "genius", "type": "address"},
            {"name": "idiot", "type": "address"},
            {"name": "purchaseId", "type": "uint256"},
            {"name": "outcome", "type": "uint8"},
        ],
        "name": "recordOutcome",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "genius", "type": "address"},
            {"name": "idiot", "type": "address"},
        ],
        "name": "isAuditReady",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "genius", "type": "address"},
            {"name": "idiot", "type": "address"},
        ],
        "name": "getCurrentCycle",
        "outputs": [{"name": "cycle", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "genius", "type": "address"},
            {"name": "idiot", "type": "address"},
        ],
        "name": "getSignalCount",
        "outputs": [{"name": "count", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "genius", "type": "address"},
            {"name": "idiot", "type": "address"},
        ],
        "name": "getPurchaseIds",
        "outputs": [{"name": "ids", "type": "uint256[]"}],
        "stateMutability": "view",
        "type": "function",
    },
]

OUTCOME_VOTING_ABI = [
    {
        "inputs": [
            {"name": "genius", "type": "address"},
            {"name": "idiot", "type": "address"},
            {"name": "qualityScore", "type": "int256"},
        ],
        "name": "submitVote",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "genius", "type": "address"},
            {"name": "idiot", "type": "address"},
            {"name": "cycle", "type": "uint256"},
        ],
        "name": "isCycleFinalized",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "genius", "type": "address"},
            {"name": "idiot", "type": "address"},
            {"name": "cycle", "type": "uint256"},
            {"name": "qualityScore", "type": "int256"},
        ],
        "name": "getVoteCount",
        "outputs": [{"name": "count", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [{"name": "validator", "type": "address"}],
        "name": "isValidator",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "getValidators",
        "outputs": [{"name": "", "type": "address[]"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "syncNonce",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "newValidators", "type": "address[]"},
            {"name": "nonce", "type": "uint256"},
        ],
        "name": "proposeSync",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
]

# Connection-type errors that indicate the RPC endpoint is unreachable
_FAILOVER_ERRORS = (ConnectionError, OSError, TimeoutError)


class ChainClient:
    """Async client for interacting with Djinn contracts on Base.

    Supports multiple RPC URLs with automatic failover. Pass a comma-separated
    string or a list of URLs. On connection failure, the client rotates to the
    next available RPC endpoint and retries.
    """

    def __init__(
        self,
        rpc_url: str | list[str],
        escrow_address: str = "",
        signal_address: str = "",
        account_address: str = "",
        outcome_voting_address: str = "",
        private_key: str = "",
        chain_id: int = 8453,
    ) -> None:
        if isinstance(rpc_url, str):
            self._rpc_urls = [u.strip() for u in rpc_url.split(",") if u.strip()]
        else:
            self._rpc_urls = list(rpc_url)
        if not self._rpc_urls:
            self._rpc_urls = ["https://mainnet.base.org"]
        self._rpc_index = 0
        self._escrow_address = escrow_address
        self._signal_address = signal_address
        self._account_address = account_address
        self._outcome_voting_address = outcome_voting_address
        self._chain_id = chain_id
        self._circuit_breaker = CircuitBreaker(
            name="rpc",
            failure_threshold=3,
            recovery_timeout=30.0,
        )
        self._w3 = self._create_provider(self._rpc_urls[0])
        self._setup_contracts()

        # Transaction signing (optional — required for settlement writes)
        self._private_key = private_key
        self._validator_address: str | None = None
        self._nonce_lock = asyncio.Lock()
        if private_key:
            try:
                acct = EthAccount.from_key(private_key)
                self._validator_address = acct.address
                log.info("chain_client_signer_configured", address=acct.address)
            except Exception as e:
                log.error("invalid_validator_private_key", err_type=type(e).__name__)
                self._private_key = ""

    def _create_provider(self, url: str) -> AsyncWeb3:
        return AsyncWeb3(
            AsyncWeb3.AsyncHTTPProvider(
                url,
                request_kwargs={"timeout": 30},
            )
        )

    def _setup_contracts(self) -> None:
        self._escrow: AsyncContract | None = None
        self._signal: AsyncContract | None = None
        self._account: AsyncContract | None = None
        self._outcome_voting: AsyncContract | None = None
        for label, addr, abi, attr in [
            ("escrow", self._escrow_address, ESCROW_ABI, "_escrow"),
            ("signal", self._signal_address, SIGNAL_COMMITMENT_ABI, "_signal"),
            ("account", self._account_address, ACCOUNT_ABI, "_account"),
            ("outcome_voting", self._outcome_voting_address, OUTCOME_VOTING_ABI, "_outcome_voting"),
        ]:
            if addr:
                try:
                    setattr(
                        self,
                        attr,
                        self._w3.eth.contract(
                            address=self._w3.to_checksum_address(addr),
                            abi=abi,
                        ),
                    )
                except ValueError:
                    log.error("invalid_contract_address", contract=label, address=addr)

    def _rotate_rpc(self) -> bool:
        """Switch to the next RPC URL. Returns True if a different URL was selected."""
        if len(self._rpc_urls) <= 1:
            return False
        old_index = self._rpc_index
        self._rpc_index = (self._rpc_index + 1) % len(self._rpc_urls)
        if self._rpc_index == old_index:
            return False
        new_url = self._rpc_urls[self._rpc_index]
        log.warning("rpc_failover", new_url=_sanitize_url(new_url), old_index=old_index, new_index=self._rpc_index)
        self._w3 = self._create_provider(new_url)
        self._setup_contracts()
        return True

    async def _with_failover(self, make_call: Callable[[], Awaitable[Any]]) -> Any:
        """Execute a contract call with circuit breaker and RPC failover.

        The circuit breaker prevents hammering endpoints that are consistently
        failing. The make_call callable is re-invoked after each rotation so
        it picks up the freshly-created contract references.
        """
        if not self._circuit_breaker.allow_request():
            raise ConnectionError(
                f"RPC circuit breaker open — all endpoints unhealthy (recovery in {self._circuit_breaker._recovery_timeout}s)"
            )

        tried = 0
        total = len(self._rpc_urls)
        last_exc: Exception | None = None
        while tried < total:
            try:
                result = await make_call()
                self._circuit_breaker.record_success()
                return result
            except _FAILOVER_ERRORS as e:
                last_exc = e
                tried += 1
                if tried < total and self._rotate_rpc():
                    from djinn_validator.api.metrics import RPC_FAILOVERS

                    RPC_FAILOVERS.inc()
                    log.warning("rpc_call_failed_retrying", err=str(e), tried=tried)
                    continue
                self._circuit_breaker.record_failure()
                raise
        self._circuit_breaker.record_failure()
        raise last_exc or ConnectionError("All RPC endpoints exhausted")

    async def is_signal_active(self, signal_id: int) -> bool:
        """Check if a signal is still active on-chain.

        Returns False on error (fail-safe: don't release shares if chain is unreachable).
        Returns True only when contract is unconfigured (dev mode).
        """
        if self._signal is None:
            log.warning("signal_contract_not_configured")
            return True  # Permissive in dev mode (no contract)
        try:
            return await self._with_failover(
                lambda: self._signal.functions.isActive(signal_id).call()  # type: ignore[union-attr]
            )
        except Exception as e:
            log.error("is_signal_active_failed", signal_id=signal_id, err=str(e))
            return False  # Fail-safe: don't release shares when chain is unreachable

    async def get_signal(self, signal_id: int) -> dict[str, Any]:
        """Read signal metadata from SignalCommitment contract."""
        if self._signal is None:
            return {}
        try:
            result = await self._with_failover(
                lambda: self._signal.functions.getSignal(signal_id).call()  # type: ignore[union-attr]
            )
            # Tuple order matches Signal struct: genius, encryptedBlob, commitHash,
            # sport, maxPriceBps, slaMultiplierBps, maxNotional, minNotional,
            # expiresAt, decoyLines, availableSportsbooks, status, createdAt
            return {
                "genius": result[0],
                "encryptedBlob": result[1],
                "commitHash": result[2],
                "sport": result[3],
                "maxPriceBps": result[4],
                "slaMultiplierBps": result[5],
                "expiresAt": result[8],
                "status": result[11],
                "createdAt": result[12],
            }
        except Exception as e:
            log.error("get_signal_failed", signal_id=signal_id, err=str(e))
            return {}

    async def verify_purchase(self, signal_id: int, buyer: str) -> dict[str, Any]:
        """Verify a purchase exists on-chain for the given signal and buyer.

        Queries getPurchasesBySignal to find purchase IDs, then checks each
        via getPurchase to find one where idiot == buyer.
        """
        empty = {"notional": 0, "pricePaid": 0, "sportsbook": ""}
        if self._escrow is None:
            log.warning("escrow_contract_not_configured")
            return empty
        try:
            buyer_addr = self._w3.to_checksum_address(buyer)
        except ValueError:
            log.error("invalid_buyer_address", buyer=buyer)
            return empty
        try:
            purchase_ids: list[int] = await self._with_failover(
                lambda: self._escrow.functions.getPurchasesBySignal(  # type: ignore[union-attr]
                    signal_id,
                ).call()
            )
            for pid in purchase_ids:
                p = await self._with_failover(
                    lambda pid=pid: self._escrow.functions.getPurchase(  # type: ignore[union-attr]
                        pid,
                    ).call()
                )
                # Purchase tuple: (idiot, signalId, notional, feePaid, creditUsed, usdcPaid, odds, outcome, purchasedAt)
                if p[0].lower() == buyer_addr.lower():
                    return {
                        "notional": p[2],
                        "pricePaid": p[4] + p[5],  # creditUsed + usdcPaid
                        "sportsbook": "",
                    }
            return empty
        except Exception as e:
            log.error("verify_purchase_failed", signal_id=signal_id, buyer=buyer, err=str(e))
            return empty

    async def is_audit_ready(self, genius: str, idiot: str) -> bool:
        """Check if a Genius-Idiot pair has completed a cycle."""
        if self._account is None:
            return False
        try:
            genius_addr = self._w3.to_checksum_address(genius)
            idiot_addr = self._w3.to_checksum_address(idiot)
        except ValueError:
            log.error("invalid_address_for_audit", genius=genius, idiot=idiot)
            return False
        try:
            return await self._with_failover(
                lambda: self._account.functions.isAuditReady(  # type: ignore[union-attr]
                    genius_addr,
                    idiot_addr,
                ).call()
            )
        except Exception as e:
            log.error("is_audit_ready_failed", genius=genius, idiot=idiot, err=str(e))
            return False

    # ------------------------------------------------------------------
    # Read helpers for settlement
    # ------------------------------------------------------------------

    async def get_purchases_by_signal(self, signal_id: int) -> list[int]:
        """Return all purchase IDs for a given signal."""
        if self._escrow is None:
            return []
        try:
            return await self._with_failover(
                lambda: self._escrow.functions.getPurchasesBySignal(signal_id).call()  # type: ignore[union-attr]
            )
        except Exception as e:
            log.error("get_purchases_by_signal_failed", signal_id=signal_id, err=str(e))
            return []

    async def get_purchase(self, purchase_id: int) -> dict[str, Any]:
        """Read a single Purchase struct from Escrow."""
        if self._escrow is None:
            return {}
        try:
            p = await self._with_failover(
                lambda: self._escrow.functions.getPurchase(purchase_id).call()  # type: ignore[union-attr]
            )
            # Purchase tuple: (idiot, signalId, notional, feePaid, creditUsed, usdcPaid, odds, outcome, purchasedAt)
            return {
                "idiot": p[0],
                "signalId": p[1],
                "notional": p[2],
                "feePaid": p[3],
                "creditUsed": p[4],
                "usdcPaid": p[5],
                "odds": p[6],
                "outcome": p[7],  # 0=Pending, 1=Favorable, 2=Unfavorable, 3=Void
                "purchasedAt": p[8],
            }
        except Exception as e:
            log.error("get_purchase_failed", purchase_id=purchase_id, err=str(e))
            return {}

    # ------------------------------------------------------------------
    # Write methods for settlement (require private key)
    # ------------------------------------------------------------------

    @property
    def can_write(self) -> bool:
        """True if the client has a private key configured for signing transactions."""
        return bool(self._private_key and self._validator_address)

    @property
    def validator_address(self) -> str | None:
        """The Base address derived from the configured private key."""
        return self._validator_address

    async def _send_tx(
        self,
        contract: AsyncContract,
        fn_name: str,
        *args: Any,
        gas_limit: int = 300_000,
    ) -> str:
        """Build, sign, and send a contract transaction. Returns tx hash hex.

        Uses a nonce lock to prevent nonce collisions when multiple txs are
        sent concurrently within the same epoch.
        """
        if not self.can_write:
            raise RuntimeError("No private key configured — cannot send transactions")

        fn = getattr(contract.functions, fn_name)(*args)

        async with self._nonce_lock:
            nonce = await self._with_failover(
                lambda: self._w3.eth.get_transaction_count(self._validator_address, "pending")  # type: ignore[arg-type]
            )

            # Estimate gas with fallback
            try:
                gas = await fn.estimate_gas({"from": self._validator_address})
                gas = int(gas * 1.3)  # 30% buffer
            except Exception:
                gas = gas_limit

            gas_price = await self._with_failover(lambda: self._w3.eth.gas_price)
            # Cap gas price at 100 gwei to prevent runaway spend during spikes
            max_gas_price = 100 * 10**9  # 100 gwei
            if gas_price > max_gas_price:
                log.warning("gas_price_capped", actual_gwei=gas_price / 10**9, cap_gwei=100)
                gas_price = max_gas_price

            tx = await fn.build_transaction({
                "from": self._validator_address,
                "gas": gas,
                "gasPrice": gas_price,
                "nonce": nonce,
                "chainId": self._chain_id,
            })

            signed = EthAccount.sign_transaction(tx, self._private_key)
            tx_hash = await self._with_failover(
                lambda: self._w3.eth.send_raw_transaction(signed.raw_transaction)
            )

        return tx_hash.hex()

    async def record_outcome(
        self,
        genius: str,
        idiot: str,
        purchase_id: int,
        outcome: int,
    ) -> str:
        """Write an outcome to Account.recordOutcome(). Returns tx hash."""
        if self._account is None:
            raise RuntimeError("Account contract not configured")

        genius_addr = self._w3.to_checksum_address(genius)
        idiot_addr = self._w3.to_checksum_address(idiot)

        return await self._send_tx(
            self._account, "recordOutcome",
            genius_addr, idiot_addr, purchase_id, outcome,
        )

    async def set_escrow_outcome(
        self,
        purchase_id: int,
        outcome: int,
    ) -> str:
        """Write an outcome to Escrow.setOutcome(). Returns tx hash."""
        if self._escrow is None:
            raise RuntimeError("Escrow contract not configured")

        return await self._send_tx(
            self._escrow, "setOutcome",
            purchase_id, outcome,
        )

    async def settle_purchase(
        self,
        genius: str,
        idiot: str,
        purchase_id: int,
        outcome: int,
    ) -> dict[str, str | None]:
        """Settle a single purchase: write outcome to both Account and Escrow.

        Returns dict with 'account_tx' and 'escrow_tx' hashes (None on error).
        Skips purchases whose on-chain outcome is already set.
        """
        result: dict[str, str | None] = {"account_tx": None, "escrow_tx": None}

        # Check if already settled on-chain
        purchase = await self.get_purchase(purchase_id)
        if purchase and purchase.get("outcome", 0) != 0:
            log.debug(
                "purchase_already_settled",
                purchase_id=purchase_id,
                on_chain_outcome=purchase["outcome"],
            )
            return result

        # Write to Account.recordOutcome
        try:
            tx = await self.record_outcome(genius, idiot, purchase_id, outcome)
            result["account_tx"] = tx
            log.info(
                "account_outcome_recorded",
                purchase_id=purchase_id,
                outcome=outcome,
                tx_hash=tx,
            )
        except Exception as e:
            err_str = str(e)
            if "OutcomeAlreadyRecorded" in err_str:
                log.debug("account_outcome_already_recorded", purchase_id=purchase_id)
            else:
                log.error("account_record_outcome_failed", purchase_id=purchase_id, err=err_str)
                return result

        # Write to Escrow.setOutcome
        try:
            tx = await self.set_escrow_outcome(purchase_id, outcome)
            result["escrow_tx"] = tx
            log.info(
                "escrow_outcome_set",
                purchase_id=purchase_id,
                outcome=outcome,
                tx_hash=tx,
            )
        except Exception as e:
            err_str = str(e)
            if "OutcomeAlreadySet" in err_str:
                log.debug("escrow_outcome_already_set", purchase_id=purchase_id)
            else:
                log.error("escrow_set_outcome_failed", purchase_id=purchase_id, err=err_str)

        return result

    # ------------------------------------------------------------------
    # Account read helpers for quality score computation
    # ------------------------------------------------------------------

    async def get_current_cycle(self, genius: str, idiot: str) -> int:
        """Get the current audit cycle for a Genius-Idiot pair."""
        if self._account is None:
            return 0
        try:
            genius_addr = self._w3.to_checksum_address(genius)
            idiot_addr = self._w3.to_checksum_address(idiot)
            return await self._with_failover(
                lambda: self._account.functions.getCurrentCycle(genius_addr, idiot_addr).call()  # type: ignore[union-attr]
            )
        except Exception as e:
            log.error("get_current_cycle_failed", genius=genius, idiot=idiot, err=str(e))
            return 0

    async def get_signal_count(self, genius: str, idiot: str) -> int:
        """Get the signal count in the current cycle for a Genius-Idiot pair."""
        if self._account is None:
            return 0
        try:
            genius_addr = self._w3.to_checksum_address(genius)
            idiot_addr = self._w3.to_checksum_address(idiot)
            return await self._with_failover(
                lambda: self._account.functions.getSignalCount(genius_addr, idiot_addr).call()  # type: ignore[union-attr]
            )
        except Exception as e:
            log.error("get_signal_count_failed", genius=genius, idiot=idiot, err=str(e))
            return 0

    async def get_purchase_ids(self, genius: str, idiot: str) -> list[int]:
        """Get all purchase IDs for the current cycle of a Genius-Idiot pair."""
        if self._account is None:
            return []
        try:
            genius_addr = self._w3.to_checksum_address(genius)
            idiot_addr = self._w3.to_checksum_address(idiot)
            return await self._with_failover(
                lambda: self._account.functions.getPurchaseIds(genius_addr, idiot_addr).call()  # type: ignore[union-attr]
            )
        except Exception as e:
            log.error("get_purchase_ids_failed", genius=genius, idiot=idiot, err=str(e))
            return []

    # ------------------------------------------------------------------
    # OutcomeVoting write methods
    # ------------------------------------------------------------------

    async def submit_vote(
        self,
        genius: str,
        idiot: str,
        quality_score: int,
    ) -> str:
        """Submit a quality score vote to OutcomeVoting. Returns tx hash."""
        if self._outcome_voting is None:
            raise RuntimeError("OutcomeVoting contract not configured")

        genius_addr = self._w3.to_checksum_address(genius)
        idiot_addr = self._w3.to_checksum_address(idiot)

        return await self._send_tx(
            self._outcome_voting, "submitVote",
            genius_addr, idiot_addr, quality_score,
            gas_limit=200_000,
        )

    async def is_cycle_finalized(self, genius: str, idiot: str, cycle: int) -> bool:
        """Check if a cycle has been finalized in OutcomeVoting."""
        if self._outcome_voting is None:
            return False
        try:
            genius_addr = self._w3.to_checksum_address(genius)
            idiot_addr = self._w3.to_checksum_address(idiot)
            return await self._with_failover(
                lambda: self._outcome_voting.functions.isCycleFinalized(  # type: ignore[union-attr]
                    genius_addr, idiot_addr, cycle,
                ).call()
            )
        except Exception as e:
            log.error("is_cycle_finalized_failed", genius=genius, idiot=idiot, cycle=cycle, err=str(e))
            return False

    async def is_registered_validator(self) -> bool:
        """Check if this validator is registered in OutcomeVoting."""
        if self._outcome_voting is None or not self._validator_address:
            return False
        try:
            return await self._with_failover(
                lambda: self._outcome_voting.functions.isValidator(  # type: ignore[union-attr]
                    self._w3.to_checksum_address(self._validator_address),
                ).call()
            )
        except Exception as e:
            log.error("is_registered_validator_failed", err=str(e))
            return False

    async def get_validators(self) -> list[str]:
        """Read the on-chain validator set from OutcomeVoting."""
        if self._outcome_voting is None:
            return []
        try:
            result = await self._with_failover(
                lambda: self._outcome_voting.functions.getValidators().call()  # type: ignore[union-attr]
            )
            return [str(addr) for addr in result]
        except Exception as e:
            log.error("get_validators_failed", err=str(e))
            return []

    async def get_sync_nonce(self) -> int:
        """Read the current sync nonce from OutcomeVoting."""
        if self._outcome_voting is None:
            return 0
        try:
            return await self._with_failover(
                lambda: self._outcome_voting.functions.syncNonce().call()  # type: ignore[union-attr]
            )
        except Exception as e:
            log.error("get_sync_nonce_failed", err=str(e))
            return 0

    async def propose_sync(self, new_validators: list[str], nonce: int) -> str:
        """Propose a new validator set on-chain via OutcomeVoting.proposeSync(). Returns tx hash."""
        if self._outcome_voting is None:
            raise RuntimeError("OutcomeVoting contract not configured")

        checksum_addrs = [self._w3.to_checksum_address(addr) for addr in new_validators]
        return await self._send_tx(
            self._outcome_voting, "proposeSync",
            checksum_addrs, nonce,
            gas_limit=500_000,
        )

    async def close(self) -> None:
        """Close the underlying HTTP provider session."""
        provider = self._w3.provider
        if hasattr(provider, "_request_session") and provider._request_session:
            session = provider._request_session
            try:
                close_coro = session.aclose() if hasattr(session, "aclose") else session.close()
                await asyncio.wait_for(close_coro, timeout=5.0)
            except TimeoutError:
                log.warning("chain_client_close_timeout")
            except Exception as e:
                log.warning("chain_client_close_error", err=str(e))

    async def is_connected(self) -> bool:
        """Check Base chain RPC connectivity (tries all endpoints)."""
        for _ in range(len(self._rpc_urls)):
            try:
                await self._w3.eth.block_number
                return True
            except _FAILOVER_ERRORS:
                if not self._rotate_rpc():
                    break
            except Exception as e:
                log.warning("rpc_connection_failed", err=str(e))
                return False
        return False

    @property
    def rpc_url(self) -> str:
        """Current active RPC URL."""
        return self._rpc_urls[self._rpc_index]

    @property
    def rpc_url_count(self) -> int:
        """Number of configured RPC endpoints."""
        return len(self._rpc_urls)
