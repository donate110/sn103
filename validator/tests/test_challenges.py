"""Tests for the consensus-based miner challenge system."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from djinn_validator.core.challenges import (
    ConsensusResult,
    LineConsensus,
    MinerResponse,
    MIN_MINERS_FOR_CONSENSUS,
    _compute_consensus,
    _score_against_consensus,
    _select_proof_targets,
    build_challenge_lines,
    challenge_miners,
)
from djinn_validator.core.espn import ESPNClient, ESPNGame
from djinn_validator.core.scoring import MinerScorer


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_game(
    espn_id: str = "401547283",
    home: str = "Los Angeles Lakers",
    away: str = "Boston Celtics",
    status: str = "in_progress",
) -> ESPNGame:
    return ESPNGame(
        espn_id=espn_id,
        home_team=home,
        away_team=away,
        home_score=55,
        away_score=50,
        status=status,
    )


def _make_miner_response(
    uid: int,
    available: set[int] | None = None,
    query_id: str | None = "q-default",
    success: bool = True,
    latency: float = 0.5,
) -> MinerResponse:
    return MinerResponse(
        uid=uid,
        hotkey=f"hk{uid}",
        ip="127.0.0.1",
        port=8080 + uid,
        available_indices=available or set(),
        query_id=query_id,
        latency=latency,
        success=success,
        error=None if success else "connection refused",
    )


def _make_challenge_lines(
    real_indices: list[int] | None = None,
    synthetic_indices: list[int] | None = None,
) -> list[dict]:
    """Build minimal challenge lines for testing."""
    real = real_indices or [1, 2, 3, 4, 5, 6, 7]
    synth = synthetic_indices or [8, 9, 10]
    lines = []
    for idx in real:
        lines.append({
            "index": idx, "sport": "basketball_nba",
            "event_id": f"espn_{idx}", "home_team": "A", "away_team": "B",
            "market": "h2h", "side": "A",
        })
    for idx in synth:
        lines.append({
            "index": idx, "sport": "basketball_nba",
            "event_id": f"fake_espn_{idx}", "home_team": "A", "away_team": "B",
            "market": "h2h", "side": "A", "is_synthetic": True,
        })
    return lines


# ---------------------------------------------------------------------------
# build_challenge_lines
# ---------------------------------------------------------------------------


class TestBuildChallengeLines:
    def test_builds_lines_from_games(self) -> None:
        games = [_make_game()]
        lines = build_challenge_lines(games, "basketball_nba")
        assert len(lines) > 0
        assert len(lines) <= 10

    def test_all_lines_have_required_fields(self) -> None:
        games = [_make_game(), _make_game("evt2")]
        lines = build_challenge_lines(games, "basketball_nba")
        for line in lines:
            assert "index" in line
            assert 1 <= line["index"] <= 10
            assert "sport" in line
            assert "event_id" in line
            assert "market" in line

    def test_includes_synthetic_lines(self) -> None:
        games = [_make_game(), _make_game("evt2"), _make_game("evt3")]
        lines = build_challenge_lines(games, "basketball_nba")
        synthetic = [l for l in lines if l.get("is_synthetic")]
        assert len(synthetic) > 0

    def test_indices_are_unique(self) -> None:
        games = [_make_game(), _make_game("evt2")]
        lines = build_challenge_lines(games, "basketball_nba")
        indices = [l["index"] for l in lines]
        assert len(indices) == len(set(indices))

    def test_empty_games_returns_empty(self) -> None:
        assert build_challenge_lines([], "basketball_nba") == []

    def test_games_without_teams_returns_empty(self) -> None:
        games = [ESPNGame(espn_id="1", home_team="", away_team="")]
        assert build_challenge_lines(games, "basketball_nba") == []

    def test_synthetic_lines_have_distinct_event_ids(self) -> None:
        games = [_make_game(), _make_game("evt2")]
        lines = build_challenge_lines(games, "basketball_nba")
        synthetic = [l for l in lines if l.get("is_synthetic")]
        real_ids = {l["event_id"] for l in lines if not l.get("is_synthetic")}
        for s in synthetic:
            # Synthetic IDs are SHA256 hex hashes, distinct from real event IDs
            assert len(s["event_id"]) == 24
            assert s["event_id"] not in real_ids


# ---------------------------------------------------------------------------
# MinerResponse
# ---------------------------------------------------------------------------


class TestMinerResponse:
    def test_defaults(self) -> None:
        r = MinerResponse(uid=0, hotkey="hk0", ip="1.2.3.4", port=8080)
        assert r.available_indices == set()
        assert r.success is False
        assert r.query_id is None


# ---------------------------------------------------------------------------
# LineConsensus
# ---------------------------------------------------------------------------


class TestLineConsensus:
    def test_consensus_available_majority(self) -> None:
        lc = LineConsensus(index=1, is_synthetic=False, votes_available=3, votes_unavailable=1, total_voters=4)
        assert lc.consensus_available is True

    def test_consensus_unavailable_majority(self) -> None:
        lc = LineConsensus(index=1, is_synthetic=False, votes_available=1, votes_unavailable=3, total_voters=4)
        assert lc.consensus_available is False

    def test_confidence_unanimous(self) -> None:
        lc = LineConsensus(index=1, is_synthetic=False, votes_available=5, votes_unavailable=0, total_voters=5)
        assert lc.confidence == 1.0
        assert lc.is_strong is True

    def test_confidence_strong_threshold(self) -> None:
        # 7 out of 10 = 0.7 = exactly strong
        lc = LineConsensus(index=1, is_synthetic=False, votes_available=7, votes_unavailable=3, total_voters=10)
        assert lc.confidence == 0.7
        assert lc.is_strong is True

    def test_confidence_weak(self) -> None:
        # 6 out of 10 = 0.6 < 0.7 — weak
        lc = LineConsensus(index=1, is_synthetic=False, votes_available=6, votes_unavailable=4, total_voters=10)
        assert lc.confidence == 0.6
        assert lc.is_strong is False

    def test_tie(self) -> None:
        lc = LineConsensus(index=1, is_synthetic=False, votes_available=2, votes_unavailable=2, total_voters=4)
        assert lc.is_tie is True
        assert lc.confidence == 0.5

    def test_zero_voters(self) -> None:
        lc = LineConsensus(index=1, is_synthetic=False)
        assert lc.confidence == 0.0
        assert lc.is_strong is False


# ---------------------------------------------------------------------------
# ConsensusResult
# ---------------------------------------------------------------------------


class TestConsensusResult:
    def test_has_quorum_with_enough_miners(self) -> None:
        cr = ConsensusResult(responding_miners=MIN_MINERS_FOR_CONSENSUS)
        assert cr.has_quorum is True

    def test_no_quorum_below_threshold(self) -> None:
        cr = ConsensusResult(responding_miners=MIN_MINERS_FOR_CONSENSUS - 1)
        assert cr.has_quorum is False

    def test_no_quorum_zero(self) -> None:
        cr = ConsensusResult(responding_miners=0)
        assert cr.has_quorum is False


# ---------------------------------------------------------------------------
# _compute_consensus
# ---------------------------------------------------------------------------


class TestComputeConsensus:
    def test_unanimous_available(self) -> None:
        lines = _make_challenge_lines([1, 2], [3])
        responses = [
            _make_miner_response(0, {1, 2}),
            _make_miner_response(1, {1, 2}),
            _make_miner_response(2, {1, 2}),
        ]
        c = _compute_consensus(responses, lines, {3})
        assert c.line_consensuses[1].votes_available == 3
        assert c.line_consensuses[1].votes_unavailable == 0
        assert c.line_consensuses[1].consensus_available is True
        assert c.line_consensuses[3].votes_available == 0  # synthetic, nobody claims it
        assert c.responding_miners == 3

    def test_majority_vote(self) -> None:
        lines = _make_challenge_lines([1], [2])
        responses = [
            _make_miner_response(0, {1}),
            _make_miner_response(1, {1}),
            _make_miner_response(2, set()),  # disagrees on line 1
        ]
        c = _compute_consensus(responses, lines, {2})
        assert c.line_consensuses[1].votes_available == 2
        assert c.line_consensuses[1].votes_unavailable == 1
        assert c.line_consensuses[1].consensus_available is True

    def test_tie_vote(self) -> None:
        lines = _make_challenge_lines([1], [2])
        responses = [
            _make_miner_response(0, {1}),
            _make_miner_response(1, {1}),
            _make_miner_response(2, set()),
            _make_miner_response(3, set()),
        ]
        c = _compute_consensus(responses, lines, {2})
        assert c.line_consensuses[1].is_tie is True

    def test_failed_responses_excluded(self) -> None:
        lines = _make_challenge_lines([1], [2])
        responses = [
            _make_miner_response(0, {1}),
            _make_miner_response(1, {1}),
            _make_miner_response(2, set(), success=False),  # failed
        ]
        c = _compute_consensus(responses, lines, {2})
        assert c.responding_miners == 2
        assert c.line_consensuses[1].total_voters == 2

    def test_quorum_check(self) -> None:
        lines = _make_challenge_lines([1], [2])
        responses = [
            _make_miner_response(0, {1}),
            _make_miner_response(1, {1}),
        ]
        c = _compute_consensus(responses, lines, {2})
        assert c.responding_miners == 2
        assert c.has_quorum is False  # Need >= 3


# ---------------------------------------------------------------------------
# _score_against_consensus
# ---------------------------------------------------------------------------


class TestScoreAgainstConsensus:
    def _build_consensus(
        self,
        line_consensuses: dict[int, LineConsensus],
        responding: int = 5,
    ) -> ConsensusResult:
        return ConsensusResult(
            line_consensuses=line_consensuses,
            responding_miners=responding,
            total_miners=responding,
        )

    def test_perfect_agreement_with_consensus(self) -> None:
        """Miner agrees with all strong consensus + rejects synthetics."""
        synth = {8, 9, 10}
        all_idx = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
        lcs = {}
        for i in range(1, 8):
            lcs[i] = LineConsensus(index=i, is_synthetic=False, votes_available=5, votes_unavailable=0, total_voters=5)
        for i in range(8, 11):
            lcs[i] = LineConsensus(index=i, is_synthetic=True, votes_available=0, votes_unavailable=5, total_voters=5)

        consensus = self._build_consensus(lcs)
        r = _make_miner_response(0, {1, 2, 3, 4, 5, 6, 7})  # all real, no synthetic

        is_correct, accuracy = _score_against_consensus(r, consensus, synth, all_idx)
        assert is_correct is True
        assert accuracy == 1.0

    def test_synthetic_rejection_scored_correctly(self) -> None:
        """Miner that claims synthetics are available gets penalized."""
        synth = {8, 9, 10}
        all_idx = {1, 8, 9, 10}
        lcs = {
            1: LineConsensus(index=1, is_synthetic=False, votes_available=5, votes_unavailable=0, total_voters=5),
            8: LineConsensus(index=8, is_synthetic=True, votes_available=0, votes_unavailable=5, total_voters=5),
            9: LineConsensus(index=9, is_synthetic=True, votes_available=0, votes_unavailable=5, total_voters=5),
            10: LineConsensus(index=10, is_synthetic=True, votes_available=0, votes_unavailable=5, total_voters=5),
        }
        consensus = self._build_consensus(lcs)
        r = _make_miner_response(0, {1, 8, 9, 10})  # claims synthetics available

        is_correct, accuracy = _score_against_consensus(r, consensus, synth, all_idx)
        # Line 1: agrees with consensus (1.0), Lines 8,9,10: claims available but synthetic (0.0 each)
        # accuracy = 1/4 = 0.25
        assert accuracy == pytest.approx(0.25)
        assert is_correct is False

    def test_no_quorum_only_synthetics_scored(self) -> None:
        """Below quorum: only synthetics are scored, real lines skipped."""
        synth = {8, 9}
        all_idx = {1, 2, 8, 9}
        lcs = {
            1: LineConsensus(index=1, is_synthetic=False, votes_available=2, votes_unavailable=0, total_voters=2),
            2: LineConsensus(index=2, is_synthetic=False, votes_available=1, votes_unavailable=1, total_voters=2),
            8: LineConsensus(index=8, is_synthetic=True, votes_available=0, votes_unavailable=2, total_voters=2),
            9: LineConsensus(index=9, is_synthetic=True, votes_available=0, votes_unavailable=2, total_voters=2),
        }
        consensus = self._build_consensus(lcs, responding=2)  # below quorum
        r = _make_miner_response(0, {1, 2})  # says real available, synthetic not

        is_correct, accuracy = _score_against_consensus(r, consensus, synth, all_idx)
        # Only synthetics scored: 8=correct(1.0), 9=correct(1.0) → accuracy=1.0
        assert accuracy == 1.0
        assert is_correct is True

    def test_weak_consensus_mild_penalty(self) -> None:
        """Weak consensus (50-70%): agreement=0.8, disagreement=0.3."""
        synth: set[int] = set()
        all_idx = {1}
        # 3 available, 2 unavailable → 60% confidence → weak
        lcs = {1: LineConsensus(index=1, is_synthetic=False, votes_available=3, votes_unavailable=2, total_voters=5)}
        consensus = self._build_consensus(lcs)

        # Miner agrees with weak consensus
        r_agree = _make_miner_response(0, {1})
        _, acc_agree = _score_against_consensus(r_agree, consensus, synth, all_idx)
        assert acc_agree == pytest.approx(0.8)

        # Miner disagrees with weak consensus
        r_disagree = _make_miner_response(1, set())
        _, acc_disagree = _score_against_consensus(r_disagree, consensus, synth, all_idx)
        assert acc_disagree == pytest.approx(0.3)

    def test_tie_neutral_credit(self) -> None:
        """Tie gives 0.5 credit regardless of miner's answer."""
        synth: set[int] = set()
        all_idx = {1}
        lcs = {1: LineConsensus(index=1, is_synthetic=False, votes_available=3, votes_unavailable=3, total_voters=6)}
        consensus = self._build_consensus(lcs, responding=6)

        r = _make_miner_response(0, {1})
        _, accuracy = _score_against_consensus(r, consensus, synth, all_idx)
        assert accuracy == pytest.approx(0.5)

    def test_outlier_penalized_by_strong_consensus(self) -> None:
        """Miner disagreeing with strong consensus on real lines gets 0."""
        synth: set[int] = set()
        all_idx = {1, 2}
        lcs = {
            1: LineConsensus(index=1, is_synthetic=False, votes_available=5, votes_unavailable=0, total_voters=5),
            2: LineConsensus(index=2, is_synthetic=False, votes_available=5, votes_unavailable=0, total_voters=5),
        }
        consensus = self._build_consensus(lcs)
        r = _make_miner_response(0, set())  # disagrees on both

        is_correct, accuracy = _score_against_consensus(r, consensus, synth, all_idx)
        assert accuracy == 0.0
        assert is_correct is False

    def test_threshold_boundary(self) -> None:
        """Accuracy exactly at 0.6 → correct."""
        synth = {4, 5}
        all_idx = {1, 2, 3, 4, 5}
        lcs = {
            1: LineConsensus(index=1, is_synthetic=False, votes_available=5, votes_unavailable=0, total_voters=5),
            2: LineConsensus(index=2, is_synthetic=False, votes_available=5, votes_unavailable=0, total_voters=5),
            3: LineConsensus(index=3, is_synthetic=False, votes_available=5, votes_unavailable=0, total_voters=5),
            4: LineConsensus(index=4, is_synthetic=True, votes_available=0, votes_unavailable=5, total_voters=5),
            5: LineConsensus(index=5, is_synthetic=True, votes_available=0, votes_unavailable=5, total_voters=5),
        }
        consensus = self._build_consensus(lcs)
        # Agree on 3 real (3x1.0) + 2 synth correct (2x1.0) = 5/5 = 1.0 → correct
        r = _make_miner_response(0, {1, 2, 3})
        is_correct, accuracy = _score_against_consensus(r, consensus, synth, all_idx)
        assert is_correct is True

        # Agree on 1 real, disagree on 2, correct on synthetics
        # 1.0 + 0.0 + 0.0 + 1.0 + 1.0 = 3/5 = 0.6 → exactly correct
        r2 = _make_miner_response(1, {1})
        is_correct2, accuracy2 = _score_against_consensus(r2, consensus, synth, all_idx)
        assert accuracy2 == pytest.approx(0.6)
        assert is_correct2 is True

    def test_failed_response_returns_zero(self) -> None:
        synth: set[int] = set()
        all_idx = {1}
        lcs = {1: LineConsensus(index=1, is_synthetic=False, votes_available=3, votes_unavailable=0, total_voters=3)}
        consensus = self._build_consensus(lcs)
        r = _make_miner_response(0, set(), success=False)
        is_correct, accuracy = _score_against_consensus(r, consensus, synth, all_idx)
        assert is_correct is False
        assert accuracy == 0.0


