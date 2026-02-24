"""Auto-update watchtower for Djinn Protocol nodes.

Polls the remote git repository for new commits on the configured branch.
When an update is detected, pulls the latest code, reinstalls dependencies
with ``uv sync``, and restarts the process via ``os.execv``.

Enable by setting ``AUTO_UPDATE=true`` in the environment. Configuration:

    AUTO_UPDATE            – "true" to enable (default: "false")
    AUTO_UPDATE_BRANCH     – branch to track (default: "main")
    AUTO_UPDATE_INTERVAL   – seconds between checks (default: 300)
    AUTO_UPDATE_REPO_ROOT  – path to the git repo root; auto-detected if unset
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

import structlog

log = structlog.get_logger()

_ENABLED = os.getenv("AUTO_UPDATE", "false").lower() in ("true", "1", "yes")
_BRANCH = os.getenv("AUTO_UPDATE_BRANCH", "main")
_INTERVAL = int(os.getenv("AUTO_UPDATE_INTERVAL", "300"))


def _find_repo_root() -> Path | None:
    """Walk up from this file to find the git repo root."""
    override = os.getenv("AUTO_UPDATE_REPO_ROOT")
    if override:
        p = Path(override)
        if (p / ".git").exists():
            return p
        return None
    d = Path(__file__).resolve().parent
    for _ in range(10):
        if (d / ".git").exists():
            return d
        d = d.parent
    return None


def _run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=120
    )


def _local_sha(repo: Path) -> str | None:
    """Return the current HEAD sha."""
    try:
        r = _run(["git", "rev-parse", "HEAD"], repo)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


def _remote_sha(repo: Path, branch: str) -> str | None:
    """Return the latest sha on the remote branch."""
    try:
        r = _run(["git", "ls-remote", "origin", branch], repo)
        if r.returncode != 0 or not r.stdout.strip():
            return None
        return r.stdout.split()[0]
    except Exception:
        return None


def _pull(repo: Path, branch: str) -> bool:
    """Pull the latest code. Returns True on success."""
    try:
        r = _run(["git", "pull", "origin", branch], repo)
        if r.returncode != 0:
            log.error("watchtower_pull_failed", stderr=r.stderr[:500])
            return False
        log.info("watchtower_pulled", stdout=r.stdout.strip()[:200])
        return True
    except Exception as e:
        log.error("watchtower_pull_error", error=str(e))
        return False


def _install_deps(package_dir: Path) -> bool:
    """Run ``uv sync`` in the package directory. Returns True on success."""
    try:
        r = _run(["uv", "sync"], package_dir)
        if r.returncode != 0:
            log.error("watchtower_uv_sync_failed", stderr=r.stderr[:500])
            return False
        log.info("watchtower_deps_installed")
        return True
    except FileNotFoundError:
        log.warning("watchtower_uv_not_found", msg="uv not installed, skipping dep install")
        return True
    except Exception as e:
        log.error("watchtower_install_error", error=str(e))
        return False


def _restart() -> None:
    """Restart the current process in-place."""
    log.info("watchtower_restarting", argv=sys.argv)
    os.execv(sys.executable, [sys.executable] + sys.argv)


async def watch_loop(package_dir: Path | None = None) -> None:
    """Main watchtower loop. Runs forever, checking for updates.

    Args:
        package_dir: Directory containing pyproject.toml for ``uv sync``.
                     If None, uses the repo root.
    """
    if not _ENABLED:
        log.info("watchtower_disabled", msg="Set AUTO_UPDATE=true to enable")
        return

    repo = _find_repo_root()
    if repo is None:
        log.error("watchtower_no_repo", msg="Could not find git repository root")
        return

    if package_dir is None:
        package_dir = repo

    log.info(
        "watchtower_started",
        branch=_BRANCH,
        interval_s=_INTERVAL,
        repo=str(repo),
        package_dir=str(package_dir),
    )

    while True:
        await asyncio.sleep(_INTERVAL)
        try:
            local = _local_sha(repo)
            remote = _remote_sha(repo, _BRANCH)

            if local is None or remote is None:
                log.debug("watchtower_skip", local=local, remote=remote)
                continue

            if local == remote:
                log.debug("watchtower_up_to_date", sha=local[:8])
                continue

            log.info(
                "watchtower_update_detected",
                local=local[:8],
                remote=remote[:8],
                branch=_BRANCH,
            )

            if not _pull(repo, _BRANCH):
                continue

            if not _install_deps(package_dir):
                continue

            _restart()

        except Exception as e:
            log.error("watchtower_error", error=str(e))
