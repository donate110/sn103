"""Tests for the notary sidecar lifecycle manager."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from djinn_miner.core.notary_sidecar import NotaryInfo, NotarySidecar


class TestNotarySidecar:
    """Test NotarySidecar lifecycle."""

    def test_disabled_by_default(self) -> None:
        sidecar = NotarySidecar(enabled=False)
        assert sidecar.enabled is False
        assert sidecar.info.enabled is False

    @pytest.mark.asyncio
    async def test_start_when_disabled_returns_false(self) -> None:
        sidecar = NotarySidecar(enabled=False)
        result = await sidecar.start()
        assert result is False

    @pytest.mark.asyncio
    async def test_start_binary_not_found(self) -> None:
        with patch("djinn_miner.core.notary_sidecar.shutil.which", return_value=None):
            with patch("djinn_miner.core.notary_sidecar.os.path.isfile", return_value=False):
                sidecar = NotarySidecar(enabled=True)
                result = await sidecar.start()
                assert result is False

    @pytest.mark.asyncio
    async def test_start_success(self) -> None:
        """Successful start extracts pubkey from stderr and reports running."""
        fake_pubkey = "a" * 66

        async def mock_readline():
            return f'  pubkey={fake_pubkey} "Notary public key"\n'.encode()

        mock_stderr = MagicMock()
        mock_stderr.readline = mock_readline

        mock_proc = MagicMock()
        mock_proc.pid = 12345
        mock_proc.returncode = None
        mock_proc.stderr = mock_stderr

        with (
            patch("djinn_miner.core.notary_sidecar.shutil.which", return_value="/usr/bin/djinn-tlsn-notary"),
            patch("djinn_miner.core.notary_sidecar.os.makedirs"),
            patch("djinn_miner.core.notary_sidecar.asyncio.create_subprocess_exec", return_value=mock_proc),
        ):
            sidecar = NotarySidecar(enabled=True, port=7047, key_path="/tmp/test-key.bin")
            result = await sidecar.start()

        assert result is True
        assert sidecar.info.enabled is True
        assert sidecar.info.pubkey_hex == fake_pubkey
        assert sidecar.info.port == 7047
        assert sidecar.info.pid == 12345

    @pytest.mark.asyncio
    async def test_stop(self) -> None:
        mock_proc = MagicMock()
        mock_proc.returncode = None
        mock_proc.wait = AsyncMock(return_value=0)

        sidecar = NotarySidecar(enabled=True)
        sidecar._process = mock_proc
        sidecar._started = True

        await sidecar.stop()

        mock_proc.send_signal.assert_called_once()
        assert sidecar._started is False

    @pytest.mark.asyncio
    async def test_health_check_running(self) -> None:
        mock_proc = MagicMock()
        mock_proc.returncode = None

        sidecar = NotarySidecar(enabled=True)
        sidecar._process = mock_proc
        sidecar._started = True

        assert await sidecar.health_check() is True

    @pytest.mark.asyncio
    async def test_health_check_exited(self) -> None:
        mock_proc = MagicMock()
        mock_proc.returncode = 1

        sidecar = NotarySidecar(enabled=True)
        sidecar._process = mock_proc
        sidecar._started = True

        assert await sidecar.health_check() is False
        assert sidecar._started is False


class TestNotaryInfoEndpoint:
    """Test the /v1/notary/info API response model."""

    def test_info_disabled(self) -> None:
        info = NotaryInfo(enabled=False)
        assert info.enabled is False
        assert info.pubkey_hex == ""
        assert info.port == 0

    def test_info_enabled(self) -> None:
        info = NotaryInfo(
            enabled=True,
            pubkey_hex="abcdef1234567890" * 4,
            port=7047,
            pid=9999,
        )
        assert info.enabled is True
        assert len(info.pubkey_hex) == 64
        assert info.port == 7047