# ---------------------------------------------------------------------------
# _select_proof_targets
# ---------------------------------------------------------------------------


class TestSelectProofTargets:
    def test_outliers_prioritized(self) -> None:
        """Outliers (2+ disagreements with strong consensus) come first."""
        synth = {10}
        lcs = {}
        for i in range(1, 10):
            lcs[i] = LineConsensus(index=i, is_synthetic=False, votes_available=5, votes_unavailable=0, total_voters=5)
        lcs[10] = LineConsensus(index=10, is_synthetic=True, votes_available=0, votes_unavailable=5, total_voters=5)
        consensus = ConsensusResult(line_consensuses=lcs, responding_miners=5, total_miners=5)

        # Outlier disagrees on 3 real lines
        outlier = _make_miner_response(0, set(), query_id="q-outlier")
        normal1 = _make_miner_response(1, {1, 2, 3, 4, 5, 6, 7, 8, 9}, query_id="q-n1")
        normal2 = _make_miner_response(2, {1, 2, 3, 4, 5, 6, 7, 8, 9}, query_id="q-n2")

        targets = _select_proof_targets([outlier, normal1, normal2], consensus, synth, max_proofs=2)
        assert targets[0].uid == 0  # outlier first

    def test_max_cap_respected(self) -> None:
        synth = {10}
        lcs = {}
        for i in range(1, 10):
            lcs[i] = LineConsensus(index=i, is_synthetic=False, votes_available=5, votes_unavailable=0, total_voters=5)
        lcs[10] = LineConsensus(index=10, is_synthetic=True, votes_available=0, votes_unavailable=5, total_voters=5)
        consensus = ConsensusResult(line_consensuses=lcs, responding_miners=5, total_miners=5)

        responses = [_make_miner_response(i, {1, 2, 3}, query_id=f"q-{i}") for i in range(10)]
        targets = _select_proof_targets(responses, consensus, synth, max_proofs=4)
        assert len(targets) <= 4

    def test_no_query_id_excluded(self) -> None:
        synth = {10}
        lcs = {
            1: LineConsensus(index=1, is_synthetic=False, votes_available=3, votes_unavailable=0, total_voters=3),
            10: LineConsensus(index=10, is_synthetic=True, votes_available=0, votes_unavailable=3, total_voters=3),
        }
        consensus = ConsensusResult(line_consensuses=lcs, responding_miners=3, total_miners=3)

        r_no_qid = _make_miner_response(0, {1}, query_id=None)
        r_has_qid = _make_miner_response(1, {1}, query_id="q-1")
        targets = _select_proof_targets([r_no_qid, r_has_qid], consensus, synth)
        assert all(t.query_id is not None for t in targets)

    def test_no_quorum_random_selection(self) -> None:
        """Below quorum: random selection from miners with query_ids."""
        synth = {10}
        lcs = {1: LineConsensus(index=1, is_synthetic=False, votes_available=1, votes_unavailable=0, total_voters=1)}
        consensus = ConsensusResult(line_consensuses=lcs, responding_miners=1, total_miners=1)

        responses = [_make_miner_response(0, {1}, query_id="q-0")]
        targets = _select_proof_targets(responses, consensus, synth)
        assert len(targets) == 1

    def test_failed_miners_excluded(self) -> None:
        synth = {10}
        lcs = {
            1: LineConsensus(index=1, is_synthetic=False, votes_available=3, votes_unavailable=0, total_voters=3),
            10: LineConsensus(index=10, is_synthetic=True, votes_available=0, votes_unavailable=3, total_voters=3),
        }
        consensus = ConsensusResult(line_consensuses=lcs, responding_miners=3, total_miners=4)

        r_fail = _make_miner_response(0, set(), success=False, query_id="q-0")
        r_ok = _make_miner_response(1, {1}, query_id="q-1")
        targets = _select_proof_targets([r_fail, r_ok], consensus, synth)
        assert all(t.success for t in targets)


