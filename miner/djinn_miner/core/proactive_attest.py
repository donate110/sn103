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

    def __init__(self, notary_port: int = 7047, notary_pubkey: str = "") -> None:
        self._notary_port = notary_port
        self._notary_pubkey = notary_pubkey
        self._cached: CachedProof | None = None
        self._running = False

    @property
    def latest(self) -> CachedProof | None:
        if self._cached and self._cached.is_fresh:
            return self._cached
        return None

    async def _generate_proof(self) -> CachedProof | None:
        """Generate a TLSNotary proof of the proactive URL using local notary."""
        from djinn_miner.core import tlsn as tlsn_module

        if not tlsn_module.is_available():
            log.warning("proactive_attest_no_binary")
            return None

        log.info("proactive_attest_starting", url=PROACTIVE_URL)
        start = time.time()

        result = await tlsn_module.generate_proof(
            PROACTIVE_URL,
            notary_host="127.0.0.1",
            notary_port=self._notary_port,
            timeout=120.0,
        )

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
                else:
                    log.debug("proactive_attest_retry_later")
            except asyncio.CancelledError:
                return
            except Exception as e:
                log.warning("proactive_attest_error", error=str(e))

            await asyncio.sleep(PROACTIVE_INTERVAL)

    def stop(self) -> None:
        self._running = False
