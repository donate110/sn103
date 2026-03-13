"""Tests for validator configuration loading and validation."""

from __future__ import annotations

import dataclasses
import os

import pytest

from djinn_validator.config import Config, _float_env


def _config(**overrides: object) -> Config:
    """Create a Config with overridden fields (bypasses frozen restriction)."""
    config = Config()
    for k, v in overrides.items():
        object.__setattr__(config, k, v)
    return config


class TestConfigDefaults:
    def test_default_port(self) -> None:
        config = Config()
        assert config.api_port == 8421

    def test_default_bt_network(self) -> None:
        config = Config()
        # conftest sets BT_NETWORK=test; verify Config reads from env
        expected = os.environ.get("BT_NETWORK", "finney")
        assert config.bt_network == expected

    def test_default_protocol_constants(self) -> None:
        config = Config()
        assert config.shares_total == 10
        assert config.shares_threshold == 7
        assert config.protocol_fee_bps == 50
        assert config.bps_denom == 10_000


class TestConfigValidation:
    def test_valid_config_no_warnings(self) -> None:
        config = _config(
            bt_network="local",
            sports_api_key="",
            base_validator_private_key="0x" + "ab" * 32,
        )
        warnings = config.validate()
        assert len(warnings) == 0

    def test_sports_api_key_set_warns_deprecated(self) -> None:
        config = _config(bt_network="local", sports_api_key="old-key")
        warnings = config.validate()
        assert any("no longer used" in w for w in warnings)

    def test_no_sports_api_key_no_warning(self) -> None:
        config = _config(bt_network="local", sports_api_key="")
        warnings = config.validate()
        assert not any("SPORTS_API_KEY" in w for w in warnings)

    def test_production_no_sports_api_key_ok(self) -> None:
        """Production no longer requires SPORTS_API_KEY."""
        config = _config(
            bt_network="finney",
            sports_api_key="",
            escrow_address="0x1234567890abcdef1234567890abcdef12345678",
            signal_commitment_address="0x1234567890abcdef1234567890abcdef12345678",
            account_address="0x1234567890abcdef1234567890abcdef12345678",
            collateral_address="0x1234567890abcdef1234567890abcdef12345678",
            outcome_voting_address="0x1234567890abcdef1234567890abcdef12345678",
            base_validator_private_key="0x" + "ab" * 32,
        )
        warnings = config.validate()
        assert not any("SPORTS_API_KEY" in w for w in warnings)

    def test_mainnet_missing_addresses_raises(self) -> None:
        config = _config(
            bt_network="finney",
            sports_api_key="",
            escrow_address="",
            signal_commitment_address="",
            account_address="",
            collateral_address="",
        )
        with pytest.raises(ValueError, match="must be set in production"):
            config.validate()

    def test_local_network_no_address_warnings(self) -> None:
        config = _config(
            bt_network="local",
            sports_api_key="",
            escrow_address="",
            base_validator_private_key="0x" + "ab" * 32,
        )
        warnings = config.validate()
        assert len(warnings) == 0

    def test_invalid_port_zero_raises(self) -> None:
        config = _config(api_port=0)
        with pytest.raises(ValueError, match="API_PORT"):
            config.validate()

    def test_invalid_port_too_high_raises(self) -> None:
        config = _config(api_port=70000)
        with pytest.raises(ValueError, match="API_PORT"):
            config.validate()


class TestConfigNetworkWarning:
    def test_known_network_no_warning(self) -> None:
        config = _config(bt_network="finney", sports_api_key="",
                         escrow_address="0x1234567890abcdef1234567890abcdef12345678",
                         signal_commitment_address="0x1234567890abcdef1234567890abcdef12345678",
                         account_address="0x1234567890abcdef1234567890abcdef12345678",
                         collateral_address="0x1234567890abcdef1234567890abcdef12345678",
                         outcome_voting_address="0x1234567890abcdef1234567890abcdef12345678",
                         base_validator_private_key="0x" + "ab" * 32)
        warnings = config.validate()
        assert not any("BT_NETWORK" in w for w in warnings)

    def test_unknown_network_warns(self) -> None:
        config = _config(bt_network="devnet-42", sports_api_key="")
        warnings = config.validate()
        assert any("BT_NETWORK" in w for w in warnings)