# ---------------------------------------------------------------------------
# challenge_miners — edge cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_challenge_miners_no_games() -> None:
    """Returns 0 when ESPN has no games."""
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[])
    scorer = MinerScorer()

    result = await challenge_miners(scorer, [], espn_client=mock_espn)
    assert result.challenged == 0


@pytest.mark.asyncio
async def test_challenge_miners_no_miners() -> None:
    """Returns 0 when no miners are given."""
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[_make_game()])
    scorer = MinerScorer()

    result = await challenge_miners(scorer, [], espn_client=mock_espn)
    assert result.challenged == 0


@pytest.mark.asyncio
async def test_challenge_miners_miner_no_ip() -> None:
    """Miner with no IP is skipped."""
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[_make_game()])
    scorer = MinerScorer()
    axon = {"uid": 0, "hotkey": "hk0", "ip": "", "port": 0}

    with patch("djinn_validator.core.challenges.httpx.AsyncClient") as mock_http_cls:
        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)
        mock_http_cls.return_value = mock_http

        result = await challenge_miners(scorer, [axon], espn_client=mock_espn)

    assert result.challenged == 0


# ---------------------------------------------------------------------------
# challenge_miners — full consensus flow
# ---------------------------------------------------------------------------


def _mock_check_response(
    available_indices: list[int] | None = None,
    query_id: str | None = None,
) -> httpx.Response:
    json_data = {
        "results": [],
        "available_indices": available_indices or [1, 2, 3],
        "response_time_ms": 50.0,
        "query_id": query_id,
    }
    return httpx.Response(
        status_code=200,
        json=json_data,
        request=httpx.Request("POST", "http://127.0.0.1:8080/v1/check"),
    )


