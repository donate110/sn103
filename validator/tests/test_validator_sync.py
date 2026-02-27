"""Tests for the metagraph-synced validator set management."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from djinn_validator.core.validator_sync import ValidatorSetSyncer


def _make_axon(ip: str, port: int) -> MagicMock:
    axon = MagicMock()
    axon.ip = ip
    axon.port = port
    return axon


def _make_neuron(validator_uids: list[int], axons: dict[int, tuple[str, int]], n: int = 10) -> MagicMock:
    """Create a mock DjinnValidator with a fake metagraph."""
    neuron = MagicMock()
    metagraph = MagicMock()
    metagraph.n = n

    # validator_permit: True for validator UIDs
    permits = []
    axon_list = []
    stakes = []
    for uid in range(n):
        permits.append(uid in validator_uids)
        ip, port = axons.get(uid, ("0.0.0.0", 0))
        axon_list.append(_make_axon(ip, port))
        # Validators get stake above _MIN_STAKE_ALPHA (1000), others get 0
        stakes.append(5000 if uid in validator_uids else 0)

    metagraph.validator_permit = permits
    metagraph.axons = axon_list
    metagraph.S = stakes
    neuron.metagraph = metagraph
    return neuron


@pytest.fixture
def chain_client() -> AsyncMock:
    client = AsyncMock()
    client.can_write = True
    client.get_validators = AsyncMock(return_value=["0xaaaa", "0xbbbb"])
    client.get_sync_nonce = AsyncMock(return_value=5)
    client.propose_sync = AsyncMock(return_value="0xtxhash")
    return client


class TestValidatorSetSyncer:
    @pytest.mark.asyncio
    async def test_sync_discovers_peers(self, chain_client: AsyncMock) -> None:
        """Peers discovered via metagraph /v1/identity calls."""
        neuron = _make_neuron(
            validator_uids=[0, 2],
            axons={0: ("10.0.0.1", 8421), 2: ("10.0.0.3", 8421)},
        )
        syncer = ValidatorSetSyncer(chain_client, neuron)

        # Mock httpx responses
        import httpx

        async def mock_get(url: str) -> MagicMock:
            resp = MagicMock()
            resp.status_code = 200
            if "10.0.0.1" in url:
                resp.json.return_value = {"base_address": "0xAAAA", "hotkey": "5F...", "version": "0.1.0"}
            elif "10.0.0.3" in url:
                resp.json.return_value = {"base_address": "0xCCCC", "hotkey": "5G...", "version": "0.1.0"}
            return resp

        with patch("djinn_validator.core.validator_sync.httpx.AsyncClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.get = mock_get
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_instance

            addresses = await syncer._discover_peer_addresses()

        assert len(addresses) == 2
        assert "0xAAAA" in addresses
        assert "0xCCCC" in addresses

    @pytest.mark.asyncio
    async def test_sync_proposes_when_changed(self, chain_client: AsyncMock) -> None:
        """When discovered set differs from on-chain, propose_sync is called."""
        neuron = _make_neuron(
            validator_uids=[0],
            axons={0: ("10.0.0.1", 8421)},
        )
        syncer = ValidatorSetSyncer(chain_client, neuron)

        # Chain has [0xaaaa, 0xbbbb], discovery will find [0xNEW]
        with patch.object(syncer, "_discover_peer_addresses", return_value=["0x1111111111111111111111111111111111111111"]):
            await syncer.sync_once()

        chain_client.propose_sync.assert_called_once()
        args = chain_client.propose_sync.call_args
        assert args[0][1] == 5  # nonce

    @pytest.mark.asyncio
    async def test_sync_skips_when_unchanged(self, chain_client: AsyncMock) -> None:
        """When discovered set matches on-chain, no proposal is made."""
        chain_client.get_validators = AsyncMock(return_value=["0xAAAA", "0xBBBB"])
        neuron = _make_neuron(validator_uids=[0, 1], axons={0: ("10.0.0.1", 8421), 1: ("10.0.0.2", 8421)})
        syncer = ValidatorSetSyncer(chain_client, neuron)

        with patch.object(syncer, "_discover_peer_addresses", return_value=["0xaaaa", "0xbbbb"]):
            await syncer.sync_once()

        chain_client.propose_sync.assert_not_called()

    @pytest.mark.asyncio
    async def test_sync_handles_unreachable_peer(self, chain_client: AsyncMock) -> None:
        """Unreachable peers are skipped, reachable ones still included."""
        neuron = _make_neuron(
            validator_uids=[0, 1],
            axons={0: ("10.0.0.1", 8421), 1: ("10.0.0.2", 8421)},
        )
        syncer = ValidatorSetSyncer(chain_client, neuron)

        import httpx

        call_count = 0

        async def mock_get(url: str) -> MagicMock:
            nonlocal call_count
            call_count += 1
            resp = MagicMock()
            if "10.0.0.1" in url:
                resp.status_code = 200
                resp.json.return_value = {"base_address": "0xAAAA", "version": "0.1.0"}
            else:
                raise httpx.ConnectError("unreachable")
            return resp

        with patch("djinn_validator.core.validator_sync.httpx.AsyncClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.get = mock_get
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_instance

            addresses = await syncer._discover_peer_addresses()

        assert len(addresses) == 1
        assert "0xAAAA" in addresses

    @pytest.mark.asyncio
    async def test_sync_skips_without_metagraph(self, chain_client: AsyncMock) -> None:
        """No metagraph → skip silently."""
        neuron = MagicMock()
        neuron.metagraph = None
        syncer = ValidatorSetSyncer(chain_client, neuron)

        await syncer.sync_once()
        chain_client.propose_sync.assert_not_called()

    @pytest.mark.asyncio
    async def test_sync_skips_without_write_access(self) -> None:
        """Chain client can't write → skip."""
        chain_client = AsyncMock()
        chain_client.can_write = False
        neuron = _make_neuron(validator_uids=[0], axons={0: ("10.0.0.1", 8421)})
        syncer = ValidatorSetSyncer(chain_client, neuron)

        await syncer.sync_once()
        chain_client.get_validators.assert_not_called()
