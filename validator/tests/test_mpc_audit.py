"""Tests for batch MPC audit set settlement."""

from __future__ import annotations

import pytest

from djinn_validator.core.audit_set import AuditSet, AuditSetStore, AuditSignal
from djinn_validator.core.mpc_audit import (
    AuditResult,
    _compute_signal_quality,
    batch_settle_audit_set,
)
from djinn_validator.core.outcomes import Outcome
from djinn_validator.core.shares import ShareStore
from djinn_validator.utils.crypto import Share

GENIUS = "0x" + "aa" * 20
IDIOT = "0x" + "bb" * 20


def _make_share_store_with_index(signal_ids: list[str], indices: list[int]) -> ShareStore:
    """Create a ShareStore with index shares for the given signals."""
    store = ShareStore()  # in-memory
    for signal_id, idx in zip(signal_ids, indices):
        store.store(
            signal_id=signal_id,
            genius_address=GENIUS,
            share=Share(x=1, y=42),
            encrypted_key_share=b"key",
            encrypted_index_share=idx.to_bytes(32, "big"),
        )
    return store


def _make_full_audit_set(
    outcomes_per_signal: list[list[Outcome]] | None = None,
    notionals: list[int] | None = None,
    odds_list: list[int] | None = None,
    sla_list: list[int] | None = None,
) -> AuditSet:
    """Create a full audit set with 10 signals."""
    audit_set = AuditSet(genius_address=GENIUS, idiot_address=IDIOT, cycle=0)
    for i in range(10):
        outcomes = outcomes_per_signal[i] if outcomes_per_signal else [Outcome.FAVORABLE] * 10
        notional = notionals[i] if notionals else 1_000_000
        odds = odds_list[i] if odds_list else 2_000_000  # +100 (even money)
        sla = sla_list[i] if sla_list else 10_000
        audit_set.signals[f"sig-{i}"] = AuditSignal(
            signal_id=f"sig-{i}",
            outcomes=outcomes,
            notional=notional,
            odds=odds,
            sla_bps=sla,
        )
    return audit_set


class TestComputeSignalQuality:
    def test_favorable(self) -> None:
        # notional=1M, odds=2M (even money): profit = 1M * (2M-1M)/1M = 1M
        score = _compute_signal_quality(Outcome.FAVORABLE, 1_000_000, 2_000_000, 10_000)
        assert score == 1_000_000

    def test_favorable_high_odds(self) -> None:
        # notional=1M, odds=3M (+200): profit = 1M * (3M-1M)/1M = 2M
        score = _compute_signal_quality(Outcome.FAVORABLE, 1_000_000, 3_000_000, 10_000)
        assert score == 2_000_000

    def test_unfavorable(self) -> None:
        # notional=1M, sla=10000bps (100%): loss = 1M * 10000/10000 = 1M
        score = _compute_signal_quality(Outcome.UNFAVORABLE, 1_000_000, 2_000_000, 10_000)
        assert score == -1_000_000

    def test_unfavorable_half_sla(self) -> None:
        # notional=1M, sla=5000bps (50%): loss = 1M * 5000/10000 = 500K
        score = _compute_signal_quality(Outcome.UNFAVORABLE, 1_000_000, 2_000_000, 5_000)
        assert score == -500_000

    def test_void(self) -> None:
        score = _compute_signal_quality(Outcome.VOID, 1_000_000, 2_000_000, 10_000)
        assert score == 0

    def test_pending(self) -> None:
        score = _compute_signal_quality(Outcome.PENDING, 1_000_000, 2_000_000, 10_000)
        assert score == 0


