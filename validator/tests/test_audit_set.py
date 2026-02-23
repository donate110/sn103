"""Tests for AuditSet data model and AuditSetStore."""

from __future__ import annotations

import pytest

from djinn_validator.core.audit_set import (
    SIGNALS_PER_CYCLE,
    AuditSet,
    AuditSetStore,
    AuditSignal,
)
from djinn_validator.core.outcomes import Outcome

GENIUS = "0x" + "aa" * 20
IDIOT = "0x" + "bb" * 20
SAMPLE_OUTCOMES = [Outcome.FAVORABLE] * 10


class TestAuditSignal:
    def test_defaults(self) -> None:
        sig = AuditSignal(signal_id="s1")
        assert sig.outcomes is None
        assert sig.notional == 0
        assert sig.odds == 1_000_000
        assert sig.sla_bps == 10_000


class TestAuditSet:
    def test_empty_set(self) -> None:
        s = AuditSet(genius_address=GENIUS, idiot_address=IDIOT)
        assert not s.is_full
        assert not s.all_resolved
        assert not s.ready_for_settlement

    def test_is_full_at_10(self) -> None:
        s = AuditSet(genius_address=GENIUS, idiot_address=IDIOT)
        for i in range(SIGNALS_PER_CYCLE):
            s.signals[f"sig-{i}"] = AuditSignal(signal_id=f"sig-{i}")
        assert s.is_full

    def test_not_full_at_9(self) -> None:
        s = AuditSet(genius_address=GENIUS, idiot_address=IDIOT)
        for i in range(9):
            s.signals[f"sig-{i}"] = AuditSignal(signal_id=f"sig-{i}")
        assert not s.is_full

    def test_all_resolved_when_outcomes_set(self) -> None:
        s = AuditSet(genius_address=GENIUS, idiot_address=IDIOT)
        for i in range(3):
            s.signals[f"sig-{i}"] = AuditSignal(
                signal_id=f"sig-{i}", outcomes=SAMPLE_OUTCOMES
            )
        assert s.all_resolved

    def test_not_resolved_when_missing(self) -> None:
        s = AuditSet(genius_address=GENIUS, idiot_address=IDIOT)
        s.signals["sig-0"] = AuditSignal(signal_id="sig-0", outcomes=SAMPLE_OUTCOMES)
        s.signals["sig-1"] = AuditSignal(signal_id="sig-1")  # no outcomes
        assert not s.all_resolved

    def test_not_resolved_when_empty(self) -> None:
        s = AuditSet(genius_address=GENIUS, idiot_address=IDIOT)
        assert not s.all_resolved

    def test_ready_for_settlement(self) -> None:
        s = AuditSet(genius_address=GENIUS, idiot_address=IDIOT)
        for i in range(SIGNALS_PER_CYCLE):
            s.signals[f"sig-{i}"] = AuditSignal(
                signal_id=f"sig-{i}", outcomes=SAMPLE_OUTCOMES
            )
        assert s.ready_for_settlement

    def test_not_ready_when_settled(self) -> None:
        s = AuditSet(genius_address=GENIUS, idiot_address=IDIOT, settled=True)
        for i in range(SIGNALS_PER_CYCLE):
            s.signals[f"sig-{i}"] = AuditSignal(
                signal_id=f"sig-{i}", outcomes=SAMPLE_OUTCOMES
            )
        assert not s.ready_for_settlement


