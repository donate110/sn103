"""Audit set tracking for batch settlement.

Supports two contract models:
- v1 (cycle-based): A fixed cycle of 10 signals between one genius-idiot
  pair.  Settlement triggers when the cycle is full and all resolved.
- v2 (queue-based): An append-only purchase queue.  Settlement triggers
  when 10+ resolved, unaudited purchases exist for a pair.

The internal data model uses the queue model (it is a superset of cycles).
The difference is only in readiness logic and on-chain call signatures.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

import structlog

from djinn_validator.core.outcomes import Outcome

log = structlog.get_logger()

SIGNALS_PER_CYCLE = 10  # v1 cycle size / v2 minimum batch size
MIN_BATCH_SIZE = 10  # v2: minimum resolved-unaudited purchases to trigger settlement


@dataclass
class AuditSignal:
    """One signal within an audit set."""

    signal_id: str
    purchase_id: int = 0  # On-chain Escrow purchase ID (needed for v2 vote)
    outcomes: list[Outcome] | None = None  # 10 line outcomes once game resolves
    notional: int = 0  # Purchase notional (wei)
    odds: int = 1_000_000  # 6-decimal odds (1.0 = 1_000_000)
    sla_bps: int = 10_000  # SLA multiplier in basis points


@dataclass
class AuditSet:
    """A settlement batch: signals between one genius-idiot pair.

    In v1, this represents a fixed 10-signal cycle.
    In v2, this is a batch of 10+ resolved, unaudited purchases.
    """

    genius_address: str
    idiot_address: str
    cycle: int = 0  # v1: cycle number; v2: batch number (monotonically increasing)
    signals: dict[str, AuditSignal] = field(default_factory=dict)
    settled: bool = False
    version: int = 1  # 1 = cycle-based, 2 = queue-based

    @property
    def is_full(self) -> bool:
        """v1: cycle has 10 signals. v2: always False (queue grows unbounded)."""
        if self.version == 2:
            return False  # v2 queues are never "full"
        return len(self.signals) >= SIGNALS_PER_CYCLE

    @property
    def resolved_signals(self) -> list[AuditSignal]:
        """All signals whose outcomes have been resolved."""
        return [s for s in self.signals.values() if s.outcomes is not None]

    @property
    def all_resolved(self) -> bool:
        return bool(self.signals) and all(
            s.outcomes is not None for s in self.signals.values()
        )

    @property
    def ready_for_settlement(self) -> bool:
        """Check if this set is ready for batch MPC settlement.

        v1: exactly 10 signals, all resolved, not yet settled.
        v2: 10+ resolved signals, not yet settled.
        """
        if self.settled:
            return False
        if self.version == 2:
            return len(self.resolved_signals) >= MIN_BATCH_SIZE
        return self.is_full and self.all_resolved

    @property
    def purchase_ids(self) -> list[int]:
        """All on-chain purchase IDs in this set (for v2 vote submission)."""
        return [s.purchase_id for s in self.signals.values() if s.purchase_id > 0]

    @property
    def resolved_purchase_ids(self) -> list[int]:
        """Purchase IDs for resolved signals only (for v2 batch voting)."""
        return [
            s.purchase_id
            for s in self.signals.values()
            if s.outcomes is not None and s.purchase_id > 0
        ]


class AuditSetStore:
    """In-memory store for audit sets, keyed by (genius, idiot, cycle).

    Thread-safe via a lock since the epoch loop and API may access
    concurrently. Works with both v1 and v2 contract models.
    """

    def __init__(self, contract_version: int = 1) -> None:
        self._sets: dict[tuple[str, str, int], AuditSet] = {}
        self._signal_index: dict[str, tuple[str, str, int]] = {}
        self._lock = threading.Lock()
        self._contract_version = contract_version

    @property
    def contract_version(self) -> int:
        return self._contract_version

    @contract_version.setter
    def contract_version(self, value: int) -> None:
        if value != self._contract_version:
            log.info("audit_set_store_version_changed", old=self._contract_version, new=value)
            self._contract_version = value

    def add_signal(
        self,
        genius: str,
        idiot: str,
        cycle: int,
        signal_id: str,
        notional: int = 0,
        odds: int = 1_000_000,
        sla_bps: int = 10_000,
        purchase_id: int = 0,
    ) -> AuditSet:
        """Add a signal to the audit set for (genius, idiot, cycle).

        In v2, cycle is the batch number (or 0 for the active queue).
        """
        key = (genius.lower(), idiot.lower(), cycle)
        with self._lock:
            audit_set = self._sets.get(key)
            if audit_set is None:
                audit_set = AuditSet(
                    genius_address=genius,
                    idiot_address=idiot,
                    cycle=cycle,
                    version=self._contract_version,
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
                purchase_id=purchase_id,
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
                purchase_id=purchase_id,
                version=self._contract_version,
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
