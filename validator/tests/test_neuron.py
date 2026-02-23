"""Tests for the Bittensor validator neuron integration."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from djinn_validator.bt.neuron import DjinnValidator


class TestDjinnValidatorInit:
    def test_defaults(self) -> None:
        v = DjinnValidator()
        assert v.netuid == 103
        assert v.network == "finney"
        assert v.wallet is None
        assert v.uid is None

    def test_custom_params(self) -> None:
        v = DjinnValidator(netuid=42, network="test", wallet_name="w", hotkey_name="h")
        assert v.netuid == 42
        assert v.network == "test"


class TestSetupWithoutBittensor:
    def test_setup_fails_without_bt(self) -> None:
        v = DjinnValidator()
        with patch("djinn_validator.bt.neuron.bt", None):
            assert v.setup() is False

    def test_setup_catches_exceptions(self) -> None:
        mock_bt = MagicMock()
        mock_bt.Wallet.side_effect = RuntimeError("no wallet")
        v = DjinnValidator()
        with patch("djinn_validator.bt.neuron.bt", mock_bt):
            assert v.setup() is False


class TestSetupSuccess:
    def _make_mock_bt(self, hotkey: str = "5FakeHotkey", n: int = 256) -> MagicMock:
        mock_bt = MagicMock()

        wallet = MagicMock()
        wallet.hotkey.ss58_address = hotkey
        wallet.coldkeypub.ss58_address = "5ColdKey"
        mock_bt.Wallet.return_value = wallet

        subtensor = MagicMock()
        mock_bt.Subtensor.return_value = subtensor

        metagraph = MagicMock()
        metagraph.n.item.return_value = n
        metagraph.hotkeys = [f"key-{i}" for i in range(n)]
        metagraph.hotkeys[7] = hotkey
        subtensor.metagraph.return_value = metagraph

        return mock_bt

    def test_setup_succeeds(self) -> None:
        mock_bt = self._make_mock_bt()
        v = DjinnValidator()
        with patch("djinn_validator.bt.neuron.bt", mock_bt):
            assert v.setup() is True
        assert v.uid == 7
        assert v.wallet is not None
        assert v.subtensor is not None

    def test_setup_not_registered(self) -> None:
        mock_bt = self._make_mock_bt(hotkey="unknown")
        mock_bt.Subtensor.return_value.metagraph.return_value.hotkeys = ["other"]
        v = DjinnValidator()
        with patch("djinn_validator.bt.neuron.bt", mock_bt):
            assert v.setup() is False
        assert v.uid is None


class TestSyncMetagraph:
    def test_sync_calls_subtensor(self) -> None:
        v = DjinnValidator()
        v.subtensor = MagicMock()
        v.metagraph = MagicMock()
        v.metagraph.n.item.return_value = 64
        v.sync_metagraph()
        v.metagraph.sync.assert_called_once_with(subtensor=v.subtensor)

    def test_sync_noop_without_subtensor(self) -> None:
        v = DjinnValidator()
        v.sync_metagraph()  # No error


class TestSetWeights:
    def test_set_weights_no_init(self) -> None:
        v = DjinnValidator()
        assert v.set_weights({1: 0.5, 2: 0.5}) is False

    def test_set_weights_empty(self) -> None:
        v = DjinnValidator()
        v.subtensor = MagicMock()
        v.wallet = MagicMock()
        assert v.set_weights({}) is False


class TestGetMinerUids:
    def test_no_metagraph(self) -> None:
        v = DjinnValidator()
        assert v.get_miner_uids() == []

    def test_returns_miner_uids(self) -> None:
        v = DjinnValidator()
        v.metagraph = MagicMock()
        v.metagraph.n.item.return_value = 4
        v.metagraph.validator_permit = [
            MagicMock(item=MagicMock(return_value=True)),   # uid 0: validator
            MagicMock(item=MagicMock(return_value=False)),  # uid 1: miner
            MagicMock(item=MagicMock(return_value=False)),  # uid 2: miner
            MagicMock(item=MagicMock(return_value=True)),   # uid 3: validator
        ]
        assert v.get_miner_uids() == [1, 2]


class TestGetAxonInfo:
    def test_no_metagraph(self) -> None:
        v = DjinnValidator()
        assert v.get_axon_info(0) == {}

    def test_returns_axon_info(self) -> None:
        v = DjinnValidator()
        v.metagraph = MagicMock()
        axon = MagicMock()
        axon.ip = "1.2.3.4"
        axon.port = 8422
        axon.hotkey = "5Miner"
        v.metagraph.axons = [axon]
        info = v.get_axon_info(0)
        assert info["ip"] == "1.2.3.4"
        assert info["port"] == 8422
        assert info["hotkey"] == "5Miner"


class TestBlock:
    def test_block_returns_subtensor_block(self) -> None:
        v = DjinnValidator()
        v.subtensor = MagicMock()
        v.subtensor.block = 99999
        assert v.block == 99999

    def test_block_zero_without_subtensor(self) -> None:
        v = DjinnValidator()
        assert v.block == 0


class TestShouldSetWeights:
    def test_no_subtensor(self) -> None:
        v = DjinnValidator()
        assert v.should_set_weights() is False

    def test_chain_based_check_enough_blocks(self) -> None:
        """Should set weights when chain last_update is old enough."""
        v = DjinnValidator()
        v.subtensor = MagicMock()
        v.subtensor.block = 200
        v.uid = 5
        v.metagraph = MagicMock()
        v.metagraph.last_update = [MagicMock() for _ in range(10)]
        v.metagraph.last_update[5].item.return_value = 50  # 200 - 50 = 150 >= 100
        assert v.should_set_weights() is True

    def test_chain_based_check_too_soon(self) -> None:
        """Should not set weights when chain last_update is too recent."""
        v = DjinnValidator()
        v.subtensor = MagicMock()
        v.subtensor.block = 150
        v.uid = 3
        v.metagraph = MagicMock()
        v.metagraph.last_update = [MagicMock() for _ in range(10)]
        v.metagraph.last_update[3].item.return_value = 100  # 150 - 100 = 50 < 100
        assert v.should_set_weights() is False

    def test_fallback_to_local_tracking(self) -> None:
        """Falls back to local tracking when chain check fails."""
        v = DjinnValidator()
        v.subtensor = MagicMock()
        v.subtensor.block = 200
        v.uid = None  # No UID triggers fallback
        v._last_weight_block = 100
        assert v.should_set_weights() is False  # uid=None returns False early

    def test_record_weight_set(self) -> None:
        """record_weight_set stores current block."""
        v = DjinnValidator()
        v.subtensor = MagicMock()
        v.subtensor.block = 500
        v.record_weight_set()
        assert v._last_weight_block == 500


class TestSetWeightsSuccess:
    def test_set_weights_calls_subtensor(self) -> None:
        """Successful set_weights calls subtensor with torch tensors."""
        v = DjinnValidator()
        v.subtensor = MagicMock()
        v.wallet = MagicMock()
        v.subtensor.set_weights.return_value = True

        mock_torch = MagicMock()
        mock_torch.tensor = MagicMock(side_effect=lambda x, dtype: x)
        mock_torch.int64 = "int64"
        mock_torch.float32 = "float32"
        with patch.dict("sys.modules", {"torch": mock_torch}):
            result = v.set_weights({1: 0.5, 2: 0.5})

        assert result is True
        v.subtensor.set_weights.assert_called_once()

    def test_set_weights_exception_returns_false(self) -> None:
        """Exception in set_weights returns False, doesn't crash."""
        v = DjinnValidator()
        v.subtensor = MagicMock()
        v.wallet = MagicMock()
        v.subtensor.set_weights.side_effect = RuntimeError("network error")

        mock_torch = MagicMock()
        mock_torch.tensor = MagicMock(side_effect=lambda x, dtype: x)
        mock_torch.int64 = "int64"
        mock_torch.float32 = "float32"
        with patch.dict("sys.modules", {"torch": mock_torch}):
            result = v.set_weights({1: 0.5})

        assert result is False


