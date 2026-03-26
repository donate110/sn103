"""Tests for the watchtower auto-update module."""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from djinn_miner.utils.watchtower import (
    _find_repo_root,
    _local_sha,
    _remote_sha,
    _verify_commit_signature,
    watch_loop,
)


class TestFindRepoRoot:
    def test_returns_path_when_git_dir_exists(self, tmp_path: Path) -> None:
        (tmp_path / ".git").mkdir()
        with patch.dict("os.environ", {"AUTO_UPDATE_REPO_ROOT": str(tmp_path)}):
            result = _find_repo_root()
        assert result == tmp_path

    def test_returns_none_when_no_git_dir(self, tmp_path: Path) -> None:
        with patch.dict("os.environ", {"AUTO_UPDATE_REPO_ROOT": str(tmp_path)}):
            result = _find_repo_root()
        assert result is None


class TestLocalSha:
    def test_returns_sha(self, tmp_path: Path) -> None:
        with patch("djinn_miner.utils.watchtower._run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="abc123\n")
            assert _local_sha(tmp_path) == "abc123"

    def test_returns_none_on_failure(self, tmp_path: Path) -> None:
        with patch("djinn_miner.utils.watchtower._run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stdout="")
            assert _local_sha(tmp_path) is None


class TestRemoteSha:
    def test_returns_sha(self, tmp_path: Path) -> None:
        with patch("djinn_miner.utils.watchtower._run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0, stdout="def456\trefs/heads/main\n"
            )
            assert _remote_sha(tmp_path, "main") == "def456"

    def test_returns_none_on_failure(self, tmp_path: Path) -> None:
        with patch("djinn_miner.utils.watchtower._run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stdout="")
            assert _remote_sha(tmp_path, "main") is None


class TestVerifyCommitSignature:
    @patch("djinn_miner.utils.watchtower._run")
    def test_good_signature_logs_info(self, mock_run: MagicMock) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="G|abc123def456|Alice\n",
        )
        _verify_commit_signature(Path("/fake"))
        mock_run.assert_called_once()

    @patch("djinn_miner.utils.watchtower._run")
    def test_untrusted_signature_logs_info(self, mock_run: MagicMock) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="U|abc123def456|Bob\n",
        )
        _verify_commit_signature(Path("/fake"))
        mock_run.assert_called_once()

    @patch("djinn_miner.utils.watchtower._run")
    def test_unsigned_commit_logs_warning(self, mock_run: MagicMock) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="N|abc123def456|Charlie\n",
        )
        _verify_commit_signature(Path("/fake"))
        mock_run.assert_called_once()

    @patch("djinn_miner.utils.watchtower._run")
    def test_bad_signature_logs_warning(self, mock_run: MagicMock) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="B|abc123def456|Eve\n",
        )
        _verify_commit_signature(Path("/fake"))
        mock_run.assert_called_once()

    @patch("djinn_miner.utils.watchtower._run")
    def test_git_failure_logs_warning(self, mock_run: MagicMock) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="", stderr="fatal: not a repo",
        )
        _verify_commit_signature(Path("/fake"))

    @patch("djinn_miner.utils.watchtower._run")
    def test_parse_error_logs_warning(self, mock_run: MagicMock) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="garbage\n",
        )
        _verify_commit_signature(Path("/fake"))

    @patch("djinn_miner.utils.watchtower._run", side_effect=Exception("boom"))
    def test_exception_logs_warning(self, mock_run: MagicMock) -> None:
        _verify_commit_signature(Path("/fake"))


class TestWatchLoop:
    @pytest.mark.asyncio
    async def test_disabled_when_explicitly_off(self) -> None:
        with patch("djinn_miner.utils.watchtower._ENABLED", False):
            await asyncio.wait_for(watch_loop(), timeout=2.0)

    @pytest.mark.asyncio
    async def test_no_repo_root_exits(self) -> None:
        with patch.dict("os.environ", {"AUTO_UPDATE": "true"}):
            with patch(
                "djinn_miner.utils.watchtower._find_repo_root", return_value=None
            ):
                await asyncio.wait_for(watch_loop(), timeout=2.0)
