"""Tests for the line availability checker."""

from __future__ import annotations

import math
from unittest.mock import AsyncMock

import httpx
import pytest

from djinn_miner.api.models import CandidateLine
from djinn_miner.core.checker import LineChecker
from djinn_miner.core.health import HealthTracker
from djinn_miner.data.odds_api import BookmakerOdds, OddsApiClient


@pytest.fixture
def odds_client(mock_odds_response: list[dict]) -> OddsApiClient:
    """Create an OddsApiClient backed by mock data."""
    mock_http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=mock_odds_response)
        )
    )
    return OddsApiClient(
        api_key="test-key",
        base_url="https://api.the-odds-api.com",
        cache_ttl=300,
        http_client=mock_http,
    )


@pytest.fixture
def checker(odds_client: OddsApiClient) -> LineChecker:
    return LineChecker(odds_client=odds_client, line_tolerance=0.5)


@pytest.mark.asyncio
async def test_check_returns_results_for_all_lines(
    checker: LineChecker, sample_lines: list[CandidateLine]
) -> None:
    check_result = await checker.check(sample_lines)
    results = check_result.results
    assert len(results) == len(sample_lines)
    indices = {r.index for r in results}
    assert indices == {1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
    assert check_result.api_error is None


@pytest.mark.asyncio
async def test_exact_spread_match(checker: LineChecker) -> None:
    """Lakers -3 @ FanDuel should be available (exact match)."""
    lines = [
        CandidateLine(
            index=1,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="spreads",
            line=-3.0,
            side="Los Angeles Lakers",
        ),
    ]
    results = (await checker.check(lines)).results
    assert results[0].available is True
    assert any(b.bookmaker == "FanDuel" for b in results[0].bookmakers)


@pytest.mark.asyncio
async def test_spread_exact_match_only(odds_client: OddsApiClient) -> None:
    """Exact match: -3.0 matches FanDuel (-3.0) but not DraftKings (-3.5)."""
    exact_checker = LineChecker(odds_client=odds_client, line_tolerance=0.0)
    lines = [
        CandidateLine(
            index=1,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="spreads",
            line=-3.0,
            side="Los Angeles Lakers",
        ),
    ]
    results = (await exact_checker.check(lines)).results
    bookmaker_names = [b.bookmaker for b in results[0].bookmakers]
    assert "FanDuel" in bookmaker_names
    assert "DraftKings" not in bookmaker_names  # -3.5 != -3.0


@pytest.mark.asyncio
async def test_spread_outside_tolerance(checker: LineChecker) -> None:
    """Lakers -5 is too far from -3 (FanDuel) and -3.5 (DraftKings)."""
    lines = [
        CandidateLine(
            index=1,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="spreads",
            line=-5.0,
            side="Los Angeles Lakers",
        ),
    ]
    results = (await checker.check(lines)).results
    assert results[0].available is False
    assert len(results[0].bookmakers) == 0
    assert results[0].unavailable_reason == "line_moved"


@pytest.mark.asyncio
async def test_unavailable_reason_no_data(checker: LineChecker) -> None:
    """Unknown event returns no_data or game_started reason."""
    lines = [
        CandidateLine(
            index=1,
            sport="basketball_nba",
            event_id="event-nonexistent-999",
            home_team="Nonexistent Team A",
            away_team="Nonexistent Team B",
            market="spreads",
            line=-3.0,
            side="Nonexistent Team A",
        ),
    ]
    results = (await checker.check(lines)).results
    assert results[0].available is False
    assert results[0].unavailable_reason in ("game_started", "no_data")


@pytest.mark.asyncio
async def test_h2h_match(checker: LineChecker) -> None:
    """H2H (moneyline) match requires no line, just team name."""
    lines = [
        CandidateLine(
            index=1,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="h2h",
            line=None,
            side="Los Angeles Lakers",
        ),
    ]
    results = (await checker.check(lines)).results
    assert results[0].available is True


@pytest.mark.asyncio
async def test_totals_match(checker: LineChecker) -> None:
    """Over 218.5 should match FanDuel (exact) and DraftKings (219, within tolerance)."""
    lines = [
        CandidateLine(
            index=1,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="totals",
            line=218.5,
            side="Over",
        ),
    ]
    results = (await checker.check(lines)).results
    assert results[0].available is True
    assert len(results[0].bookmakers) >= 1


@pytest.mark.asyncio
async def test_wrong_side_does_not_match(checker: LineChecker) -> None:
    """A spread line for the wrong team should not match."""
    lines = [
        CandidateLine(
            index=1,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="spreads",
            line=-3.0,
            side="Boston Celtics",  # Celtics have +3.0, not -3.0
        ),
    ]
    results = (await checker.check(lines)).results
    assert results[0].available is False


@pytest.mark.asyncio
async def test_full_10_line_check(
    checker: LineChecker, sample_lines: list[CandidateLine]
) -> None:
    """Full 10-line check produces the expected available/unavailable split."""
    results = (await checker.check(sample_lines)).results

    available = {r.index for r in results if r.available}
    unavailable = {r.index for r in results if not r.available}

    # Line 1: Lakers -5 spread -> outside tolerance -> unavailable
    assert 1 not in available
    # Line 2: Celtics +3 spread -> exact match at FanDuel -> available
    assert 2 in available
    # Line 3: Lakers h2h -> available
    assert 3 in available
    # Line 4: Over 218.5 -> available
    assert 4 in available
    # Line 5: Lakers -3 spread -> exact match -> available
    assert 5 in available
    # Line 6: Under 218.5 -> available
    assert 6 in available
    # Line 7: Celtics +5 spread -> outside tolerance from +3/+3.5 -> unavailable
    assert 7 not in available
    # Line 8: Heat -2 spread -> exact match at FanDuel -> available
    assert 8 in available
    # Line 9: Warriors h2h -> available
    assert 9 in available
    # Line 10: Lakers -4.5 spread -> outside tolerance from -3 and -3.5 -> unavailable
    assert 10 not in available


@pytest.mark.asyncio
async def test_check_with_api_failure() -> None:
    """If the odds API fails, lines should be reported as unavailable."""
    mock_http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(500, json={"error": "internal"})
        )
    )
    odds_client = OddsApiClient(api_key="test", http_client=mock_http)
    chk = LineChecker(odds_client=odds_client, line_tolerance=0.5)

    lines = [
        CandidateLine(
            index=1,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="spreads",
            line=-3.0,
            side="Los Angeles Lakers",
        ),
    ]
    check_result = await chk.check(lines)
    assert check_result.results[0].available is False
    assert check_result.api_error is not None  # All sports failed => api_error set


