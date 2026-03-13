"""Batch MPC settlement for audit sets.

Processes an entire audit set (10 signals × 10 lines = 100 outcomes) in
one pass, outputting only aggregate statistics.  No individual signal
outcome is ever revealed to validators.

Quality score formula (matches Audit.sol computeScore):
  FAVORABLE:   +notional × (odds - 1e6) / 1e6
  UNFAVORABLE: -notional × sla_bps / 10_000
  VOID:         0
"""

from __future__ import annotations

from dataclasses import dataclass

import structlog

from djinn_validator.core.audit_set import AuditSet
from djinn_validator.core.mpc_outcome import prototype_select_outcome
from djinn_validator.core.outcomes import Outcome
from djinn_validator.core.shares import ShareStore
from djinn_validator.utils.crypto import BN254_PRIME, Share

log = structlog.get_logger()


@dataclass
class AuditResult:
    """Aggregate settlement result — the only output of batch MPC."""

    genius: str
    idiot: str
    cycle: int
    quality_score: int  # Signed, in notional units (USDC 6-decimal)
    total_notional: int  # Sum of notional for non-void signals (CF-06)
    wins: int
    losses: int
    voids: int
    n: int


def _compute_signal_quality(
    outcome: Outcome,
    notional: int,
    odds: int,
    sla_bps: int,
) -> int:
    """Compute per-signal quality contribution.

    Matches Audit.sol computeScore() formula.
    """
    if outcome == Outcome.FAVORABLE:
        return notional * (odds - 1_000_000) // 1_000_000
    elif outcome == Outcome.UNFAVORABLE:
        return -(notional * sla_bps // 10_000)
    return 0  # VOID or PENDING


def batch_settle_audit_set(
    audit_set: AuditSet,
    share_store: ShareStore,
    threshold: int = 1,
    prime: int = BN254_PRIME,
) -> AuditResult | None:
    """Run batch MPC settlement on a complete audit set.

    For each signal:
    1. Retrieve index shares from the share store
    2. Use prototype_select_outcome to extract the real outcome
    3. Compute quality contribution using the Audit.sol formula

    Returns aggregate statistics only — never individual outcomes.

    In prototype/dev mode, prototype_select_outcome reconstructs the index
    locally.  In production with distributed MPC, each validator only holds
    one Shamir share and the polynomial evaluation prevents any single
    validator from learning any index.
    """
    if not audit_set.ready_for_settlement:
        log.warning(
            "audit_set_not_ready",
            genius=audit_set.genius_address,
            idiot=audit_set.idiot_address,
            cycle=audit_set.cycle,
        )
        return None

    quality_score = 0
    total_notional = 0
    wins = 0
    losses = 0
    voids = 0
    n = 0

    for signal_id, signal in audit_set.signals.items():
        if signal.outcomes is None:
            log.error("signal_outcomes_missing", signal_id=signal_id)
            return None

        # Get index shares for this signal
        all_records = share_store.get_all(signal_id)
        if not all_records:
            log.warning("no_shares_for_signal", signal_id=signal_id)
            return None

        index_shares: list[Share] = []
        for rec in all_records:
            if rec.encrypted_index_share and len(rec.encrypted_index_share) > 0:
                index_shares.append(
                    Share(
                        x=rec.share.x,
                        y=int.from_bytes(rec.encrypted_index_share, "big"),
                    )
                )

        if not index_shares:
            log.warning("no_index_shares_for_signal", signal_id=signal_id)
            return None

        # MPC: extract the real outcome without revealing the index
        outcome_value = prototype_select_outcome(
            index_shares,
            [o.value for o in signal.outcomes],
            threshold=threshold,
            prime=prime,
        )

        if outcome_value is None:
            log.warning("outcome_selection_failed", signal_id=signal_id)
            return None

        outcome = Outcome(outcome_value)
        contribution = _compute_signal_quality(
            outcome, signal.notional, signal.odds, signal.sla_bps,
        )
        quality_score += contribution

        if outcome == Outcome.FAVORABLE:
            wins += 1
            total_notional += signal.notional
        elif outcome == Outcome.UNFAVORABLE:
            losses += 1
            total_notional += signal.notional
        elif outcome == Outcome.VOID:
            voids += 1
            # Void signals excluded from total_notional (CF-06)
        n += 1

    log.info(
        "audit_set_settled",
        genius=audit_set.genius_address,
        idiot=audit_set.idiot_address,
        cycle=audit_set.cycle,
        quality_score=quality_score,
        total_notional=total_notional,
        wins=wins,
        losses=losses,
        voids=voids,
        n=n,
    )

    return AuditResult(
        genius=audit_set.genius_address,
        idiot=audit_set.idiot_address,
        cycle=audit_set.cycle,
        quality_score=quality_score,
        total_notional=total_notional,
        wins=wins,
        losses=losses,
        voids=voids,
        n=n,
    )
