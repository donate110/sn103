"""Burn-gate authentication for external notary session requests.

Callers prove they burned >= MIN_BURN_ALPHA of SN103 alpha within the last
BURN_WINDOW_SECONDS by providing:
  - X-Coldkey: their SS58 coldkey address (the extrinsic signer)
  - X-Signature: sr25519 signature of the burn tx hash (hex)
  - X-Burn-Tx: the extrinsic hash of the burn_alpha call

The caller stakes TAO on SN103 (to any validator), then calls burn_alpha
to permanently destroy alpha from that stake. The extrinsic is signed by
the coldkey. The validator verifies the signature, looks up the extrinsic
on-chain, and confirms the burn amount, recency, subnet, and coldkey match.

Results are cached so repeated requests with the same tx hash are instant.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import bittensor as bt
import structlog

log = structlog.get_logger()

BURN_CACHE_PATH = Path(os.getenv(
    "BURN_CACHE_PATH",
    os.path.expanduser("~/.local/share/djinn/burn_cache.json"),
))

# Hardcoded constants (no .env override)
MIN_BURN_ALPHA: float = 1.0  # Minimum alpha burned per tx
BURN_WINDOW_SECONDS: int = 365 * 86400  # 1 year for initial on-chain verification
BURN_NETUID: int = 103
ALPHA_RAO_PER_TOKEN: int = 1_000_000_000  # 1 alpha = 1e9 rao

# Cache: tx_hash -> {valid, error, coldkey, amount, block_ts, checked_at}
_cache: dict[str, dict[str, Any]] = {}
CACHE_TTL_SECONDS: int = 300  # 5 minutes for invalid/not-found entries
# Once a burn is verified and cached, it stays valid permanently.
# The burn happened, the alpha is destroyed, re-verification is pointless.
# Block state gets pruned from subtensor nodes, so re-checking on-chain
# will fail for old burns even though they're perfectly valid.
CACHE_TTL_VALID_SECONDS: int = 10 * 365 * 86400  # 10 years (effectively permanent)


def _cache_ttl(entry: dict[str, Any]) -> int:
    """Valid burns are cached for the full burn window; failures expire fast."""
    return CACHE_TTL_VALID_SECONDS if entry.get("valid") else CACHE_TTL_SECONDS


def _load_cache() -> None:
    """Load persisted valid burn entries from disk on startup.

    Valid burns are loaded regardless of age. The burn happened, the
    alpha is destroyed. Re-verification would require on-chain lookup
    which fails when block state is pruned.
    """
    if not BURN_CACHE_PATH.exists():
        return
    try:
        data = json.loads(BURN_CACHE_PATH.read_text())
        loaded = 0
        for tx_hash, entry in data.items():
            if not entry.get("valid"):
                continue
            _cache[tx_hash] = entry
            loaded += 1
        if loaded:
            log.info("burn_cache_loaded", count=loaded)
    except Exception as e:
        log.warning("burn_cache_load_failed", error=str(e))


def _persist_cache() -> None:
    """Write valid burn entries to disk so they survive restarts."""
    valid_entries = {k: v for k, v in _cache.items() if v.get("valid")}
    if not valid_entries:
        return
    try:
        BURN_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        BURN_CACHE_PATH.write_text(json.dumps(valid_entries))
    except Exception as e:
        log.warning("burn_cache_persist_failed", error=str(e))


def _cache_get(tx_hash: str) -> dict[str, Any] | None:
    entry = _cache.get(tx_hash)
    if entry and (time.time() - entry["checked_at"]) < _cache_ttl(entry):
        return entry
    return None


def _cache_set(tx_hash: str, entry: dict[str, Any]) -> None:
    entry["checked_at"] = time.time()
    _cache[tx_hash] = entry
    # Evict old entries if cache grows too large
    if len(_cache) > 1000:
        now = time.time()
        stale = [k for k, v in _cache.items() if (now - v["checked_at"]) >= _cache_ttl(v)]
        for k in stale:
            del _cache[k]
    # Persist valid entries to disk
    if entry.get("valid"):
        _persist_cache()


# Load persisted burns on module import
_load_cache()


def verify_signature(coldkey_ss58: str, tx_hash_hex: str, signature_hex: str) -> bool:
    """Verify an sr25519 signature of the tx hash against the coldkey."""
    try:
        keypair = bt.Keypair(ss58_address=coldkey_ss58)
        tx_bytes = bytes.fromhex(tx_hash_hex.removeprefix("0x"))
        sig_bytes = bytes.fromhex(signature_hex.removeprefix("0x"))
        return keypair.verify(tx_bytes, sig_bytes)
    except Exception as e:
        log.warning("burn_gate_sig_verify_failed", coldkey=coldkey_ss58, error=str(e))
        return False


def verify_burn_tx(
    tx_hash: str,
    expected_coldkey: str,
    substrate: Any,
) -> tuple[bool, str]:
    """Look up a burn_alpha extrinsic on-chain and validate it.

    The extrinsic is signed by the coldkey. The hotkey param in the call
    identifies which validator's stake the alpha was burned from (the caller
    can stake to any validator on SN103, then burn from that position).

    Returns (valid, error_message).
    """
    # Check cache first.
    cached = _cache_get(tx_hash)
    if cached is not None:
        if not cached["valid"]:
            return False, cached["error"]
        if cached["coldkey"] != expected_coldkey:
            return False, "Burn coldkey does not match request coldkey"
        # Re-check age: a previously valid burn may have expired.
        block_ts = cached.get("block_ts", 0)
        if block_ts and (time.time() - block_ts) > BURN_WINDOW_SECONDS:
            age = int(time.time() - block_ts)
            expired_err = f"Burn too old ({age}s > {BURN_WINDOW_SECONDS}s)"
            _cache_set(tx_hash, {"valid": False, "error": expired_err, "coldkey": cached["coldkey"], "block_ts": block_ts})
            return False, expired_err
        return True, ""

    tx_hash_clean = tx_hash.lower().removeprefix("0x")

    try:
        current_block = substrate.get_block_number(None)
        # 30 days at ~12s/block = ~216000 blocks; but the tx hash is provided
        # so we only need to scan far enough to find it. Use 7500 (~25h) as
        # initial scan depth; if the burn is older it will be cached from a
        # previous successful lookup.
        search_depth = 7500

        for block_num in range(current_block, max(current_block - search_depth, 0), -1):
            block_hash = substrate.get_block_hash(block_num)
            extrinsics = substrate.get_extrinsics(block_hash=block_hash)
            if not extrinsics:
                continue

            for ex in extrinsics:
                ex_hash = ex.extrinsic_hash
                if ex_hash is None:
                    continue
                if isinstance(ex_hash, bytes):
                    if ex_hash.hex() != tx_hash_clean:
                        continue
                elif isinstance(ex_hash, str):
                    if ex_hash.lower().removeprefix("0x") != tx_hash_clean:
                        continue
                else:
                    continue

                # Found the extrinsic
                call = ex.value.get("call", {})
                call_module = call.get("call_module", "")
                call_function = call.get("call_function", "")

                # Extract coldkey (extrinsic signer)
                coldkey = ""
                ex_address = ex.value.get("address", "")
                if isinstance(ex_address, str):
                    coldkey = ex_address
                elif isinstance(ex_address, dict):
                    coldkey = ex_address.get("Id", "")

                if call_module != "SubtensorModule" or call_function != "burn_alpha":
                    entry = {"valid": False, "error": f"Not a burn_alpha call ({call_module}.{call_function})", "coldkey": coldkey, "block_ts": 0}
                    _cache_set(tx_hash, entry)
                    return False, entry["error"]

                call_args = {a["name"]: a["value"] for a in call.get("call_args", [])}

                # Check netuid
                netuid = call_args.get("netuid", -1)
                if netuid != BURN_NETUID:
                    entry = {"valid": False, "error": f"Wrong subnet (netuid={netuid}, expected {BURN_NETUID})", "coldkey": coldkey, "block_ts": 0}
                    _cache_set(tx_hash, entry)
                    return False, entry["error"]

                # Check amount (in rao)
                amount_rao = call_args.get("amount", 0)
                amount_alpha = amount_rao / ALPHA_RAO_PER_TOKEN
                if amount_alpha < MIN_BURN_ALPHA:
                    entry = {"valid": False, "error": f"Burn amount {amount_alpha:.4f} alpha < {MIN_BURN_ALPHA} required", "coldkey": coldkey, "block_ts": 0}
                    _cache_set(tx_hash, entry)
                    return False, entry["error"]

                # Get block timestamp
                block_ts = 0
                block_data = substrate.get_block(block_hash)
                for bex in block_data.get("extrinsics", []):
                    bcall = bex.value.get("call", {})
                    if bcall.get("call_module") == "Timestamp":
                        ts_args = {a["name"]: a["value"] for a in bcall.get("call_args", [])}
                        block_ts = ts_args.get("now", 0) / 1000  # ms -> seconds
                        break

                # Check recency
                age = time.time() - block_ts
                if age > BURN_WINDOW_SECONDS:
                    entry = {"valid": False, "error": f"Burn too old ({int(age)}s > {BURN_WINDOW_SECONDS}s)", "coldkey": coldkey, "block_ts": block_ts}
                    _cache_set(tx_hash, entry)
                    return False, entry["error"]

                # Check coldkey matches
                if coldkey != expected_coldkey:
                    entry = {"valid": False, "error": "Burn coldkey does not match request coldkey", "coldkey": coldkey, "block_ts": block_ts}
                    _cache_set(tx_hash, entry)
                    return False, entry["error"]

                # All checks passed
                log.info(
                    "burn_verified",
                    tx_hash=tx_hash[:16] + "...",
                    coldkey=coldkey,
                    amount_alpha=amount_alpha,
                    block_num=block_num,
                )
                entry = {"valid": True, "error": "", "coldkey": coldkey, "amount": amount_alpha, "block_ts": block_ts}
                _cache_set(tx_hash, entry)
                return True, ""

        entry = {"valid": False, "error": f"Tx {tx_hash[:16]}... not found in last {search_depth} blocks", "coldkey": "", "block_ts": 0}
        _cache_set(tx_hash, entry)
        return False, entry["error"]

    except Exception as e:
        log.warning("burn_gate_verify_error", tx_hash=tx_hash[:16], tx_hash_full=tx_hash, error=str(e))
        # Do NOT cache chain lookup failures (e.g. "State discarded").
        # The burn may be valid but unprovable right now. A peer validator
        # or a future archive node query could still verify it.
        return False, f"Chain lookup failed: {e}"


async def verify_burn_via_peers(
    tx_hash: str,
    expected_coldkey: str,
    peer_urls: list[str],
) -> tuple[bool, str]:
    """Ask peer validators if they have a verified burn in their cache.

    Falls back to this when on-chain lookup fails (block state pruned).

    SECURITY NOTE: Peer responses are plain unsigned HTTP JSON. A malicious
    peer (or MITM) could forge a positive response to bypass the burn gate.
    Until a protocol-level signing mechanism is added, we mitigate this by
    requiring at least 2 independent peers to confirm the burn (quorum of 2).

    TODO: Responses should be signed with the peer validator's hotkey so the
    coordinator can verify authenticity. Without signatures, a network-level
    attacker (or a compromised peer) can forge confirmations. Implement
    hotkey-signed responses before removing the quorum mitigation.
    """
    if not peer_urls:
        return False, "No peer validators to query"

    log.warning(
        "burn_peer_verification_unsigned",
        tx_hash=tx_hash[:16] + "...",
        peer_count=len(peer_urls),
        note="Peer responses are not hotkey-signed; relies on quorum for integrity",
    )

    _PEER_QUORUM = 2  # minimum confirmations required

    import httpx

    confirming_peers: list[str] = []
    last_data: dict | None = None

    async with httpx.AsyncClient(timeout=5.0) as client:
        for url in peer_urls:
            try:
                resp = await client.get(
                    f"{url}/v1/burn/verify",
                    params={"tx_hash": tx_hash, "coldkey": expected_coldkey},
                )
                if resp.status_code != 200:
                    continue
                data = resp.json()
                if data.get("valid"):
                    confirming_peers.append(url)
                    last_data = data
                    if len(confirming_peers) >= _PEER_QUORUM:
                        log.info(
                            "burn_verified_via_peers",
                            tx_hash=tx_hash[:16] + "...",
                            peers=confirming_peers,
                            quorum=_PEER_QUORUM,
                        )
                        entry = {
                            "valid": True,
                            "error": "",
                            "coldkey": expected_coldkey,
                            "amount": last_data.get("amount", 0),
                            "block_ts": last_data.get("block_ts", 0),
                        }
                        _cache_set(tx_hash, entry)
                        _persist_cache()
                        return True, ""
            except Exception as e:
                log.debug("burn_peer_query_failed", peer=url, error=str(e))
                continue

    if confirming_peers:
        return False, f"Only {len(confirming_peers)} peer(s) confirmed (need {_PEER_QUORUM})"
    return False, "No peer validators could verify this burn"


def authenticate_request(
    coldkey_ss58: str,
    tx_hash_hex: str,
    signature_hex: str,
    substrate: Any,
    peer_validator_urls: list[str] | None = None,
) -> tuple[bool, str]:
    """Full burn-gate authentication: signature + on-chain verification.

    Returns (valid, error_message).
    """
    if not coldkey_ss58 or not tx_hash_hex or not signature_hex:
        return False, "Missing required headers: X-Coldkey, X-Burn-Tx, X-Signature"

    # Step 1: Verify the signature (fast, local)
    if not verify_signature(coldkey_ss58, tx_hash_hex, signature_hex):
        return False, "Invalid signature"

    # Step 2: Verify the burn on-chain (cached after first lookup)
    valid, error = verify_burn_tx(tx_hash_hex, coldkey_ss58, substrate)
    if valid:
        return True, ""

    # Step 3: On-chain lookup failed (likely pruned). Store the error and
    # peer_urls for the caller to try async peer verification.
    # We return the error context so the caller can decide.
    return False, error