@pytest.mark.asyncio
async def test_check_multiple_sports() -> None:
    """Lines from different sports trigger separate API calls."""
    nba_data = [
        {
            "id": "nba-001",
            "sport_key": "basketball_nba",
            "home_team": "Los Angeles Lakers",
            "away_team": "Boston Celtics",
            "bookmakers": [
                {
                    "key": "fanduel",
                    "title": "FanDuel",
                    "markets": [
                        {
                            "key": "h2h",
                            "outcomes": [
                                {"name": "Los Angeles Lakers", "price": 1.45},
                                {"name": "Boston Celtics", "price": 2.80},
                            ],
                        },
                    ],
                },
            ],
        },
    ]
    nfl_data = [
        {
            "id": "nfl-001",
            "sport_key": "americanfootball_nfl",
            "home_team": "Kansas City Chiefs",
            "away_team": "Buffalo Bills",
            "bookmakers": [
                {
                    "key": "draftkings",
                    "title": "DraftKings",
                    "markets": [
                        {
                            "key": "spreads",
                            "outcomes": [
                                {"name": "Kansas City Chiefs", "price": 1.91, "point": -3.0},
                                {"name": "Buffalo Bills", "price": 1.91, "point": 3.0},
                            ],
                        },
                    ],
                },
            ],
        },
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "basketball_nba" in url:
            return httpx.Response(200, json=nba_data)
        if "americanfootball_nfl" in url:
            return httpx.Response(200, json=nfl_data)
        return httpx.Response(404)

    mock_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    odds_client = OddsApiClient(api_key="test", http_client=mock_http)
    chk = LineChecker(odds_client=odds_client, line_tolerance=0.5)

    lines = [
        CandidateLine(
            index=1,
            sport="basketball_nba",
            event_id="nba-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="h2h",
            line=None,
            side="Los Angeles Lakers",
        ),
        CandidateLine(
            index=2,
            sport="football_nfl",
            event_id="nfl-001",
            home_team="Kansas City Chiefs",
            away_team="Buffalo Bills",
            market="spreads",
            line=-3.0,
            side="Kansas City Chiefs",
        ),
    ]

    check_result = await chk.check(lines)
    assert len(check_result.results) == 2
    assert check_result.results[0].available is True  # NBA h2h
    assert check_result.results[1].available is True  # NFL spread
    assert check_result.api_error is None


@pytest.mark.asyncio
async def test_strict_tolerance() -> None:
    """With tolerance=0, only exact line matches should work."""
    mock_data = [
        {
            "id": "ev-001",
            "home_team": "Los Angeles Lakers",
            "away_team": "Boston Celtics",
            "bookmakers": [
                {
                    "key": "fanduel",
                    "title": "FanDuel",
                    "markets": [
                        {
                            "key": "spreads",
                            "outcomes": [
                                {"name": "Los Angeles Lakers", "price": 1.91, "point": -3.0},
                            ],
                        },
                    ],
                },
            ],
        },
    ]
    mock_http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=mock_data))
    )
    odds_client = OddsApiClient(api_key="test", http_client=mock_http)
    chk = LineChecker(odds_client=odds_client, line_tolerance=0.0)

    exact = [
        CandidateLine(
            index=1, sport="basketball_nba", event_id="ev-001",
            home_team="Los Angeles Lakers", away_team="Boston Celtics",
            market="spreads", line=-3.0, side="Los Angeles Lakers",
        ),
    ]
    close = [
        CandidateLine(
            index=2, sport="basketball_nba", event_id="ev-001",
            home_team="Los Angeles Lakers", away_team="Boston Celtics",
            market="spreads", line=-3.5, side="Los Angeles Lakers",
        ),
    ]

    res_exact = (await chk.check(exact)).results
    res_close = (await chk.check(close)).results
    assert res_exact[0].available is True
    assert res_close[0].available is False