class TestConfigStrictAutoDetect:
    """Strict mode auto-detects production network."""

    def test_strict_auto_enabled_on_finney(self) -> None:
        """Warnings become errors on finney when strict is unset."""
        config = _config(
            bt_network="finney",
            sports_api_key="",
            escrow_address="0x1234567890abcdef1234567890abcdef12345678",
            signal_commitment_address="0x1234567890abcdef1234567890abcdef12345678",
            account_address="0x1234567890abcdef1234567890abcdef12345678",
            collateral_address="0x1234567890abcdef1234567890abcdef12345678",
            outcome_voting_address="0x1234567890abcdef1234567890abcdef12345678",
            base_validator_private_key="0x" + "ab" * 32,
            base_chain_id=99999,  # Non-standard → generates a warning
        )
        with pytest.raises(ValueError, match="strict mode"):
            config.validate()  # strict=None → auto-detects finney → strict

    def test_strict_auto_disabled_on_local(self) -> None:
        """Warnings are returned (not raised) on local network."""
        config = _config(
            bt_network="local",
            sports_api_key="",
            base_chain_id=99999,
        )
        warnings = config.validate()  # strict=None → auto-detects local → lenient
        assert any("BASE_CHAIN_ID" in w for w in warnings)

    def test_explicit_strict_false_overrides_auto(self) -> None:
        """Explicit strict=False overrides auto-detect even on finney."""
        config = _config(
            bt_network="finney",
            sports_api_key="",
            escrow_address="0x1234567890abcdef1234567890abcdef12345678",
            signal_commitment_address="0x1234567890abcdef1234567890abcdef12345678",
            account_address="0x1234567890abcdef1234567890abcdef12345678",
            collateral_address="0x1234567890abcdef1234567890abcdef12345678",
            outcome_voting_address="0x1234567890abcdef1234567890abcdef12345678",
            base_validator_private_key="0x" + "ab" * 32,
            base_chain_id=99999,
        )
        warnings = config.validate(strict=False)
        assert any("BASE_CHAIN_ID" in w for w in warnings)


class TestConfigTimeouts:
    def test_default_http_timeout(self) -> None:
        config = Config()
        assert config.http_timeout == 30

    def test_default_rpc_timeout(self) -> None:
        config = Config()
        assert config.rpc_timeout == 30

    def test_http_timeout_zero_raises(self) -> None:
        config = _config(bt_network="local", sports_api_key="", http_timeout=0)
        with pytest.raises(ValueError, match="HTTP_TIMEOUT"):
            config.validate()

    def test_rpc_timeout_zero_raises(self) -> None:
        config = _config(bt_network="local", sports_api_key="", rpc_timeout=0)
        with pytest.raises(ValueError, match="RPC_TIMEOUT"):
            config.validate()


class TestConfigNetuidValidation:
    def test_netuid_zero_raises(self) -> None:
        config = _config(bt_netuid=0, bt_network="local", sports_api_key="")
        with pytest.raises(ValueError, match="BT_NETUID"):
            config.validate()

    def test_netuid_too_high_raises(self) -> None:
        config = _config(bt_netuid=70000, bt_network="local", sports_api_key="")
        with pytest.raises(ValueError, match="BT_NETUID"):
            config.validate()

    def test_netuid_valid(self) -> None:
        config = _config(bt_netuid=103, bt_network="local", sports_api_key="")
        warnings = config.validate()
        assert not any("BT_NETUID" in w for w in warnings)


class TestConfigChainId:
    def test_standard_chain_id_no_warning(self) -> None:
        config = _config(bt_network="local", sports_api_key="", base_chain_id=8453)
        warnings = config.validate()
        assert not any("BASE_CHAIN_ID" in w for w in warnings)

    def test_localhost_chain_id_no_warning(self) -> None:
        config = _config(bt_network="local", sports_api_key="", base_chain_id=31337)
        warnings = config.validate()
        assert not any("BASE_CHAIN_ID" in w for w in warnings)

    def test_nonstandard_chain_id_warns(self) -> None:
        config = _config(bt_network="local", sports_api_key="", base_chain_id=999)
        warnings = config.validate()
        assert any("BASE_CHAIN_ID" in w for w in warnings)