class TestAuditSetStore:
    def test_add_signal(self) -> None:
        store = AuditSetStore()
        result = store.add_signal(GENIUS, IDIOT, 0, "sig-1")
        assert len(result.signals) == 1
        assert "sig-1" in result.signals

    def test_add_multiple_signals(self) -> None:
        store = AuditSetStore()
        for i in range(5):
            store.add_signal(GENIUS, IDIOT, 0, f"sig-{i}")
        audit_set = store.get_set(GENIUS, IDIOT, 0)
        assert audit_set is not None
        assert len(audit_set.signals) == 5

    def test_add_signal_preserves_economics(self) -> None:
        store = AuditSetStore()
        store.add_signal(GENIUS, IDIOT, 0, "sig-1", notional=100, odds=2_000_000, sla_bps=5000)
        audit_set = store.get_set(GENIUS, IDIOT, 0)
        assert audit_set is not None
        sig = audit_set.signals["sig-1"]
        assert sig.notional == 100
        assert sig.odds == 2_000_000
        assert sig.sla_bps == 5000

    def test_duplicate_signal_ignored(self) -> None:
        store = AuditSetStore()
        store.add_signal(GENIUS, IDIOT, 0, "sig-1")
        store.add_signal(GENIUS, IDIOT, 0, "sig-1")
        audit_set = store.get_set(GENIUS, IDIOT, 0)
        assert audit_set is not None
        assert len(audit_set.signals) == 1

    def test_full_set_rejects_new_signals(self) -> None:
        store = AuditSetStore()
        for i in range(SIGNALS_PER_CYCLE):
            store.add_signal(GENIUS, IDIOT, 0, f"sig-{i}")
        store.add_signal(GENIUS, IDIOT, 0, "sig-extra")
        audit_set = store.get_set(GENIUS, IDIOT, 0)
        assert audit_set is not None
        assert len(audit_set.signals) == SIGNALS_PER_CYCLE
        assert "sig-extra" not in audit_set.signals

    def test_different_cycles_separate(self) -> None:
        store = AuditSetStore()
        store.add_signal(GENIUS, IDIOT, 0, "sig-0")
        store.add_signal(GENIUS, IDIOT, 1, "sig-1")
        assert store.count == 2

    def test_different_pairs_separate(self) -> None:
        idiot2 = "0x" + "cc" * 20
        store = AuditSetStore()
        store.add_signal(GENIUS, IDIOT, 0, "sig-0")
        store.add_signal(GENIUS, idiot2, 0, "sig-1")
        assert store.count == 2

    def test_case_insensitive_keys(self) -> None:
        store = AuditSetStore()
        store.add_signal(GENIUS.upper(), IDIOT.upper(), 0, "sig-0")
        result = store.get_set(GENIUS.lower(), IDIOT.lower(), 0)
        assert result is not None

    def test_record_outcomes(self) -> None:
        store = AuditSetStore()
        store.add_signal(GENIUS, IDIOT, 0, "sig-1")
        success = store.record_outcomes("sig-1", SAMPLE_OUTCOMES)
        assert success is True
        audit_set = store.get_set(GENIUS, IDIOT, 0)
        assert audit_set is not None
        assert audit_set.signals["sig-1"].outcomes == SAMPLE_OUTCOMES

    def test_record_outcomes_unknown_signal(self) -> None:
        store = AuditSetStore()
        success = store.record_outcomes("nonexistent", SAMPLE_OUTCOMES)
        assert success is False

    def test_get_ready_sets(self) -> None:
        store = AuditSetStore()
        # Set 1: full and resolved → ready
        for i in range(SIGNALS_PER_CYCLE):
            store.add_signal(GENIUS, IDIOT, 0, f"sig-{i}")
            store.record_outcomes(f"sig-{i}", SAMPLE_OUTCOMES)
        # Set 2: not full → not ready
        store.add_signal(GENIUS, IDIOT, 1, "sig-next")
        store.record_outcomes("sig-next", SAMPLE_OUTCOMES)

        ready = store.get_ready_sets()
        assert len(ready) == 1
        assert ready[0].cycle == 0

    def test_mark_settled(self) -> None:
        store = AuditSetStore()
        for i in range(SIGNALS_PER_CYCLE):
            store.add_signal(GENIUS, IDIOT, 0, f"sig-{i}")
            store.record_outcomes(f"sig-{i}", SAMPLE_OUTCOMES)
        assert len(store.get_ready_sets()) == 1

        store.mark_settled(GENIUS, IDIOT, 0)
        assert len(store.get_ready_sets()) == 0

    def test_get_set_for_signal(self) -> None:
        store = AuditSetStore()
        store.add_signal(GENIUS, IDIOT, 0, "sig-42")
        result = store.get_set_for_signal("sig-42")
        assert result is not None
        assert result.genius_address == GENIUS

    def test_get_set_for_unknown_signal(self) -> None:
        store = AuditSetStore()
        assert store.get_set_for_signal("nope") is None

    def test_count(self) -> None:
        store = AuditSetStore()
        assert store.count == 0
        store.add_signal(GENIUS, IDIOT, 0, "sig-1")
        assert store.count == 1
