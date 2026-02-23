"""Tests for the BurnLedger — consumed alpha burn tracking with multi-credit support."""

from __future__ import annotations

import pytest

from djinn_validator.core.burn_ledger import BurnLedger


@pytest.fixture
def ledger():
    bl = BurnLedger()  # in-memory
    yield bl
    bl.close()


class TestBurnLedger:
    def test_record_and_check(self, ledger: BurnLedger) -> None:
        """Recording a single-credit burn makes it consumed."""
        assert ledger.record_burn("0xabc123", "5ColdKey", 0.0001) is True
        assert ledger.is_consumed("0xabc123") is True

    def test_double_consume_rejected(self, ledger: BurnLedger) -> None:
        """Second record of a single-credit burn returns False."""
        assert ledger.record_burn("0xdouble", "5ColdKey", 0.0001) is True
        assert ledger.record_burn("0xdouble", "5ColdKey", 0.0001) is False

    def test_unconsumed(self, ledger: BurnLedger) -> None:
        """Unknown hash returns False for is_consumed."""
        assert ledger.is_consumed("0xnever_seen") is False

    def test_remaining_credits_unknown(self, ledger: BurnLedger) -> None:
        """Unknown hash returns 0 remaining credits."""
        assert ledger.remaining_credits("0xnever_seen") == 0

    def test_multiple_distinct_burns(self, ledger: BurnLedger) -> None:
        """Different tx hashes are tracked independently."""
        assert ledger.record_burn("0xtx1", "5Key1", 0.0001) is True
        assert ledger.record_burn("0xtx2", "5Key2", 0.0001) is True
        assert ledger.is_consumed("0xtx1") is True
        assert ledger.is_consumed("0xtx2") is True
        assert ledger.is_consumed("0xtx3") is False


class TestMultiCreditBurns:
    """Tests for multi-credit burn support (bulk attestation)."""

    def test_multi_credit_burn(self, ledger: BurnLedger) -> None:
        """Burning 0.0005 TAO gives 5 credits at 0.0001 min."""
        assert ledger.record_burn("0xbulk", "5Key", 0.0005, min_amount=0.0001) is True
        assert ledger.remaining_credits("0xbulk") == 4  # 5 total, 1 used
        assert ledger.is_consumed("0xbulk") is False

    def test_credits_deplete(self, ledger: BurnLedger) -> None:
        """Credits deplete one at a time until exhausted."""
        # 3 credits total
        assert ledger.record_burn("0x3x", "5Key", 0.0003, min_amount=0.0001) is True
        assert ledger.remaining_credits("0x3x") == 2  # used 1 of 3

        assert ledger.record_burn("0x3x", "5Key", 0.0003, min_amount=0.0001) is True
        assert ledger.remaining_credits("0x3x") == 1  # used 2 of 3

        assert ledger.record_burn("0x3x", "5Key", 0.0003, min_amount=0.0001) is True
        assert ledger.remaining_credits("0x3x") == 0  # used 3 of 3

        # 4th attempt should fail
        assert ledger.record_burn("0x3x", "5Key", 0.0003, min_amount=0.0001) is False
        assert ledger.is_consumed("0x3x") is True

    def test_13_page_bulk_burn(self, ledger: BurnLedger) -> None:
        """Burning 0.0013 TAO grants exactly 13 credits."""
        tx = "0x13pages"
        for i in range(13):
            assert ledger.record_burn(tx, "5Key", 0.0013, min_amount=0.0001) is True

        assert ledger.remaining_credits(tx) == 0
        assert ledger.is_consumed(tx) is True
        assert ledger.record_burn(tx, "5Key", 0.0013, min_amount=0.0001) is False

    def test_partial_amount_floors(self, ledger: BurnLedger) -> None:
        """Amounts that aren't exact multiples floor to the lower credit count."""
        # 0.00025 / 0.0001 = 2.5, floors to 2 credits
        assert ledger.record_burn("0xpartial", "5Key", 0.00025, min_amount=0.0001) is True
        assert ledger.remaining_credits("0xpartial") == 1  # 2 total, 1 used

        assert ledger.record_burn("0xpartial", "5Key", 0.00025, min_amount=0.0001) is True
        assert ledger.record_burn("0xpartial", "5Key", 0.00025, min_amount=0.0001) is False

    def test_minimum_burn_gives_one_credit(self, ledger: BurnLedger) -> None:
        """Burning exactly the minimum amount gives 1 credit."""
        assert ledger.record_burn("0xmin", "5Key", 0.0001, min_amount=0.0001) is True
        assert ledger.remaining_credits("0xmin") == 0
        assert ledger.is_consumed("0xmin") is True


