"""Tests for hardened peer notary: load balancing, exclude logic, discovery edge cases."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from djinn_validator.core.challenges import (
    PeerNotary,
    assign_peer_notary,
    discover_peer_notaries,
)


def _make_notaries(count: int, start_uid: int = 1) -> list[PeerNotary]:
    """Helper to create a list of peer notaries."""
    return [
        PeerNotary(
            uid=start_uid + i,
            ip=f"10.0.0.{start_uid + i}",
            port=8422,
            notary_port=7047,
            pubkey_hex=f"{start_uid + i:066d}",
        )
        for i in range(count)
    ]


class TestLoadBalancedAssignment:
    """Test that notary assignments are capped per notary per round."""

    def test_cap_enforced(self) -> None:
        """No notary gets more than max_per_notary assignments."""
        notaries = _make_notaries(2, start_uid=10)
        counts: dict[int, int] = {}

        results = []
        for prover_uid in range(1, 9):  # 8 provers
            n = assign_peer_notary(
                prover_uid, notaries,
                assignment_counts=counts, max_per_notary=4,
            )
            results.append(n)

        assigned = [r for r in results if r is not None]
        assert len(assigned) == 8
        # Each notary should have at most 4
        assert counts[10] <= 4
        assert counts[11] <= 4

    def test_returns_none_when_all_at_capacity(self) -> None:
        """Returns None when all eligible notaries are at max capacity."""
        notaries = _make_notaries(1, start_uid=10)
        counts: dict[int, int] = {10: 4}

        result = assign_peer_notary(
            1, notaries,
            assignment_counts=counts, max_per_notary=4,
        )
        assert result is None

    def test_counts_incremented_on_assignment(self) -> None:
        """Assignment counts are incremented in-place."""
        notaries = _make_notaries(1, start_uid=10)
        counts: dict[int, int] = {}

        assign_peer_notary(1, notaries, assignment_counts=counts, max_per_notary=10)
        assert counts[10] == 1

        assign_peer_notary(2, notaries, assignment_counts=counts, max_per_notary=10)
        assert counts[10] == 2

    def test_overflow_to_second_notary(self) -> None:
        """When first notary is at cap, assignments go to the second."""
        notaries = _make_notaries(2, start_uid=10)
        counts: dict[int, int] = {10: 2}

        # Prover can use either notary, but 10 is at cap=2
        for _ in range(2):
            n = assign_peer_notary(
                1, notaries,
                assignment_counts=counts, max_per_notary=2,
            )
            assert n is not None
            assert n.uid == 11  # Must use the other notary

        # Now both are at cap
        n = assign_peer_notary(
            1, notaries,
            assignment_counts=counts, max_per_notary=2,
        )
        assert n is None

    def test_no_counts_means_no_cap(self) -> None:
        """When assignment_counts is None, no cap is applied."""
        notaries = _make_notaries(1, start_uid=100)

        # Should always succeed regardless of how many times called
        # (prover UIDs 1-20 never match notary UID 100)
        for i in range(1, 21):
            n = assign_peer_notary(i, notaries, assignment_counts=None)
            assert n is not None

    def test_cap_with_self_exclusion(self) -> None:
        """Cap works correctly when combined with self-exclusion."""
        notaries = _make_notaries(3, start_uid=1)  # uid 1, 2, 3
        counts: dict[int, int] = {}

        # Prover is uid=1, so only notaries 2 and 3 are eligible
        for _ in range(4):
            n = assign_peer_notary(
                1, notaries,
                assignment_counts=counts, max_per_notary=2,
            )
            assert n is not None
            assert n.uid in (2, 3)

        # After 4 assignments (2 each), both should be at cap
        assert counts.get(2, 0) + counts.get(3, 0) == 4
        n = assign_peer_notary(
            1, notaries,
            assignment_counts=counts, max_per_notary=2,
        )
        assert n is None

    def test_cap_with_ip_exclusion(self) -> None:
        """Cap works correctly combined with same-IP exclusion."""
        notaries = [
            PeerNotary(uid=10, ip="10.0.0.1", port=8422, notary_port=7047, pubkey_hex="a" * 66),
            PeerNotary(uid=11, ip="10.0.0.2", port=8422, notary_port=7047, pubkey_hex="b" * 66),
        ]
        counts: dict[int, int] = {}

        # Prover is on 10.0.0.1, so only uid=11 is eligible
        for _ in range(3):
            n = assign_peer_notary(
                1, notaries,
                prover_ip="10.0.0.1",
                assignment_counts=counts, max_per_notary=3,
            )
            assert n is not None
            assert n.uid == 11

        # uid=11 is now at cap
        n = assign_peer_notary(
            1, notaries,
            prover_ip="10.0.0.1",
            assignment_counts=counts, max_per_notary=3,
        )
        assert n is None


class TestExcludeNotaryUIDs:
    """Test the exclude_uids parameter for retry logic."""

    def test_exclude_single_notary(self) -> None:
        """Excluded notary UIDs are never assigned."""
        notaries = _make_notaries(3, start_uid=10)

        for _ in range(50):
            n = assign_peer_notary(
                1, notaries,
                exclude_uids={10},
            )
            assert n is not None
            assert n.uid != 10

    def test_exclude_all_notaries(self) -> None:
        """Returns None when all notaries are excluded."""
        notaries = _make_notaries(2, start_uid=10)

        n = assign_peer_notary(
            1, notaries,
            exclude_uids={10, 11},
        )
        assert n is None

    def test_exclude_combined_with_cap(self) -> None:
        """Exclude and cap work together."""
        notaries = _make_notaries(3, start_uid=10)
        counts: dict[int, int] = {11: 2}

        # Exclude uid=10, uid=11 is at cap=2, only uid=12 available
        n = assign_peer_notary(
            1, notaries,
            assignment_counts=counts, max_per_notary=2,
            exclude_uids={10},
        )
        assert n is not None
        assert n.uid == 12

    def test_empty_exclude_set_is_noop(self) -> None:
        """Empty exclude set doesn't affect assignment."""
        notaries = _make_notaries(2, start_uid=10)

        n = assign_peer_notary(1, notaries, exclude_uids=set())
        assert n is not None


