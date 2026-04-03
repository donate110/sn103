"""ECIES encryption for per-validator tunnel URL commitments.

Each miner encrypts its tunnel URL with each validator's public key
so only legitimate validators can discover the tunnel endpoint.
"""

from __future__ import annotations

import json
import time

import structlog

log = structlog.get_logger()

try:
    import ecies
    _HAS_ECIES = True
except ImportError:
    _HAS_ECIES = False


def encrypt_for_validators(
    tunnel_url: str,
    validator_hotkeys: list[str],
    miner_hotkey: str,
) -> bytes:
    """Encrypt tunnel URL for each validator.

    Returns a JSON blob: {
        "v": 1,
        "miner": "<ss58>",
        "ts": <unix_timestamp>,
        "entries": {"<validator_ss58>": "<hex_encrypted_url>", ...}
    }

    Each entry is ECIES-encrypted with the validator's hotkey public key
    so only that validator can decrypt it.
    """
    if not _HAS_ECIES:
        raise RuntimeError("eciespy not installed: pip install eciespy")

    payload = json.dumps({"url": tunnel_url, "ts": int(time.time())}).encode()
    entries: dict[str, str] = {}

    for vk in validator_hotkeys:
        try:
            pubkey_bytes = _ss58_to_public_key(vk)
            encrypted = ecies.encrypt(pubkey_bytes, payload)
            entries[vk] = encrypted.hex()
        except Exception as e:
            log.warning("encrypt_for_validator_failed", validator=vk, error=str(e))

    commitment = {
        "v": 1,
        "miner": miner_hotkey,
        "ts": int(time.time()),
        "entries": entries,
    }
    return json.dumps(commitment, separators=(",", ":")).encode()


def decrypt_tunnel_url(
    commitment_data: bytes,
    validator_hotkey_ss58: str,
    validator_private_key: bytes,
    max_age: float = 7200.0,
) -> str | None:
    """Decrypt a tunnel URL from a miner's commitment.

    Returns the URL if decryption succeeds and the commitment is fresh,
    None otherwise.
    """
    if not _HAS_ECIES:
        return None

    try:
        commitment = json.loads(commitment_data)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None

    if commitment.get("v") != 1:
        return None

    # Check freshness
    ts = commitment.get("ts", 0)
    if max_age > 0 and (time.time() - ts) > max_age:
        log.debug("commitment_too_old", age=time.time() - ts, max_age=max_age)
        return None

    encrypted_hex = commitment.get("entries", {}).get(validator_hotkey_ss58)
    if not encrypted_hex:
        return None

    try:
        encrypted = bytes.fromhex(encrypted_hex)
        decrypted = ecies.decrypt(validator_private_key, encrypted)
        inner = json.loads(decrypted)
        return inner.get("url")
    except Exception as e:
        log.debug("commitment_decrypt_failed", error=str(e))
        return None


def _ss58_to_public_key(ss58_address: str) -> bytes:
    """Convert an SS58 address to a 32-byte public key.

    Uses the base58/blake2b decoding from the SS58 spec.
    """
    import base58
    decoded = base58.b58decode(ss58_address)
    # SS58 format: [prefix(1-2 bytes)] [pubkey(32 bytes)] [checksum(2 bytes)]
    # For substrate addresses (prefix < 64), prefix is 1 byte
    if len(decoded) == 35:
        return decoded[1:33]
    if len(decoded) == 36:
        return decoded[2:34]
    raise ValueError(f"Unexpected SS58 decoded length: {len(decoded)}")