def _mock_proof_response(status: str = "submitted") -> httpx.Response:
    return httpx.Response(
        status_code=200,
        json={"query_id": "test-q", "proof_hash": "abc123", "status": status},
        request=httpx.Request("POST", "http://127.0.0.1:8080/v1/proof"),
    )


@pytest.mark.asyncio
async def test_challenge_miners_scores_miner() -> None:
    """Happy path: miner responds, gets scored."""
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[
        _make_game(), _make_game("evt2"),
    ])
    scorer = MinerScorer()
    axon = {"uid": 0, "hotkey": "hk0", "ip": "127.0.0.1", "port": 8080}

    with patch("djinn_validator.core.challenges.httpx.AsyncClient") as mock_http_cls:
        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)
        mock_http.post = AsyncMock(return_value=_mock_check_response())
        mock_http_cls.return_value = mock_http

        result = await challenge_miners(scorer, [axon], espn_client=mock_espn)

    assert result.challenged == 1
    metrics = scorer.get_or_create(0, "hk0")
    assert metrics.queries_total > 0


@pytest.mark.asyncio
async def test_challenge_miners_unreachable_miner() -> None:
    """Unreachable miners get scored with correct=False."""
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[_make_game()])
    scorer = MinerScorer()
    axon = {"uid": 0, "hotkey": "hk0", "ip": "127.0.0.1", "port": 8080}

    with patch("djinn_validator.core.challenges.httpx.AsyncClient") as mock_http_cls:
        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)
        mock_http.post = AsyncMock(side_effect=httpx.ConnectError("refused"))
        mock_http_cls.return_value = mock_http

        result = await challenge_miners(scorer, [axon], espn_client=mock_espn)

    assert result.challenged == 1  # Counted as challenged (but scored as incorrect)


