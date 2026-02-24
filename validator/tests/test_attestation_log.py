"""Tests for the AttestationLog — SQLite attestation request tracking."""

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
