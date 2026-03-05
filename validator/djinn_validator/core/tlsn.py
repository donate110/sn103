"""TLSNotary proof verification via Rust CLI wrapper.

Calls the `djinn-tlsn-verifier` binary to verify a TLSNotary presentation
and extract the disclosed HTTP response data. Validators use this to confirm
that a miner's odds data came from an authentic TLS session.

When the binary is not available, falls back to HTTP attestation verification
(re-querying the same endpoint within a time window).
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
from dataclasses import dataclass

import structlog

log = structlog.get_logger()

# Resolve binary: env override → PATH → ~/.local/bin → auto-download
from djinn_validator.core.tlsn_bootstrap import ensure_binary

VERIFIER_BINARY = ensure_binary("djinn-tlsn-verifier")

# Trusted notary public keys (hex-encoded secp256k1). If empty, any key is
# accepted (dev mode). In production, configure via TLSN_TRUSTED_NOTARY_KEYS.
import re as _re

_HEX_KEY_RE = _re.compile(r"^[0-9a-fA-F]{64,130}$")

_raw_keys = set(filter(None, os.getenv("TLSN_TRUSTED_NOTARY_KEYS", "").split(",")))
TRUSTED_NOTARY_KEYS: set[str] = set()
for _k in _raw_keys:
    _k = _k.strip()
    if _HEX_KEY_RE.match(_k):
        TRUSTED_NOTARY_KEYS.add(_k)
    elif _k:
        log.warning("invalid_notary_key_ignored", key=_k[:16] + "...", reason="must be 64-130 hex chars")


@dataclass
class TLSNVerifyResult:
    """Result of TLSNotary proof verification."""

    verified: bool
    server_name: str = ""
    connection_time: str = ""
    response_body: str = ""
    notary_key: str = ""
    error: str = ""


def is_available() -> bool:
    """Check if the TLSNotary verifier binary is available."""
    binary = shutil.which(VERIFIER_BINARY)
    if binary:
        return True
    return os.path.isfile(VERIFIER_BINARY) and os.access(VERIFIER_BINARY, os.X_OK)


async def verify_proof(
    presentation_bytes: bytes,
    *,
    expected_server: str | None = None,
    timeout: float = 30.0,
) -> TLSNVerifyResult:
    """Verify a TLSNotary presentation and extract disclosed data.

    Args:
        presentation_bytes: Serialized Presentation from the miner.
        expected_server: If set, verify the server name matches.
        timeout: Max seconds to wait for verification.

    Returns:
        TLSNVerifyResult with the verified response body on success.
    """
    # Write presentation to a temp file
    with tempfile.NamedTemporaryFile(suffix=".bin", prefix="djinn-verify-", delete=False) as f:
        f.write(presentation_bytes)
        presentation_path = f.name

    base_cmd = [VERIFIER_BINARY, "--presentation", presentation_path]

    # Try each trusted notary key until one succeeds
    keys_to_try = list(TRUSTED_NOTARY_KEYS) if TRUSTED_NOTARY_KEYS else [None]
    last_error = ""
    proc = None
    stdout = b""
    stderr = b""

    for key_path in keys_to_try:
        cmd = list(base_cmd)
        if key_path is not None:
            cmd.extend(["--notary-pubkey", key_path])
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            if proc.returncode == 0:
                break
            last_error = stderr.decode().strip() if stderr else "unknown error"
            log.debug("tlsn_key_mismatch", key=key_path, error=last_error[:200])
        except TimeoutError:
            _cleanup(presentation_path)
            return TLSNVerifyResult(verified=False, error=f"verification timed out after {timeout}s")
        except FileNotFoundError:
            _cleanup(presentation_path)
            return TLSNVerifyResult(
                verified=False,
                error=f"TLSNotary verifier binary not found: {VERIFIER_BINARY}",
            )

    _cleanup(presentation_path)

    if proc is None or proc.returncode != 0:
        error_msg = last_error or (stderr.decode().strip() if stderr else "unknown error")
        # Try to parse stdout for structured error
        try:
            result = json.loads(stdout.decode().strip())
            error_msg = result.get("error", error_msg)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            log.debug("tlsn_error_output_parse_failed", error=str(e))
        return TLSNVerifyResult(verified=False, error=error_msg[:500])

    # Parse verification output
    try:
        result = json.loads(stdout.decode().strip())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return TLSNVerifyResult(verified=False, error="failed to parse verifier output")

    if result.get("status") != "verified":
        return TLSNVerifyResult(verified=False, error=result.get("error", "verification failed"))

    server_name = result.get("server_name", "")

    # Check expected server if provided (exact or subdomain match, not substring)
    if expected_server:
        server_match = (
            server_name == expected_server
            or server_name.endswith("." + expected_server)
        )
        if not server_match:
            return TLSNVerifyResult(
                verified=False,
                server_name=server_name,
                error=f"server mismatch: expected {expected_server}, got {server_name}",
            )

    return TLSNVerifyResult(
        verified=True,
        server_name=server_name,
        connection_time=result.get("connection_time", ""),
        response_body=result.get("response_body", ""),
        notary_key=result.get("notary_key", ""),
    )


def _cleanup(path: str) -> None:
    """Remove temp file, ignoring errors."""
    try:
        os.unlink(path)
    except OSError:
        pass