@pytest.mark.asyncio
async def test_challenge_miners_miner_500() -> None:
    """Miner returning 500 gets scored as incorrect."""
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[_make_game()])
    scorer = MinerScorer()
    axon = {"uid": 0, "hotkey": "hk0", "ip": "127.0.0.1", "port": 8080}

    with patch("djinn_validator.core.challenges.httpx.AsyncClient") as mock_http_cls:
        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)
        mock_http.post = AsyncMock(return_value=httpx.Response(
            status_code=500,
            json={"detail": "error"},
            request=httpx.Request("POST", "http://127.0.0.1:8080/v1/check"),
        ))
        mock_http_cls.return_value = mock_http

        result = await challenge_miners(scorer, [axon], espn_client=mock_espn)

    assert result.challenged == 1


# ---------------------------------------------------------------------------
# Consensus challenge integration tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_consensus_three_miners_majority() -> None:
    """3 miners with 2 agreeing — majority determines correctness."""
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[
        _make_game(), _make_game("evt2"),
    ])
    scorer = MinerScorer()
    axons = [
        {"uid": 0, "hotkey": "hk0", "ip": "127.0.0.1", "port": 8080},
        {"uid": 1, "hotkey": "hk1", "ip": "127.0.0.1", "port": 8081},
        {"uid": 2, "hotkey": "hk2", "ip": "127.0.0.1", "port": 8082},
    ]

    with patch("djinn_validator.core.challenges.httpx.AsyncClient") as mock_http_cls:
        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)
        # Phase 1: All queries first (all 3 miners)
        # Miners 0 and 1 agree on [1,2,3], Miner 2 disagrees
        mock_http.post = AsyncMock(side_effect=[
            _mock_check_response([1, 2, 3]),
            _mock_check_response([1, 2, 3]),
            _mock_check_response([4, 5, 6]),  # outlier
        ])
        mock_http_cls.return_value = mock_http

        result = await challenge_miners(scorer, axons, espn_client=mock_espn)

    assert result.challenged == 3
    # All 3 should be scored
    for uid in range(3):
        m = scorer.get_or_create(uid, f"hk{uid}")
        assert m.queries_total > 0


