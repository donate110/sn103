"""Cloudflared binary management: locate, download, verify."""

from __future__ import annotations

import hashlib
import os
import platform
import shutil
import stat
import urllib.request

import structlog

log = structlog.get_logger()

# Official GitHub release URLs by platform
_RELEASE_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download"
_BINARIES = {
    ("Linux", "x86_64"): "cloudflared-linux-amd64",
    ("Linux", "aarch64"): "cloudflared-linux-arm64",
    ("Darwin", "x86_64"): "cloudflared-darwin-amd64.tgz",
    ("Darwin", "arm64"): "cloudflared-darwin-arm64.tgz",
}


def _platform_key() -> tuple[str, str]:
    return (platform.system(), platform.machine())


def locate_or_download(
    preferred_path: str = "",
    expected_checksum: str = "",
    install_dir: str = "",
) -> str | None:
    """Find cloudflared on PATH or download it.

    Returns the path to the binary, or None if unavailable.
    """
    # 1. Explicit path
    if preferred_path and os.path.isfile(preferred_path):
        if _verify_checksum(preferred_path, expected_checksum):
            return preferred_path
        log.warning("cloudflared_checksum_mismatch", path=preferred_path)

    # 2. Already on PATH
    found = shutil.which("cloudflared")
    if found:
        log.info("cloudflared_found", path=found)
        return found

    # 3. Download
    key = _platform_key()
    filename = _BINARIES.get(key)
    if not filename:
        log.error("cloudflared_unsupported_platform", system=key[0], arch=key[1])
        return None

    dest_dir = install_dir or os.path.expanduser("~/.djinn-shield")
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, "cloudflared")

    if os.path.isfile(dest):
        if _verify_checksum(dest, expected_checksum):
            return dest
        log.info("cloudflared_stale_binary", path=dest)

    url = f"{_RELEASE_BASE}/{filename}"
    log.info("cloudflared_downloading", url=url, dest=dest)
    try:
        urllib.request.urlretrieve(url, dest)
        os.chmod(dest, os.stat(dest).st_mode | stat.S_IEXEC)
        if expected_checksum and not _verify_checksum(dest, expected_checksum):
            log.error("cloudflared_download_checksum_failed", dest=dest)
            os.remove(dest)
            return None
        log.info("cloudflared_installed", path=dest)
        return dest
    except Exception as e:
        log.error("cloudflared_download_failed", error=str(e))
        return None


def _verify_checksum(path: str, expected: str) -> bool:
    """Verify SHA256 checksum. Returns True if expected is empty (skip)."""
    if not expected:
        return True
    sha = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            sha.update(chunk)
    return sha.hexdigest() == expected.lower()