class TestApplyBurn:
    def test_apply_burn_empty(self) -> None:
        v = DjinnValidator()
        result = v.apply_burn({}, 0.95)
        assert result == {0: 1.0}

    def test_apply_burn_single_miner(self) -> None:
        v = DjinnValidator()
        result = v.apply_burn({1: 1.0}, 0.95)
        assert abs(result[0] - 0.95) < 1e-9
        assert abs(result[1] - 0.05) < 1e-9

    def test_apply_burn_multiple_miners(self) -> None:
        v = DjinnValidator()
        result = v.apply_burn({1: 0.6, 2: 0.3, 3: 0.1}, 0.95)
        assert abs(result[0] - 0.95) < 1e-9
        assert abs(result[1] - 0.03) < 1e-9
        assert abs(result[2] - 0.015) < 1e-9
        assert abs(result[3] - 0.005) < 1e-9

    def test_apply_burn_uid0_in_input(self) -> None:
        """UID 0 in miner weights is replaced by burn allocation."""
        v = DjinnValidator()
        result = v.apply_burn({0: 0.5, 1: 0.5}, 0.95)
        assert abs(result[0] - 0.95) < 1e-9
        assert abs(result[1] - 0.025) < 1e-9
        assert 0 in result
        assert len(result) == 2

    def test_apply_burn_sum_to_one(self) -> None:
        v = DjinnValidator()
        weights = {i: 1.0 / 10 for i in range(1, 11)}
        result = v.apply_burn(weights, 0.95)
        assert abs(sum(result.values()) - 1.0) < 1e-9

    def test_apply_burn_full_burn(self) -> None:
        """burn_fraction=1.0 sends everything to UID 0."""
        v = DjinnValidator()
        result = v.apply_burn({1: 0.5, 2: 0.5}, 1.0)
        assert result == {0: 1.0}

    def test_apply_burn_zero_burn(self) -> None:
        """burn_fraction=0.0 leaves miners unchanged."""
        v = DjinnValidator()
        result = v.apply_burn({1: 0.6, 2: 0.4}, 0.0)
        assert abs(result[0] - 0.0) < 1e-9
        assert abs(result[1] - 0.6) < 1e-9
        assert abs(result[2] - 0.4) < 1e-9


class TestSetupWalletNotFound:
    def test_wallet_not_found(self) -> None:
        """FileNotFoundError in setup returns False with specific logging."""
        mock_bt = MagicMock()
        mock_bt.Wallet.side_effect = FileNotFoundError("~/.bittensor/wallets/default/hotkeys/default")
        v = DjinnValidator()
        with patch("djinn_validator.bt.neuron.bt", mock_bt):
            assert v.setup() is False
