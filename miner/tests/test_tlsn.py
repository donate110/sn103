"""Tests for TLSNotary proof generation wrapper."""

from __future__ import annotations

import asyncio
import base64
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from djinn_miner.core.tlsn import (
    TLSNProofResult,
    generate_proof,
    is_available,
)
from djinn_miner.core.proof import (
    CapturedSession,
    ProofGenerator,
    SessionCapture,
)


class TestIsAvailable:
    """Test binary availability detection."""

    @patch("djinn_miner.core.tlsn.shutil.which")
    def test_available_via_which(self, mock_which: MagicMock) -> None:
        mock_which.return_value = "/usr/local/bin/djinn-tlsn-prover"
        assert is_available() is True

    @patch("djinn_miner.core.tlsn.shutil.which")
    @patch("djinn_miner.core.tlsn.os.path.isfile")
    def test_not_available(
        self, mock_isfile: MagicMock, mock_which: MagicMock
    ) -> None:
        mock_which.return_value = None
        mock_isfile.return_value = False
        assert is_available() is False


class TestGenerateProof:
    """Test the TLSNotary proof generation subprocess call."""

    @pytest.mark.asyncio
    async def test_success(self) -> None:
        """Successful proof generation creates a presentation file."""
        fake_presentation = b"\x00\x01\x02\x03" * 100

        async def mock_subprocess(*args, **kwargs):
            proc = MagicMock()
            proc.returncode = 0
            # args are passed as positional: (binary, "--url", url, "--notary-host", ...)
            # Find the --output flag and write the fake presentation there
            arg_list = list(args)
            for i, a in enumerate(arg_list):
                if a == "--output" and i + 1 < len(arg_list):
                    import pathlib
                    pathlib.Path(arg_list[i + 1]).write_bytes(fake_presentation)
                    break

            stdout = json.dumps({"status": "success", "server": "api.the-odds-api.com"}).encode()
            proc.communicate = AsyncMock(return_value=(stdout, b""))
            return proc

        with (
            patch("djinn_miner.core.tlsn.asyncio.create_subprocess_exec", side_effect=mock_subprocess),
            patch("djinn_miner.core.tlsn.NOTARY_HOST", "localhost"),
        ):
            result = await generate_proof(
                "https://api.the-odds-api.com/v4/sports/nba/odds?apiKey=test",
                timeout=10.0,
            )

        assert result.success is True
        assert result.presentation_bytes == fake_presentation
        assert result.server == "api.the-odds-api.com"

    @pytest.mark.asyncio
    async def test_binary_not_found(self) -> None:
        """Missing binary returns graceful error."""
        with (
            patch(
                "djinn_miner.core.tlsn.asyncio.create_subprocess_exec",
                side_effect=FileNotFoundError("not found"),
            ),
            patch("djinn_miner.core.tlsn.NOTARY_HOST", "localhost"),
        ):
            result = await generate_proof("https://example.com")

        assert result.success is False
        assert "not found" in result.error

    @pytest.mark.asyncio
    async def test_timeout(self) -> None:
        """Timeout returns graceful error and kills the process."""
        async def mock_subprocess(*args, **kwargs):
            proc = MagicMock()
            # Use MagicMock (not async) for communicate — the mocked
            # wait_for raises TimeoutError before awaiting the coroutine,
            # so an async function would create an unawaited coroutine warning.
            proc.communicate = MagicMock()
            proc.wait = AsyncMock()
            return proc

        call_count = 0

        async def mock_wait_for(coro, timeout):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # First call is proc.communicate() — raise timeout
                raise asyncio.TimeoutError()
            # Subsequent calls (proc.wait()) — succeed
            return await coro

        with (
            patch("djinn_miner.core.tlsn.asyncio.create_subprocess_exec", side_effect=mock_subprocess),
            patch("djinn_miner.core.tlsn.asyncio.wait_for", side_effect=mock_wait_for),
            patch("djinn_miner.core.tlsn.NOTARY_HOST", "localhost"),
        ):
            result = await generate_proof("https://example.com", timeout=0.1)

        assert result.success is False
        assert "timed out" in result.error

    @pytest.mark.asyncio
    async def test_nonzero_exit(self) -> None:
        """Non-zero exit code returns error."""
        async def mock_subprocess(*args, **kwargs):
            proc = MagicMock()
            proc.returncode = 1
            proc.communicate = AsyncMock(return_value=(b"", b"TLS handshake failed"))
            return proc

        with (
            patch("djinn_miner.core.tlsn.asyncio.create_subprocess_exec", side_effect=mock_subprocess),
            patch("djinn_miner.core.tlsn.NOTARY_HOST", "localhost"),
        ):
            result = await generate_proof("https://example.com")

        assert result.success is False
        assert "TLS handshake failed" in result.error


