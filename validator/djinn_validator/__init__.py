"""Djinn Protocol Bittensor Validator."""

import subprocess as _sp

__version__ = "0.1.0"

try:
    _sha = _sp.check_output(
        ["git", "rev-parse", "--short", "HEAD"],
        stderr=_sp.DEVNULL,
    ).decode().strip()
    __version__ = f"0.1.0+{_sha}"
except Exception:
    pass
