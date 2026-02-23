"""Validator configuration loaded from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _int_env(key: str, default: str) -> int:
    val = os.getenv(key, default)
    try:
        return int(val)
    except (ValueError, TypeError, OverflowError):
        raise ValueError(f"Invalid integer for {key}: {val!r}")


def _float_env(key: str, default: str) -> float:
    val = os.getenv(key, default)
    try:
        return float(val)
    except (ValueError, TypeError, OverflowError):
        raise ValueError(f"Invalid float for {key}: {val!r}")


@dataclass(frozen=True)
class Config:
    _REDACTED_FIELDS = frozenset({"base_validator_private_key", "sports_api_key"})

    def __repr__(self) -> str:
        fields = []
        for f in self.__dataclass_fields__:
            val = getattr(self, f)
            if f in self._REDACTED_FIELDS and val:
                fields.append(f"{f}='***REDACTED***'")
            else:
                fields.append(f"{f}={val!r}")
        return f"Config({', '.join(fields)})"

    # Bittensor
    bt_netuid: int = _int_env("BT_NETUID", "103")
    bt_network: str = os.getenv("BT_NETWORK", "finney")
    bt_wallet_name: str = os.getenv("BT_WALLET_NAME", "default")
    bt_wallet_hotkey: str = os.getenv("BT_WALLET_HOTKEY", "default")
    bt_burn_fraction: float = _float_env("BT_BURN_FRACTION", "0.95")

    # Base chain (comma-separated URLs for failover)
    base_rpc_url: str = os.getenv("BASE_RPC_URL", "https://mainnet.base.org")
    base_chain_id: int = _int_env("BASE_CHAIN_ID", "8453")

    @property
    def base_rpc_urls(self) -> list[str]:
        """Parse comma-separated RPC URLs for failover support."""
        return [u.strip() for u in self.base_rpc_url.split(",") if u.strip()]

    # Validator Base chain private key (for signing outcome settlement txs)
    base_validator_private_key: str = os.getenv("BASE_VALIDATOR_PRIVATE_KEY", "")

    # Contract addresses
    escrow_address: str = os.getenv("ESCROW_ADDRESS", "")
    signal_commitment_address: str = os.getenv("SIGNAL_COMMITMENT_ADDRESS", "")
    account_address: str = os.getenv("ACCOUNT_ADDRESS", "")
    collateral_address: str = os.getenv("COLLATERAL_ADDRESS", "")
    outcome_voting_address: str = os.getenv("OUTCOME_VOTING_ADDRESS", "")

    # Validator API
    api_host: str = os.getenv("API_HOST", "0.0.0.0")
    api_port: int = _int_env("API_PORT", "8421")

    # External address for metagraph discovery (set when behind NAT/proxy)
    external_ip: str = os.getenv("EXTERNAL_IP", "")
    external_port: int = _int_env("EXTERNAL_PORT", "0")

    # Sports data
    sports_api_key: str = os.getenv("SPORTS_API_KEY", "")

    # Timeouts (seconds)
    http_timeout: int = _int_env("HTTP_TIMEOUT", "30")
    rpc_timeout: int = _int_env("RPC_TIMEOUT", "30")

    # Rate limits (configurable without redeploy)
    rate_limit_capacity: int = _int_env("RATE_LIMIT_CAPACITY", "60")
    rate_limit_rate: int = _int_env("RATE_LIMIT_RATE", "10")

    # MPC
    mpc_peer_timeout: float = _float_env("MPC_PEER_TIMEOUT", "10.0")
    mpc_availability_timeout: float = _float_env("MPC_AVAILABILITY_TIMEOUT", "15.0")

    # Attestation burn gate
    attest_burn_amount: float = _float_env("ATTEST_BURN_AMOUNT", "0.0001")
    attest_burn_address: str = os.getenv(
        "ATTEST_BURN_ADDRESS",
        "5GrsjiBeCErhUGj339vu5GubTgyJMyZLGQqUFBJAtKrCziU9",  # Djinn-specific burn wallet (seed discarded)
    )

    # Data directory for SQLite databases (shares, burns, purchases)
    data_dir: str = os.getenv("DATA_DIR", "data")

    # Protocol constants
    signals_per_cycle: int = 10
    shares_total: int = 10
    shares_threshold: int = _int_env("SHAMIR_THRESHOLD", "7")
    mpc_quorum: float = 2 / 3
    protocol_fee_bps: int = 50
    odds_precision: int = 1_000_000
    bps_denom: int = 10_000

    def validate(self, *, strict: bool | None = None) -> list[str]:
        """Validate config at startup. Returns list of warnings (empty = all good).

        Args:
            strict: If True, raise ValueError on any warning. Defaults to True
                    when bt_network is a production network (finney/mainnet).
        """
        if strict is None:
            strict = self.bt_network in ("finney", "mainnet")
        import re

        warnings = []
        if not (0.0 <= self.bt_burn_fraction <= 1.0):
            raise ValueError(f"BT_BURN_FRACTION must be 0.0-1.0, got {self.bt_burn_fraction}")
        if not (1 <= self.bt_netuid <= 65535):
            raise ValueError(f"BT_NETUID must be 1-65535, got {self.bt_netuid}")
        if self.api_port < 1 or self.api_port > 65535:
            raise ValueError(f"API_PORT must be 1-65535, got {self.api_port}")
        is_production = self.bt_network in ("finney", "mainnet")
        if self.sports_api_key:
            warnings.append(
                "SPORTS_API_KEY is set but no longer used — "
                "validator now uses ESPN's free public API for scores"
            )
        contract_names = ("escrow_address", "signal_commitment_address", "account_address", "collateral_address", "outcome_voting_address")
        if is_production:
            for name in contract_names:
                addr = getattr(self, name)
                if not addr:
                    raise ValueError(f"{name.upper()} must be set in production")
                elif not re.match(r"^0x[0-9a-fA-F]{40}$", addr):
                    raise ValueError(f"{name.upper()} is not a valid Ethereum address: {addr!r}")
        elif self.bt_network not in ("finney", "mainnet"):
            for name in contract_names:
                addr = getattr(self, name)
                if addr and not re.match(r"^0x[0-9a-fA-F]{40}$", addr):
                    raise ValueError(f"{name.upper()} is not a valid Ethereum address: {addr!r}")
        if not self.base_validator_private_key:
            if is_production:
                raise ValueError("BASE_VALIDATOR_PRIVATE_KEY must be set in production — outcome settlement requires it")
            warnings.append("BASE_VALIDATOR_PRIVATE_KEY not set — on-chain outcome settlement disabled")
        elif not re.match(r"^(0x)?[0-9a-fA-F]{64}$", self.base_validator_private_key):
            raise ValueError("BASE_VALIDATOR_PRIVATE_KEY must be a 32-byte hex string (with optional 0x prefix)")
        known_networks = ("finney", "mainnet", "test", "local", "mock")
        if self.bt_network not in known_networks:
            warnings.append(f"BT_NETWORK={self.bt_network!r} is not a recognized network ({', '.join(known_networks)})")
        if self.http_timeout < 1:
            raise ValueError(f"HTTP_TIMEOUT must be >= 1, got {self.http_timeout}")
        if self.rpc_timeout < 1:
            raise ValueError(f"RPC_TIMEOUT must be >= 1, got {self.rpc_timeout}")
        if self.base_chain_id not in (8453, 84532, 31337):
            warnings.append(
                f"BASE_CHAIN_ID={self.base_chain_id} is non-standard "
                "(expected 8453=mainnet, 84532=sepolia, 31337=localhost)"
            )
        if self.rate_limit_capacity < 1:
            raise ValueError(f"RATE_LIMIT_CAPACITY must be >= 1, got {self.rate_limit_capacity}")
        if self.rate_limit_rate < 1:
            raise ValueError(f"RATE_LIMIT_RATE must be >= 1, got {self.rate_limit_rate}")
        if self.mpc_peer_timeout < 1.0 or self.mpc_peer_timeout > 60.0:
            raise ValueError(f"MPC_PEER_TIMEOUT must be 1.0-60.0, got {self.mpc_peer_timeout}")
        if self.mpc_availability_timeout < 5.0 or self.mpc_availability_timeout > 120.0:
            raise ValueError(f"MPC_AVAILABILITY_TIMEOUT must be 5.0-120.0, got {self.mpc_availability_timeout}")
        if self.shares_threshold > self.shares_total:
            raise ValueError(
                f"SHAMIR_THRESHOLD ({self.shares_threshold}) must be <= shares_total ({self.shares_total})"
            )
        if self.shares_threshold < 1:
            raise ValueError(f"SHAMIR_THRESHOLD must be >= 1, got {self.shares_threshold}")
        if is_production and self.shares_threshold < 3:
            raise ValueError(
                f"SHAMIR_THRESHOLD must be >= 3 in production for meaningful secret sharing, "
                f"got {self.shares_threshold}"
            )
        if self.rate_limit_capacity < self.rate_limit_rate:
            warnings.append(
                f"RATE_LIMIT_CAPACITY ({self.rate_limit_capacity}) < RATE_LIMIT_RATE ({self.rate_limit_rate}) "
                "— bucket will never fill above rate"
            )
        if strict and warnings:
            raise ValueError("Config validation failed in strict mode:\n" + "\n".join(f"  - {w}" for w in warnings))
        return warnings