class TestChallengeFlowLoadBalancing:
    """Integration-style tests for the challenge flow's notary assignment."""

    def test_many_miners_distributed_across_notaries(self) -> None:
        """85 miners across 3 notaries should distribute across them."""
        notaries = _make_notaries(3, start_uid=100)
        counts: dict[int, int] = {}
        max_per = max(4, 85 // 3)  # 28; total capacity = 84

        assigned_count = 0
        for prover_uid in range(1, 86):
            n = assign_peer_notary(
                prover_uid, notaries,
                assignment_counts=counts, max_per_notary=max_per,
            )
            if n:
                assigned_count += 1

        # 3 * 28 = 84 capacity, so at most 1 miner unassigned
        assert assigned_count >= 84
        # No notary should have more than max_per
        for uid, count in counts.items():
            assert count <= max_per
        # All three notaries should be used
        assert len(counts) == 3

    def test_single_notary_caps_at_limit(self) -> None:
        """With only 1 notary, assignments cap at max_per_notary."""
        notaries = _make_notaries(1, start_uid=100)
        counts: dict[int, int] = {}

        assigned = 0
        for prover_uid in range(1, 86):
            n = assign_peer_notary(
                prover_uid, notaries,
                assignment_counts=counts, max_per_notary=10,
            )
            if n:
                assigned += 1

        assert assigned == 10  # capped
        assert counts[100] == 10

    def test_two_notaries_double_capacity(self) -> None:
        """With 2 notaries, capacity doubles."""
        notaries = _make_notaries(2, start_uid=100)
        counts: dict[int, int] = {}

        assigned = 0
        for prover_uid in range(1, 86):
            n = assign_peer_notary(
                prover_uid, notaries,
                assignment_counts=counts, max_per_notary=10,
            )
            if n:
                assigned += 1

        assert assigned == 20  # 2 * 10


class TestNotaryDiscoveryEdgeCases:
    """Edge cases in peer notary discovery."""

    @pytest.mark.asyncio
    async def test_discover_handles_malformed_json(self) -> None:
        """Malformed JSON from /v1/notary/info is handled gracefully."""
        axons = [{"uid": 1, "hotkey": "hk1", "ip": "10.0.0.1", "port": 8422}]

        async def mock_get(url: str, **kwargs):
            resp = MagicMock()
            resp.status_code = 200
            resp.json.side_effect = ValueError("bad json")
            return resp

        client = MagicMock()
        client.get = mock_get

        notaries = await discover_peer_notaries(client, axons)
        assert len(notaries) == 0

    @pytest.mark.asyncio
    async def test_discover_handles_missing_fields(self) -> None:
        """Missing required fields in notary info response are handled."""
        axons = [{"uid": 1, "hotkey": "hk1", "ip": "10.0.0.1", "port": 8422}]

        async def mock_get(url: str, **kwargs):
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {"enabled": True}  # missing pubkey_hex and port
            return resp

        client = MagicMock()
        client.get = mock_get

        notaries = await discover_peer_notaries(client, axons)
        assert len(notaries) == 0  # pubkey_hex is falsy

    @pytest.mark.asyncio
    async def test_discover_multiple_notaries(self) -> None:
        """Multiple notaries are discovered correctly."""
        import asyncio
        from unittest.mock import AsyncMock, patch

        axons = [
            {"uid": i, "hotkey": f"hk{i}", "ip": f"10.0.0.{i}", "port": 8422}
            for i in range(1, 6)
        ]

        async def mock_get(url: str, **kwargs):
            resp = MagicMock()
            # All miners are notary-capable
            resp.status_code = 200
            resp.json.return_value = {
                "enabled": True,
                "pubkey_hex": "a" * 66,
                "port": 7047,
            }
            return resp

        client = MagicMock()
        client.get = mock_get

        # Mock TCP probe so it succeeds without a real server
        mock_writer = MagicMock()
        mock_writer.close = MagicMock()
        mock_writer.wait_closed = AsyncMock()

        with patch("asyncio.open_connection", AsyncMock(return_value=(MagicMock(), mock_writer))):
            notaries = await discover_peer_notaries(client, axons)
        assert len(notaries) == 5
        uids = {n.uid for n in notaries}
        assert uids == {1, 2, 3, 4, 5}
