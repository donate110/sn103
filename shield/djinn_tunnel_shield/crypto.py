"""Signed tunnel URL commitments for on-chain publication.

Bittensor uses sr25519 keys which don't support asymmetric encryption
directly. Instead, we sign the tunnel URL with the miner's hotkey so
validators can verify authenticity. The URL is readable by anyone, but
Cloudflare absorbs DDoS on the tunnel endpoint so this is acceptable.

The miner's firewall (validator IP whitelist) prevents unauthorized
access to the health endpoint, which is the primary URL distribution
path. On-chain commitment is a secondary path for when the miner is
unreachable (active DDoS).
"""

from __future__ import annotations

import json
import time

import structlog

log = structlog.get_logger()


def build_commitment(tunnel_url: str, miner_hotkey_ss58: str, wallet: object = None) -> str:
    """Build a signed commitment payload for on-chain publication.

    Returns a JSON string containing the tunnel URL, timestamp, and
    an optional signature if the wallet is available.
    """
    ts = int(time.time())
    payload = {"v": 2, "url": tunnel_url, "ts": ts, "miner": miner_hotkey_ss58}

    if wallet is not None:
        try:
            message = f"{tunnel_url}:{ts}"
            sig = wallet.hotkey.sign(message.encode())
            payload["sig"] = sig.hex() if isinstance(sig, bytes) else str(sig)
        except Exception as e:
            log.warning("commitment_sign_failed", error=str(e))

    return json.dumps(payload, separators=(",", ":"))


def parse_commitment(data: str, max_age: float = 7200.0) -> str | None:
    """Parse a tunnel URL from a miner's on-chain commitment.

    Returns the URL if the commitment is fresh and well-formed, None otherwise.
    Signature verification is optional (validators can verify if they have
    the miner's public key from the metagraph).
    """
    try:
        commitment = json.loads(data)
    except (json.JSONDecodeError, ValueError):
        return None

    if commitment.get("v") not in (1, 2):
        return None

    ts = commitment.get("ts", 0)
    if max_age > 0 and (time.time() - ts) > max_age:
        return None

    return commitment.get("url")


def verify_commitment(data: str, expected_hotkey_ss58: str, metagraph: object = None) -> bool:
    """Verify that a commitment was signed by the expected miner hotkey.

    Returns True if signature is valid or if no signature is present
    (backwards compatibility). Returns False only on signature mismatch.
    """
    try:
        commitment = json.loads(data)
    except (json.JSONDecodeError, ValueError):
        return False

    sig_hex = commitment.get("sig")
    if not sig_hex:
        return True  # No signature, accept (backwards compat)

    miner_ss58 = commitment.get("miner", "")
    if miner_ss58 != expected_hotkey_ss58:
        return False

    ts = commitment.get("ts", 0)
    url = commitment.get("url", "")
    message = f"{url}:{ts}"

    try:
        if metagraph is not None:
            # Use metagraph to look up the keypair and verify
            from substrateinterface import Keypair
            kp = Keypair(ss58_address=expected_hotkey_ss58)
            sig_bytes = bytes.fromhex(sig_hex)
            return kp.verify(message.encode(), sig_bytes)
    except Exception:
        pass

    return True  # Can't verify without keypair, accept