class TestBatchSettleAuditSet:
    def test_all_favorable(self) -> None:
        """All 10 signals win: quality score = sum of profits."""
        # Each signal: real index=1, line 1 is FAVORABLE, even money, notional=1M
        indices = [1] * 10
        signal_ids = [f"sig-{i}" for i in range(10)]
        share_store = _make_share_store_with_index(signal_ids, indices)

        outcomes_per_signal = []
        for _ in range(10):
            outcomes = [Outcome.UNFAVORABLE] * 10
            outcomes[0] = Outcome.FAVORABLE  # index 1 (0-based: 0) is real
            outcomes_per_signal.append(outcomes)

        audit_set = _make_full_audit_set(outcomes_per_signal=outcomes_per_signal)
        result = batch_settle_audit_set(audit_set, share_store, threshold=1)

        assert result is not None
        assert result.wins == 10
        assert result.losses == 0
        assert result.voids == 0
        assert result.n == 10
        # Each: 1M * (2M-1M)/1M = 1M profit; total = 10M
        assert result.quality_score == 10_000_000

    def test_all_unfavorable(self) -> None:
        """All 10 signals lose."""
        indices = [1] * 10
        signal_ids = [f"sig-{i}" for i in range(10)]
        share_store = _make_share_store_with_index(signal_ids, indices)

        outcomes_per_signal = []
        for _ in range(10):
            outcomes = [Outcome.FAVORABLE] * 10
            outcomes[0] = Outcome.UNFAVORABLE  # real line loses
            outcomes_per_signal.append(outcomes)

        audit_set = _make_full_audit_set(outcomes_per_signal=outcomes_per_signal)
        result = batch_settle_audit_set(audit_set, share_store, threshold=1)

        assert result is not None
        assert result.wins == 0
        assert result.losses == 10
        assert result.quality_score == -10_000_000

    def test_mixed_outcomes(self) -> None:
        """Mix of wins, losses, voids."""
        signal_ids = [f"sig-{i}" for i in range(10)]
        # Real indices: signal 0-3 → index 1, signal 4-6 → index 2, signal 7-9 → index 3
        indices = [1, 1, 1, 1, 2, 2, 2, 3, 3, 3]
        share_store = _make_share_store_with_index(signal_ids, indices)

        outcomes_per_signal = []
        for i in range(10):
            outcomes = [Outcome.PENDING] * 10
            real_idx = indices[i] - 1  # 0-based
            if i < 4:
                outcomes[real_idx] = Outcome.FAVORABLE  # 4 wins
            elif i < 7:
                outcomes[real_idx] = Outcome.UNFAVORABLE  # 3 losses
            else:
                outcomes[real_idx] = Outcome.VOID  # 3 voids
            outcomes_per_signal.append(outcomes)

        audit_set = _make_full_audit_set(outcomes_per_signal=outcomes_per_signal)
        result = batch_settle_audit_set(audit_set, share_store, threshold=1)

        assert result is not None
        assert result.wins == 4
        assert result.losses == 3
        assert result.voids == 3
        assert result.n == 10
        assert result.wins + result.losses + result.voids == result.n
        # 4 × 1M profit - 3 × 1M loss + 0 void = 1M
        assert result.quality_score == 1_000_000

    def test_void_contributes_zero(self) -> None:
        """All voids → score = 0."""
        indices = [1] * 10
        signal_ids = [f"sig-{i}" for i in range(10)]
        share_store = _make_share_store_with_index(signal_ids, indices)

        outcomes_per_signal = []
        for _ in range(10):
            outcomes = [Outcome.FAVORABLE] * 10
            outcomes[0] = Outcome.VOID
            outcomes_per_signal.append(outcomes)

        audit_set = _make_full_audit_set(outcomes_per_signal=outcomes_per_signal)
        result = batch_settle_audit_set(audit_set, share_store, threshold=1)

        assert result is not None
        assert result.quality_score == 0
        assert result.voids == 10

    def test_quality_formula_matches_audit_sol(self) -> None:
        """Verify exact formula with non-trivial odds and SLA."""
        signal_ids = [f"sig-{i}" for i in range(10)]
        indices = [1] * 10
        share_store = _make_share_store_with_index(signal_ids, indices)

        # Signal 0: win, notional=500K, odds=2.5M (+150), sla=8000bps
        # profit = 500K * (2.5M - 1M) / 1M = 750K
        # Signal 1: loss, notional=300K, odds=1.8M (-125), sla=12000bps
        # loss = 300K * 12000 / 10000 = 360K
        # Signals 2-9: void → 0

        outcomes_per_signal = []
        for i in range(10):
            outcomes = [Outcome.PENDING] * 10
            if i == 0:
                outcomes[0] = Outcome.FAVORABLE
            elif i == 1:
                outcomes[0] = Outcome.UNFAVORABLE
            else:
                outcomes[0] = Outcome.VOID
            outcomes_per_signal.append(outcomes)

        notionals = [500_000, 300_000] + [1_000_000] * 8
        odds_list = [2_500_000, 1_800_000] + [2_000_000] * 8
        sla_list = [8_000, 12_000] + [10_000] * 8

        audit_set = _make_full_audit_set(
            outcomes_per_signal=outcomes_per_signal,
            notionals=notionals,
            odds_list=odds_list,
            sla_list=sla_list,
        )
        result = batch_settle_audit_set(audit_set, share_store, threshold=1)

        assert result is not None
        assert result.wins == 1
        assert result.losses == 1
        assert result.voids == 8
        assert result.quality_score == 750_000 - 360_000  # 390K

    def test_incomplete_set_returns_none(self) -> None:
        """Audit set with <10 signals isn't ready."""
        audit_set = AuditSet(genius_address=GENIUS, idiot_address=IDIOT)
        for i in range(5):
            audit_set.signals[f"sig-{i}"] = AuditSignal(
                signal_id=f"sig-{i}", outcomes=[Outcome.FAVORABLE] * 10
            )
        share_store = ShareStore()
        result = batch_settle_audit_set(audit_set, share_store, threshold=1)
        assert result is None

    def test_unresolved_signals_returns_none(self) -> None:
        """Full set but some signals not resolved yet."""
        audit_set = AuditSet(genius_address=GENIUS, idiot_address=IDIOT)
        for i in range(10):
            outcomes = [Outcome.FAVORABLE] * 10 if i < 9 else None
            audit_set.signals[f"sig-{i}"] = AuditSignal(
                signal_id=f"sig-{i}", outcomes=outcomes
            )
        share_store = ShareStore()
        result = batch_settle_audit_set(audit_set, share_store, threshold=1)
        assert result is None

    def test_missing_shares_returns_none(self) -> None:
        """Full and resolved but share store has no shares."""
        audit_set = _make_full_audit_set()
        share_store = ShareStore()  # empty
        result = batch_settle_audit_set(audit_set, share_store, threshold=1)
        assert result is None

    def test_result_aggregates_correct(self) -> None:
        """wins + losses + voids == n always."""
        signal_ids = [f"sig-{i}" for i in range(10)]
        indices = [1] * 10
        share_store = _make_share_store_with_index(signal_ids, indices)

        outcomes_per_signal = []
        for i in range(10):
            outcomes = [Outcome.PENDING] * 10
            if i % 3 == 0:
                outcomes[0] = Outcome.FAVORABLE
            elif i % 3 == 1:
                outcomes[0] = Outcome.UNFAVORABLE
            else:
                outcomes[0] = Outcome.VOID
            outcomes_per_signal.append(outcomes)

        audit_set = _make_full_audit_set(outcomes_per_signal=outcomes_per_signal)
        result = batch_settle_audit_set(audit_set, share_store, threshold=1)

        assert result is not None
        assert result.wins + result.losses + result.voids == result.n

    def test_genius_idiot_cycle_preserved(self) -> None:
        """Result carries through genius/idiot/cycle from audit set."""
        genius2 = "0x" + "11" * 20
        idiot2 = "0x" + "22" * 20
        audit_set = AuditSet(genius_address=genius2, idiot_address=idiot2, cycle=7)
        for i in range(10):
            audit_set.signals[f"sig-{i}"] = AuditSignal(
                signal_id=f"sig-{i}",
                outcomes=[Outcome.VOID] * 10,
            )

        signal_ids = [f"sig-{i}" for i in range(10)]
        share_store = _make_share_store_with_index(signal_ids, [1] * 10)
        result = batch_settle_audit_set(audit_set, share_store, threshold=1)

        assert result is not None
        assert result.genius == genius2
        assert result.idiot == idiot2
        assert result.cycle == 7

    def test_settled_set_returns_none(self) -> None:
        """Already-settled sets are rejected."""
        audit_set = _make_full_audit_set()
        audit_set.settled = True
        share_store = ShareStore()
        result = batch_settle_audit_set(audit_set, share_store, threshold=1)
        assert result is None
