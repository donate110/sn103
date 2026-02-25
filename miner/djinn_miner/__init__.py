"""Djinn Protocol Bittensor miner — line availability checking and TLSNotary proof generation."""

import subprocess as _sp

__version__ = "0.1.0"

try:
    _count = _sp.check_output(
        ["git", "rev-list", "--count", "HEAD"],
        stderr=_sp.DEVNULL,
    ).decode().strip()
    __version__ = f"0.1.{_count}"
except Exception:
    pass
