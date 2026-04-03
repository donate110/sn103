"""Djinn Protocol Bittensor miner — line availability checking and TLSNotary proof generation."""

import subprocess as _sp
from pathlib import Path as _Path

__version__ = "0"

try:
    # Find the latest release tag (e.g. v985) and count commits since it
    _desc = _sp.check_output(
        ["git", "describe", "--tags", "--match", "v[0-9]*", "--long"],
        stderr=_sp.DEVNULL,
        cwd=_Path(__file__).parent,
    ).decode().strip()
    # Format: v985-3-gabcdef (tag, commits since, hash)
    _parts = _desc.rsplit("-", 2)
    _tag = _parts[0].lstrip("v")
    _extra = int(_parts[1])
    __version__ = _tag if _extra == 0 else f"{_tag}+{_extra}"
except Exception:
    try:
        __version__ = (_Path(__file__).parent / "VERSION").read_text().strip()
    except Exception:
        pass
