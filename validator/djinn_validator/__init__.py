"""Djinn Protocol Bittensor Validator."""

import subprocess as _sp

__version__ = "0"

try:
    __version__ = _sp.check_output(
        ["git", "rev-list", "--count", "HEAD"],
        stderr=_sp.DEVNULL,
    ).decode().strip()
except Exception:
    pass
