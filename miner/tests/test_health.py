"""Tests for the HealthTracker module."""

from __future__ import annotations

import time
from unittest.mock import patch

from djinn_miner import __version__
from djinn_miner.core.health import HealthTracker


class TestHealthTracker:
    def test_initial_state(self) -> None:
        tracker = HealthTracker(uid=42, odds_api_connected=True, bt_connected=True)
        status = tracker.get_status()
        assert status.status == "ok"
        assert status.version == __version__
        assert status.uid == 42
        assert status.odds_api_connected is True
        assert status.bt_connected is True

    def test_default_state(self) -> None:
        tracker = HealthTracker()
        status = tracker.get_status()
        assert status.uid is None
        assert status.odds_api_connected is False
        assert status.bt_connected is False

    def test_uptime_positive(self) -> None:
        tracker = HealthTracker()
        status = tracker.get_status()
        assert status.uptime_seconds >= 0

    def test_record_ping(self) -> None:
        tracker = HealthTracker()
        assert tracker.ping_count == 0
        tracker.record_ping()
        tracker.record_ping()
        tracker.record_ping()
        assert tracker.ping_count == 3

    def test_set_uid(self) -> None:
        tracker = HealthTracker()
        assert tracker.get_status().uid is None
        tracker.set_uid(99)
        assert tracker.get_status().uid == 99

    def test_set_odds_api_connected(self) -> None:
        tracker = HealthTracker()
        assert tracker.get_status().odds_api_connected is False
        tracker.set_odds_api_connected(True)
        assert tracker.get_status().odds_api_connected is True
        tracker.set_odds_api_connected(False)
        assert tracker.get_status().odds_api_connected is False

    def test_set_bt_connected(self) -> None:
        tracker = HealthTracker()
        assert tracker.get_status().bt_connected is False
        tracker.set_bt_connected(True)
        assert tracker.get_status().bt_connected is True

    def test_uptime_increases_over_time(self) -> None:
        tracker = HealthTracker()
        first = tracker.get_status().uptime_seconds
        # Monotonic time always moves forward, so second call should be >= first
        second = tracker.get_status().uptime_seconds
        assert second >= first

    def test_api_success_resets_failure_counter(self) -> None:
        tracker = HealthTracker(odds_api_connected=True)
        # Record failures up to threshold - 1
        for _ in range(HealthTracker.CONSECUTIVE_FAILURE_THRESHOLD - 1):
            tracker.record_api_failure()
        assert tracker.get_status().odds_api_connected is True
        # Success resets counter
        tracker.record_api_success()
        # Now even threshold failures won't degrade because counter reset
        for _ in range(HealthTracker.CONSECUTIVE_FAILURE_THRESHOLD - 1):
            tracker.record_api_failure()
        assert tracker.get_status().odds_api_connected is True

    def test_api_failures_degrade_health(self) -> None:
        tracker = HealthTracker(odds_api_connected=True)
        for _ in range(HealthTracker.CONSECUTIVE_FAILURE_THRESHOLD):
            tracker.record_api_failure()
        assert tracker.get_status().odds_api_connected is False

    def test_api_success_recovers_health(self) -> None:
        tracker = HealthTracker(odds_api_connected=False)
        tracker.record_api_success()
        assert tracker.get_status().odds_api_connected is True

    def test_failures_below_threshold_keep_connected(self) -> None:
        """Failures below threshold should not degrade health."""
        tracker = HealthTracker(odds_api_connected=True)
        for _ in range(HealthTracker.CONSECUTIVE_FAILURE_THRESHOLD - 1):
            tracker.record_api_failure()
        assert tracker.get_status().odds_api_connected is True

    def test_repeated_failures_after_degradation(self) -> None:
        """Additional failures after degradation don't cause errors."""
        tracker = HealthTracker(odds_api_connected=True)
        for _ in range(HealthTracker.CONSECUTIVE_FAILURE_THRESHOLD + 5):
            tracker.record_api_failure()
        assert tracker.get_status().odds_api_connected is False

    def test_recovery_then_degradation_cycle(self) -> None:
        """Multiple cycles of degradation and recovery should work."""
        tracker = HealthTracker(odds_api_connected=True)
        # Degrade
        for _ in range(HealthTracker.CONSECUTIVE_FAILURE_THRESHOLD):
            tracker.record_api_failure()
        assert tracker.get_status().odds_api_connected is False
        # Recover
        tracker.record_api_success()
        assert tracker.get_status().odds_api_connected is True
        # Degrade again
        for _ in range(HealthTracker.CONSECUTIVE_FAILURE_THRESHOLD):
            tracker.record_api_failure()
        assert tracker.get_status().odds_api_connected is False

    def test_already_disconnected_stays_disconnected(self) -> None:
        """Failures when already disconnected don't change state."""
        tracker = HealthTracker(odds_api_connected=False)
        tracker.record_api_failure()
        tracker.record_api_failure()
        assert tracker.get_status().odds_api_connected is False


class TestBTDegradation:
    def test_bt_failures_degrade_health(self) -> None:
        tracker = HealthTracker(bt_connected=True)
        for _ in range(HealthTracker.CONSECUTIVE_FAILURE_THRESHOLD):
            tracker.record_bt_failure()
        assert tracker.get_status().bt_connected is False

    def test_bt_failures_below_threshold_keep_connected(self) -> None:
        tracker = HealthTracker(bt_connected=True)
        for _ in range(HealthTracker.CONSECUTIVE_FAILURE_THRESHOLD - 1):
            tracker.record_bt_failure()
        assert tracker.get_status().bt_connected is True

    def test_bt_set_connected_resets_failures(self) -> None:
        tracker = HealthTracker(bt_connected=True)
        for _ in range(HealthTracker.CONSECUTIVE_FAILURE_THRESHOLD - 1):
            tracker.record_bt_failure()
        # Successful sync resets counter
        tracker.set_bt_connected(True)
        # Now threshold-1 more failures still won't degrade
        for _ in range(HealthTracker.CONSECUTIVE_FAILURE_THRESHOLD - 1):
            tracker.record_bt_failure()
        assert tracker.get_status().bt_connected is True

    def test_bt_recovery_cycle(self) -> None:
        tracker = HealthTracker(bt_connected=True)
        # Degrade
        for _ in range(HealthTracker.CONSECUTIVE_FAILURE_THRESHOLD):
            tracker.record_bt_failure()
        assert tracker.get_status().bt_connected is False
        # Recover
        tracker.set_bt_connected(True)
        assert tracker.get_status().bt_connected is True