@pytest.mark.asyncio
async def test_consensus_two_miners_fallback() -> None:
    """2 miners: below quorum, only synthetic lines scored."""
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[_make_game()])
    scorer = MinerScorer()
    axons = [
        {"uid": 0, "hotkey": "hk0", "ip": "127.0.0.1", "port": 8080},
        {"uid": 1, "hotkey": "hk1", "ip": "127.0.0.1", "port": 8081},
    ]

    with patch("djinn_validator.core.challenges.httpx.AsyncClient") as mock_http_cls:
        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)
        # Both return some available indices (no synthetics claimed)
        mock_http.post = AsyncMock(return_value=_mock_check_response([1, 2, 3]))
        mock_http_cls.return_value = mock_http

        result = await challenge_miners(scorer, axons, espn_client=mock_espn)

    assert result.challenged == 2
    # Both should still be scored (at least on synthetics)
    m0 = scorer.get_or_create(0, "hk0")
    m1 = scorer.get_or_create(1, "hk1")
    assert m0.queries_total > 0
    assert m1.queries_total > 0


@pytest.mark.asyncio
async def test_consensus_all_same_response() -> None:
    """All miners agree — everyone scores high."""
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[
        _make_game(), _make_game("evt2"),
    ])
    scorer = MinerScorer()
    axons = [
        {"uid": i, "hotkey": f"hk{i}", "ip": "127.0.0.1", "port": 8080 + i}
        for i in range(5)
    ]

    with patch("djinn_validator.core.challenges.httpx.AsyncClient") as mock_http_cls:
        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)
        mock_http.post = AsyncMock(return_value=_mock_check_response([1, 2, 3, 4, 5]))
        mock_http_cls.return_value = mock_http

        result = await challenge_miners(scorer, axons, espn_client=mock_espn)

    assert result.challenged == 5
    for i in range(5):
        m = scorer.get_or_create(i, f"hk{i}")
        assert m.queries_total > 0
        assert m.queries_correct > 0  # unanimous consensus → all correct


