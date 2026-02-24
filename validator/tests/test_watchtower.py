"""Tests for the watchtower auto-update module."""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from djinn_validator.utils import watchtower
from djinn_validator.utils.watchtower import (
    _find_repo_root,
    _install_deps,
    _local_sha,
    _pull,
    _remote_sha,
    watch_loop,
)


class TestConfig:
    def test_disabled_by_default(self) -> None:
        assert not watchtower._ENABLED

    def test_default_branch(self) -> None:
        assert watchtower._BRANCH == "main"

    def test_default_interval(self) -> None:
        assert watchtower._INTERVAL == 300


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

    def test_empty_override_falls_back_to_walk(self) -> None:
        with patch.dict("os.environ", {"AUTO_UPDATE_REPO_ROOT": ""}):
            root = _find_repo_root()
            # Module lives inside the djinn repo, should find it
            assert root is not None


class TestLocalSha:
    def test_returns_sha(self, tmp_path: Path) -> None:
        with patch("djinn_validator.utils.watchtower._run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="abc123\n")
            assert _local_sha(tmp_path) == "abc123"

    def test_returns_none_on_failure(self, tmp_path: Path) -> None:
        with patch("djinn_validator.utils.watchtower._run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stdout="")
            assert _local_sha(tmp_path) is None


class TestRemoteSha:
    def test_returns_sha(self, tmp_path: Path) -> None:
        with patch("djinn_validator.utils.watchtower._run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0, stdout="def456\trefs/heads/main\n"
            )
            assert _remote_sha(tmp_path, "main") == "def456"

    def test_returns_none_on_failure(self, tmp_path: Path) -> None:
        with patch("djinn_validator.utils.watchtower._run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stdout="")
            assert _remote_sha(tmp_path, "main") is None


class TestPull:
    @patch("djinn_validator.utils.watchtower._run")
    def test_success(self, mock_run: MagicMock) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="Already up to date.",
        )
        assert _pull(Path("/fake"), "main") is True

    @patch("djinn_validator.utils.watchtower._run")
    def test_failure(self, mock_run: MagicMock) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="", stderr="merge conflict",
        )
        assert _pull(Path("/fake"), "main") is False


class TestInstallDeps:
    @patch("djinn_validator.utils.watchtower._run")
    def test_success(self, mock_run: MagicMock) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="",
        )
        assert _install_deps(Path("/fake")) is True

    @patch("djinn_validator.utils.watchtower._run")
    def test_failure(self, mock_run: MagicMock) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="", stderr="error",
        )
        assert _install_deps(Path("/fake")) is False

    @patch("djinn_validator.utils.watchtower._run", side_effect=FileNotFoundError)
    def test_uv_not_found_returns_true(self, mock_run: MagicMock) -> None:
        assert _install_deps(Path("/fake")) is True


class TestWatchLoop:
    @pytest.mark.asyncio
    async def test_disabled_by_default(self) -> None:
        """watch_loop returns immediately when AUTO_UPDATE is not set."""
        with patch.object(watchtower, "_ENABLED", False):
            await asyncio.wait_for(watch_loop(), timeout=2.0)

    @pytest.mark.asyncio
    async def test_no_repo_root_exits(self) -> None:
        with patch.object(watchtower, "_ENABLED", True), \
             patch.object(watchtower, "_find_repo_root", return_value=None):
            await asyncio.wait_for(watch_loop(), timeout=2.0)

    @pytest.mark.asyncio
    async def test_detects_update_and_restarts(self) -> None:
        with patch.object(watchtower, "_ENABLED", True), \
             patch.object(watchtower, "_INTERVAL", 0), \
             patch.object(watchtower, "_find_repo_root", return_value=Path("/fake")), \
             patch.object(watchtower, "_local_sha", return_value="aaa"), \
             patch.object(watchtower, "_remote_sha", return_value="bbb"), \
             patch.object(watchtower, "_pull", return_value=True) as mock_pull, \
             patch.object(watchtower, "_install_deps", return_value=True) as mock_deps, \
             patch.object(watchtower, "_restart") as mock_restart:
            mock_restart.side_effect = SystemExit(0)
            with pytest.raises(SystemExit):
                await watch_loop(package_dir=Path("/fake"))
            mock_pull.assert_called_once_with(Path("/fake"), "main")
            mock_deps.assert_called_once_with(Path("/fake"))
            mock_restart.assert_called_once()

    @pytest.mark.asyncio
    async def test_skips_when_up_to_date(self) -> None:
        call_count = 0

        original_sleep = asyncio.sleep

        async def _counting_sleep(secs: float) -> None:
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError

        with patch.object(watchtower, "_ENABLED", True), \
             patch.object(watchtower, "_INTERVAL", 0), \
             patch.object(watchtower, "_find_repo_root", return_value=Path("/fake")), \
             patch.object(watchtower, "_local_sha", return_value="same"), \
             patch.object(watchtower, "_remote_sha", return_value="same"), \
             patch.object(watchtower, "_pull") as mock_pull, \
             patch.object(watchtower, "_restart") as mock_restart, \
             patch("asyncio.sleep", side_effect=_counting_sleep):
            with pytest.raises(asyncio.CancelledError):
                await watch_loop(package_dir=Path("/fake"))
            mock_pull.assert_not_called()
            mock_restart.assert_not_called()

    @pytest.mark.asyncio
    async def test_continues_on_pull_failure(self) -> None:
        call_count = 0

        async def _counting_sleep(secs: float) -> None:
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError

        with patch.object(watchtower, "_ENABLED", True), \
             patch.object(watchtower, "_INTERVAL", 0), \
             patch.object(watchtower, "_find_repo_root", return_value=Path("/fake")), \
             patch.object(watchtower, "_local_sha", return_value="aaa"), \
             patch.object(watchtower, "_remote_sha", return_value="bbb"), \
             patch.object(watchtower, "_pull", return_value=False), \
             patch.object(watchtower, "_restart") as mock_restart, \
             patch("asyncio.sleep", side_effect=_counting_sleep):
            with pytest.raises(asyncio.CancelledError):
                await watch_loop(package_dir=Path("/fake"))
            mock_restart.assert_not_called()