class TestProofGeneratorTLSNIntegration:
    """Test that ProofGenerator correctly tries TLSNotary first."""

    @pytest.mark.asyncio
    async def test_tlsn_success_produces_tlsnotary_type(self) -> None:
        """When TLSNotary succeeds, proof type is 'tlsnotary'."""
        capture = SessionCapture()
        session = CapturedSession(
            query_id="test-1",
            request_url="https://api.the-odds-api.com/v4/sports/nba/odds",
            request_params={"apiKey": "test123", "regions": "us"},
            response_status=200,
            response_body=b'[{"id": "event1"}]',
        )
        capture.record(session)

        fake_presentation = b"fake_presentation_bytes_here"
        tlsn_result = TLSNProofResult(
            success=True,
            presentation_bytes=fake_presentation,
            server="api.the-odds-api.com",
        )

        with (
            patch("djinn_miner.core.proof.tlsn_module.is_available", return_value=True),
            patch("djinn_miner.core.proof.tlsn_module.generate_proof", return_value=tlsn_result),
        ):
            gen = ProofGenerator(session_capture=capture)
            gen._tlsn_available = True
            result = await gen.generate("test-1")

        assert result.status == "submitted"
        msg = json.loads(result.message)
        assert msg["type"] == "tlsnotary"
        assert msg["server"] == "api.the-odds-api.com"
        # Presentation should be base64-encoded in the message
        decoded = base64.b64decode(msg["presentation"])
        assert decoded == fake_presentation

    @pytest.mark.asyncio
    async def test_tlsn_failure_falls_back_to_http_attestation(self) -> None:
        """When TLSNotary fails, falls back to HTTP attestation."""
        capture = SessionCapture()
        session = CapturedSession(
            query_id="test-2",
            request_url="https://api.the-odds-api.com/v4/sports/nba/odds",
            response_status=200,
            response_body=b'[{"id": "e1", "bookmakers": [{"key": "bk1"}]}]',
        )
        capture.record(session)

        tlsn_result = TLSNProofResult(success=False, error="connection refused")

        with (
            patch("djinn_miner.core.proof.tlsn_module.is_available", return_value=True),
            patch("djinn_miner.core.proof.tlsn_module.generate_proof", return_value=tlsn_result),
        ):
            gen = ProofGenerator(session_capture=capture)
            gen._tlsn_available = True
            result = await gen.generate("test-2")

        msg = json.loads(result.message)
        assert msg["type"] == "http_attestation"

    @pytest.mark.asyncio
    async def test_tlsn_not_available_uses_http_attestation(self) -> None:
        """When TLSNotary binary is missing, uses HTTP attestation directly."""
        capture = SessionCapture()
        session = CapturedSession(
            query_id="test-3",
            request_url="https://api.example.com/odds",
            response_status=200,
            response_body=b'[{"id": "e1", "bookmakers": []}]',
        )
        capture.record(session)

        with patch("djinn_miner.core.proof.tlsn_module.is_available", return_value=False):
            gen = ProofGenerator(session_capture=capture)
            assert gen.tlsn_available is False
            result = await gen.generate("test-3")

        msg = json.loads(result.message)
        assert msg["type"] == "http_attestation"