class TestConfigRateLimits:
    def test_default_rate_limits(self) -> None:
        config = Config()
        assert config.rate_limit_capacity == 60
        assert config.rate_limit_rate == 10

    def test_rate_limit_capacity_zero_raises(self) -> None:
        config = _config(bt_network="local", sports_api_key="", rate_limit_capacity=0)
        with pytest.raises(ValueError, match="RATE_LIMIT_CAPACITY"):
            config.validate()

    def test_rate_limit_rate_zero_raises(self) -> None:
        config = _config(bt_network="local", sports_api_key="", rate_limit_rate=0)
        with pytest.raises(ValueError, match="RATE_LIMIT_RATE"):
            config.validate()


class TestConfigMPCPeerTimeout:
    def test_default_mpc_peer_timeout(self) -> None:
        config = Config()
        assert config.mpc_peer_timeout == 10.0

    def test_mpc_peer_timeout_too_low_raises(self) -> None:
        config = _config(bt_network="local", sports_api_key="", mpc_peer_timeout=0.5)
        with pytest.raises(ValueError, match="MPC_PEER_TIMEOUT"):
            config.validate()

    def test_mpc_peer_timeout_too_high_raises(self) -> None:
        config = _config(bt_network="local", sports_api_key="", mpc_peer_timeout=120.0)
        with pytest.raises(ValueError, match="MPC_PEER_TIMEOUT"):
            config.validate()

    def test_rate_limit_capacity_below_rate_warns(self) -> None:
        config = _config(
            bt_network="local", sports_api_key="",
            rate_limit_capacity=5, rate_limit_rate=10,
        )
        warnings = config.validate()
        assert any("RATE_LIMIT_CAPACITY" in w for w in warnings)


class TestConfigAddressValidation:
    def test_valid_address_accepted(self) -> None:
        config = _config(
            bt_network="finney",
            sports_api_key="",
            escrow_address="0x1234567890abcdef1234567890abcdef12345678",
            signal_commitment_address="0x1234567890abcdef1234567890abcdef12345678",
            account_address="0x1234567890abcdef1234567890abcdef12345678",
            collateral_address="0x1234567890abcdef1234567890abcdef12345678",
            outcome_voting_address="0x1234567890abcdef1234567890abcdef12345678",
            base_validator_private_key="0x" + "ab" * 32,
        )
        warnings = config.validate()
        assert not any("not a valid" in w for w in warnings)

    def test_invalid_address_format_raises(self) -> None:
        config = _config(
            bt_network="finney",
            sports_api_key="",
            escrow_address="not-an-address",
            signal_commitment_address="0x1234567890abcdef1234567890abcdef12345678",
            account_address="0x1234567890abcdef1234567890abcdef12345678",
            collateral_address="0x1234567890abcdef1234567890abcdef12345678",
        )
        with pytest.raises(ValueError, match="not a valid Ethereum address"):
            config.validate()

    def test_short_address_raises(self) -> None:
        config = _config(
            bt_network="finney",
            sports_api_key="",
            escrow_address="0x1234",
            signal_commitment_address="0x1234567890abcdef1234567890abcdef12345678",
            account_address="0x1234567890abcdef1234567890abcdef12345678",
            collateral_address="0x1234567890abcdef1234567890abcdef12345678",
        )
        with pytest.raises(ValueError, match="not a valid Ethereum address"):
            config.validate()

    def test_invalid_address_in_dev_mode_raises(self) -> None:
        config = _config(
            bt_network="local",
            sports_api_key="",
            escrow_address="not-an-address",
        )
        with pytest.raises(ValueError, match="not a valid Ethereum address"):
            config.validate()


