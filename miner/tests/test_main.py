"""Tests for miner entry point functions (bt_sync_loop, run_server, async_main)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from djinn_miner.core.health import HealthTracker
from djinn_miner.main import async_main, bt_sync_loop


class TestBtSyncLoop:
    """Test the background Bittensor metagraph sync loop."""

    @pytest.mark.asyncio
    async def test_sync_loop_sets_bt_connected(self) -> None:
        """Successful sync sets bt_connected True."""
        neuron = MagicMock()
        neuron.is_registered.return_value = True
        neuron.uid = 42
        health = HealthTracker()

        call_count = 0

        def counting_sync():
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError()

        neuron.sync_metagraph = counting_sync
        with patch("djinn_miner.main.asyncio.sleep", new_callable=AsyncMock):
            await bt_sync_loop(neuron, health)
        assert health.get_status().bt_connected is True

    @pytest.mark.asyncio
    async def test_sync_loop_detects_deregistration(self) -> None:
        """When miner is deregistered, bt_connected goes False."""
        neuron = MagicMock()
        neuron.is_registered.return_value = False
        health = HealthTracker(bt_connected=True)

        call_count = 0

        def counting_sync():
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError()

        neuron.sync_metagraph = counting_sync
        with patch("djinn_miner.main.asyncio.sleep", new_callable=AsyncMock):
            await bt_sync_loop(neuron, health)
        assert health.get_status().bt_connected is False

    @pytest.mark.asyncio
    async def test_sync_loop_handles_errors_with_backoff(self) -> None:
        """Errors don't crash the loop; it backs off and retries."""
        neuron = MagicMock()
        health = HealthTracker()
        call_count = 0

        def error_then_cancel():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("network error")
            raise asyncio.CancelledError()

        neuron.sync_metagraph = error_then_cancel

        with patch("djinn_miner.main.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await bt_sync_loop(neuron, health)

        # Should have called sleep with backoff after error
        assert mock_sleep.called
        # First error: backoff = min(60 * 2^1, 600) = 120
        backoff_arg = mock_sleep.call_args_list[0][0][0]
        assert backoff_arg >= 60  # At least 60s backoff

    @pytest.mark.asyncio
    async def test_sync_loop_cancellation(self) -> None:
        """CancelledError exits the loop cleanly."""
        neuron = MagicMock()
        neuron.sync_metagraph.side_effect = asyncio.CancelledError()
        health = HealthTracker()

        with patch("djinn_miner.main.asyncio.sleep", new_callable=AsyncMock):
            await bt_sync_loop(neuron, health)  # Should not raise

    @pytest.mark.asyncio
    async def test_sync_loop_refreshes_uid(self) -> None:
        """UID is refreshed on successful sync when registered."""
        neuron = MagicMock()
        neuron.is_registered.return_value = True
        neuron.uid = 99
        health = HealthTracker(uid=42)

        call_count = 0

        def counting_sync():
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError()

        neuron.sync_metagraph = counting_sync
        with patch("djinn_miner.main.asyncio.sleep", new_callable=AsyncMock):
            await bt_sync_loop(neuron, health)
        assert health.get_status().uid == 99

    @pytest.mark.asyncio
    async def test_sync_loop_consecutive_errors_increase_backoff(self) -> None:
        """Multiple consecutive errors increase backoff up to the cap."""
        neuron = MagicMock()
        health = HealthTracker()
        call_count = 0

        def errors_then_cancel():
            nonlocal call_count
            call_count += 1
            if call_count <= 3:
                raise RuntimeError(f"error {call_count}")
            raise asyncio.CancelledError()

        neuron.sync_metagraph = errors_then_cancel

        with patch("djinn_miner.main.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await bt_sync_loop(neuron, health)

        # 3 errors → 3 backoff sleeps with jitter
        assert mock_sleep.call_count == 3
        backoffs = [c[0][0] for c in mock_sleep.call_args_list]
        # Each backoff should be within jitter range (50-150% of base)
        # Base values: 60*2^1=120, 60*2^2=240, 60*2^3=480
        assert 60 <= backoffs[0] <= 180   # 120 * [0.5, 1.5]
        assert 120 <= backoffs[1] <= 360  # 240 * [0.5, 1.5]
        assert 240 <= backoffs[2] <= 720  # 480 * [0.5, 1.5]
        # All within absolute cap (600 * 1.5 = 900 max with jitter)
        assert all(b <= 900 for b in backoffs)


class TestAsyncMainBtFailure:
    """Test that async_main exits on production when BT setup fails."""

    @pytest.mark.asyncio
    async def test_bt_failure_exits_on_finney(self) -> None:
        """On finney, a BT setup failure should raise SystemExit(1)."""
        mock_config = MagicMock()
        mock_config.bt_network = "finney"
        mock_config.validate.return_value = []
        mock_config.odds_api_key = "test"
        mock_config.odds_api_base_url = "https://api.test.com"
        mock_config.odds_cache_ttl = 30
        mock_config.line_tolerance = 0.5
        mock_config.api_host = "0.0.0.0"
        mock_config.api_port = 8422
        mock_config.bt_netuid = 103
        mock_config.bt_wallet_name = "default"
        mock_config.bt_wallet_hotkey = "default"
        mock_config.external_ip = ""
        mock_config.external_port = 0
        mock_config.http_timeout = 30
        mock_config.rate_limit_capacity = 30
        mock_config.rate_limit_rate = 5

        mock_neuron = MagicMock()
        mock_neuron.setup.return_value = False

        with (
            patch("djinn_miner.main.Config", return_value=mock_config),
            patch("djinn_miner.main.DjinnMiner", return_value=mock_neuron),
            patch("djinn_miner.main.OddsApiClient"),
            patch("djinn_miner.main.SessionCapture"),
            pytest.raises(SystemExit) as exc_info,
        ):
            await async_main()

        assert exc_info.value.code == 1

    @pytest.mark.asyncio
    async def test_bt_failure_exits_on_mainnet(self) -> None:
        """On mainnet, a BT setup failure should raise SystemExit(1)."""
        mock_config = MagicMock()
        mock_config.bt_network = "mainnet"
        mock_config.validate.return_value = []
        mock_config.odds_api_key = "test"
        mock_config.odds_api_base_url = "https://api.test.com"
        mock_config.odds_cache_ttl = 30
        mock_config.line_tolerance = 0.5
        mock_config.api_host = "0.0.0.0"
        mock_config.api_port = 8422
        mock_config.bt_netuid = 103
        mock_config.bt_wallet_name = "default"
        mock_config.bt_wallet_hotkey = "default"
        mock_config.external_ip = ""
        mock_config.external_port = 0
        mock_config.http_timeout = 30
        mock_config.rate_limit_capacity = 30
        mock_config.rate_limit_rate = 5

        mock_neuron = MagicMock()
        mock_neuron.setup.return_value = False

        with (
            patch("djinn_miner.main.Config", return_value=mock_config),
            patch("djinn_miner.main.DjinnMiner", return_value=mock_neuron),
            patch("djinn_miner.main.OddsApiClient"),
            patch("djinn_miner.main.SessionCapture"),
            pytest.raises(SystemExit) as exc_info,
        ):
            await async_main()

        assert exc_info.value.code == 1

    @pytest.mark.asyncio
    async def test_bt_failure_continues_on_test_network(self) -> None:
        """On test/local networks, BT failure should NOT exit."""
        mock_config = MagicMock()
        mock_config.bt_network = "test"
        mock_config.validate.return_value = []
        mock_config.odds_api_key = "test"
        mock_config.odds_api_base_url = "https://api.test.com"
        mock_config.odds_cache_ttl = 30
        mock_config.line_tolerance = 0.5
        mock_config.api_host = "0.0.0.0"
        mock_config.api_port = 8422
        mock_config.bt_netuid = 103
        mock_config.bt_wallet_name = "default"
        mock_config.bt_wallet_hotkey = "default"
        mock_config.external_ip = ""
        mock_config.external_port = 0
        mock_config.http_timeout = 30
        mock_config.rate_limit_capacity = 30
        mock_config.rate_limit_rate = 5

        mock_neuron = MagicMock()
        mock_neuron.setup.return_value = False

        shutdown_event = asyncio.Event()
        shutdown_event.set()

        with (
            patch("djinn_miner.main.Config", return_value=mock_config),
            patch("djinn_miner.main.DjinnMiner", return_value=mock_neuron),
            patch("djinn_miner.main.OddsApiClient"),
            patch("djinn_miner.main.SessionCapture"),
            patch("djinn_miner.main.create_app"),
            patch("djinn_miner.main.run_server", new_callable=AsyncMock),
            patch("djinn_miner.main.asyncio.Event", return_value=shutdown_event),
            patch("asyncio.get_running_loop") as mock_loop,
        ):
            mock_loop.return_value.add_signal_handler = MagicMock()
            await async_main()
