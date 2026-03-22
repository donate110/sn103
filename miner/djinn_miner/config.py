"""Miner configuration loaded from environment variables."""

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
    # Bittensor
    bt_netuid: int = _int_env("BT_NETUID", "103")
    bt_network: str = os.getenv("BT_NETWORK", "finney")
    bt_wallet_name: str = os.getenv("BT_WALLET_NAME", "default")
    bt_wallet_hotkey: str = os.getenv("BT_WALLET_HOTKEY", "default")

    # Miner API
    api_host: str = os.getenv("API_HOST", "0.0.0.0")
    api_port: int = _int_env("API_PORT", "8422")

    # External address for metagraph discovery (set when behind NAT/proxy)
    external_ip: str = os.getenv("EXTERNAL_IP", "")
    external_port: int = _int_env("EXTERNAL_PORT", "0")

    # Sports data provider: "odds_api" (default) or a custom module path
    # e.g. "my_provider.MyClient" for a custom SportsDataProvider implementation
    sports_data_provider: str = os.getenv("SPORTS_DATA_PROVIDER", "odds_api")

    # The Odds API (only required when sports_data_provider = "odds_api")
    odds_api_key: str = os.getenv("ODDS_API_KEY", "")
    odds_api_base_url: str = os.getenv("ODDS_API_BASE_URL", "https://api.the-odds-api.com")

    # Cache TTL in seconds
    odds_cache_ttl: int = _int_env("ODDS_CACHE_TTL", "30")

    # Line matching tolerance: how close a sportsbook line must be to match.
    # Default 0.0 = exact match only. A signal's line must exist at the exact
    # value at a sportsbook for verification to pass.
    line_tolerance: float = _float_env("LINE_TOLERANCE", "0.0")

    # Timeouts (seconds)
    http_timeout: int = _int_env("HTTP_TIMEOUT", "30")

    # Rate limits
    rate_limit_capacity: int = _int_env("RATE_LIMIT_CAPACITY", "30")
    rate_limit_rate: int = _int_env("RATE_LIMIT_RATE", "5")

    def validate(self, *, strict: bool | None = None) -> list[str]:
        """Validate config at startup. Raises ValueError on hard errors, returns warnings.

        Args:
            strict: If True, raise ValueError on any warning. Defaults to True
                    when bt_network is a production network (finney/mainnet).
        """
        if strict is None:
            strict = self.bt_network in ("finney", "mainnet")
        warnings: list[str] = []
        if self.sports_data_provider == "odds_api" and not self.odds_api_key:
            raise ValueError("ODDS_API_KEY is required when using the default odds_api provider. Get one at https://the-odds-api.com")
        if not (1 <= self.bt_netuid <= 65535):
            raise ValueError(f"BT_NETUID must be 1-65535, got {self.bt_netuid}")
        if not self.odds_api_base_url.startswith(("http://", "https://")):
            raise ValueError(f"ODDS_API_BASE_URL must start with http:// or https://, got {self.odds_api_base_url!r}")
        known_networks = ("finney", "mainnet", "test", "local", "mock")
        if self.bt_network not in known_networks:
            warnings.append(f"BT_NETWORK={self.bt_network!r} is not a recognized network ({', '.join(known_networks)})")
        if self.api_port < 1 or self.api_port > 65535:
            raise ValueError(f"API_PORT must be 1-65535, got {self.api_port}")
        if self.odds_cache_ttl < 0:
            raise ValueError(f"ODDS_CACHE_TTL must be >= 0, got {self.odds_cache_ttl}")
        if self.line_tolerance < 0 or self.line_tolerance > 100.0:
            raise ValueError(f"LINE_TOLERANCE must be 0-100.0, got {self.line_tolerance}")
        if self.http_timeout < 1:
            raise ValueError(f"HTTP_TIMEOUT must be >= 1, got {self.http_timeout}")
        if self.rate_limit_capacity < 1:
            raise ValueError(f"RATE_LIMIT_CAPACITY must be >= 1, got {self.rate_limit_capacity}")
        if self.rate_limit_rate < 1:
            raise ValueError(f"RATE_LIMIT_RATE must be >= 1, got {self.rate_limit_rate}")
        if self.rate_limit_capacity < self.rate_limit_rate:
            warnings.append(
                f"RATE_LIMIT_CAPACITY ({self.rate_limit_capacity}) < RATE_LIMIT_RATE ({self.rate_limit_rate}) "
                "— bucket will never fill above rate"
            )
        if strict and warnings:
            raise ValueError("Config validation failed in strict mode:\n" + "\n".join(f"  - {w}" for w in warnings))
        return warnings
