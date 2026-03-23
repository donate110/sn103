"""Tests for the AttestationLog — SQLite attestation request tracking."""

import time

import pytest

from djinn_validator.core.attestation_log import AttestationLog


@pytest.fixture
def log() -> AttestationLog:
    return AttestationLog()  # in-memory


class TestAttestationLog:
    def test_log_and_retrieve(self, log: AttestationLog) -> None:
        log.log_attestation(
            url="https://example.com",
            request_id="req-1",
            success=True,
            verified=True,
            server_name="example.com",
            miner_uid=3,
            elapsed_s=1.5,
        )
        entries = log.recent_attestations(10)
        assert len(entries) == 1
        assert entries[0]["url"] == "https://example.com"
        assert entries[0]["success"] is True
        assert entries[0]["verified"] is True
        assert entries[0]["miner_uid"] == 3
        assert entries[0]["elapsed_s"] == 1.5

    def test_recent_ordering(self, log: AttestationLog) -> None:
        for i in range(5):
            log.log_attestation(
                url=f"https://example.com/{i}",
                request_id=f"req-{i}",
                success=True,
                verified=True,
            )
        entries = log.recent_attestations(10)
        assert len(entries) == 5
        # Most recent first (highest ID)
        assert entries[0]["url"] == "https://example.com/4"
        assert entries[-1]["url"] == "https://example.com/0"

    def test_limit_respected(self, log: AttestationLog) -> None:
        for i in range(10):
            log.log_attestation(
                url=f"https://example.com/{i}",
                request_id=f"req-{i}",
                success=True,
                verified=True,
            )
        entries = log.recent_attestations(3)
        assert len(entries) == 3

    def test_failed_attestation(self, log: AttestationLog) -> None:
        log.log_attestation(
            url="https://example.com",
            request_id="req-fail",
            success=False,
            verified=False,
            error="Miner unreachable",
        )
        entries = log.recent_attestations(1)
        assert len(entries) == 1
        assert entries[0]["success"] is False
        assert entries[0]["error"] == "Miner unreachable"

    def test_empty(self, log: AttestationLog) -> None:
        assert log.recent_attestations(10) == []

    def test_lazy_pruning_fires_above_threshold(self, log: AttestationLog) -> None:
        log._PRUNE_THRESHOLD = 50
        log._PRUNE_CHECK_INTERVAL = 10

        old_ts = int(time.time()) - (31 * 24 * 3600)  # 31 days ago

        # Insert 40 old rows directly
        for i in range(40):
            log._conn.execute(
                "INSERT INTO attestation_log "
                "(url, request_id, success, verified, created_at) "
                "VALUES (?, ?, 1, 1, ?)",
                (f"https://old.com/{i}", f"old-{i}", old_ts),
            )
        log._conn.commit()

        # Insert 20 new rows via log_attestation to trigger prune checks
        for i in range(20):
            log.log_attestation(
                url=f"https://new.com/{i}",
                request_id=f"new-{i}",
                success=True,
                verified=True,
            )

        entries = log.recent_attestations(100)
        old_entries = [e for e in entries if "old.com" in e["url"]]
        new_entries = [e for e in entries if "new.com" in e["url"]]
        assert len(old_entries) == 0, f"Expected 0 old entries, got {len(old_entries)}"
        assert len(new_entries) == 20

    def test_lazy_pruning_skips_below_threshold(self, log: AttestationLog) -> None:
        log._PRUNE_THRESHOLD = 100
        log._PRUNE_CHECK_INTERVAL = 5

        old_ts = int(time.time()) - (31 * 24 * 3600)

        # Insert 10 old rows — below threshold
        for i in range(10):
            log._conn.execute(
                "INSERT INTO attestation_log "
                "(url, request_id, success, verified, created_at) "
                "VALUES (?, ?, 1, 1, ?)",
                (f"https://old.com/{i}", f"old-{i}", old_ts),
            )
        log._conn.commit()

        # Insert 10 new rows
        for i in range(10):
            log.log_attestation(
                url=f"https://new.com/{i}",
                request_id=f"new-{i}",
                success=True,
                verified=True,
            )

        entries = log.recent_attestations(100)
        old_entries = [e for e in entries if "old.com" in e["url"]]
        assert len(old_entries) == 10, "Old entries should NOT be pruned below threshold"


class TestMinerFailureStreaks:
    def test_empty_log(self, log: AttestationLog) -> None:
        assert log.miner_failure_streaks() == {}

    def test_all_successes(self, log: AttestationLog) -> None:
        for i in range(5):
            log.log_attestation(
                url="https://example.com",
                request_id=f"req-{i}",
                success=True,
                verified=True,
                miner_uid=10,
            )
        assert log.miner_failure_streaks() == {}

    def test_consecutive_failures(self, log: AttestationLog) -> None:
        for i in range(4):
            log.log_attestation(
                url="https://example.com",
                request_id=f"req-{i}",
                success=False,
                verified=False,
                miner_uid=5,
                error="timeout",
            )
        streaks = log.miner_failure_streaks()
        assert streaks == {5: 4}

    def test_success_breaks_streak(self, log: AttestationLog) -> None:
        # Oldest first: fail, fail, success, fail, fail, fail
        for i, ok in enumerate([False, False, True, False, False, False]):
            log.log_attestation(
                url="https://example.com",
                request_id=f"req-{i}",
                success=ok,
                verified=ok,
                miner_uid=7,
            )
        # Newest first: fail, fail, fail, success -- streak is 3
        streaks = log.miner_failure_streaks()
        assert streaks == {7: 3}

    def test_multiple_miners(self, log: AttestationLog) -> None:
        # Miner 1: 2 recent failures
        for i in range(2):
            log.log_attestation(
                url="https://example.com",
                request_id=f"m1-{i}",
                success=False,
                verified=False,
                miner_uid=1,
            )
        # Miner 2: success (no streak)
        log.log_attestation(
            url="https://example.com",
            request_id="m2-0",
            success=True,
            verified=True,
            miner_uid=2,
        )
        # Miner 3: 5 failures
        for i in range(5):
            log.log_attestation(
                url="https://example.com",
                request_id=f"m3-{i}",
                success=False,
                verified=False,
                miner_uid=3,
            )
        streaks = log.miner_failure_streaks()
        assert streaks == {1: 2, 3: 5}
        assert 2 not in streaks

    def test_ignores_null_miner_uid(self, log: AttestationLog) -> None:
        log.log_attestation(
            url="https://example.com",
            request_id="req-null",
            success=False,
            verified=False,
            miner_uid=None,
        )
        assert log.miner_failure_streaks() == {}

    def test_lookback_window(self, log: AttestationLog) -> None:
        old_ts = int(time.time()) - 7200  # 2 hours ago
        # Insert old failure directly
        log._conn.execute(
            "INSERT INTO attestation_log "
            "(url, request_id, success, verified, miner_uid, created_at) "
            "VALUES (?, ?, 0, 0, 99, ?)",
            ("https://example.com", "old-req", old_ts),
        )
        log._conn.commit()
        # With 1 hour lookback, old failure should be excluded
        assert log.miner_failure_streaks(lookback_seconds=3600) == {}
        # With 3 hour lookback, old failure should be included
        assert log.miner_failure_streaks(lookback_seconds=10800) == {99: 1}
