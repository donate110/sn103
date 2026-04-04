"""Bootstrap audit sets from on-chain state.

On startup the validator has no in-memory audit sets because
AuditSetStore is ephemeral.  This module reconstructs them from
on-chain truth (Account.getPurchaseIds + Escrow.getPurchase) using
the genius addresses already persisted in the ShareStore.

Also registers signals with the OutcomeAttestor by parsing the
on-chain decoyLines (which contain full JSON with sport, event_id,
home_team, away_team, market, line, side, price, commence_time).

Flow:
  1. Query ShareStore for all distinct genius addresses
  2. Scan SignalPurchased events (or use share signal_ids) to find buyers
  3. For each (genius, idiot) pair: read current cycle + purchase IDs
  4. Populate AuditSetStore with signal data from chain
  5. Parse decoy line JSON and register signals with OutcomeAttestor
  6. The normal epoch loop then resolves outcomes and triggers settlement
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

import structlog

if TYPE_CHECKING:
    from djinn_validator.chain.contracts import ChainClient
    from djinn_validator.core.audit_set import AuditSetStore
    from djinn_validator.core.outcomes import OutcomeAttestor
    from djinn_validator.core.shares import ShareStore

log = structlog.get_logger()


async def bootstrap_audit_sets(
    chain_client: "ChainClient",
    share_store: "ShareStore",
    audit_set_store: "AuditSetStore",
    outcome_attestor: "OutcomeAttestor | None" = None,
) -> int:
    """Populate audit_set_store from on-chain state.

    If outcome_attestor is provided, also registers signals by parsing
    the on-chain decoyLines JSON so the epoch loop can resolve outcomes.

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

    # Detect contract version to decide which read path to use
    contract_version = await chain_client.detect_contract_version()
    log.info("audit_bootstrap_contract_version", version=contract_version)

    # Step 3: For each pair, load purchase data (v1: cycle-based, v2: queue-based)
    populated = 0
    for genius, idiot in pairs:
        try:
            if contract_version == 2:
                populated += await _bootstrap_pair_v2(
                    chain_client, audit_set_store, genius, idiot,
                )
            else:
                populated += await _bootstrap_pair_v1(
                    chain_client, audit_set_store, genius, idiot,
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

    # Step 4: Register signals with OutcomeAttestor by parsing on-chain decoy lines.
    # The decoyLines stored on-chain contain full JSON with sport, event_id, teams.
    if outcome_attestor and populated > 0:
        registered = await _register_signals_from_chain(
            chain_client, audit_set_store, outcome_attestor,
        )
        log.info("audit_bootstrap_signals_registered", count=registered)

    ready = audit_set_store.get_ready_sets()
    log.info(
        "audit_bootstrap_complete",
        pairs_loaded=populated,
        total_audit_sets=audit_set_store.count,
        ready_for_settlement=len(ready),
    )
    return populated


async def _bootstrap_pair_v1(
    chain_client: "ChainClient",
    audit_set_store: "AuditSetStore",
    genius: str,
    idiot: str,
) -> int:
    """Bootstrap a single pair using v1 cycle-based reads. Returns 1 on success, 0 on skip."""
    cycle = await chain_client.get_current_cycle(genius, idiot)
    count = await chain_client.get_signal_count(genius, idiot)
    if count == 0:
        return 0

    purchase_ids = await chain_client.get_purchase_ids(genius, idiot)
    if not purchase_ids:
        return 0

    for pid in purchase_ids:
        try:
            purchase = await chain_client.get_purchase(pid)
            if purchase is None:
                continue

            signal_id = str(purchase["signalId"])
            notional = int(purchase["notional"])
            odds = int(purchase["odds"])

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
                purchase_id=pid,
            )
        except Exception as e:
            log.debug("audit_bootstrap_purchase_skip", purchase_id=pid, err=str(e)[:100])
            continue

    log.info(
        "audit_bootstrap_pair_loaded",
        genius=genius[:10],
        idiot=idiot[:10],
        cycle=cycle,
        signals=count,
        purchases=len(purchase_ids),
        version=1,
    )
    return 1


