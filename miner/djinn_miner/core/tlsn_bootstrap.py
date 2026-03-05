"""Auto-download TLSNotary binaries if not found locally.

On first run, checks for djinn-tlsn-prover (miner) and djinn-tlsn-verifier
(validator). If missing, downloads pre-built binaries from the latest GitHub
release of Djinn-Inc/djinn and installs them to ~/.local/bin/.

Can be overridden with TLSN_PROVER_BINARY / TLSN_VERIFIER_BINARY env vars
pointing to existing binaries.
"""

from __future__ import annotations

import os
import platform
import shutil
import stat
import tarfile
import tempfile
import urllib.request

import structlog

log = structlog.get_logger()

GITHUB_REPO = "Djinn-Inc/djinn"
INSTALL_DIR = os.path.expanduser("~/.local/bin")
BINARIES = ("djinn-tlsn-prover", "djinn-tlsn-verifier")


def _detect_platform() -> str | None:
    """Return the platform suffix for release asset names, or None if unsupported."""
    system = platform.system().lower()
    machine = platform.machine().lower()

    os_name = {"linux": "linux", "darwin": "macos"}.get(system)
    arch = {"x86_64": "x86_64", "amd64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}.get(machine)

    if not os_name or not arch:
        return None
    return f"{os_name}-{arch}"


def _latest_release_tag() -> str | None:
    """Fetch the latest release tag from GitHub."""
    url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/vnd.github.v3+json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            import json
            data = json.loads(resp.read())
            return data.get("tag_name")
    except Exception as e:
        log.debug("tlsn_bootstrap_release_check_failed", error=str(e))
        return None


def _download_and_install(tag: str, plat: str) -> bool:
    """Download the release tarball and extract binaries to INSTALL_DIR."""
    asset_name = f"djinn-tlsn-tools-{plat}.tar.gz"
    url = f"https://github.com/{GITHUB_REPO}/releases/download/{tag}/{asset_name}"

    log.info("tlsn_bootstrap_downloading", url=url, install_dir=INSTALL_DIR)

    try:
        os.makedirs(INSTALL_DIR, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmpdir:
            archive_path = os.path.join(tmpdir, asset_name)
            urllib.request.urlretrieve(url, archive_path)

            with tarfile.open(archive_path, "r:gz") as tar:
                # Security: only extract known binary names
                for member in tar.getmembers():
                    basename = os.path.basename(member.name)
                    if basename in BINARIES:
                        member.name = basename  # flatten path
                        tar.extract(member, tmpdir)

            for binary in BINARIES:
                src = os.path.join(tmpdir, binary)
                dst = os.path.join(INSTALL_DIR, binary)
                if os.path.isfile(src):
                    shutil.move(src, dst)
                    os.chmod(dst, os.stat(dst).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
                    log.info("tlsn_bootstrap_installed", binary=binary, path=dst)

        return True
    except Exception as e:
        log.warning("tlsn_bootstrap_download_failed", error=str(e))
        return False


def ensure_binary(name: str) -> str:
    """Ensure a TLSNotary binary is available, downloading if necessary.

    Args:
        name: Binary name, e.g. "djinn-tlsn-prover" or "djinn-tlsn-verifier"

    Returns:
        Path to the binary (may be just the name if it's on PATH).
    """
    # Check env override
    env_key = "TLSN_PROVER_BINARY" if "prover" in name else "TLSN_VERIFIER_BINARY"
    env_val = os.getenv(env_key)
    if env_val:
        if shutil.which(env_val) or (os.path.isfile(env_val) and os.access(env_val, os.X_OK)):
            return env_val

    # Check if already on PATH
    found = shutil.which(name)
    if found:
        return found

    # Check install dir
    installed = os.path.join(INSTALL_DIR, name)
    if os.path.isfile(installed) and os.access(installed, os.X_OK):
        return installed

    # Try to download
    plat = _detect_platform()
    if not plat:
        log.warning("tlsn_bootstrap_unsupported_platform", system=platform.system(), machine=platform.machine())
        return name  # Return bare name; will fail at runtime with clear error

    tag = _latest_release_tag()
    if not tag:
        log.warning("tlsn_bootstrap_no_release", repo=GITHUB_REPO)
        return name

    if _download_and_install(tag, plat):
        if os.path.isfile(installed) and os.access(installed, os.X_OK):
            return installed

    return name  # Fallback to bare name