@pytest.mark.asyncio
async def test_consensus_mixed_success_failure() -> None:
    """Mix of successful and failed miners."""
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[_make_game()])
    scorer = MinerScorer()
    axons = [
        {"uid": 0, "hotkey": "hk0", "ip": "127.0.0.1", "port": 8080},
        {"uid": 1, "hotkey": "hk1", "ip": "127.0.0.1", "port": 8081},
        {"uid": 2, "hotkey": "hk2", "ip": "127.0.0.1", "port": 8082},
    ]

    with patch("djinn_validator.core.challenges.httpx.AsyncClient") as mock_http_cls:
        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)
        mock_http.post = AsyncMock(side_effect=[
            _mock_check_response([1, 2, 3]),
            httpx.ConnectError("refused"),  # miner 1 fails
            _mock_check_response([1, 2, 3]),
        ])
        mock_http_cls.return_value = mock_http

        result = await challenge_miners(scorer, axons, espn_client=mock_espn)

    assert result.challenged == 3  # All 3 counted
    # Failed miner still gets metrics
    m1 = scorer.get_or_create(1, "hk1")
    assert m1.queries_total > 0
    assert m1.queries_correct == 0


@pytest.mark.asyncio
async def test_consensus_proof_requested_from_outlier() -> None:
    """Proof is requested from outlier miner (disagrees with strong consensus)."""
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[
        _make_game(), _make_game("evt2"),
    ])
    scorer = MinerScorer()
    axons = [
        {"uid": 0, "hotkey": "hk0", "ip": "127.0.0.1", "port": 8080},
        {"uid": 1, "hotkey": "hk1", "ip": "127.0.0.1", "port": 8081},
        {"uid": 2, "hotkey": "hk2", "ip": "127.0.0.1", "port": 8082},
        {"uid": 3, "hotkey": "hk3", "ip": "127.0.0.1", "port": 8083},
    ]

    with patch("djinn_validator.core.challenges.httpx.AsyncClient") as mock_http_cls:
        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)
        # Phase 1: queries from all 4 miners
        # Phase 4: proof from outlier
        mock_http.post = AsyncMock(side_effect=[
            # Phase 1: 4 check responses
            _mock_check_response([1, 2, 3, 4, 5], query_id="q-0"),
            _mock_check_response([1, 2, 3, 4, 5], query_id="q-1"),
            _mock_check_response([1, 2, 3, 4, 5], query_id="q-2"),
            _mock_check_response([], query_id="q-3"),  # outlier: nothing available
            # Phase 4: proof responses (could be multiple)
            _mock_proof_response(),
            _mock_proof_response(),
            _mock_proof_response(),
            _mock_proof_response(),
        ])
        mock_http_cls.return_value = mock_http

        result = await challenge_miners(scorer, axons, espn_client=mock_espn)

    assert result.challenged == 4
    # Proof was requested (at least check + proof calls)
    assert mock_http.post.call_count > 4