@pytest.mark.asyncio
async def test_partial_sport_failure_still_returns_results() -> None:
    """If one sport fails but another succeeds, partial results are returned."""
    nba_data = [
        {
            "id": "nba-001",
            "home_team": "Lakers",
            "away_team": "Celtics",
            "bookmakers": [
                {
                    "key": "fanduel", "title": "FanDuel",
                    "markets": [{"key": "h2h", "outcomes": [
                        {"name": "Lakers", "price": 1.5},
                    ]}],
                },
            ],
        },
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "basketball_nba" in url:
            return httpx.Response(200, json=nba_data)
        return httpx.Response(500, json={"error": "fail"})

    mock_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    odds_client = OddsApiClient(api_key="test", http_client=mock_http)
    health = HealthTracker(odds_api_connected=True)
    chk = LineChecker(odds_client=odds_client, line_tolerance=0.5, health_tracker=health)

    lines = [
        CandidateLine(
            index=1, sport="basketball_nba", event_id="nba-001",
            home_team="Lakers", away_team="Celtics",
            market="h2h", line=None, side="Lakers",
        ),
        CandidateLine(
            index=2, sport="football_nfl", event_id="nfl-001",
            home_team="Chiefs", away_team="Bills",
            market="h2h", line=None, side="Chiefs",
        ),
    ]

    check_result = await chk.check(lines)
    assert len(check_result.results) == 2
    assert check_result.results[0].available is True  # NBA succeeded
    assert check_result.results[1].available is False  # NFL failed
    # Health should record success since at least one sport succeeded
    assert health.get_status().odds_api_connected is True
    # Partial failure: at least one sport succeeded, so no api_error
    assert check_result.api_error is None


@pytest.mark.asyncio
async def test_all_sports_fail_degrades_health() -> None:
    """When all sports fail, health tracker records failure."""
    mock_http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(500, json={"error": "down"})
        )
    )
    odds_client = OddsApiClient(api_key="test", http_client=mock_http)
    health = HealthTracker(odds_api_connected=True)
    chk = LineChecker(odds_client=odds_client, line_tolerance=0.5, health_tracker=health)

    lines = [
        CandidateLine(
            index=1, sport="basketball_nba", event_id="ev-1",
            home_team="A", away_team="B",
            market="h2h", line=None, side="A",
        ),
    ]

    # Need CONSECUTIVE_FAILURE_THRESHOLD failures to degrade
    for _ in range(HealthTracker.CONSECUTIVE_FAILURE_THRESHOLD):
        check_result = await chk.check(lines)
        assert check_result.api_error is not None  # All fetches failed

    assert health.get_status().odds_api_connected is False


@pytest.mark.asyncio
async def test_check_empty_odds_returns_all_unavailable(checker: LineChecker) -> None:
    """When odds data has no matching event, all lines are unavailable."""
    lines = [
        CandidateLine(
            index=1, sport="basketball_nba", event_id="nonexistent-event",
            home_team="Team A", away_team="Team B",
            market="h2h", line=None, side="Team A",
        ),
    ]
    check_result = await checker.check(lines)
    assert check_result.results[0].available is False
    # API succeeded (returned data), just no matching event — no api_error
    assert check_result.api_error is None


