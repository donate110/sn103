"""Shared utility for spawning ephemeral TLSNotary notary processes.

Each call starts a short-lived notary binary on a random port, waits for
it to accept connections, and returns the process handle and port. The
caller is responsible for killing the process when done.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import socket

import structlog

from djinn_miner.core.tlsn_bootstrap import ensure_binary

log = structlog.get_logger()

# Default key path, same as notary_sidecar.py
_DEFAULT_KEY_PATH = os.getenv(
    "NOTARY_KEY_PATH",
    os.path.expanduser("~/.local/share/djinn/notary-key.bin"),
)


async def spawn_ephemeral_notary(
    key_path: str = _DEFAULT_KEY_PATH,
) -> tuple[asyncio.subprocess.Process, int] | None:
    """Spawn a short-lived notary process on a random port.

    Finds a free port, starts the ``djinn-tlsn-notary`` binary, and waits
    up to 4 seconds for it to accept TCP connections. Returns ``(process,
    port)`` on success or ``None`` if the binary is missing or fails to
    start.

    Args:
        key_path: Path to the notary's secp256k1 key file.

    Returns:
        Tuple of (process, port) on success, None on failure.
    """
    binary = shutil.which(ensure_binary("djinn-tlsn-notary"))
    if not binary:
        return None

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    env = os.environ.copy()
    env["RUST_LOG"] = "warn"

    try:
        proc = await asyncio.create_subprocess_exec(
            binary,
            "--port",
            str(port),
            "--key",
            key_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            env=env,
        )
        # Wait up to 4 seconds for the notary to accept connections
        for _ in range(40):
            await asyncio.sleep(0.1)
            try:
                r, w = await asyncio.wait_for(
                    asyncio.open_connection("127.0.0.1", port),
                    timeout=0.5,
                )
                w.close()
                await w.wait_closed()
                return proc, port
            except (ConnectionRefusedError, TimeoutError, OSError):
                if proc.returncode is not None:
                    return None
        log.warning("ephemeral_notary_start_timeout", port=port)
        proc.kill()
        return None
    except Exception as e:
        log.warning("ephemeral_notary_spawn_failed", error=str(e))
        return None
