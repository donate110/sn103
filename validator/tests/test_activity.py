"""Tests for the in-memory activity ring buffer."""

from __future__ import annotations

import threading
import time

from djinn_validator.core.activity import ActivityBuffer, ActivityCategory


class TestActivityBuffer:
    def test_record_and_recent(self) -> None:
        buf = ActivityBuffer()
        buf.record(ActivityCategory.CHALLENGE_ROUND, "Challenged 5 miners", sport="nba")
        buf.record(ActivityCategory.HEALTH_CHECK, "3/5 miners responded")

        events = buf.recent()
        assert len(events) == 2
        # Newest first
        assert events[0]["category"] == "health_check"
        assert events[1]["category"] == "challenge_round"
        assert events[1]["details"]["sport"] == "nba"

    def test_empty_buffer(self) -> None:
        buf = ActivityBuffer()
        assert buf.recent() == []
        assert len(buf) == 0

    def test_maxlen_eviction(self) -> None:
        buf = ActivityBuffer(max_size=10)
        for i in range(20):
            buf.record(ActivityCategory.HEALTH_CHECK, f"Event {i}")

        assert len(buf) == 10
        events = buf.recent()
        # Should have events 10-19 (oldest 0-9 evicted)
        assert events[0]["summary"] == "Event 19"
        assert events[-1]["summary"] == "Event 10"

    def test_category_filter(self) -> None:
        buf = ActivityBuffer()
        buf.record(ActivityCategory.CHALLENGE_ROUND, "Challenge A")
        buf.record(ActivityCategory.HEALTH_CHECK, "Health B")
        buf.record(ActivityCategory.CHALLENGE_ROUND, "Challenge C")

        filtered = buf.recent(category="challenge_round")
        assert len(filtered) == 2
        assert all(e["category"] == "challenge_round" for e in filtered)

    def test_category_filter_no_match(self) -> None:
        buf = ActivityBuffer()
        buf.record(ActivityCategory.HEALTH_CHECK, "Health")
        assert buf.recent(category="weight_set") == []

    def test_limit_parameter(self) -> None:
        buf = ActivityBuffer()
        for i in range(10):
            buf.record(ActivityCategory.HEALTH_CHECK, f"Event {i}")

        events = buf.recent(limit=3)
        assert len(events) == 3
        assert events[0]["summary"] == "Event 9"

    def test_timestamp_present(self) -> None:
        before = time.time()
        buf = ActivityBuffer()
        buf.record(ActivityCategory.WEIGHT_SET, "Set weights")
        after = time.time()

        events = buf.recent()
        assert before <= events[0]["timestamp"] <= after

    def test_details_dict(self) -> None:
        buf = ActivityBuffer()
        buf.record(
            ActivityCategory.CHALLENGE_ROUND,
            "Challenged miners",
            sport="nba",
            miners_challenged=5,
            consensus_quorum=True,
        )
        event = buf.recent()[0]
        assert event["details"]["sport"] == "nba"
        assert event["details"]["miners_challenged"] == 5
        assert event["details"]["consensus_quorum"] is True

    def test_thread_safety(self) -> None:
        buf = ActivityBuffer(max_size=500)
        errors: list[Exception] = []

        def writer(start: int) -> None:
            try:
                for i in range(100):
                    buf.record(ActivityCategory.HEALTH_CHECK, f"Thread {start} event {i}")
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=writer, args=(t,)) for t in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert len(buf) == 500

    def test_all_categories(self) -> None:
        buf = ActivityBuffer()
        for cat in ActivityCategory:
            buf.record(cat, f"Test {cat.value}")

        events = buf.recent()
        assert len(events) == len(ActivityCategory)
        categories = {e["category"] for e in events}
        assert categories == {c.value for c in ActivityCategory}