async def _bootstrap_pair_v2(
    chain_client: "ChainClient",
    audit_set_store: "AuditSetStore",
    genius: str,
    idiot: str,
) -> int:
    """Bootstrap a single pair using v2 queue-based reads. Returns 1 on success, 0 on skip."""
    total_purchases, resolved_count, audited_count, batch_count = await chain_client.get_queue_state(
        genius, idiot,
    )
    unaudited_resolved = resolved_count - audited_count
    if total_purchases == 0 or unaudited_resolved <= 0:
        return 0

    purchase_ids = await chain_client.get_pair_purchase_ids(genius, idiot)
    if not purchase_ids:
        return 0

    # Filter to unaudited purchases only
    loaded = 0
    for pid in purchase_ids:
        try:
            already_audited = await chain_client.is_purchase_audited(pid)
            if already_audited:
                continue

            purchase = await chain_client.get_purchase(pid)
            if purchase is None:
                continue

            signal_id = str(purchase["signalId"])
            notional = int(purchase["notional"])
            odds = int(purchase["odds"])

            signal = await chain_client.get_signal(int(signal_id))
            sla_bps = int(signal["slaMultiplierBps"]) if signal and isinstance(signal, dict) else 10_000

            # v2: use batch_count as the "cycle" identifier for the current batch
            audit_set_store.add_signal(
                genius=genius,
                idiot=idiot,
                cycle=batch_count,
                signal_id=signal_id,
                notional=notional,
                odds=odds,
                sla_bps=sla_bps,
                purchase_id=pid,
            )
            loaded += 1
        except Exception as e:
            log.debug("audit_bootstrap_purchase_skip", purchase_id=pid, err=str(e)[:100])
            continue

    if loaded > 0:
        log.info(
            "audit_bootstrap_pair_loaded",
            genius=genius[:10],
            idiot=idiot[:10],
            cycle=batch_count,
            signals=loaded,
            purchases=len(purchase_ids),
            unaudited_resolved=unaudited_resolved,
            version=2,
        )
        return 1
    return 0


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


async def _register_signals_from_chain(
    chain_client: "ChainClient",
    audit_set_store: "AuditSetStore",
    outcome_attestor: "OutcomeAttestor",
) -> int:
    """Parse on-chain decoyLines JSON and register signals for outcome resolution.

    The decoyLines stored on SignalCommitment contain full JSON objects like:
      {"sport":"soccer_epl","event_id":"9c44...","home_team":"Sunderland",
       "away_team":"Brighton","market":"h2h","line":null,"side":"Brighton",
       "price":2.19,"commence_time":"2026-03-14T15:00:00Z"}

    We parse these to build SignalMetadata for the OutcomeAttestor.
    """
    from djinn_validator.core.outcomes import SignalMetadata, parse_pick

    # Collect all unique signal_ids from loaded audit sets
    signal_ids: set[str] = set()
    for audit_set in audit_set_store._sets.values():
        for sig_id in audit_set.signals:
            signal_ids.add(sig_id)

    if not signal_ids:
        return 0

    registered = 0
    for signal_id in signal_ids:
        # Skip if already registered
        if outcome_attestor.get_signal(signal_id) is not None:
            continue

        try:
            signal = await chain_client.get_signal(int(signal_id))
            if not signal or not isinstance(signal, dict):
                continue

            decoy_lines = signal.get("decoyLines", [])
            if not decoy_lines or len(decoy_lines) < 10:
                continue

            # Parse the first decoy line's JSON to extract game metadata
            first_line = _parse_decoy_json(decoy_lines[0])
            if not first_line:
                continue

            sport = first_line.get("sport", "")
            event_id = first_line.get("event_id", "")
            home_team = first_line.get("home_team", "")
            away_team = first_line.get("away_team", "")

            if not sport or not event_id:
                continue

            # Build pick strings for parse_pick (e.g., "Brighton ML +220")
            parsed_lines = []
            for dl in decoy_lines:
                dl_data = _parse_decoy_json(dl)
                if dl_data:
                    pick_str = _decoy_to_pick_string(dl_data)
                    try:
                        parsed_lines.append(parse_pick(pick_str))
                    except Exception:
                        parsed_lines.append(parse_pick("Unknown 0 (+100)"))
                else:
                    parsed_lines.append(parse_pick("Unknown 0 (+100)"))

            if len(parsed_lines) != 10:
                continue

            metadata = SignalMetadata(
                signal_id=signal_id,
                sport=sport,
                event_id=event_id,
                home_team=home_team,
                away_team=away_team,
                lines=parsed_lines,
            )
            outcome_attestor.register_signal(metadata)
            registered += 1

        except Exception as e:
            log.debug(
                "audit_bootstrap_register_skip",
                signal_id=signal_id[:20],
                err=str(e)[:100],
            )
            continue

        # Rate limit
        if registered % 10 == 0:
            await asyncio.sleep(0.5)

    return registered


def _parse_decoy_json(line: str) -> dict | None:
    """Try to parse a decoy line as JSON."""
    try:
        data = json.loads(line)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, TypeError):
        pass
    return None


def _decoy_to_pick_string(data: dict) -> str:
    """Convert a decoy line JSON object to a pick string for parse_pick."""
    market = data.get("market", "h2h")
    team = data.get("side", data.get("team", "Unknown"))
    line_val = data.get("line")
    price = data.get("price", 2.0)

    # Convert decimal odds to American
    if price >= 2.0:
        american = int((price - 1) * 100)
    else:
        american = int(-100 / (price - 1))

    if market == "spreads" and line_val is not None:
        return f"{team} {line_val:+g} ({american:+d})"
    elif market == "totals" and line_val is not None:
        side = data.get("side", "Over")
        return f"{side} {line_val} ({american:+d})"
    else:
        # h2h / moneyline
        return f"{team} ML ({american:+d})"