class TestRefundCredit:
    """Tests for credit refund on miner failure."""

    def test_refund_restores_credit(self, ledger: BurnLedger) -> None:
        """Refunding a consumed credit makes it available again."""
        ledger.record_burn("0xrefund1", "5Key", 0.0001)
        assert ledger.is_consumed("0xrefund1") is True
        assert ledger.remaining_credits("0xrefund1") == 0

        assert ledger.refund_credit("0xrefund1") is True
        assert ledger.is_consumed("0xrefund1") is False
        assert ledger.remaining_credits("0xrefund1") == 1

    def test_refund_unknown_tx_returns_false(self, ledger: BurnLedger) -> None:
        """Refunding an unknown tx hash returns False."""
        assert ledger.refund_credit("0xunknown") is False

    def test_refund_then_reuse(self, ledger: BurnLedger) -> None:
        """After refund, the credit can be consumed again."""
        ledger.record_burn("0xreuse", "5Key", 0.0001)
        assert ledger.is_consumed("0xreuse") is True

        ledger.refund_credit("0xreuse")
        assert ledger.record_burn("0xreuse", "5Key", 0.0001) is True
        assert ledger.is_consumed("0xreuse") is True

    def test_refund_multi_credit(self, ledger: BurnLedger) -> None:
        """Refund works with multi-credit burns."""
        ledger.record_burn("0xmulti", "5Key", 0.0003, min_amount=0.0001)
        ledger.record_burn("0xmulti", "5Key", 0.0003, min_amount=0.0001)
        ledger.record_burn("0xmulti", "5Key", 0.0003, min_amount=0.0001)
        assert ledger.is_consumed("0xmulti") is True

        ledger.refund_credit("0xmulti")
        assert ledger.remaining_credits("0xmulti") == 1
        assert ledger.is_consumed("0xmulti") is False

    def test_cannot_refund_below_zero(self, ledger: BurnLedger) -> None:
        """Refunding when used_credits is 0 returns False."""
        ledger.record_burn("0xzero", "5Key", 0.0001)
        ledger.refund_credit("0xzero")  # used goes to 0
        assert ledger.refund_credit("0xzero") is False  # Can't go below 0


class TestAttestationLog:
    """Tests for attestation request logging."""

    def test_log_and_retrieve(self, ledger: BurnLedger) -> None:
        ledger.log_attestation(
            tx_hash="0xabc", coldkey="5Key", url="https://example.com",
            request_id="req-1", success=True, verified=True,
            server_name="example.com", miner_uid=5, elapsed_s=1.23,
        )
        rows = ledger.recent_attestations(limit=10)
        assert len(rows) == 1
        assert rows[0]["tx_hash"] == "0xabc"
        assert rows[0]["url"] == "https://example.com"
        assert rows[0]["success"] is True
        assert rows[0]["verified"] is True
        assert rows[0]["miner_uid"] == 5
        assert rows[0]["elapsed_s"] == 1.23

    def test_recent_ordering(self, ledger: BurnLedger) -> None:
        """Newest attestations come first."""
        import time
        ledger.log_attestation(
            tx_hash="0x1", coldkey="5K", url="https://a.com",
            request_id="r1", success=True, verified=True,
        )
        time.sleep(0.01)
        ledger.log_attestation(
            tx_hash="0x2", coldkey="5K", url="https://b.com",
            request_id="r2", success=False, verified=False, error="timeout",
        )
        rows = ledger.recent_attestations(limit=10)
        assert len(rows) == 2
        assert rows[0]["tx_hash"] == "0x2"
        assert rows[1]["tx_hash"] == "0x1"

    def test_limit_respected(self, ledger: BurnLedger) -> None:
        for i in range(10):
            ledger.log_attestation(
                tx_hash=f"0x{i}", coldkey="5K", url=f"https://{i}.com",
                request_id=f"r{i}", success=True, verified=True,
            )
        rows = ledger.recent_attestations(limit=3)
        assert len(rows) == 3

    def test_failed_attestation(self, ledger: BurnLedger) -> None:
        ledger.log_attestation(
            tx_hash="0xfail", coldkey="5K", url="https://fail.com",
            request_id="rf", success=False, verified=False,
            error="Miner unreachable",
        )
        rows = ledger.recent_attestations()
        assert rows[0]["success"] is False
        assert rows[0]["error"] == "Miner unreachable"


class TestHourlyBurnStats:
    """Tests for hourly burn aggregation."""

    def test_empty(self, ledger: BurnLedger) -> None:
        assert ledger.hourly_burn_stats() == []

    def test_aggregation(self, ledger: BurnLedger) -> None:
        """Burns in the same hour are grouped together."""
        import time
        now = int(time.time())
        # Insert 3 burns with current timestamp (same hour)
        for i in range(3):
            ledger.record_burn(f"0xh{i}", "5K", 0.0001)
        stats = ledger.hourly_burn_stats(days=1)
        assert len(stats) == 1
        assert stats[0]["count"] == 3
        assert abs(stats[0]["amount"] - 0.0003) < 1e-9
