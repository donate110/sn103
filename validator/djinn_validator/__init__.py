"""Djinn Protocol Bittensor Validator."""

import subprocess as _sp
from pathlib import Path as _Path

__version__ = "0"

try:
    __version__ = _sp.check_output(
        ["git", "rev-list", "--count", "HEAD"],
        stderr=_sp.DEVNULL,
        cwd=_Path(__file__).parent,
    ).decode().strip()
except Exception:
    # Not a git repo (e.g., pip install or copy deploy). Read from VERSION file.
    try:
        __version__ = (_Path(__file__).parent / "VERSION").read_text().strip()
    except Exception:
        pass
