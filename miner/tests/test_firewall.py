"""Tests for automatic firewall management."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from djinn_miner.utils.firewall import _get_validator_ips, apply_sysctl_hardening, update_firewall


class TestGetValidatorIps:
    def test_returns_empty_when_no_neuron(self) -> None:
        assert _get_validator_ips(None) == set()

    def test_returns_empty_when_no_metagraph(self) -> None:
        neuron = MagicMock()
        neuron.metagraph = None
        assert _get_validator_ips(neuron) == set()

    def test_extracts_validator_ips(self) -> None:
        neuron = MagicMock()
        neuron.metagraph.n = 3
        neuron.metagraph.validator_permit = [True, False, True]
        axon0 = MagicMock()
        axon0.ip = "1.1.1.1"
        axon1 = MagicMock()
        axon1.ip = "2.2.2.2"
        axon2 = MagicMock()
        axon2.ip = "3.3.3.3"
        neuron.metagraph.axons = [axon0, axon1, axon2]
        ips = _get_validator_ips(neuron)
        assert ips == {"1.1.1.1", "3.3.3.3"}

    def test_skips_zero_ip(self) -> None:
        neuron = MagicMock()
        neuron.metagraph.n = 1
        neuron.metagraph.validator_permit = [True]
        axon = MagicMock()
        axon.ip = "0.0.0.0"
        neuron.metagraph.axons = [axon]
        assert _get_validator_ips(neuron) == set()

    def test_handles_tensor_items(self) -> None:
        """Metagraph values may be torch tensors with .item()."""
        neuron = MagicMock()
        n_mock = MagicMock()
        n_mock.item.return_value = 1
        neuron.metagraph.n = n_mock
        permit_mock = MagicMock()
        permit_mock.item.return_value = True
        neuron.metagraph.validator_permit = [permit_mock]
        axon = MagicMock()
        axon.ip = "10.0.0.1"
        neuron.metagraph.axons = [axon]
        assert _get_validator_ips(neuron) == {"10.0.0.1"}


class TestUpdateFirewall:
    @patch("djinn_miner.utils.firewall._is_root", return_value=False)
    def test_skips_when_not_root(self, mock_root: MagicMock) -> None:
        assert update_firewall({"1.1.1.1"}, 8422) is False

    @patch("djinn_miner.utils.firewall._has_ufw", return_value=False)
    @patch("djinn_miner.utils.firewall._is_root", return_value=True)
    def test_skips_when_no_ufw(self, mock_root: MagicMock, mock_ufw: MagicMock) -> None:
        assert update_firewall({"1.1.1.1"}, 8422) is False

    @patch("djinn_miner.utils.firewall._has_ufw", return_value=True)
    @patch("djinn_miner.utils.firewall._is_root", return_value=True)
    def test_skips_empty_ips(self, mock_root: MagicMock, mock_ufw: MagicMock) -> None:
        assert update_firewall(set(), 8422) is False

    @patch("djinn_miner.utils.firewall._run")
    @patch("djinn_miner.utils.firewall._get_current_allowed_ips", return_value=set())
    @patch("djinn_miner.utils.firewall._has_ufw", return_value=True)
    @patch("djinn_miner.utils.firewall._is_root", return_value=True)
    def test_adds_new_ips(self, mock_root: MagicMock, mock_ufw: MagicMock,
                          mock_current: MagicMock, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(returncode=0)
        result = update_firewall({"1.1.1.1", "2.2.2.2"}, 8422)
        assert result is True
        # Should have called ufw allow for each IP on both API and notary ports
        allow_calls = [c for c in mock_run.call_args_list
                       if "allow" in str(c) and "from" in str(c)]
        assert len(allow_calls) == 4  # 2 IPs x 2 ports (API + notary)

    @patch("djinn_miner.utils.firewall._run")
    @patch("djinn_miner.utils.firewall._get_current_allowed_ips", return_value={"1.1.1.1", "9.9.9.9"})
    @patch("djinn_miner.utils.firewall._has_ufw", return_value=True)
    @patch("djinn_miner.utils.firewall._is_root", return_value=True)
    def test_removes_stale_and_adds_new(self, mock_root: MagicMock, mock_ufw: MagicMock,
                                         mock_current: MagicMock, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(returncode=0)
        result = update_firewall({"1.1.1.1", "2.2.2.2"}, 8422)
        assert result is True
        # 9.9.9.9 should be deleted, 2.2.2.2 should be added
        delete_calls = [c for c in mock_run.call_args_list if "delete" in str(c) and "9.9.9.9" in str(c)]
        add_calls = [c for c in mock_run.call_args_list if "from" in str(c) and "2.2.2.2" in str(c)]
        assert len(delete_calls) >= 1
        assert len(add_calls) >= 1


class TestApplySysctl:
    @patch("djinn_miner.utils.firewall._is_root", return_value=False)
    def test_skips_when_not_root(self, mock_root: MagicMock) -> None:
        assert apply_sysctl_hardening() is False
