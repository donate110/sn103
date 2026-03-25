"""Tests for miner entry point functions (bt_sync_loop, run_server, async_main)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from djinn_miner.core.health import HealthTracker
from djinn_miner.main import bt_sync_loop


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
        # Reconnect should fail so the 3rd error still hits the backoff path
        neuron.reconnect_subtensor.return_value = False
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


class TestBtSyncLoopReconnect:
    """Test the reconnection logic in bt_sync_loop."""

    @pytest.mark.asyncio
    async def test_reconnect_success_resets_error_count(self) -> None:
        """When reconnect succeeds after 3 errors, consecutive count resets."""
        neuron = MagicMock()
        neuron.reconnect_subtensor.return_value = True
        health = HealthTracker()
        call_count = 0

        def errors_then_succeed_then_cancel():
            nonlocal call_count
            call_count += 1
            if call_count <= 3:
                raise RuntimeError(f"error {call_count}")
            if call_count == 4:
                # After reconnect, the next sync succeeds
                neuron.is_registered.return_value = True
                neuron.uid = 99
                return
            raise asyncio.CancelledError()

        neuron.sync_metagraph = errors_then_succeed_then_cancel
        neuron.is_registered.return_value = True
        neuron.uid = 99

        with patch("djinn_miner.main.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await bt_sync_loop(neuron, health)

        # 2 sleeps (errors 1+2), then error 3 triggers reconnect which
        # succeeds and continues without sleeping
        assert mock_sleep.call_count == 3  # 2 error backoffs + 1 normal 60s sleep
        neuron.reconnect_subtensor.assert_called_once()

    @pytest.mark.asyncio
    async def test_reconnect_failure_continues_backoff(self) -> None:
        """When reconnect fails, errors keep accumulating and backoff continues."""
        neuron = MagicMock()
        neuron.reconnect_subtensor.return_value = False
        health = HealthTracker()
        call_count = 0

        def four_errors_then_cancel():
            nonlocal call_count
            call_count += 1
            if call_count <= 4:
                raise RuntimeError(f"error {call_count}")
            raise asyncio.CancelledError()

        neuron.sync_metagraph = four_errors_then_cancel

        with patch("djinn_miner.main.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await bt_sync_loop(neuron, health)

        # 4 errors, all hit the backoff path (reconnect fails on error 3)
        assert mock_sleep.call_count == 4
        neuron.reconnect_subtensor.assert_called_once()
