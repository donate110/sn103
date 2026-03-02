"""Tests for the ChainClient on-chain interaction layer."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from djinn_validator.chain.contracts import ChainClient


@pytest.fixture
def client() -> ChainClient:
    """Create a ChainClient with all addresses configured."""
    with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
        mock_w3 = MagicMock()
        mock_w3.to_checksum_address = lambda x: x
        mock_w3.eth = MagicMock()
        mock_contract = MagicMock()
        mock_w3.eth.contract.return_value = mock_contract
        MockW3.return_value = mock_w3
        MockW3.AsyncHTTPProvider = MagicMock()

        c = ChainClient(
            rpc_url="http://localhost:8545",
            escrow_address="0x1111111111111111111111111111111111111111",
            signal_address="0x2222222222222222222222222222222222222222",
            account_address="0x3333333333333333333333333333333333333333",
        )
        c._w3 = mock_w3
        return c


class TestChainClientInit:
    def test_no_contracts_when_addresses_empty(self) -> None:
        with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
            mock_w3 = MagicMock()
            MockW3.return_value = mock_w3
            MockW3.AsyncHTTPProvider = MagicMock()
            c = ChainClient(rpc_url="http://localhost:8545")
            assert c._escrow is None
            assert c._signal is None
            assert c._account is None


class TestIsSignalActive:
    @pytest.mark.asyncio
    async def test_returns_true_when_no_contract(self) -> None:
        """Permissive in dev mode: returns True when contract not configured."""
        with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
            mock_w3 = MagicMock()
            MockW3.return_value = mock_w3
            MockW3.AsyncHTTPProvider = MagicMock()
            c = ChainClient(rpc_url="http://localhost:8545")
            assert await c.is_signal_active(1) is True

    @pytest.mark.asyncio
    async def test_calls_contract(self, client: ChainClient) -> None:
        mock_call = AsyncMock(return_value=True)
        client._signal.functions.isActive.return_value.call = mock_call
        result = await client.is_signal_active(42)
        assert result is True
        client._signal.functions.isActive.assert_called_with(42)

    @pytest.mark.asyncio
    async def test_returns_false_for_inactive(self, client: ChainClient) -> None:
        mock_call = AsyncMock(return_value=False)
        client._signal.functions.isActive.return_value.call = mock_call
        result = await client.is_signal_active(99)
        assert result is False


class TestGetSignal:
    @pytest.mark.asyncio
    async def test_returns_empty_when_no_contract(self) -> None:
        with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
            mock_w3 = MagicMock()
            MockW3.return_value = mock_w3
            MockW3.AsyncHTTPProvider = MagicMock()
            c = ChainClient(rpc_url="http://localhost:8545")
            result = await c.get_signal(1)
            assert result == {}

    @pytest.mark.asyncio
    async def test_parses_contract_result(self, client: ChainClient) -> None:
        # 13-field Signal struct: genius, encryptedBlob, commitHash, sport,
        # maxPriceBps, slaMultiplierBps, maxNotional, minNotional, expiresAt,
        # decoyLines, availableSportsbooks, status, createdAt
        mock_result = [
            "0xGenius",            # [0] genius
            b"\xab\xcd",          # [1] encryptedBlob
            b"\x00" * 32,         # [2] commitHash
            "basketball_nba",     # [3] sport
            500,                   # [4] maxPriceBps
            200,                   # [5] slaMultiplierBps
            100_000_000,           # [6] maxNotional
            10_000_000,            # [7] minNotional
            1700100000,            # [8] expiresAt
            ["line1", "line2"],   # [9] decoyLines
            ["draftkings"],       # [10] availableSportsbooks
            1,                     # [11] status
            1700000000,            # [12] createdAt
        ]
        mock_call = AsyncMock(return_value=mock_result)
        client._signal.functions.getSignal.return_value.call = mock_call

        result = await client.get_signal(42)
        assert result["genius"] == "0xGenius"
        assert result["sport"] == "basketball_nba"
        assert result["maxPriceBps"] == 500
        assert result["slaMultiplierBps"] == 200
        assert result["expiresAt"] == 1700100000
        assert result["status"] == 1
        assert result["createdAt"] == 1700000000


class TestVerifyPurchase:
    @pytest.mark.asyncio
    async def test_returns_zero_when_no_contract(self) -> None:
        with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
            mock_w3 = MagicMock()
            MockW3.return_value = mock_w3
            MockW3.AsyncHTTPProvider = MagicMock()
            c = ChainClient(rpc_url="http://localhost:8545")
            result = await c.verify_purchase(1, "0xBuyer")
            assert result["notional"] == 0
            assert result["pricePaid"] == 0

    @pytest.mark.asyncio
    async def test_returns_purchase_data(self, client: ChainClient) -> None:
        # getPurchasesBySignal returns list of purchase IDs
        client._escrow.functions.getPurchasesBySignal.return_value.call = AsyncMock(
            return_value=[42]
        )
        # getPurchase returns tuple: (idiot, signalId, notional, feePaid, creditUsed, usdcPaid, odds, outcome, purchasedAt)
        client._escrow.functions.getPurchase.return_value.call = AsyncMock(
            return_value=["0xBuyer", 1, 1000000, 10000, 20000, 30000, 150, 0, 1700000000]
        )

        result = await client.verify_purchase(1, "0xBuyer")
        assert result["notional"] == 1000000
        assert result["pricePaid"] == 50000  # creditUsed + usdcPaid

    @pytest.mark.asyncio
    async def test_returns_zero_when_buyer_not_found(self, client: ChainClient) -> None:
        client._escrow.functions.getPurchasesBySignal.return_value.call = AsyncMock(
            return_value=[42]
        )
        client._escrow.functions.getPurchase.return_value.call = AsyncMock(
            return_value=["0xOtherBuyer", 1, 1000000, 10000, 20000, 30000, 150, 0, 1700000000]
        )

        result = await client.verify_purchase(1, "0xBuyer")
        assert result["notional"] == 0
        assert result["pricePaid"] == 0

    @pytest.mark.asyncio
    async def test_returns_zero_when_no_purchases(self, client: ChainClient) -> None:
        client._escrow.functions.getPurchasesBySignal.return_value.call = AsyncMock(
            return_value=[]
        )

        result = await client.verify_purchase(1, "0xBuyer")
        assert result["notional"] == 0
        assert result["pricePaid"] == 0


class TestIsAuditReady:
    @pytest.mark.asyncio
    async def test_returns_false_when_no_contract(self) -> None:
        with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
            mock_w3 = MagicMock()
            MockW3.return_value = mock_w3
            MockW3.AsyncHTTPProvider = MagicMock()
            c = ChainClient(rpc_url="http://localhost:8545")
            result = await c.is_audit_ready("0xGenius", "0xIdiot")
            assert result is False

    @pytest.mark.asyncio
    async def test_calls_contract(self, client: ChainClient) -> None:
        mock_call = AsyncMock(return_value=True)
        client._account.functions.isAuditReady.return_value.call = mock_call
        result = await client.is_audit_ready("0xGenius", "0xIdiot")
        assert result is True


class TestIsConnected:
    @pytest.mark.asyncio
    async def test_returns_true_on_success(self, client: ChainClient) -> None:
        client._w3.eth.block_number = AsyncMock(return_value=12345)
        # The property access needs to be awaited — mock it as a coroutine
        type(client._w3.eth).block_number = property(
            lambda self: _async_value(12345)
        )
        result = await client.is_connected()
        assert result is True

    @pytest.mark.asyncio
    async def test_returns_false_on_error(self, client: ChainClient) -> None:
        async def _raise() -> int:
            raise ConnectionError("connection refused")

        type(client._w3.eth).block_number = property(lambda self: _raise())
        result = await client.is_connected()
        assert result is False


class TestClose:
    @pytest.mark.asyncio
    async def test_close_with_session(self, client: ChainClient) -> None:
        mock_session = AsyncMock()
        client._w3.provider._request_session = mock_session
        await client.close()
        # close() now prefers aclose() if available
        mock_session.aclose.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_close_without_session(self, client: ChainClient) -> None:
        """close() should not raise even if provider has no session."""
        client._w3.provider = MagicMock(spec=[])  # No _request_session attr
        await client.close()  # Should not raise


class TestContractCallErrors:
    """Verify contract methods handle RPC errors gracefully."""

    @pytest.mark.asyncio
    async def test_is_signal_active_rpc_error(self, client: ChainClient) -> None:
        """RPC failure returns False (fail-safe: don't release shares)."""
        mock_call = AsyncMock(side_effect=ConnectionError("RPC down"))
        client._signal.functions.isActive.return_value.call = mock_call
        result = await client.is_signal_active(1)
        assert result is False

    @pytest.mark.asyncio
    async def test_get_signal_rpc_error(self, client: ChainClient) -> None:
        """RPC failure returns empty dict."""
        mock_call = AsyncMock(side_effect=ConnectionError("RPC down"))
        client._signal.functions.getSignal.return_value.call = mock_call
        result = await client.get_signal(1)
        assert result == {}

    @pytest.mark.asyncio
    async def test_verify_purchase_rpc_error(self, client: ChainClient) -> None:
        """RPC failure returns zero values."""
        mock_call = AsyncMock(side_effect=ConnectionError("RPC down"))
        client._escrow.functions.getPurchasesBySignal.return_value.call = mock_call
        result = await client.verify_purchase(1, "0xBuyer")
        assert result["notional"] == 0
        assert result["pricePaid"] == 0
        assert result["sportsbook"] == ""

    @pytest.mark.asyncio
    async def test_is_audit_ready_rpc_error(self, client: ChainClient) -> None:
        """RPC failure returns False."""
        mock_call = AsyncMock(side_effect=ConnectionError("RPC down"))
        client._account.functions.isAuditReady.return_value.call = mock_call
        result = await client.is_audit_ready("0xGenius", "0xIdiot")
        assert result is False

    @pytest.mark.asyncio
    async def test_close_timeout(self, client: ChainClient) -> None:
        """close() handles timeout gracefully."""
        import asyncio

        async def slow_close():
            await asyncio.sleep(10)

        mock_session = MagicMock()
        mock_session.aclose = slow_close
        client._w3.provider._request_session = mock_session
        # Should complete within timeout, not hang forever
        await asyncio.wait_for(client.close(), timeout=10.0)

    @pytest.mark.asyncio
    async def test_close_idempotent(self, client: ChainClient) -> None:
        """Calling close twice should not raise."""
        client._w3.provider = MagicMock(spec=[])
        await client.close()
        await client.close()


class TestRpcFailover:
    """Verify automatic RPC failover when endpoints become unreachable."""

    def test_single_url_init(self) -> None:
        with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
            mock_w3 = MagicMock()
            MockW3.return_value = mock_w3
            MockW3.AsyncHTTPProvider = MagicMock()
            c = ChainClient(rpc_url="http://localhost:8545")
            assert c.rpc_url_count == 1
            assert c.rpc_url == "http://localhost:8545"

    def test_comma_separated_urls(self) -> None:
        with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
            mock_w3 = MagicMock()
            MockW3.return_value = mock_w3
            MockW3.AsyncHTTPProvider = MagicMock()
            c = ChainClient(rpc_url="http://rpc1:8545 , http://rpc2:8545")
            assert c.rpc_url_count == 2
            assert c.rpc_url == "http://rpc1:8545"

    def test_list_urls(self) -> None:
        with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
            mock_w3 = MagicMock()
            MockW3.return_value = mock_w3
            MockW3.AsyncHTTPProvider = MagicMock()
            c = ChainClient(rpc_url=["http://rpc1:8545", "http://rpc2:8545"])
            assert c.rpc_url_count == 2

    def test_rotate_with_single_url_returns_false(self) -> None:
        with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
            mock_w3 = MagicMock()
            MockW3.return_value = mock_w3
            MockW3.AsyncHTTPProvider = MagicMock()
            c = ChainClient(rpc_url="http://rpc1:8545")
            assert c._rotate_rpc() is False

    def test_rotate_switches_url(self) -> None:
        with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
            mock_w3 = MagicMock()
            MockW3.return_value = mock_w3
            MockW3.AsyncHTTPProvider = MagicMock()
            c = ChainClient(rpc_url=["http://rpc1:8545", "http://rpc2:8545"])
            assert c.rpc_url == "http://rpc1:8545"
            assert c._rotate_rpc() is True
            assert c.rpc_url == "http://rpc2:8545"

    @pytest.mark.asyncio
    async def test_failover_on_connection_error(self) -> None:
        """Contract call should failover to next RPC on ConnectionError."""
        with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
            mock_w3 = MagicMock()
            mock_w3.to_checksum_address = lambda x: x
            mock_contract = MagicMock()
            mock_w3.eth.contract.return_value = mock_contract
            MockW3.return_value = mock_w3
            MockW3.AsyncHTTPProvider = MagicMock()

            c = ChainClient(
                rpc_url=["http://rpc1:8545", "http://rpc2:8545"],
                signal_address="0x2222222222222222222222222222222222222222",
            )

            call_count = 0
            async def _failing_then_ok():
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    raise ConnectionError("rpc1 down")
                return True

            c._signal.functions.isActive.return_value.call = _failing_then_ok
            result = await c.is_signal_active(1)
            assert result is True
            assert call_count == 2

    @pytest.mark.asyncio
    async def test_is_connected_tries_all_endpoints(self) -> None:
        """is_connected should try all endpoints before returning False."""
        with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
            mock_w3 = MagicMock()
            MockW3.return_value = mock_w3
            MockW3.AsyncHTTPProvider = MagicMock()

            c = ChainClient(rpc_url=["http://rpc1:8545", "http://rpc2:8545"])

            async def _raise():
                raise ConnectionError("down")

            type(c._w3.eth).block_number = property(lambda self: _raise())
            result = await c.is_connected()
            assert result is False

    def test_empty_url_fallback(self) -> None:
        with patch("djinn_validator.chain.contracts.AsyncWeb3") as MockW3:
            mock_w3 = MagicMock()
            MockW3.return_value = mock_w3
            MockW3.AsyncHTTPProvider = MagicMock()
            c = ChainClient(rpc_url="")
            assert c.rpc_url_count == 1
            assert "base.org" in c.rpc_url


async def _async_value(val: int) -> int:
    return val
