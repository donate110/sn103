"""Bootstrap audit sets from on-chain state.

On startup the validator has no in-memory audit sets because
AuditSetStore is ephemeral.  This module reconstructs them from
on-chain truth (Account.getPurchaseIds + Escrow.getPurchase) using
the genius addresses already persisted in the ShareStore.

Flow:
  1. Query ShareStore for all distinct genius addresses
  2. Scan SignalPurchased events (or use share signal_ids) to find buyers
  3. For each (genius, idiot) pair: read current cycle + purchase IDs
  4. Populate AuditSetStore with signal data from chain
  5. The normal epoch loop then resolves outcomes and triggers settlement
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import structlog

if TYPE_CHECKING:
    from djinn_validator.chain.contracts import ChainClient
    from djinn_validator.core.audit_set import AuditSetStore
    from djinn_validator.core.shares import ShareStore

log = structlog.get_logger()


async def bootstrap_audit_sets(
    chain_client: "ChainClient",
    share_store: "ShareStore",
    audit_set_store: "AuditSetStore",
) -> int:
    """Populate audit_set_store from on-chain state.

    Returns the number of audit sets populated.
    """
    # Step 1: Get all distinct (genius_address, signal_id) pairs from shares DB
    genius_signals = _get_genius_signals(share_store)
    if not genius_signals:
        log.info("audit_bootstrap_no_shares")
        return 0

    # Step 2: For each signal, find buyers via on-chain purchases
    # Collect unique (genius, idiot) pairs
    pairs: set[tuple[str, str]] = set()
    signal_count = len(genius_signals)
    log.info("audit_bootstrap_scanning", signals=signal_count)

    # Batch check: only look at signals that have purchases.
    # Use small batches with delays to avoid RPC rate limits (Base Sepolia
    # public endpoint returns 403 under heavy load).
    batch_size = 5
    signal_list = list(genius_signals.items())
    errors = 0

    for i in range(0, len(signal_list), batch_size):
        batch = signal_list[i : i + batch_size]
        tasks = []
        for signal_id, genius_addr in batch:
            tasks.append(_get_buyers_for_signal(chain_client, signal_id, genius_addr))

        results = await asyncio.gather(*tasks, return_exceptions=True)
        for result in results:
            if isinstance(result, Exception):
                errors += 1
                continue
            for genius, idiot in result:
                pairs.add((genius.lower(), idiot.lower()))

        # Log progress every 100 signals
        processed = min(i + batch_size, len(signal_list))
        if processed % 100 < batch_size:
            log.info(
                "audit_bootstrap_progress",
                processed=processed,
                total=len(signal_list),
                pairs_found=len(pairs),
                errors=errors,
            )

        # Delay between batches to avoid RPC rate limits
        if i + batch_size < len(signal_list):
            await asyncio.sleep(1.0)

    if not pairs:
        log.info("audit_bootstrap_no_pairs")
        return 0

    log.info("audit_bootstrap_pairs_found", count=len(pairs))

    # Step 3: For each pair, load current cycle purchase data
    populated = 0
    for genius, idiot in pairs:
        try:
            cycle = await chain_client.get_current_cycle(genius, idiot)
            count = await chain_client.get_signal_count(genius, idiot)
            if count == 0:
                continue

            purchase_ids = await chain_client.get_purchase_ids(genius, idiot)
            if not purchase_ids:
                continue

            # Load each purchase and populate the audit set
            for pid in purchase_ids:
                try:
                    purchase = await chain_client.get_purchase(pid)
                    if purchase is None:
                        continue

                    signal_id = str(purchase["signalId"])
                    notional = int(purchase["notional"])
                    odds = int(purchase["odds"])

                    # Get SLA from the signal commitment
                    signal = await chain_client.get_signal(int(signal_id))
                    sla_bps = int(signal["slaMultiplierBps"]) if signal and isinstance(signal, dict) else 10_000

                    audit_set_store.add_signal(
                        genius=genius,
                        idiot=idiot,
                        cycle=cycle,
                        signal_id=signal_id,
                        notional=notional,
                        odds=odds,
                        sla_bps=sla_bps,
                    )
                except Exception as e:
                    log.debug(
                        "audit_bootstrap_purchase_skip",
                        purchase_id=pid,
                        err=str(e)[:100],
                    )
                    continue

            populated += 1
            log.info(
                "audit_bootstrap_pair_loaded",
                genius=genius[:10],
                idiot=idiot[:10],
                cycle=cycle,
                signals=count,
                purchases=len(purchase_ids),
            )

            # Small delay between pairs
            await asyncio.sleep(0.2)

        except Exception as e:
            log.debug(
                "audit_bootstrap_pair_skip",
                genius=genius[:10],
                idiot=idiot[:10],
                err=str(e)[:100],
            )
            continue

    ready = audit_set_store.get_ready_sets()
    log.info(
        "audit_bootstrap_complete",
        pairs_loaded=populated,
        total_audit_sets=audit_set_store.count,
        ready_for_settlement=len(ready),
    )
    return populated


async def _get_buyers_for_signal(
    chain_client: "ChainClient",
    signal_id: str,
    genius_addr: str,
) -> list[tuple[str, str]]:
    """Return list of (genius, idiot) pairs for a signal's purchases."""
    pairs = []
    try:
        purchase_ids = await chain_client.get_purchases_by_signal(int(signal_id))
        if purchase_ids:
            log.info(
                "audit_bootstrap_signal_has_purchases",
                signal_id=signal_id[:20],
                purchases=len(purchase_ids),
            )
        for pid in purchase_ids:
            purchase = await chain_client.get_purchase(pid)
            if purchase:
                buyer = purchase["idiot"]
                pairs.append((genius_addr, buyer))
    except Exception as e:
        # Only log first few errors to avoid spam
        if not hasattr(_get_buyers_for_signal, "_error_count"):
            _get_buyers_for_signal._error_count = 0  # type: ignore[attr-defined]
        _get_buyers_for_signal._error_count += 1  # type: ignore[attr-defined]
        if _get_buyers_for_signal._error_count <= 5:  # type: ignore[attr-defined]
            log.info(
                "audit_bootstrap_buyer_check_failed",
                signal_id=signal_id[:20],
                err=str(e)[:150],
            )
    return pairs


def _get_genius_signals(share_store: "ShareStore") -> dict[str, str]:
    """Query ShareStore for all (signal_id -> genius_address) mappings."""
    result: dict[str, str] = {}
    try:
        with share_store._lock:
            cursor = share_store._conn.execute(
                "SELECT DISTINCT signal_id, genius_address FROM shares"
            )
            for row in cursor:
                result[row[0]] = row[1]
    except Exception as e:
        log.error("audit_bootstrap_db_query_failed", err=str(e))
    return result