class TestFloatEnv:
    def test_float_env_valid(self) -> None:
        import os
        os.environ["_TEST_FLOAT"] = "3.14"
        assert _float_env("_TEST_FLOAT", "1.0") == 3.14
        del os.environ["_TEST_FLOAT"]

    def test_float_env_default(self) -> None:
        assert _float_env("_TEST_FLOAT_MISSING", "2.5") == 2.5

    def test_float_env_malformed_raises(self) -> None:
        import os
        os.environ["_TEST_FLOAT_BAD"] = "not-a-number"
        with pytest.raises(ValueError, match="Invalid float"):
            _float_env("_TEST_FLOAT_BAD", "1.0")
        del os.environ["_TEST_FLOAT_BAD"]


class TestMpcAvailabilityTimeout:
    def test_default_value(self) -> None:
        config = Config()
        assert config.mpc_availability_timeout == 90.0

    def test_too_low_raises(self) -> None:
        config = _config(sports_api_key="", bt_network="local", mpc_availability_timeout=2.0)
        with pytest.raises(ValueError, match="MPC_AVAILABILITY_TIMEOUT"):
            config.validate()

    def test_too_high_raises(self) -> None:
        config = _config(sports_api_key="", bt_network="local", mpc_availability_timeout=200.0)
        with pytest.raises(ValueError, match="MPC_AVAILABILITY_TIMEOUT"):
            config.validate()

    def test_valid_range_accepted(self) -> None:
        config = _config(sports_api_key="", bt_network="local", mpc_availability_timeout=30.0)
        config.validate()


class TestShamirThresholdProduction:
    """Production requires SHAMIR_THRESHOLD >= 3 for meaningful security."""

    def _prod_config(self, **overrides: object) -> Config:
        defaults = dict(
            bt_network="finney",
            sports_api_key="",
            escrow_address="0x1234567890abcdef1234567890abcdef12345678",
            signal_commitment_address="0x1234567890abcdef1234567890abcdef12345678",
            account_address="0x1234567890abcdef1234567890abcdef12345678",
            collateral_address="0x1234567890abcdef1234567890abcdef12345678",
            outcome_voting_address="0x1234567890abcdef1234567890abcdef12345678",
            base_validator_private_key="0x" + "ab" * 32,
        )
        defaults.update(overrides)
        return _config(**defaults)

    def test_threshold_1_raises_in_production(self) -> None:
        config = self._prod_config(shares_threshold=1)
        with pytest.raises(ValueError, match="SHAMIR_THRESHOLD must be >= 3 in production"):
            config.validate()

    def test_threshold_2_raises_in_production(self) -> None:
        config = self._prod_config(shares_threshold=2)
        with pytest.raises(ValueError, match="SHAMIR_THRESHOLD must be >= 3 in production"):
            config.validate()

    def test_threshold_3_passes_in_production(self) -> None:
        config = self._prod_config(shares_threshold=3)
        warnings = config.validate()
        assert not any("SHAMIR_THRESHOLD" in w for w in warnings)

    def test_threshold_7_passes_in_production(self) -> None:
        config = self._prod_config(shares_threshold=7)
        warnings = config.validate()
        assert not any("SHAMIR_THRESHOLD" in w for w in warnings)

    def test_threshold_1_allowed_in_dev(self) -> None:
        config = _config(bt_network="local", sports_api_key="", shares_threshold=1)
        warnings = config.validate()
        assert not any("SHAMIR_THRESHOLD" in w for w in warnings)


class TestBaseRpcUrls:
    def test_single_url(self) -> None:
        config = _config(base_rpc_url="https://mainnet.base.org")
        assert config.base_rpc_urls == ["https://mainnet.base.org"]

    def test_multiple_urls(self) -> None:
        config = _config(base_rpc_url="https://rpc1.base.org, https://rpc2.base.org")
        assert config.base_rpc_urls == ["https://rpc1.base.org", "https://rpc2.base.org"]

    def test_empty_segments_stripped(self) -> None:
        config = _config(base_rpc_url="https://rpc1.base.org,,, https://rpc2.base.org,")
        assert config.base_rpc_urls == ["https://rpc1.base.org", "https://rpc2.base.org"]
