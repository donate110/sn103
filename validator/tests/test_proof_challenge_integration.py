"""Integration test: ESPN → challenge → check → proof → verify → score.

Tests the full pipeline from ESPN game discovery through miner scoring,
without any Odds API dependency. Updated for consensus-based scoring.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from djinn_validator.core.challenges import challenge_miners
from djinn_validator.core.espn import ESPNClient, ESPNGame
from djinn_validator.core.outcomes import OutcomeAttestor, SignalMetadata, parse_pick
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
        home_score=55 if status != "final" else 110,
        away_score=50 if status != "final" else 105,
        status=status,
    )


def _check_response(
    available_indices: list[int],
    query_id: str | None = "test-query-id",
) -> httpx.Response:
    return httpx.Response(
        status_code=200,
        json={
            "results": [],
            "available_indices": available_indices,
            "response_time_ms": 42.0,
            "query_id": query_id,
        },
        request=httpx.Request("POST", "http://127.0.0.1:8080/v1/check"),
    )


def _proof_response(status: str = "submitted") -> httpx.Response:
    return httpx.Response(
        status_code=200,
        json={"query_id": "test-query-id", "proof_hash": "deadbeef", "status": status},
        request=httpx.Request("POST", "http://127.0.0.1:8080/v1/proof"),
    )


# ---------------------------------------------------------------------------
# Full Pipeline: ESPN → challenge → check → proof → score
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_full_pipeline_with_proof() -> None:
    """End-to-end: ESPN games → challenge → miner check+proof → score recorded.

    With consensus scoring, all queries happen first (Phase 1), then scoring
    (Phase 3), then targeted proofs (Phase 4).
    """
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[
        _make_game(),
        _make_game("evt2", home="Golden State Warriors", away="Miami Heat"),
    ])

    scorer = MinerScorer()
    axons = [
        {"uid": 0, "hotkey": "hk0", "ip": "127.0.0.1", "port": 8080},
        {"uid": 1, "hotkey": "hk1", "ip": "127.0.0.1", "port": 8081},
    ]

    with patch("djinn_validator.core.challenges.httpx.AsyncClient") as mock_http_cls:
        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)
        # Phase 1: Both miners queried first (all queries before any proofs)
        # Phase 4: Proofs requested from targeted miners
        mock_http.post = AsyncMock(side_effect=[
            _check_response([1, 2, 3], query_id="q-miner0"),
            _check_response([1, 3, 5], query_id="q-miner1"),
            # Phase 4: proof responses (may or may not be called)
            _proof_response(),
            _proof_response(),
        ])
        mock_http_cls.return_value = mock_http

        challenged = await challenge_miners(scorer, axons, espn_client=mock_espn)

    assert challenged.challenged == 2
    # Both miners should have metrics recorded
    m0 = scorer.get_or_create(0, "hk0")
    m1 = scorer.get_or_create(1, "hk1")
    assert m0.queries_total > 0
    assert m1.queries_total > 0


@pytest.mark.asyncio
async def test_pipeline_old_miner_no_query_id() -> None:
    """Old miners that don't return query_id still get scored (no proof)."""
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[_make_game()])

    scorer = MinerScorer()
    axon = {"uid": 0, "hotkey": "hk0", "ip": "127.0.0.1", "port": 8080}

    with patch("djinn_validator.core.challenges.httpx.AsyncClient") as mock_http_cls:
        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)
        # Miner returns check WITHOUT query_id — no proof target
        mock_http.post = AsyncMock(return_value=_check_response([1, 2], query_id=None))
        mock_http_cls.return_value = mock_http

        challenged = await challenge_miners(scorer, [axon], espn_client=mock_espn)

    assert challenged.challenged == 1
    m = scorer.get_or_create(0, "hk0")
    assert m.queries_total > 0
    # Only one POST (check), no proof request (no query_id = not a proof target)
    assert mock_http.post.call_count == 1


@pytest.mark.asyncio
async def test_pipeline_espn_outcome_resolution() -> None:
    """OutcomeAttestor resolves a signal using ESPN data."""
    final_game = ESPNGame(
        espn_id="1", home_team="Los Angeles Lakers", away_team="Boston Celtics",
        home_score=110, away_score=105, status="final",
    )
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_game_by_teams = AsyncMock(return_value=final_game)
    mock_espn.close = AsyncMock()

    sample_lines = [parse_pick(l) for l in [
        "Lakers -3.5 (-110)", "Celtics +3.5 (-110)", "Over 218.5 (-110)",
        "Under 218.5 (-110)", "Lakers ML (-150)", "Celtics ML (+130)",
        "Lakers -1.5 (-105)", "Celtics +1.5 (-115)", "Over 215.0 (-110)",
        "Under 215.0 (-110)",
    ]]
    attestor = OutcomeAttestor(espn_client=mock_espn)
    meta = SignalMetadata(
        signal_id="sig1", sport="basketball_nba", event_id="evt1",
        home_team="Lakers", away_team="Celtics",
        lines=sample_lines,
    )
    attestor.register_signal(meta)

    result = await attestor.resolve_signal("sig1", "validator-1")

    assert result == "sig1"
    assert meta.resolved
    assert meta.outcomes is not None
    assert len(meta.outcomes) == 10


@pytest.mark.asyncio
async def test_no_odds_api_key_needed() -> None:
    """Validator can challenge and resolve without any API key."""
    # Challenge: uses ESPN, no API key
    mock_espn = AsyncMock(spec=ESPNClient)
    mock_espn.get_scoreboard = AsyncMock(return_value=[_make_game()])
    mock_espn.get_game_by_teams = AsyncMock(return_value=_make_game(status="final"))
    mock_espn.close = AsyncMock()

    scorer = MinerScorer()

    # Challenge works
    with patch("djinn_validator.core.challenges.httpx.AsyncClient") as mock_http_cls:
        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)
        mock_http.post = AsyncMock(return_value=_check_response([1, 2, 3]))
        mock_http_cls.return_value = mock_http

        challenged = await challenge_miners(
            scorer,
            [{"uid": 0, "hotkey": "hk0", "ip": "127.0.0.1", "port": 8080}],
            espn_client=mock_espn,
        )
    assert challenged.challenged == 1

    # Outcome resolution works
    sample_lines2 = [parse_pick(l) for l in [
        "Over 200.5 (-110)", "Under 200.5 (-110)", "Lakers -3.5 (-110)",
        "Celtics +3.5 (-110)", "Lakers ML (-150)", "Celtics ML (+130)",
        "Over 215.0 (-110)", "Under 215.0 (-110)", "Lakers -1.5 (-105)",
        "Celtics +1.5 (-115)",
    ]]
    attestor = OutcomeAttestor(espn_client=mock_espn)
    meta = SignalMetadata(
        signal_id="sig1", sport="basketball_nba", event_id="evt1",
        home_team="Lakers", away_team="Celtics",
        lines=sample_lines2,
    )
    attestor.register_signal(meta)
    result = await attestor.resolve_signal("sig1", "v1")
    assert result == "sig1"
    assert meta.resolved
    assert meta.outcomes is not None
