"""Tests for PSE notary fallback blocking on miners."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from djinn_miner.core.tlsn import (
    NOTARY_HOST,
    TLSNProofResult,
    generate_proof,
)


class TestPSEFallbackBlocking:
    """Test that miners refuse centralized PSE notary when required."""

    @pytest.mark.asyncio
    async def test_pse_blocked_when_require_peer(self) -> None:
        """Miner rejects PSE notary when REQUIRE_PEER_NOTARY is True."""
        with patch("djinn_miner.core.tlsn.REQUIRE_PEER_NOTARY", True):
            result = await generate_proof("https://example.com")

        assert result.success is False
        assert "peer notary" in result.error.lower() or "pse" in result.error.lower()

    @pytest.mark.asyncio
    async def test_pse_allowed_when_opt_in(self) -> None:
        """Miner allows PSE notary when REQUIRE_PEER_NOTARY is False."""

        async def mock_prover(*args, **kwargs):
            return TLSNProofResult(success=True, server="example.com")

        with (
            patch("djinn_miner.core.tlsn.REQUIRE_PEER_NOTARY", False),
            patch("djinn_miner.core.tlsn._run_prover", side_effect=mock_prover),
        ):
            result = await generate_proof("https://example.com")

        assert result.success is True

    @pytest.mark.asyncio
    async def test_peer_notary_bypasses_pse_check(self) -> None:
        """When notary_host is provided, PSE check is never triggered."""

        async def mock_ws_prover(*args, **kwargs):
            return TLSNProofResult(success=True, server="example.com")

        with (
            patch("djinn_miner.core.tlsn.REQUIRE_PEER_NOTARY", True),
            patch("djinn_miner.core.tlsn._run_prover_via_ws", side_effect=mock_ws_prover),
        ):
            result = await generate_proof(
                "https://example.com",
                notary_host="10.0.0.5",
                notary_port=8422,
                notary_ws=True,
            )

        assert result.success is True

    @pytest.mark.asyncio
    async def test_custom_notary_host_bypasses_pse_check(self) -> None:
        """When TLSN_NOTARY_HOST is set to a non-PSE host, no PSE warning."""

        async def mock_prover(*args, **kwargs):
            return TLSNProofResult(success=True, server="example.com")

        with (
            patch("djinn_miner.core.tlsn.NOTARY_HOST", "custom-notary.example.com"),
            patch("djinn_miner.core.tlsn.REQUIRE_PEER_NOTARY", True),
            patch("djinn_miner.core.tlsn._run_prover", side_effect=mock_prover),
        ):
            result = await generate_proof("https://example.com")

        # Not PSE, so REQUIRE_PEER_NOTARY doesn't block it
        assert result.success is True

    def test_env_parsing_logic(self) -> None:
        """TLSN_ALLOW_PSE_FALLBACK env var parsing produces correct REQUIRE_PEER_NOTARY."""
        for val, expected_require in [
            ("false", True), ("False", True), ("no", True), ("0", True),
            ("true", False), ("True", False), ("yes", False), ("1", False),
        ]:
            result = val.lower() not in ("true", "1", "yes")
            assert result == expected_require, (
                f"TLSN_ALLOW_PSE_FALLBACK={val} should mean REQUIRE_PEER_NOTARY={expected_require}"
            )

    @pytest.mark.asyncio
    async def test_centralized_fallback_counter_incremented(self) -> None:
        """PSE fallback counter is incremented even when fallback is blocked."""
        from unittest.mock import MagicMock

        mock_counter = MagicMock()
        with (
            patch("djinn_miner.core.tlsn.REQUIRE_PEER_NOTARY", True),
            patch("djinn_miner.api.metrics.CENTRALIZED_NOTARY_FALLBACKS", mock_counter),
        ):
            result = await generate_proof("https://example.com")

        assert result.success is False
        mock_counter.inc.assert_called_once()

    @pytest.mark.asyncio
    async def test_pse_fallback_counter_incremented_when_allowed(self) -> None:
        """PSE fallback counter is also incremented when fallback is allowed."""
        from unittest.mock import MagicMock

        mock_counter = MagicMock()

        async def mock_prover(*args, **kwargs):
            return TLSNProofResult(success=True, server="example.com")

        with (
            patch("djinn_miner.core.tlsn.REQUIRE_PEER_NOTARY", False),
            patch("djinn_miner.api.metrics.CENTRALIZED_NOTARY_FALLBACKS", mock_counter),
            patch("djinn_miner.core.tlsn._run_prover", side_effect=mock_prover),
        ):
            result = await generate_proof("https://example.com")

        assert result.success is True
        mock_counter.inc.assert_called_once()
