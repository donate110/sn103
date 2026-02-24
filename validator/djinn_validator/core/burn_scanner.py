"""Background scanner that pre-registers burn transactions in the ledger.

Periodically scans recent Bittensor blocks for transfers to the burn address
and records them in the BurnLedger. This eliminates the need for on-demand
block scanning when users submit attestation requests — by the time they
submit their tx_hash, it's already in the ledger.

The scanner tracks its last-scanned block number so each run only looks at
new blocks (typically ~60 blocks per 10-minute interval).
"""

from __future__ import annotations

import asyncio
import os

import structlog

from djinn_validator.core.burn_ledger import BurnLedger

log = structlog.get_logger()

# How often to scan (seconds). Default 10 minutes.
SCAN_INTERVAL = int(os.getenv("BURN_SCAN_INTERVAL", "600"))

# How many blocks to scan on first run when we have no checkpoint.
# After that, we only scan blocks since the last checkpoint.
INITIAL_SCAN_DEPTH = 600  # ~100 minutes of blocks on first run


def _extract_burns_from_block(
    substrate: object,
    block_hash: str,
    burn_address: str,
) -> list[tuple[str, str, float]]:
    """Extract all balance transfers to the burn address from a single block.

    Returns list of (tx_hash_hex, sender_ss58, amount_tao).
    """
    results: list[tuple[str, str, float]] = []
    extrinsics = substrate.get_extrinsics(block_hash=block_hash)  # type: ignore[attr-defined]
    if not extrinsics:
        return results

    for ex in extrinsics:
        ex_hash = ex.extrinsic_hash
        if ex_hash is None:
            continue

        call = ex.value.get("call", {})
        call_module = call.get("call_module", "")
        call_function = call.get("call_function", "")

        if call_module != "Balances" or call_function not in (
            "transfer",
            "transfer_keep_alive",
            "transfer_allow_death",
        ):
            continue

        call_args = {a["name"]: a["value"] for a in call.get("call_args", [])}
        dest = call_args.get("dest", "")
        if isinstance(dest, dict):
            dest = dest.get("Id", "")

        if dest != burn_address:
            continue

        # Found a transfer to the burn address
        value = call_args.get("value", 0)
        amount_tao = value / 1e9

        # Extract sender
        ex_address = ex.value.get("address", "")
        if isinstance(ex_address, str):
            sender = ex_address
        elif isinstance(ex_address, dict):
            sender = ex_address.get("Id", "")
        else:
            sender = ""

        # Normalize tx hash to hex string
        if isinstance(ex_hash, bytes):
            tx_hex = "0x" + ex_hash.hex()
        elif isinstance(ex_hash, str):
            tx_hex = ex_hash if ex_hash.startswith("0x") else "0x" + ex_hash
        else:
            continue

        results.append((tx_hex, sender, amount_tao))

    return results


async def burn_scan_loop(
    neuron: object,
    burn_ledger: BurnLedger,
    burn_address: str,
    min_amount: float = 0.0001,
) -> None:
    """Background loop that scans blocks and pre-registers burns in the ledger.

    Args:
        neuron: DjinnValidator instance (needs .subtensor.substrate).
        burn_ledger: The BurnLedger to register found burns into.
        burn_address: SS58 address that receives burn payments.
        min_amount: Minimum burn amount per attestation credit (TAO).
    """
    if not hasattr(neuron, "subtensor") or neuron.subtensor is None:  # type: ignore[attr-defined]
        log.warning("burn_scanner_disabled", reason="no subtensor connection")
        return

    substrate = neuron.subtensor.substrate  # type: ignore[attr-defined]
    last_scanned_block: int | None = None

    log.info(
        "burn_scanner_started",
        interval_s=SCAN_INTERVAL,
        burn_address=burn_address,
        min_amount=min_amount,
    )

    while True:
        try:
            current_block = substrate.get_block_number(None)

            if last_scanned_block is None:
                # First run: scan a reasonable initial window
                start_block = max(current_block - INITIAL_SCAN_DEPTH, 0)
            else:
                # Subsequent runs: only scan new blocks since last checkpoint
                start_block = last_scanned_block + 1

            if start_block > current_block:
                # Nothing new to scan
                await asyncio.sleep(SCAN_INTERVAL)
                continue

            blocks_to_scan = current_block - start_block + 1
            burns_found = 0

            for block_num in range(start_block, current_block + 1):
                block_hash = substrate.get_block_hash(block_num)
                burns = _extract_burns_from_block(substrate, block_hash, burn_address)

                for tx_hex, sender, amount_tao in burns:
                    if amount_tao < min_amount:
                        log.debug(
                            "burn_scanner_dust_skipped",
                            tx_hash=tx_hex[:18] + "...",
                            amount=amount_tao,
                        )
                        continue

                    # Pre-register in ledger (record_burn is idempotent for known hashes)
                    # We don't consume a credit here — just register it so it's ready.
                    # Use _preregister_burn which registers without consuming.
                    _preregister(burn_ledger, tx_hex, sender, amount_tao, min_amount)
                    burns_found += 1

            last_scanned_block = current_block

            if burns_found > 0 or blocks_to_scan > 100:
                log.info(
                    "burn_scan_complete",
                    blocks_scanned=blocks_to_scan,
                    burns_found=burns_found,
                    head_block=current_block,
                )

        except asyncio.CancelledError:
            log.info("burn_scanner_cancelled")
            return
        except Exception as e:
            log.warning("burn_scan_error", error=str(e))

        await asyncio.sleep(SCAN_INTERVAL)


def _preregister(
    ledger: BurnLedger,
    tx_hash: str,
    sender: str,
    amount: float,
    min_amount: float,
) -> None:
    """Register a burn in the ledger without consuming a credit.

    If the burn is already known, this is a no-op.
    """
    # Check if already registered
    with ledger._lock:
        row = ledger._conn.execute(
            "SELECT 1 FROM consumed_burns WHERE tx_hash = ?",
            (tx_hash,),
        ).fetchone()
        if row is not None:
            return  # Already registered

        # Register with 0 used credits (all credits available for future use)
        amount_rao = int(amount * 1_000_000_000)
        min_rao = int(min_amount * 1_000_000_000)
        total = max(1, amount_rao // min_rao) if min_rao > 0 else 1

        import time

        ledger._conn.execute(
            "INSERT INTO consumed_burns (tx_hash, coldkey, amount, total_credits, used_credits, created_at) "
            "VALUES (?, ?, ?, ?, 0, ?)",
            (tx_hash, sender, amount, total, int(time.time())),
        )
        ledger._conn.commit()
        log.info(
            "burn_preregistered",
            tx_hash=tx_hash[:18] + "...",
            sender=sender[:12] + "...",
            amount=amount,
            credits=total,
        )
