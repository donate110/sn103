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

PROVER_BINARY = ensure_binary("djinn-tlsn-prover")

# Max age (seconds) before a prover process is considered stuck and killed.
_PROVER_MAX_AGE = int(os.getenv("TLSN_PROVER_MAX_AGE", "300"))

NOTARY_HOST = os.getenv("TLSN_NOTARY_HOST", "notary.pse.dev")
NOTARY_PORT = int(os.getenv("TLSN_NOTARY_PORT", "443"))

# When True, refuse to fall back to the centralized PSE notary.
# All validators now assign peer notaries, so PSE fallback just creates
# zombie provers that hang on notary.pse.dev for hours. Fail fast instead.
REQUIRE_PEER_NOTARY = os.getenv("TLSN_REQUIRE_PEER_NOTARY", "true").lower() in ("true", "1", "yes")

# Headers whose values should be redacted from the proof
REDACT_HEADERS = os.getenv("TLSN_REDACT_HEADERS", "authorization,apikey,x-api-key")


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
    binary = shutil.which(PROVER_BINARY)
    if binary:
        return True
    # Check if the configured path exists directly
    return os.path.isfile(PROVER_BINARY) and os.access(PROVER_BINARY, os.X_OK)


async def generate_proof(
    url: str,
    *,
    notary_host: str | None = None,
    notary_port: int | None = None,
    notary_ws: bool = False,
    output_dir: str | None = None,
    timeout: float = 180.0,
) -> TLSNProofResult:
    """Generate a TLSNotary proof for an HTTPS request.

    Args:
        url: Full URL to fetch (with query params, including API key).
        notary_host: Notary server hostname. Defaults to TLSN_NOTARY_HOST env.
        notary_port: Notary server port. Defaults to TLSN_NOTARY_PORT env.
        notary_ws: If True, connect to the peer notary via WebSocket proxy
            at ws://notary_host:notary_port/v1/notary/ws. A local TCP bridge
            is created so the prover binary can connect as usual.
        output_dir: Directory for the presentation file. Uses tempdir if None.
        timeout: Max seconds to wait for proof generation.

    Returns:
        TLSNProofResult with the serialized presentation bytes on success.
    """
    host = notary_host or NOTARY_HOST
    port = notary_port or NOTARY_PORT

    # Warn when falling back to centralized PSE notary.
    # During transition, validators may not yet assign peer notaries,
    # so we allow PSE with a deprecation warning rather than hard-blocking.
    # Once all validators are updated, set TLSN_ALLOW_PSE_FALLBACK=false
    # to hard-block PSE.
    if not notary_host and host == "notary.pse.dev":
        try:
            from djinn_miner.api.metrics import CENTRALIZED_NOTARY_FALLBACKS
            CENTRALIZED_NOTARY_FALLBACKS.inc()
        except Exception:
            pass
        if REQUIRE_PEER_NOTARY:
            log.error(
                "pse_notary_blocked",
                msg="No peer notary assigned and TLSN_ALLOW_PSE_FALLBACK is not set. "
                "Refusing to use centralized notary.pse.dev. Validator should assign "
                "a peer notary via notary_host/notary_port.",
            )
            return TLSNProofResult(
                success=False,
                error="No peer notary assigned. Centralized PSE notary is disabled.",
            )
        log.warning(
            "using_centralized_notary_fallback",
            host=host,
            msg="No peer notary assigned — falling back to centralized notary. "
            "This will be blocked in a future update.",
        )

    # Resolve redirects: the prover can't follow them, so we do a HEAD
    # request first and use the final URL.
    try:
        import httpx

        async with httpx.AsyncClient(follow_redirects=True, timeout=10.0) as _rc:
            head = await _rc.head(url)
            final_url = str(head.url)
            if final_url != url:
                log.info("tlsn_redirect_resolved", original=url, final=final_url)
                url = final_url
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

    try:
        if notary_ws and notary_host:
            result = await _run_prover_via_ws(
                url, notary_host, port, output_path, timeout,
            )
            # If peer notary failed, fall back to PSE rather than returning error
            if not result.success and not REQUIRE_PEER_NOTARY:
                log.warning(
                    "peer_notary_failed_pse_fallback",
                    peer_host=notary_host,
                    peer_port=port,
                    error=result.error[:100],
                )
                try:
                    from djinn_miner.api.metrics import CENTRALIZED_NOTARY_FALLBACKS
                    CENTRALIZED_NOTARY_FALLBACKS.inc()
                except Exception:
                    pass
                return await _run_prover(url, NOTARY_HOST, NOTARY_PORT, output_path, timeout)
            return result
        return await _run_prover(url, host, port, output_path, timeout)
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

    cmd = [
        PROVER_BINARY,
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
        log.error("tlsn_binary_not_found", binary=PROVER_BINARY)
        _cleanup_dir(output_path)
        return TLSNProofResult(
            success=False,
            error=f"TLSNotary binary not found: {PROVER_BINARY}",
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
) -> TLSNProofResult:
    """Run the prover via a WebSocket bridge to a peer notary.

    The peer notary's miner exposes /v1/notary/ws which proxies to its local
    notary sidecar. We create a local TCP server, point the prover at it, and
    bridge bytes between the prover's TCP connection and the peer's WebSocket.
    """
    import websockets.client

    ws_url = f"ws://{notary_host}:{notary_api_port}/v1/notary/ws"
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
                    async for msg in ws:
                        if isinstance(msg, bytes):
                            writer.write(msg)
                            await writer.drain()

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
