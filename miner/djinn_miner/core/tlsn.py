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
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

import structlog

log = structlog.get_logger()

# Default binary location (can be overridden via env)
PROVER_BINARY = os.getenv(
    "TLSN_PROVER_BINARY",
    shutil.which("djinn-tlsn-prover") or "djinn-tlsn-prover",
)

NOTARY_HOST = os.getenv("TLSN_NOTARY_HOST", "notary.pse.dev")
NOTARY_PORT = int(os.getenv("TLSN_NOTARY_PORT", "443"))

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
    output_dir: str | None = None,
    timeout: float = 180.0,
) -> TLSNProofResult:
    """Generate a TLSNotary proof for an HTTPS request.

    Args:
        url: Full URL to fetch (with query params, including API key).
        notary_host: Notary server hostname. Defaults to TLSN_NOTARY_HOST env.
        notary_port: Notary server port. Defaults to TLSN_NOTARY_PORT env.
        output_dir: Directory for the presentation file. Uses tempdir if None.
        timeout: Max seconds to wait for proof generation.

    Returns:
        TLSNProofResult with the serialized presentation bytes on success.
    """
    host = notary_host or NOTARY_HOST
    port = notary_port or NOTARY_PORT

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
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        log.error("tlsn_proof_timeout", timeout=timeout)
        try:
            proc.kill()
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
