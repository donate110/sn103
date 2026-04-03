"""Djinn Protocol Bittensor Validator."""

import subprocess as _sp
from pathlib import Path as _Path

_dir = _Path(__file__).parent
_OURS = int((_dir / "VERSION").read_text().strip())
__version__ = str(_OURS)

try:
    _total = int(_sp.check_output(
        ["git", "rev-list", "--count", "HEAD"],
        stderr=_sp.DEVNULL, cwd=_dir,
    ).decode().strip())
    _extra = _total - _OURS
    if _extra > 0:
        __version__ = f"{_OURS}+{_extra}"
    elif _extra == 0:
        __version__ = str(_OURS)
    else:
        __version__ = str(_total)
except Exception:
    pass
