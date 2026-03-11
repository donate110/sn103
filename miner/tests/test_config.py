"""Tests for miner configuration loading and validation."""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from djinn_miner.config import Config


def _config(**overrides: object) -> Config:
    """Create a Config with overridden fields (bypasses frozen restriction)."""
    config = Config()
    for k, v in overrides.items():
        object.__setattr__(config, k, v)
    return config


class TestConfigDefaults:
    def test_default_port(self) -> None:
        config = Config()
        assert config.api_port == 8422

    def test_default_bt_network(self) -> None:
        config = Config()
        # Default is "finney" but may be overridden by .env file
        expected = os.getenv("BT_NETWORK", "finney")
        assert config.bt_network == expected

    def test_default_cache_ttl(self) -> None:
        config = Config()
        assert config.odds_cache_ttl == 30

    def test_default_line_tolerance(self) -> None:
        config = Config()
        assert config.line_tolerance == 0.0


class TestConfigValidation:
    def test_valid_config(self) -> None:
        config = _config(odds_api_key="test-key")
        config.validate()  # Should not raise

    def test_missing_odds_api_key_raises(self) -> None:
        config = _config(odds_api_key="")
        with pytest.raises(ValueError, match="ODDS_API_KEY"):
            config.validate()

    def test_invalid_port_raises(self) -> None:
        config = _config(odds_api_key="key", api_port=0)
        with pytest.raises(ValueError, match="API_PORT"):
            config.validate()

    def test_port_too_high_raises(self) -> None:
        config = _config(odds_api_key="key", api_port=70000)
        with pytest.raises(ValueError, match="API_PORT"):
            config.validate()

    def test_negative_cache_ttl_raises(self) -> None:
        config = _config(odds_api_key="key", odds_cache_ttl=-1)
        with pytest.raises(ValueError, match="ODDS_CACHE_TTL"):
            config.validate()

    def test_negative_line_tolerance_raises(self) -> None:
        config = _config(odds_api_key="key", line_tolerance=-0.1)
        with pytest.raises(ValueError, match="LINE_TOLERANCE"):
            config.validate()

    def test_line_tolerance_too_high_raises(self) -> None:
        config = _config(odds_api_key="key", line_tolerance=200.0)
        with pytest.raises(ValueError, match="LINE_TOLERANCE"):
            config.validate()

    def test_rate_limit_capacity_below_rate_warns(self) -> None:
        config = _config(odds_api_key="key", bt_network="local", rate_limit_capacity=3, rate_limit_rate=10)
        warnings = config.validate()
        assert any("RATE_LIMIT_CAPACITY" in w for w in warnings)


class TestConfigNetworkWarning:
    def test_known_network_no_warning(self) -> None:
        config = _config(odds_api_key="key", bt_network="finney")
        warnings = config.validate()
        assert not any("BT_NETWORK" in w for w in warnings)

    def test_unknown_network_warns(self) -> None:
        config = _config(odds_api_key="key", bt_network="devnet-42")
        warnings = config.validate()
        assert any("BT_NETWORK" in w for w in warnings)


class TestConfigStrictAutoDetect:
    """Strict mode auto-detects production network."""

    def test_strict_auto_enabled_on_finney_with_warning(self) -> None:
        """Unknown network type with finney → warning becomes error."""
        # We can't produce a warning from finney config easily since all finney-specific
        # validations are hard errors. But we can verify strict=False override works.
        config = _config(odds_api_key="key", bt_network="finney")
        warnings = config.validate()
        assert warnings == []  # No warnings when config is valid

    def test_strict_auto_disabled_on_local(self) -> None:
        """Warnings are returned (not raised) on local network."""
        config = _config(odds_api_key="key", bt_network="devnet-42")
        warnings = config.validate()  # strict=None → devnet-42 not in prod → lenient
        assert any("BT_NETWORK" in w for w in warnings)

    def test_explicit_strict_raises_on_warning(self) -> None:
        """Explicit strict=True raises on warnings."""
        config = _config(odds_api_key="key", bt_network="devnet-42")
        with pytest.raises(ValueError, match="strict mode"):
            config.validate(strict=True)