@pytest.mark.asyncio
async def test_side_matching_case_insensitive(checker: LineChecker) -> None:
    """Side matching should be case-insensitive."""
    lines = [
        CandidateLine(
            index=1, sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers", away_team="Boston Celtics",
            market="h2h", line=None,
            side="los angeles lakers",  # lowercase
        ),
    ]
    results = (await checker.check(lines)).results
    assert results[0].available is True


@pytest.mark.asyncio
async def test_check_preserves_line_order(checker: LineChecker) -> None:
    """Results should be in the same order as input lines."""
    lines = [
        CandidateLine(
            index=5, sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers", away_team="Boston Celtics",
            market="h2h", line=None, side="Los Angeles Lakers",
        ),
        CandidateLine(
            index=2, sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers", away_team="Boston Celtics",
            market="spreads", line=-99.0, side="Los Angeles Lakers",
        ),
    ]
    results = (await checker.check(lines)).results
    assert results[0].index == 5
    assert results[1].index == 2


class TestNaNGuard:
    """NaN values in line or point must not produce false matches."""

    def _make_checker(self) -> LineChecker:
        mock_http = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json=[]))
        )
        client = OddsApiClient(api_key="test", http_client=mock_http)
        return LineChecker(odds_client=client, line_tolerance=0.5)

    def _make_line(self, line_val: float | None = -3.0) -> CandidateLine:
        return CandidateLine(
            index=1, sport="basketball_nba", event_id="ev-1",
            home_team="A", away_team="B",
            market="spreads", line=line_val, side="A",
        )

    def _make_odds(self, point: float | None = -3.0) -> BookmakerOdds:
        return BookmakerOdds(
            bookmaker_key="fanduel", bookmaker_title="FanDuel",
            market="spreads", name="A", price=1.91, point=point,
        )

    def test_nan_line_does_not_match(self) -> None:
        chk = self._make_checker()
        line = self._make_line(float("nan"))
        odds = self._make_odds(-3.0)
        assert chk._line_matches(line, odds) is False

    def test_nan_point_does_not_match(self) -> None:
        chk = self._make_checker()
        line = self._make_line(-3.0)
        odds = self._make_odds(float("nan"))
        assert chk._line_matches(line, odds) is False

    def test_both_nan_does_not_match(self) -> None:
        chk = self._make_checker()
        line = self._make_line(float("nan"))
        odds = self._make_odds(float("nan"))
        assert chk._line_matches(line, odds) is False

    def test_inf_line_does_not_match(self) -> None:
        chk = self._make_checker()
        line = self._make_line(float("inf"))
        odds = self._make_odds(-3.0)
        assert chk._line_matches(line, odds) is False

    def test_neg_inf_point_does_not_match(self) -> None:
        chk = self._make_checker()
        line = self._make_line(-3.0)
        odds = self._make_odds(float("-inf"))
        assert chk._line_matches(line, odds) is False

    def test_finite_values_still_match(self) -> None:
        chk = self._make_checker()
        line = self._make_line(-3.0)
        odds = self._make_odds(-3.0)
        assert chk._line_matches(line, odds) is True


@pytest.mark.asyncio
async def test_api_error_on_401_unauthorized() -> None:
    """A 401 from the Odds API should surface as api_error, not just unavailable lines."""
    mock_http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(401, text="Unauthorized")
        )
    )
    odds_client = OddsApiClient(api_key="bad-key", http_client=mock_http)
    chk = LineChecker(odds_client=odds_client, line_tolerance=0.5)

    lines = [
        CandidateLine(
            index=1, sport="basketball_nba", event_id="ev-1",
            home_team="A", away_team="B",
            market="h2h", line=None, side="A",
        ),
    ]
    check_result = await chk.check(lines)
    assert check_result.results[0].available is False
    assert check_result.api_error is not None
    assert "401" in check_result.api_error


@pytest.mark.asyncio
async def test_no_api_error_on_success(checker: LineChecker) -> None:
    """Successful API responses should not set api_error."""
    lines = [
        CandidateLine(
            index=1, sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers", away_team="Boston Celtics",
            market="h2h", line=None, side="Los Angeles Lakers",
        ),
    ]
    check_result = await checker.check(lines)
    assert check_result.api_error is None
    assert check_result.results[0].available is True
