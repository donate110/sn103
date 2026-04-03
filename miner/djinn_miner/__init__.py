"""Djinn Protocol Bittensor miner — line availability checking and TLSNotary proof generation."""

import subprocess as _sp
from pathlib import Path as _Path

_dir = _Path(__file__).parent
_BASE = (_dir / "VERSION").read_text().strip()        # e.g. "0.9.0"
_COMMIT_BASE = (_dir / "COMMIT_BASE").read_text().strip()  # e.g. "983"
__version__ = _BASE

try:
    _total = int(_sp.check_output(
        ["git", "rev-list", "--count", "HEAD"],
        stderr=_sp.DEVNULL, cwd=_dir,
    ).decode().strip())
    _extra = _total - int(_COMMIT_BASE)
    if _extra > 0:
        __version__ = f"{_BASE}+{_extra}"
    elif _extra < 0:
        __version__ = f"{_BASE}-{abs(_extra)}"
except Exception:
    pass