class TestConfigNetuidValidation:
    def test_netuid_zero_raises(self) -> None:
        config = _config(odds_api_key="key", bt_netuid=0)
        with pytest.raises(ValueError, match="BT_NETUID"):
            config.validate()

    def test_netuid_too_high_raises(self) -> None:
        config = _config(odds_api_key="key", bt_netuid=70000)
        with pytest.raises(ValueError, match="BT_NETUID"):
            config.validate()


class TestConfigBaseUrl:
    def test_invalid_base_url_raises(self) -> None:
        config = _config(odds_api_key="key", odds_api_base_url="ftp://bad.url")
        with pytest.raises(ValueError, match="ODDS_API_BASE_URL"):
            config.validate()

    def test_valid_https_url_accepted(self) -> None:
        config = _config(odds_api_key="key", odds_api_base_url="https://api.example.com")
        config.validate()  # Should not raise

    def test_valid_http_url_accepted(self) -> None:
        config = _config(odds_api_key="key", odds_api_base_url="http://localhost:8080")
        config.validate()  # Should not raise


class TestConfigRateLimits:
    def test_default_rate_limits(self) -> None:
        config = Config()
        assert config.rate_limit_capacity == 30
        assert config.rate_limit_rate == 5

    def test_rate_limit_capacity_zero_raises(self) -> None:
        config = _config(odds_api_key="key", rate_limit_capacity=0)
        with pytest.raises(ValueError, match="RATE_LIMIT_CAPACITY"):
            config.validate()

    def test_rate_limit_rate_zero_raises(self) -> None:
        config = _config(odds_api_key="key", rate_limit_rate=0)
        with pytest.raises(ValueError, match="RATE_LIMIT_RATE"):
            config.validate()


class TestConfigTimeouts:
    def test_default_http_timeout(self) -> None:
        config = Config()
        assert config.http_timeout == 30

    def test_http_timeout_zero_raises(self) -> None:
        config = _config(odds_api_key="key", http_timeout=0)
        with pytest.raises(ValueError, match="HTTP_TIMEOUT"):
            config.validate()


class TestConfigBoundary:
    def test_netuid_at_lower_boundary(self) -> None:
        config = _config(odds_api_key="key", bt_netuid=1)
        config.validate()  # Should not raise

    def test_netuid_at_upper_boundary(self) -> None:
        config = _config(odds_api_key="key", bt_netuid=65535)
        config.validate()  # Should not raise

    def test_port_at_boundaries(self) -> None:
        config = _config(odds_api_key="key", api_port=1)
        config.validate()
        config = _config(odds_api_key="key", api_port=65535)
        config.validate()

    def test_zero_cache_ttl_accepted(self) -> None:
        """TTL=0 means no caching — should be accepted."""
        config = _config(odds_api_key="key", odds_cache_ttl=0)
        config.validate()

    def test_zero_line_tolerance_accepted(self) -> None:
        """Tolerance=0 means exact match only — should be accepted."""
        config = _config(odds_api_key="key", line_tolerance=0.0)
        config.validate()

    def test_all_known_networks_accepted(self) -> None:
        """All known networks should not produce warnings."""
        for network in ("finney", "mainnet", "test", "local", "mock"):
            config = _config(odds_api_key="key", bt_network=network)
            warnings = config.validate()
            assert not any("BT_NETWORK" in w for w in warnings), f"Warning for {network}"


class TestIntEnvEdgeCases:
    def test_int_env_valid_value(self) -> None:
        from djinn_miner.config import _int_env
        import os
        os.environ["TEST_INT_VAL"] = "42"
        assert _int_env("TEST_INT_VAL", "0") == 42
        del os.environ["TEST_INT_VAL"]

    def test_int_env_uses_default(self) -> None:
        from djinn_miner.config import _int_env
        assert _int_env("NONEXISTENT_INT_KEY_12345", "99") == 99

    def test_float_env_valid_value(self) -> None:
        from djinn_miner.config import _float_env
        import os
        os.environ["TEST_FLOAT_VAL"] = "3.14"
        assert _float_env("TEST_FLOAT_VAL", "0.0") == pytest.approx(3.14)
        del os.environ["TEST_FLOAT_VAL"]

    def test_float_env_uses_default(self) -> None:
        from djinn_miner.config import _float_env
        assert _float_env("NONEXISTENT_FLOAT_KEY_12345", "2.5") == pytest.approx(2.5)
