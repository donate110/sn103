"""Djinn Protocol Bittensor Validator."""

import subprocess as _sp
from pathlib import Path as _Path

__version__ = "0"

try:
    _desc = _sp.check_output(
        ["git", "describe", "--tags", "--match", "v[0-9]*", "--long"],
        stderr=_sp.DEVNULL,
        cwd=_Path(__file__).parent,
    ).decode().strip()
    _parts = _desc.rsplit("-", 2)
    _tag = _parts[0].lstrip("v")
    _extra = int(_parts[1])
    __version__ = _tag if _extra == 0 else f"{_tag}+{_extra}"
except Exception:
    try:
        __version__ = (_Path(__file__).parent / "VERSION").read_text().strip()
    except Exception:
        pass
