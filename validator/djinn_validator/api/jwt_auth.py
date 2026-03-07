"""Ed25519 JWT verification for external notary session requests.

Verifies JWTs signed by a trusted external issuer (e.g. debust/firmrecord).
The validator is stateless: it only checks the signature and expiry.
No user tracking, no billing, no usage counting.

Configuration:
    NOTARY_AUTH_PUBKEY: Hex-encoded Ed25519 public key (32 bytes = 64 hex chars).
                       When unset, the endpoint rejects all requests.
"""

from __future__ import annotations

import os
from typing import Any

import jwt
import structlog
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

log = structlog.get_logger()

_pubkey_hex = os.getenv("NOTARY_AUTH_PUBKEY", "")
_public_key: Ed25519PublicKey | None = None

if _pubkey_hex:
    try:
        _raw = bytes.fromhex(_pubkey_hex)
        if len(_raw) != 32:
            log.error("notary_auth_pubkey_invalid", length=len(_raw), expected=32)
        else:
            _public_key = Ed25519PublicKey.from_public_bytes(_raw)
            log.info("notary_auth_configured", pubkey=_pubkey_hex[:16] + "...")
    except (ValueError, Exception) as e:
        log.error("notary_auth_pubkey_parse_failed", error=str(e))


def is_configured() -> bool:
    """Return True if a valid NOTARY_AUTH_PUBKEY is loaded."""
    return _public_key is not None


def verify_token(token: str) -> dict[str, Any]:
    """Verify an Ed25519-signed JWT and return its claims.

    Raises:
        ValueError: If no public key is configured, token is invalid,
                    expired, or signature verification fails.
    """
    if _public_key is None:
        raise ValueError("Notary auth not configured (NOTARY_AUTH_PUBKEY not set)")

    try:
        payload = jwt.decode(
            token,
            _public_key,
            algorithms=["EdDSA"],
            options={"require": ["exp"]},
        )
        return payload
    except jwt.ExpiredSignatureError:
        raise ValueError("Token expired")
    except jwt.InvalidTokenError as e:
        raise ValueError(f"Invalid token: {e}")
