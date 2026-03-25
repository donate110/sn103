"""Tests for validator entry point functions (epoch_loop, mpc_cleanup_loop)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from djinn_validator.core.outcomes import OutcomeAttestor
from djinn_validator.core.scoring import MinerScorer
from djinn_validator.core.shares import ShareStore
from djinn_validator.core.mpc_coordinator import MPCCoordinator
from djinn_validator.main import async_main, epoch_loop, mpc_cleanup_loop


@pytest.fixture
def mock_neuron() -> MagicMock:
    neuron = MagicMock()
    neuron.wallet = MagicMock()
    neuron.wallet.hotkey.ss58_address = "5FakeKey"
    neuron.get_miner_uids.return_value = [1, 2]
    neuron.get_axon_info.side_effect = lambda uid: {"hotkey": f"key-{uid}"}
    neuron.should_set_weights.return_value = False
    return neuron


@pytest.fixture
def mock_share_store(tmp_path):
    store = ShareStore(db_path=str(tmp_path / "test.db"))
    yield store
    store.close()


@pytest.fixture
def mock_scorer() -> MinerScorer:
    return MinerScorer()


@pytest.fixture
def mock_outcome_attestor() -> AsyncMock:
    attestor = AsyncMock(spec=OutcomeAttestor)
    attestor.resolve_all_pending.return_value = []
    attestor.cleanup_resolved.return_value = None
    return attestor


@pytest.fixture(autouse=True)
def _patch_sleep():
    """Prevent real sleeps in all epoch loop tests."""
    with patch("djinn_validator.main.asyncio.sleep", new_callable=AsyncMock):
        yield


class TestEpochLoop:
    """Test the validator's main epoch loop."""

    @pytest.mark.asyncio
    async def test_epoch_loop_runs_one_cycle(
        self,
        mock_neuron: MagicMock,
        mock_scorer: MinerScorer,
        mock_share_store: ShareStore,
        mock_outcome_attestor: AsyncMock,
    ) -> None:
        """One successful epoch cycle: sync, health check, resolve, score."""
        call_count = 0

        def counting_sync(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError()

        mock_neuron.sync_metagraph = counting_sync

        await epoch_loop(mock_neuron, mock_scorer, mock_share_store, mock_outcome_attestor)

        # Outcome attestor was called
        mock_outcome_attestor.resolve_all_pending.assert_called_once()
        mock_outcome_attestor.cleanup_resolved.assert_called_once()

    @pytest.mark.asyncio
    async def test_epoch_loop_health_checks_miners(
        self,
        mock_neuron: MagicMock,
        mock_scorer: MinerScorer,
        mock_share_store: ShareStore,
        mock_outcome_attestor: AsyncMock,
    ) -> None:
        """Each miner gets a health check recorded (and consecutive_epochs incremented)."""
        call_count = 0

        def counting_sync(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError()

        mock_neuron.sync_metagraph = counting_sync

        # Provide ip/port so health checks actually attempt HTTP requests.
        # Use a public IP (not 127.0.0.1) because _is_public_ip rejects non-global addresses.
        mock_neuron.get_axon_info.side_effect = lambda uid: {
            "hotkey": f"key-{uid}",
            "ip": "8.8.8.8",
            "port": 9999,
        }

        # Mock httpx.AsyncClient so the health check returns 200
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_client = AsyncMock()
        mock_client.get.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("djinn_validator.main.httpx.AsyncClient", return_value=mock_client):
            await epoch_loop(mock_neuron, mock_scorer, mock_share_store, mock_outcome_attestor)

        # Miners should exist in scorer (created during health check)
        m1 = mock_scorer.get_or_create(1, "key-1")
        m2 = mock_scorer.get_or_create(2, "key-2")
        # Health checks were recorded (metrics accumulate until weights are set)
        assert m1.health_checks_responded >= 1
        assert m2.health_checks_responded >= 1

    @pytest.mark.asyncio
    async def test_epoch_loop_sets_weights_when_due(
        self,
        mock_neuron: MagicMock,
        mock_scorer: MinerScorer,
        mock_share_store: ShareStore,
        mock_outcome_attestor: AsyncMock,
    ) -> None:
        """Weights are set when should_set_weights() returns True."""
        mock_neuron.should_set_weights.return_value = True
        mock_neuron.set_weights.return_value = True

        call_count = 0

        def counting_sync(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError()

        mock_neuron.sync_metagraph = counting_sync

        await epoch_loop(mock_neuron, mock_scorer, mock_share_store, mock_outcome_attestor)

        # set_weights should have been called since miners were tracked
        mock_neuron.set_weights.assert_called_once()

    @pytest.mark.asyncio
    async def test_epoch_loop_records_weight_set_block(
        self,
        mock_neuron: MagicMock,
        mock_scorer: MinerScorer,
        mock_share_store: ShareStore,
        mock_outcome_attestor: AsyncMock,
    ) -> None:
        """After successful weight set, record_weight_set is called."""
        mock_neuron.should_set_weights.return_value = True
        mock_neuron.set_weights.return_value = True

        call_count = 0

        def counting_sync(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError()

        mock_neuron.sync_metagraph = counting_sync

        await epoch_loop(mock_neuron, mock_scorer, mock_share_store, mock_outcome_attestor)

        mock_neuron.record_weight_set.assert_called_once()

    @pytest.mark.asyncio
    async def test_epoch_loop_does_not_record_on_weight_failure(
        self,
        mock_neuron: MagicMock,
        mock_scorer: MinerScorer,
        mock_share_store: ShareStore,
        mock_outcome_attestor: AsyncMock,
    ) -> None:
        """Failed weight set does not call record_weight_set."""
        mock_neuron.should_set_weights.return_value = True
        mock_neuron.set_weights.return_value = False

        call_count = 0

        def counting_sync(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError()

        mock_neuron.sync_metagraph = counting_sync

        await epoch_loop(mock_neuron, mock_scorer, mock_share_store, mock_outcome_attestor)

        mock_neuron.record_weight_set.assert_not_called()

    @pytest.mark.asyncio
    async def test_epoch_loop_handles_errors(
        self,
        mock_neuron: MagicMock,
        mock_scorer: MinerScorer,
        mock_share_store: ShareStore,
        mock_outcome_attestor: AsyncMock,
    ) -> None:
        """Errors trigger backoff, not a crash."""
        call_count = 0

        def error_then_cancel(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("metagraph error")
            raise asyncio.CancelledError()

        mock_neuron.sync_metagraph = error_then_cancel

        with patch("djinn_validator.main.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await epoch_loop(mock_neuron, mock_scorer, mock_share_store, mock_outcome_attestor)

        assert mock_sleep.called
        backoff = mock_sleep.call_args_list[0][0][0]
        assert backoff >= 12  # min(12 * 2^1, 300) = 24

    @pytest.mark.asyncio
    async def test_epoch_loop_cancellation(
        self,
        mock_neuron: MagicMock,
        mock_scorer: MinerScorer,
        mock_share_store: ShareStore,
        mock_outcome_attestor: AsyncMock,
    ) -> None:
        """CancelledError exits cleanly."""
        mock_neuron.sync_metagraph.side_effect = asyncio.CancelledError()

        await epoch_loop(mock_neuron, mock_scorer, mock_share_store, mock_outcome_attestor)

    @pytest.mark.asyncio
    async def test_epoch_loop_resets_epoch_metrics(
        self,
        mock_neuron: MagicMock,
        mock_scorer: MinerScorer,
        mock_share_store: ShareStore,
        mock_outcome_attestor: AsyncMock,
    ) -> None:
        """Per-epoch metrics are reset after weights are set."""
        # Pre-populate miner with some metrics
        m = mock_scorer.get_or_create(1, "key-1")
        m.record_query(correct=True, latency=0.5, proof_submitted=True)

        # Metrics only reset when weights are actually set
        mock_neuron.should_set_weights.return_value = True
        mock_neuron.set_weights.return_value = True

        call_count = 0

        def counting_sync(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError()

        mock_neuron.sync_metagraph = counting_sync

        await epoch_loop(mock_neuron, mock_scorer, mock_share_store, mock_outcome_attestor)

        # After reset, queries should be 0 (health check adds 1 though)
        assert m.queries_total == 0  # reset_epoch clears this
        assert m.latencies == []  # reset_epoch clears this


class TestMPCCleanupLoop:
    """Test the MPC session cleanup background loop."""

    @pytest.mark.asyncio
    async def test_cleanup_loop_removes_expired(self) -> None:
        """Cleanup loop calls cleanup_expired on the coordinator."""
        coordinator = MagicMock(spec=MPCCoordinator)
        coordinator.cleanup_expired.return_value = 3

        call_count = 0
        original_cleanup = coordinator.cleanup_expired

        def counting_cleanup():
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError()
            return 3

        coordinator.cleanup_expired = counting_cleanup

        with patch("djinn_validator.main.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await mpc_cleanup_loop(coordinator)

        # Sleep should have been called with 300 (5 minutes)
        assert mock_sleep.call_args_list[0][0][0] == 300

    @pytest.mark.asyncio
    async def test_cleanup_loop_handles_errors(self) -> None:
        """Errors in cleanup don't crash the loop."""
        coordinator = MagicMock(spec=MPCCoordinator)
        call_count = 0

        def error_then_cancel():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("cleanup error")
            raise asyncio.CancelledError()

        coordinator.cleanup_expired = error_then_cancel

        with patch("djinn_validator.main.asyncio.sleep", new_callable=AsyncMock):
            await mpc_cleanup_loop(coordinator)  # Should not raise

    @pytest.mark.asyncio
    async def test_cleanup_loop_cancellation(self) -> None:
        """CancelledError exits cleanly."""
        coordinator = MagicMock(spec=MPCCoordinator)

        with patch("djinn_validator.main.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            mock_sleep.side_effect = asyncio.CancelledError()
            await mpc_cleanup_loop(coordinator)


class TestAsyncMainBtFailure:
    """Test that async_main exits on production when BT setup fails."""

    @pytest.mark.asyncio
    async def test_bt_failure_exits_on_finney(self, tmp_path) -> None:
        """On finney, a BT setup failure should raise SystemExit(1)."""
        mock_config = MagicMock()
        mock_config.bt_network = "finney"
        mock_config.validate.return_value = []
        mock_config.data_dir = str(tmp_path)
        mock_config.sports_api_key = "test"
        mock_config.base_rpc_url = "https://rpc.test.com"
        mock_config.base_chain_id = 8453
        mock_config.escrow_address = ""
        mock_config.signal_commitment_address = ""
        mock_config.account_address = ""
        mock_config.outcome_voting_address = ""
        mock_config.base_validator_private_key = ""
        mock_config.api_host = "0.0.0.0"
        mock_config.api_port = 8421
        mock_config.bt_netuid = 103
        mock_config.bt_wallet_name = "default"
        mock_config.bt_wallet_hotkey = "default"
        mock_config.external_ip = ""
        mock_config.external_port = 0

        mock_neuron = MagicMock()
        mock_neuron.setup.return_value = False

        with (
            patch("djinn_validator.main.Config", return_value=mock_config),
            patch("djinn_validator.main.DjinnValidator", return_value=mock_neuron),
            patch("djinn_validator.main.ChainClient"),
            pytest.raises(SystemExit) as exc_info,
        ):
            await async_main()

        assert exc_info.value.code == 1

    @pytest.mark.asyncio
    async def test_bt_failure_exits_on_mainnet(self, tmp_path) -> None:
        """On mainnet, a BT setup failure should raise SystemExit(1)."""
        mock_config = MagicMock()
        mock_config.bt_network = "mainnet"
        mock_config.validate.return_value = []
        mock_config.data_dir = str(tmp_path)
        mock_config.sports_api_key = "test"
        mock_config.base_rpc_url = "https://rpc.test.com"
        mock_config.base_chain_id = 8453
        mock_config.escrow_address = ""
        mock_config.signal_commitment_address = ""
        mock_config.account_address = ""
        mock_config.outcome_voting_address = ""
        mock_config.base_validator_private_key = ""
        mock_config.api_host = "0.0.0.0"
        mock_config.api_port = 8421
        mock_config.bt_netuid = 103
        mock_config.bt_wallet_name = "default"
        mock_config.bt_wallet_hotkey = "default"
        mock_config.external_ip = ""
        mock_config.external_port = 0

        mock_neuron = MagicMock()
        mock_neuron.setup.return_value = False

        with (
            patch("djinn_validator.main.Config", return_value=mock_config),
            patch("djinn_validator.main.DjinnValidator", return_value=mock_neuron),
            patch("djinn_validator.main.ChainClient"),
            pytest.raises(SystemExit) as exc_info,
        ):
            await async_main()

        assert exc_info.value.code == 1

    @pytest.mark.asyncio
    async def test_bt_failure_continues_on_test_network(self, tmp_path) -> None:
        """On test/local networks, BT failure should NOT exit."""
        mock_config = MagicMock()
        mock_config.bt_network = "test"
        mock_config.validate.return_value = []
        mock_config.data_dir = str(tmp_path)
        mock_config.sports_api_key = "test"
        mock_config.base_rpc_url = "https://rpc.test.com"
        mock_config.base_chain_id = 8453
        mock_config.escrow_address = ""
        mock_config.signal_commitment_address = ""
        mock_config.account_address = ""
        mock_config.outcome_voting_address = ""
        mock_config.base_validator_private_key = ""
        mock_config.api_host = "0.0.0.0"
        mock_config.api_port = 8421
        mock_config.bt_netuid = 103
        mock_config.bt_wallet_name = "default"
        mock_config.bt_wallet_hotkey = "default"
        mock_config.external_ip = ""
        mock_config.external_port = 0
        mock_config.rate_limit_capacity = 60
        mock_config.rate_limit_rate = 10
        mock_config.mpc_availability_timeout = 15.0
        mock_config.shares_threshold = 7
        mock_neuron = MagicMock()
        mock_neuron.setup.return_value = False

        shutdown_event = asyncio.Event()
        shutdown_event.set()

        with (
            patch("djinn_validator.main.Config", return_value=mock_config),
            patch("djinn_validator.main.DjinnValidator", return_value=mock_neuron),
            patch("djinn_validator.main.ChainClient"),
            patch("djinn_validator.main.create_app"),
            patch("djinn_validator.main.run_server", new_callable=AsyncMock),
            patch("djinn_validator.main.mpc_cleanup_loop", new_callable=AsyncMock),
            patch("djinn_validator.main.asyncio.Event", return_value=shutdown_event),
            patch("asyncio.get_running_loop") as mock_loop,
        ):
            mock_loop.return_value.add_signal_handler = MagicMock()
            await async_main()
