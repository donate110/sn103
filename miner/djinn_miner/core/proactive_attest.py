"""Proactive attestation: miners periodically prove TLSNotary capability.

Every few hours, the miner attests a simple URL (example.com) using its
own notary sidecar. The proof is cached and served via the health endpoint
so validators can verify capability without random dispatch.

The proof includes the server's Date header, which is cryptographically
bound to the TLS session. Validators check freshness (within 24h) and
verify the TLSNotary presentation to confirm the miner can produce
real proofs.

This is self-notarized (miner is both prover and notary), which proves
capability but not independence. Validator-assigned peer-notary challenges
provide the higher trust layer.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from dataclasses import dataclass, field

import structlog

log = structlog.get_logger()

PROACTIVE_URL = os.getenv("PROACTIVE_ATTEST_URL", "https://httpbin.org/get")
# Re-attest every 4 hours by default. Validators accept proofs up to 24h old.
PROACTIVE_INTERVAL = int(os.getenv("PROACTIVE_ATTEST_INTERVAL", "14400"))


@dataclass
class CachedProof:
    """A cached proactive attestation proof."""

    url: str = ""
    server_name: str = ""
    notary_pubkey: str = ""
    proof_hex: str = ""
    created_at: float = 0.0  # time.time()
    date_header: str = ""
    binary_hash: str = ""  # SHA256 prefix of TLSNotary binary

    @property
    def age_seconds(self) -> float:
        if self.created_at == 0:
            return float("inf")
        return time.time() - self.created_at

    @property
    def is_fresh(self) -> bool:
        return self.age_seconds < 86400  # 24 hours


class ProactiveAttester:
    """Background loop that periodically attests a URL using the local notary."""

    _RETRY_INTERVAL = 300  # 5 minutes after failure

    def __init__(self, notary_port: int = 7047, notary_pubkey: str = "") -> None:
        self._notary_port = notary_port
        self._notary_pubkey = notary_pubkey
        self._notary_key_path = os.getenv(
            "NOTARY_KEY_PATH", os.path.expanduser("~/.local/share/djinn/notary-key.bin")
        )
        self._cached: CachedProof | None = None
        self._running = False
        self._consecutive_failures = 0
        self._binary_hash = self._compute_binary_hash()

    async def _spawn_ephemeral_notary(self) -> tuple[asyncio.subprocess.Process, int] | None:
        """Spawn a short-lived notary on a random port for one proof."""
        import shutil
        import socket
        from djinn_miner.core.tlsn_bootstrap import ensure_binary

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
                binary, "--port", str(port), "--key", self._notary_key_path,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                env=env,
            )
            for _ in range(40):
                await asyncio.sleep(0.1)
                try:
                    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    s.connect(("127.0.0.1", port))
                    s.close()
                    return proc, port
                except ConnectionRefusedError:
                    continue
            proc.kill()
            return None
        except Exception as e:
            log.warning("ephemeral_notary_spawn_failed", error=str(e))
            return None

    @staticmethod
    def _compute_binary_hash() -> str:
        """SHA256 prefix of the TLSNotary notary binary for version matching."""
        import hashlib
        try:
            from djinn_miner.core.tlsn import _get_prover_binary
            binary_path = _get_prover_binary()
            with open(binary_path, "rb") as f:
                h = hashlib.sha256()
                while chunk := f.read(65536):
                    h.update(chunk)
            return h.hexdigest()[:16]
        except Exception:
            return ""

    @property
    def latest(self) -> CachedProof | None:
        if self._cached and self._cached.is_fresh:
            return self._cached
        return None

    async def _generate_proof(self) -> CachedProof | None:
        """Generate a TLSNotary proof of the proactive URL using an ephemeral notary.

        Spawns a temporary notary process on a random port so it doesn't
        interfere with the main sidecar or peer notary sessions. The
        process is killed after the proof completes.
        """
        from djinn_miner.core import tlsn as tlsn_module

        if not tlsn_module.is_available():
            log.warning("proactive_attest_no_binary")
            return None

        log.info("proactive_attest_starting", url=PROACTIVE_URL)
        start = time.time()

        # Spawn ephemeral notary to avoid colliding with the main sidecar
        ephemeral = await self._spawn_ephemeral_notary()
        if ephemeral is None:
            # Fall back to shared sidecar if ephemeral spawn fails
            notary_port = self._notary_port
            ephemeral_proc = None
        else:
            ephemeral_proc, notary_port = ephemeral

        try:
            result = await tlsn_module.generate_proof(
                PROACTIVE_URL,
                notary_host="127.0.0.1",
                notary_port=notary_port,
                timeout=120.0,
            )
        finally:
            if ephemeral_proc is not None:
                try:
                    ephemeral_proc.kill()
                except Exception:
                    pass

        if not result.success:
            log.warning("proactive_attest_failed", error=result.error, elapsed_s=round(time.time() - start, 1))
            return None

        if not result.presentation_bytes:
            log.warning("proactive_attest_no_proof_bytes")
            return None

        proof_hex = result.presentation_bytes.hex()

        # Extract Date header from the proof if possible
        date_header = ""
        if result.presentation_bytes:
            # The presentation contains HTTP response data. Look for Date header
            # in the raw bytes (it's part of the committed TLS transcript).
            try:
                text = result.presentation_bytes.decode("utf-8", errors="ignore")
                match = re.search(r"[Dd]ate:\s*([^\r\n]+)", text)
                if match:
                    date_header = match.group(1).strip()
            except Exception:
                pass

        notary_pubkey = self._notary_pubkey

        elapsed = round(time.time() - start, 1)
        log.info(
            "proactive_attest_success",
            server=result.server,
            proof_size=len(result.presentation_bytes),
            date_header=date_header,
            elapsed_s=elapsed,
        )

        return CachedProof(
            url=PROACTIVE_URL,
            server_name=result.server,
            notary_pubkey=notary_pubkey,
            proof_hex=proof_hex,
            created_at=time.time(),
            date_header=date_header,
            binary_hash=self._binary_hash,
        )

    async def run_loop(self) -> None:
        """Periodically generate proactive attestation proofs."""
        self._running = True
        # Initial delay: let the notary sidecar stabilize
        await asyncio.sleep(30)

        while self._running:
            try:
                proof = await self._generate_proof()
                if proof:
                    self._cached = proof
                    self._consecutive_failures = 0
                    interval = PROACTIVE_INTERVAL
                else:
                    self._consecutive_failures += 1
                    interval = self._RETRY_INTERVAL
                    log.debug(
                        "proactive_attest_retry_later",
                        consecutive_failures=self._consecutive_failures,
                        retry_in_s=interval,
                    )
            except asyncio.CancelledError:
                return
            except Exception as e:
                self._consecutive_failures += 1
                interval = self._RETRY_INTERVAL
                log.warning(
                    "proactive_attest_error",
                    error=str(e),
                    consecutive_failures=self._consecutive_failures,
                )

            await asyncio.sleep(interval)

    def stop(self) -> None:
        self._running = False
