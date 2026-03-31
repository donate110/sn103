"""TLSNotary proof generation via Rust CLI wrapper.

Calls the `djinn-tlsn-prover` binary to perform an MPC-TLS handshake with
a target server (e.g. The Odds API) via a TLSNotary Notary server. The
binary outputs a serialized Presentation file that validators can verify.

When the binary is not available (dev mode), falls back to HTTP attestation.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

import structlog

log = structlog.get_logger()

# Resolve binary: env override → PATH → ~/.local/bin → auto-download
from djinn_miner.core.tlsn_bootstrap import ensure_binary

_prover_binary_cache: str | None = None


def _get_prover_binary() -> str:
    """Lazily resolve and cache the prover binary path on first call."""
    global _prover_binary_cache
    if _prover_binary_cache is None:
        _prover_binary_cache = ensure_binary("djinn-tlsn-prover")
    return _prover_binary_cache


# Keep PROVER_BINARY as a lazy property for backward compat. All internal
# usage goes through _get_prover_binary() so the network call only happens
# on first actual use, not at import time.
def __getattr__(name: str) -> object:
    if name == "PROVER_BINARY":
        return _get_prover_binary()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

# Max age (seconds) before a prover process is considered stuck and killed.
_PROVER_MAX_AGE = int(os.getenv("TLSN_PROVER_MAX_AGE", "300"))

NOTARY_HOST = os.getenv("TLSN_NOTARY_HOST", "")
NOTARY_PORT = int(os.getenv("TLSN_NOTARY_PORT", "7047"))

# Headers whose values should be redacted from the proof
REDACT_HEADERS = os.getenv("TLSN_REDACT_HEADERS", "authorization,apikey,x-api-key")

# Max receive data for MPC circuit (bytes). Smaller = faster proofs for small responses.
# Default 0 = use dynamic sizing (512KB floor, scales up based on Content-Length preflight).
# Set explicitly to override dynamic sizing (e.g. for known-large responses).
MAX_RECV_DATA = int(os.getenv("TLSN_MAX_RECV_DATA", "0"))


@dataclass
class TLSNProofResult:
    """Result of a TLSNotary proof generation."""

    success: bool
    presentation_path: str | None = None
    presentation_bytes: bytes | None = None
    server: str = ""
    error: str = ""


def is_available() -> bool:
    """Check if the TLSNotary prover binary is available."""
    binary_path = _get_prover_binary()
    binary = shutil.which(binary_path)
    if binary:
        return True
    # Check if the configured path exists directly
    return os.path.isfile(binary_path) and os.access(binary_path, os.X_OK)


async def generate_proof(
    url: str,
    *,
    notary_host: str | None = None,
    notary_port: int | None = None,
    notary_ws: bool = False,
    notary_ws_port: int | None = None,
    notary_ticket: str | None = None,
    output_dir: str | None = None,
    timeout: float = 180.0,
) -> TLSNProofResult:
    """Generate a TLSNotary proof for an HTTPS request.

    Args:
        url: Full URL to fetch (with query params, including API key).
        notary_host: Notary server hostname. Defaults to TLSN_NOTARY_HOST env.
        notary_port: Notary server TCP port. Tried first via direct TCP.
        notary_ws: If True and direct TCP fails, fall back to WebSocket proxy.
        notary_ws_port: API port for WS fallback (ws://host:ws_port/v1/notary/ws).
        output_dir: Directory for the presentation file. Uses tempdir if None.
        timeout: Max seconds to wait for proof generation.

    Returns:
        TLSNProofResult with the serialized presentation bytes on success.
    """
    host = notary_host or NOTARY_HOST
    port = notary_port or NOTARY_PORT

    if not host:
        # Default to the local notary sidecar if no host is configured.
        # This lets the miner serve attestation requests even without a
        # peer notary assignment from the validator.
        from djinn_miner.core.notary_sidecar import NOTARY_PORT as _LOCAL_PORT
        host = "127.0.0.1"
        port = _LOCAL_PORT
        log.info("tlsn_using_local_notary_default", port=port)

    # Resolve redirects and probe response size. The prover can't follow
    # redirects, and knowing the size lets us right-size the MPC circuit.
    preflight_content_length: int | None = None
    try:
        import httpx

        async with httpx.AsyncClient(follow_redirects=True, timeout=10.0) as _rc:
            head = await _rc.head(url)
            final_url = str(head.url)
            if final_url != url:
                log.info("tlsn_redirect_resolved", original=url, final=final_url)
                url = final_url
            cl = head.headers.get("content-length")
            if cl and cl.isdigit():
                preflight_content_length = int(cl)
    except Exception as e:
        log.debug("tlsn_redirect_check_failed", error=str(e))

    # Create output file
    tmp_dir: str | None = None
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, "presentation.bin")
    else:
        tmp_dir = tempfile.mkdtemp(prefix="djinn-tlsn-")
        output_path = os.path.join(tmp_dir, "presentation.bin")

    # Right-size the MPC circuit based on preflight Content-Length.
    # Round up to the next power of two after doubling (2x headroom for
    # response variance, HTTP headers, and TLS framing overhead).
    # Floor of 512KB; falls back to 512KB when Content-Length is absent.
    # 256KB was too small for many real web pages, causing "connection closed
    # before message completed" errors.
    _MIN_RECV = 524_288  # 512 KB floor
    if preflight_content_length is not None and preflight_content_length > 0:
        raw = preflight_content_length * 2
        # Next power of two >= raw
        recv_data_size = 1 << (raw - 1).bit_length()
        recv_data_size = max(_MIN_RECV, recv_data_size)
        log.info(
            "tlsn_circuit_sized",
            content_length=preflight_content_length,
            max_recv_data=recv_data_size,
        )
    else:
        recv_data_size = _MIN_RECV

    try:
        # Try direct TCP first (works when peer notary binds 0.0.0.0).
        # If TCP is refused, fall back to WS bridge on the API port.
        if notary_host and port:
            import socket as _sock
            tcp_ok = False
            try:
                s = _sock.socket()
                s.settimeout(3)
                s.connect((host, port))
                s.close()
                tcp_ok = True
            except (ConnectionRefusedError, TimeoutError, OSError):
                pass

            if tcp_ok:
                log.info("tlsn_using_direct_tcp", host=host, port=port)
                return await _run_prover(url, host, port, output_path, timeout,
                                         max_recv_data=recv_data_size)

            # Direct TCP failed. Try WS bridge if we have an API port.
            ws_port = notary_ws_port or (port if notary_ws else None)
            if ws_port and notary_host:
                log.info("tlsn_tcp_refused_trying_ws", host=notary_host, tcp_port=port, ws_port=ws_port)
                return await _run_prover_via_ws(
                    url, notary_host, ws_port, output_path, timeout,
                    max_recv_data=recv_data_size,
                    notary_ticket=notary_ticket,
                )

            # No WS fallback available, TCP refused
            return TLSNProofResult(
                success=False,
                error=f"Peer notary {host}:{port} TCP refused and no WS fallback available",
            )

        return await _run_prover(url, host, port, output_path, timeout,
                                 max_recv_data=recv_data_size)
    except Exception:
        # Ensure temp dir is cleaned up on any unexpected exception
        if tmp_dir:
            _cleanup_dir(output_path)
        raise


async def _run_prover(
    url: str,
    host: str,
    port: int,
    output_path: str,
    timeout: float,
    max_recv_data: int = 0,
) -> TLSNProofResult:
    """Run the TLSNotary prover binary and return the result."""
    # Split URL at query params to avoid leaking API key in /proc/*/cmdline
    from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

    parsed = urlparse(url)
    query_params = parse_qs(parsed.query)
    api_key = query_params.pop("apiKey", [None])[0] or query_params.pop("api_key", [None])[0] or ""
    # Rebuild URL without API key
    sanitized_query = urlencode({k: v[0] for k, v in query_params.items()}, doseq=False)
    sanitized_url = urlunparse(parsed._replace(query=sanitized_query))

    prover_bin = _get_prover_binary()
    cmd = [
        prover_bin,
        "--url",
        sanitized_url,
        "--notary-host",
        host,
        "--notary-port",
        str(port),
        "--output",
        output_path,
        "--redact-headers",
        REDACT_HEADERS,
    ]

    # Right-size MPC circuit: prefer caller's value, then env override, then binary default
    recv_limit = max_recv_data or MAX_RECV_DATA
    if recv_limit > 0:
        cmd.extend(["--max-recv-data", str(recv_limit)])

    log.info(
        "tlsn_proof_starting",
        notary=f"{host}:{port}",
        output=output_path,
    )

    # Pass API key via environment variable instead of CLI arg (avoids /proc exposure)
    env = {**os.environ, "ODDS_API_KEY": api_key}

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            start_new_session=True,  # own process group so we can kill the tree
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        log.error("tlsn_proof_timeout", timeout=timeout, pid=proc.pid)
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, OSError) as kill_err:
            log.debug("tlsn_process_kill_failed", error=str(kill_err))
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except (TimeoutError, OSError) as wait_err:
            log.warning("tlsn_process_wait_failed", error=str(wait_err), pid=proc.pid)
        _cleanup_dir(output_path)
        return TLSNProofResult(
            success=False,
            error=f"proof generation timed out after {timeout}s",
        )
    except FileNotFoundError:
        log.error("tlsn_binary_not_found", binary=prover_bin)
        _cleanup_dir(output_path)
        return TLSNProofResult(
            success=False,
            error=f"TLSNotary binary not found: {prover_bin}",
        )

    if proc.returncode != 0:
        error_msg = stderr.decode().strip() if stderr else "unknown error"
        log.error(
            "tlsn_proof_failed",
            returncode=proc.returncode,
            error=error_msg[:500],
        )
        _cleanup_dir(output_path)
        return TLSNProofResult(
            success=False,
            error=f"prover exited with code {proc.returncode}: {error_msg[:500]}",
        )

    # Parse stdout JSON summary
    try:
        summary = json.loads(stdout.decode().strip())
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        log.debug("tlsn_summary_parse_failed", error=str(e))
        summary = {}

    # Read presentation bytes
    presentation_path = Path(output_path)
    if not presentation_path.exists():
        _cleanup_dir(output_path)
        return TLSNProofResult(
            success=False,
            error="presentation file was not created",
        )

    try:
        presentation_bytes = presentation_path.read_bytes()
    except OSError as e:
        log.error("tlsn_presentation_read_failed", error=str(e))
        _cleanup_dir(output_path)
        return TLSNProofResult(success=False, error=f"failed to read presentation: {e}")
    _cleanup_dir(output_path)

    log.info(
        "tlsn_proof_generated",
        size=len(presentation_bytes),
        server=summary.get("server", ""),
    )

    return TLSNProofResult(
        success=True,
        presentation_path=str(presentation_path),
        presentation_bytes=presentation_bytes,
        server=summary.get("server", ""),
    )


async def _run_prover_via_ws(
    url: str,
    notary_host: str,
    notary_api_port: int,
    output_path: str,
    timeout: float,
    max_recv_data: int = 0,
    notary_ticket: str | None = None,
) -> TLSNProofResult:
    """Run the prover via a WebSocket bridge to a peer notary.

    The peer notary's miner exposes /v1/notary/ws which proxies to its local
    notary sidecar. We create a local TCP server, point the prover at it, and
    bridge bytes between the prover's TCP connection and the peer's WebSocket.
    """
    import websockets.client

    # Append ticket as query param if available (peer notary verifies it)
    ticket_param = f"?ticket={notary_ticket}" if notary_ticket else ""
    ws_url = f"ws://{notary_host}:{notary_api_port}/v1/notary/ws{ticket_param}"
    log.info("tlsn_ws_bridge_connecting", ws_url=ws_url)

    # Find a free local port for the bridge
    bridge_server = await asyncio.start_server(
        lambda r, w: None, "127.0.0.1", 0,
    )
    bridge_port = bridge_server.sockets[0].getsockname()[1]
    bridge_server.close()
    await bridge_server.wait_closed()

    # We'll start the bridge when the prover connects
    bridge_ready = asyncio.Event()
    bridge_error: str = ""

    async def _bridge_server() -> None:
        nonlocal bridge_error
        server = await asyncio.start_server(
            _handle_bridge, "127.0.0.1", bridge_port,
        )
        bridge_ready.set()
        async with server:
            await server.serve_forever()

    async def _handle_bridge(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        nonlocal bridge_error
        try:
            async with websockets.client.connect(
                ws_url,
                max_size=10 * 1024 * 1024,  # 10 MB — MPC messages can be large
                open_timeout=20.0,
                close_timeout=5.0,
            ) as ws:
                async def tcp_to_ws() -> None:
                    while True:
                        data = await reader.read(65536)
                        if not data:
                            break
                        await ws.send(data)

                async def ws_to_tcp() -> None:
                    try:
                        async for msg in ws:
                            if isinstance(msg, bytes):
                                writer.write(msg)
                                await writer.drain()
                    finally:
                        # Close the TCP writer so tcp_to_ws detects EOF
                        # and exits instead of hanging forever.
                        writer.close()

                async with asyncio.timeout(150):
                    await asyncio.gather(tcp_to_ws(), ws_to_tcp())
        except Exception as e:
            bridge_error = str(e)
            log.warning("tlsn_ws_bridge_error", error=str(e))
        finally:
            writer.close()

    # Start the bridge server
    bridge_task = asyncio.create_task(_bridge_server())
    await bridge_ready.wait()

    try:
        # Run the prover pointing at our local bridge
        result = await _run_prover(
            url, "127.0.0.1", bridge_port, output_path, timeout,
            max_recv_data=max_recv_data,
        )
        if not result.success and bridge_error:
            result.error = f"WebSocket bridge: {bridge_error}; {result.error}"
        return result
    finally:
        bridge_task.cancel()
        try:
            await bridge_task
        except asyncio.CancelledError:
            pass


def _cleanup_dir(file_path: str) -> None:
    """Remove temp file and its parent directory if it's a temp dir."""
    try:
        parent = os.path.dirname(file_path)
        if os.path.isfile(file_path):
            os.unlink(file_path)
        if parent and os.path.basename(parent).startswith("djinn-tlsn-"):
            shutil.rmtree(parent, ignore_errors=True)
    except OSError as e:
        log.warning("tlsn_cleanup_failed", path=file_path, error=str(e))


def reap_stale_provers(max_age: int | None = None) -> int:
    """Kill djinn-tlsn-prover processes older than max_age seconds.

    Called at miner startup to clean up orphans from previous runs
    (e.g. after a watchtower restart via os.execv). Returns the number
    of processes killed.
    """
    import subprocess

    max_age = max_age or _PROVER_MAX_AGE
    killed = 0
    try:
        result = subprocess.run(
            ["pgrep", "-f", "djinn-tlsn-prover"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return 0
        my_pid = os.getpid()
        for line in result.stdout.strip().splitlines():
            pid = int(line.strip())
            if pid == my_pid:
                continue
            try:
                # Check process age via /proc/PID/stat
                stat = Path(f"/proc/{pid}/stat").read_text()
                starttime_ticks = int(stat.split(")")[1].split()[19])
                uptime_s = float(Path("/proc/uptime").read_text().split()[0])
                clock_ticks = os.sysconf("SC_CLK_TCK")
                proc_age = uptime_s - (starttime_ticks / clock_ticks)
                if proc_age > max_age:
                    os.kill(pid, signal.SIGKILL)
                    killed += 1
                    log.warning(
                        "stale_prover_killed",
                        pid=pid,
                        age_s=round(proc_age),
                    )
            except (ProcessLookupError, FileNotFoundError, ValueError, OSError):
                continue
    except Exception as e:
        log.debug("reap_stale_provers_error", error=str(e))
    if killed:
        log.info("stale_provers_reaped", count=killed)
    return killed
