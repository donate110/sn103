"""Audit set tracking for batch settlement.

An audit set is 10 signals between one genius-idiot pair (one settlement
cycle).  The validator resolves all 100 outcomes (10 signals × 10 lines)
from public data, then a single batch MPC extracts the 10 real outcomes
and computes aggregate statistics — never revealing individual results.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

import structlog

from djinn_validator.core.outcomes import Outcome

log = structlog.get_logger()

SIGNALS_PER_CYCLE = 10  # Matches Account.sol


@dataclass
class AuditSignal:
    """One signal within an audit set."""

    signal_id: str
    outcomes: list[Outcome] | None = None  # 10 line outcomes once game resolves
    notional: int = 0  # Purchase notional (wei)
    odds: int = 1_000_000  # 6-decimal odds (1.0 = 1_000_000)
    sla_bps: int = 10_000  # SLA multiplier in basis points


@dataclass
class AuditSet:
    """A settlement cycle: 10 signals between one genius-idiot pair."""

    genius_address: str
    idiot_address: str
    cycle: int = 0
    signals: dict[str, AuditSignal] = field(default_factory=dict)
    settled: bool = False

    @property
    def is_full(self) -> bool:
        return len(self.signals) >= SIGNALS_PER_CYCLE

    @property
    def all_resolved(self) -> bool:
        return bool(self.signals) and all(
            s.outcomes is not None for s in self.signals.values()
        )

    @property
    def ready_for_settlement(self) -> bool:
        return self.is_full and self.all_resolved and not self.settled


class AuditSetStore:
    """In-memory store for audit sets, keyed by (genius, idiot, cycle).

    Thread-safe via a lock since the epoch loop and API may access
    concurrently.
    """

    def __init__(self) -> None:
        self._sets: dict[tuple[str, str, int], AuditSet] = {}
        self._signal_index: dict[str, tuple[str, str, int]] = {}
        self._lock = threading.Lock()

    def add_signal(
        self,
        genius: str,
        idiot: str,
        cycle: int,
        signal_id: str,
        notional: int = 0,
        odds: int = 1_000_000,
        sla_bps: int = 10_000,
    ) -> AuditSet:
        """Add a signal to the audit set for (genius, idiot, cycle)."""
        key = (genius.lower(), idiot.lower(), cycle)
        with self._lock:
            audit_set = self._sets.get(key)
            if audit_set is None:
                audit_set = AuditSet(
                    genius_address=genius,
                    idiot_address=idiot,
                    cycle=cycle,
                )
                self._sets[key] = audit_set

            if signal_id in audit_set.signals:
                log.debug("signal_already_in_audit_set", signal_id=signal_id)
                return audit_set

            if audit_set.is_full:
                log.warning(
                    "audit_set_full",
                    genius=genius,
                    idiot=idiot,
                    cycle=cycle,
                    signal_id=signal_id,
                )
                return audit_set

            audit_set.signals[signal_id] = AuditSignal(
                signal_id=signal_id,
                notional=notional,
                odds=odds,
                sla_bps=sla_bps,
            )
            self._signal_index[signal_id] = key
            log.debug(
                "signal_added_to_audit_set",
                signal_id=signal_id,
                genius=genius,
                idiot=idiot,
                cycle=cycle,
                count=len(audit_set.signals),
            )
            return audit_set

    def record_outcomes(self, signal_id: str, outcomes: list[Outcome]) -> bool:
        """Record the 10 line outcomes for a signal."""
        with self._lock:
            key = self._signal_index.get(signal_id)
            if key is None:
                return False
            audit_set = self._sets.get(key)
            if audit_set is None:
                return False
            signal = audit_set.signals.get(signal_id)
            if signal is None:
                return False
            signal.outcomes = outcomes
            return True

    def get_ready_sets(self) -> list[AuditSet]:
        """Return all audit sets ready for batch settlement."""
        with self._lock:
            return [s for s in self._sets.values() if s.ready_for_settlement]

    def mark_settled(self, genius: str, idiot: str, cycle: int) -> None:
        """Mark an audit set as settled to prevent re-processing."""
        key = (genius.lower(), idiot.lower(), cycle)
        with self._lock:
            audit_set = self._sets.get(key)
            if audit_set is not None:
                audit_set.settled = True

    def get_set(self, genius: str, idiot: str, cycle: int) -> AuditSet | None:
        """Look up an audit set by key."""
        key = (genius.lower(), idiot.lower(), cycle)
        with self._lock:
            return self._sets.get(key)

    def get_set_for_signal(self, signal_id: str) -> AuditSet | None:
        """Look up the audit set containing a signal."""
        with self._lock:
            key = self._signal_index.get(signal_id)
            if key is None:
                return None
            return self._sets.get(key)

    @property
    def count(self) -> int:
        """Total number of tracked audit sets."""
        with self._lock:
            return len(self._sets)
