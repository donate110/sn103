"""Tests for the TelemetryStore — SQLite persistent event log."""

import time

import pytest

from djinn_validator.core.telemetry import TelemetryStore


@pytest.fixture
def store(tmp_path) -> TelemetryStore:
    return TelemetryStore(tmp_path / "test_telemetry.db")


class TestTelemetryStore:
    def test_record_and_query(self, store: TelemetryStore) -> None:
        store.record("health_check", "5/10 miners responded", responded=5, total=10)
        events = store.query(limit=10)
        assert len(events) == 1
        assert events[0]["category"] == "health_check"
        assert events[0]["summary"] == "5/10 miners responded"
        assert events[0]["details"]["responded"] == 5

    def test_query_by_category(self, store: TelemetryStore) -> None:
        store.record("health_check", "check 1")
        store.record("weight_set", "weights set")
        store.record("health_check", "check 2")
        events = store.query(category="health_check")
        assert len(events) == 2
        assert all(e["category"] == "health_check" for e in events)

    def test_query_newest_first(self, store: TelemetryStore) -> None:
        store.record("a", "first")
        store.record("b", "second")
        store.record("c", "third")
        events = store.query(limit=10)
        assert events[0]["category"] == "c"
        assert events[-1]["category"] == "a"

    def test_query_limit(self, store: TelemetryStore) -> None:
        for i in range(20):
            store.record("test", f"event {i}")
        events = store.query(limit=5)
        assert len(events) == 5

    def test_count(self, store: TelemetryStore) -> None:
        assert store.count() == 0
        store.record("a", "x")
        store.record("b", "y")
        store.record("a", "z")
        assert store.count() == 3
        assert store.count(category="a") == 2
        assert store.count(category="b") == 1

    def test_lazy_pruning_fires_above_threshold(self, store: TelemetryStore) -> None:
        # Lower thresholds for testing
        store._PRUNE_THRESHOLD = 50
        store._PRUNE_CHECK_INTERVAL = 10

        old_ts = time.time() - (31 * 24 * 3600)  # 31 days ago
        conn = store._get_conn()

        # Insert 40 "old" rows directly
        for i in range(40):
            conn.execute(
                "INSERT INTO events (timestamp, category, summary, details) VALUES (?, ?, ?, ?)",
                (old_ts, "old", f"old event {i}", "{}"),
            )
        conn.commit()

        # Insert 20 "new" rows via record() to trigger prune check
        for i in range(20):
            store.record("new", f"new event {i}")

        # Total was 60 (>50 threshold), so old rows (>30d) should be pruned
        # after the 10th insert triggers a prune check
        events = store.query(limit=100)
        old_events = [e for e in events if e["category"] == "old"]
        new_events = [e for e in events if e["category"] == "new"]
        assert len(old_events) == 0, f"Expected 0 old events, got {len(old_events)}"
        assert len(new_events) == 20

    def test_lazy_pruning_skips_below_threshold(self, store: TelemetryStore) -> None:
        store._PRUNE_THRESHOLD = 100
        store._PRUNE_CHECK_INTERVAL = 5

        old_ts = time.time() - (31 * 24 * 3600)
        conn = store._get_conn()

        # Insert 10 old rows — below threshold
        for i in range(10):
            conn.execute(
                "INSERT INTO events (timestamp, category, summary, details) VALUES (?, ?, ?, ?)",
                (old_ts, "old", f"old {i}", "{}"),
            )
        conn.commit()

        # Insert 10 new rows to trigger prune check
        for i in range(10):
            store.record("new", f"new {i}")

        # Below threshold — old rows should NOT be pruned
        events = store.query(limit=100)
        old_events = [e for e in events if e["category"] == "old"]
        assert len(old_events) == 10

    def test_empty_query(self, store: TelemetryStore) -> None:
        assert store.query() == []
        assert store.count() == 0
