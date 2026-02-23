"""Tests for the ESPN public API client."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

import httpx
import pytest

from djinn_validator.core.espn import (
    SPORT_MAP,
    SUPPORTED_SPORTS,
    ESPNClient,
    ESPNGame,
    match_game,
    normalize_team,
    teams_match,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _scoreboard_json(events: list[dict] | None = None) -> dict:
    """Build a minimal ESPN scoreboard response."""
    if events is None:
        events = [_make_event()]
    return {"events": events}


def _make_event(
    espn_id: str = "401547283",
    home: str = "Los Angeles Lakers",
    away: str = "Boston Celtics",
    home_score: str = "110",
    away_score: str = "105",
    status: str = "STATUS_FINAL",
    date: str = "2026-02-22T00:30Z",
) -> dict:
    return {
        "id": espn_id,
        "date": date,
        "status": {"type": {"name": status}},
        "competitions": [
            {
                "competitors": [
                    {
                        "homeAway": "home",
                        "team": {"displayName": home},
                        "score": home_score,
                    },
                    {
                        "homeAway": "away",
                        "team": {"displayName": away},
                        "score": away_score,
                    },
                ]
            }
        ],
    }


def _make_response(status_code: int = 200, json_data: dict | None = None) -> httpx.Response:
    return httpx.Response(
        status_code=status_code,
        json=json_data if json_data is not None else {},
        request=httpx.Request("GET", "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"),
    )


# ---------------------------------------------------------------------------
# Team Name Normalization
# ---------------------------------------------------------------------------


class TestNormalizeTeam:
    def test_alias_match(self) -> None:
        assert normalize_team("Lakers") == "los angeles lakers"

    def test_alias_case_insensitive(self) -> None:
        assert normalize_team("LAKERS") == "los angeles lakers"

    def test_full_name_passthrough(self) -> None:
        assert normalize_team("Los Angeles Lakers") == "los angeles lakers"

    def test_unknown_team_lowered(self) -> None:
        assert normalize_team("Some Unknown Team") == "some unknown team"

    def test_whitespace_stripped(self) -> None:
        assert normalize_team("  Lakers  ") == "los angeles lakers"

    def test_nfl_alias(self) -> None:
        assert normalize_team("Chiefs") == "kansas city chiefs"

    def test_mlb_alias(self) -> None:
        assert normalize_team("Yankees") == "new york yankees"

    def test_nhl_alias(self) -> None:
        assert normalize_team("Bruins") == "boston bruins"

    def test_multi_word_alias(self) -> None:
        assert normalize_team("Red Sox") == "boston red sox"

    def test_abbreviation_alias(self) -> None:
        assert normalize_team("Pats") == "new england patriots"


class TestTeamsMatch:
    def test_exact_match(self) -> None:
        assert teams_match("Los Angeles Lakers", "Los Angeles Lakers")

    def test_alias_vs_full(self) -> None:
        assert teams_match("Lakers", "Los Angeles Lakers")

    def test_full_vs_alias(self) -> None:
        assert teams_match("Los Angeles Lakers", "Lakers")

    def test_different_teams(self) -> None:
        assert not teams_match("Lakers", "Celtics")

    def test_case_insensitive(self) -> None:
        assert teams_match("lakers", "LOS ANGELES LAKERS")

    def test_substring_match(self) -> None:
        assert teams_match("Golden State", "Golden State Warriors")

    def test_no_false_positive(self) -> None:
        # "New York" should not match "New England" via substring
        assert not teams_match("New York Knicks", "New England Patriots")


class TestMatchGame:
    def test_finds_matching_game(self) -> None:
        games = [
            ESPNGame(espn_id="1", home_team="Los Angeles Lakers", away_team="Boston Celtics"),
            ESPNGame(espn_id="2", home_team="Golden State Warriors", away_team="Miami Heat"),
        ]
        result = match_game(games, "Los Angeles Lakers", "Boston Celtics")
        assert result is not None
        assert result.espn_id == "1"

    def test_alias_matching(self) -> None:
        games = [
            ESPNGame(espn_id="1", home_team="Los Angeles Lakers", away_team="Boston Celtics"),
        ]
        result = match_game(games, "Lakers", "Celtics")
        assert result is not None
        assert result.espn_id == "1"

    def test_no_match(self) -> None:
        games = [
            ESPNGame(espn_id="1", home_team="Los Angeles Lakers", away_team="Boston Celtics"),
        ]
        result = match_game(games, "Chicago Bulls", "Miami Heat")
        assert result is None

    def test_swapped_home_away(self) -> None:
        games = [
            ESPNGame(espn_id="1", home_team="Los Angeles Lakers", away_team="Boston Celtics"),
        ]
        result = match_game(games, "Boston Celtics", "Los Angeles Lakers")
        assert result is not None

    def test_empty_games(self) -> None:
        assert match_game([], "Lakers", "Celtics") is None


# ---------------------------------------------------------------------------
# Sport Mapping
# ---------------------------------------------------------------------------


class TestSportMap:
    def test_nba_mapping(self) -> None:
        assert SPORT_MAP["basketball_nba"] == "basketball/nba"

    def test_nfl_mapping(self) -> None:
        assert SPORT_MAP["americanfootball_nfl"] == "football/nfl"

    def test_mlb_mapping(self) -> None:
        assert SPORT_MAP["baseball_mlb"] == "baseball/mlb"

    def test_nhl_mapping(self) -> None:
        assert SPORT_MAP["icehockey_nhl"] == "hockey/nhl"

    def test_all_supported_sports_have_mapping(self) -> None:
        for sport in SUPPORTED_SPORTS:
            assert sport in SPORT_MAP, f"Missing mapping for {sport}"


# ---------------------------------------------------------------------------
# ESPNClient — Scoreboard Parsing
# ---------------------------------------------------------------------------


class TestESPNClientParsing:
    @pytest.mark.asyncio
    async def test_parses_final_game(self) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, _scoreboard_json()))
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("basketball_nba")

        assert len(games) == 1
        assert games[0].home_team == "Los Angeles Lakers"
        assert games[0].away_team == "Boston Celtics"
        assert games[0].home_score == 110
        assert games[0].away_score == 105
        assert games[0].status == "final"

    @pytest.mark.asyncio
    async def test_parses_in_progress_game(self) -> None:
        event = _make_event(status="STATUS_IN_PROGRESS", home_score="55", away_score="50")
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, _scoreboard_json([event])))
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("basketball_nba")

        assert len(games) == 1
        assert games[0].status == "in_progress"

    @pytest.mark.asyncio
    async def test_parses_scheduled_game(self) -> None:
        event = _make_event(status="STATUS_SCHEDULED", home_score="", away_score="")
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, _scoreboard_json([event])))
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("basketball_nba")

        assert len(games) == 1
        assert games[0].status == "scheduled"
        assert games[0].home_score is None
        assert games[0].away_score is None

    @pytest.mark.asyncio
    async def test_parses_postponed_game(self) -> None:
        event = _make_event(status="STATUS_POSTPONED")
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, _scoreboard_json([event])))
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("basketball_nba")

        assert len(games) == 1
        assert games[0].status == "postponed"

    @pytest.mark.asyncio
    async def test_parses_cancelled_game(self) -> None:
        event = _make_event(status="STATUS_CANCELED")
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, _scoreboard_json([event])))
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("basketball_nba")

        assert len(games) == 1
        assert games[0].status == "cancelled"

    @pytest.mark.asyncio
    async def test_multiple_games(self) -> None:
        events = [
            _make_event(espn_id="1", home="Lakers", away="Celtics"),
            _make_event(espn_id="2", home="Warriors", away="Heat"),
        ]
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, _scoreboard_json(events)))
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("basketball_nba")

        assert len(games) == 2

    @pytest.mark.asyncio
    async def test_empty_scoreboard(self) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, {"events": []}))
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("basketball_nba")

        assert games == []

    @pytest.mark.asyncio
    async def test_malformed_event_skipped(self) -> None:
        events = [
            {"id": "bad", "competitions": []},  # Missing competitors
            _make_event(espn_id="good"),
        ]
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, _scoreboard_json(events)))
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("basketball_nba")

        assert len(games) == 1
        assert games[0].espn_id == "good"


# ---------------------------------------------------------------------------
# ESPNClient — Unsupported Sports / HTTP Errors
# ---------------------------------------------------------------------------


class TestESPNClientErrors:
    @pytest.mark.asyncio
    async def test_unsupported_sport_returns_empty(self) -> None:
        mock_client = AsyncMock()
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("cricket_ipl")

        assert games == []
        mock_client.get.assert_not_called()

    @pytest.mark.asyncio
    async def test_http_error_returns_empty(self) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(500))
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("basketball_nba")

        assert games == []

    @pytest.mark.asyncio
    async def test_network_error_returns_empty(self) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.ConnectError("refused"))
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("basketball_nba")

        assert games == []

    @pytest.mark.asyncio
    async def test_date_parameter_passed(self) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, {"events": []}))
        espn = ESPNClient(http_client=mock_client)

        await espn.get_scoreboard("basketball_nba", date="20260222")

        mock_client.get.assert_called_once()
        call_kwargs = mock_client.get.call_args
        assert call_kwargs[1]["params"]["dates"] == "20260222"


# ---------------------------------------------------------------------------
# ESPNClient — Circuit Breaker
# ---------------------------------------------------------------------------


class TestESPNCircuitBreaker:
    @pytest.mark.asyncio
    async def test_opens_after_threshold_failures(self) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(500))
        espn = ESPNClient(http_client=mock_client)
        espn.CIRCUIT_BREAKER_THRESHOLD = 3

        for _ in range(3):
            await espn.get_scoreboard("basketball_nba")

        assert espn._consecutive_failures == 3
        assert espn._circuit_opened_at is not None

    @pytest.mark.asyncio
    async def test_open_circuit_skips_request(self) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(500))
        espn = ESPNClient(http_client=mock_client)
        espn.CIRCUIT_BREAKER_THRESHOLD = 2

        # Trip circuit
        for _ in range(2):
            await espn.get_scoreboard("basketball_nba")

        call_count = mock_client.get.call_count

        # Next request should be skipped
        games = await espn.get_scoreboard("basketball_nba")
        assert games == []
        assert mock_client.get.call_count == call_count

    @pytest.mark.asyncio
    async def test_circuit_resets_after_timeout(self) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(500))
        espn = ESPNClient(http_client=mock_client)
        espn.CIRCUIT_BREAKER_THRESHOLD = 2
        espn.CIRCUIT_BREAKER_RESET_SECONDS = 10.0

        # Trip circuit
        for _ in range(2):
            await espn.get_scoreboard("basketball_nba")

        assert espn._is_circuit_open()

        # Simulate time passing
        espn._circuit_opened_at = time.monotonic() - 11.0

        assert not espn._is_circuit_open()  # Half-open

    @pytest.mark.asyncio
    async def test_success_resets_circuit(self) -> None:
        mock_client = AsyncMock()
        espn = ESPNClient(http_client=mock_client)

        # Manually set failure state
        espn._consecutive_failures = 10
        espn._circuit_opened_at = time.monotonic() - 100  # Expired

        mock_client.get = AsyncMock(return_value=_make_response(200, {"events": []}))
        await espn.get_scoreboard("basketball_nba")

        assert espn._consecutive_failures == 0
        assert espn._circuit_opened_at is None

    @pytest.mark.asyncio
    async def test_network_error_increments_failures(self) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.ConnectError("refused"))
        espn = ESPNClient(http_client=mock_client)

        await espn.get_scoreboard("basketball_nba")

        assert espn._consecutive_failures == 1


# ---------------------------------------------------------------------------
# ESPNClient — get_game_by_teams
# ---------------------------------------------------------------------------


class TestGetGameByTeams:
    @pytest.mark.asyncio
    async def test_finds_game(self) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, _scoreboard_json()))
        espn = ESPNClient(http_client=mock_client)

        game = await espn.get_game_by_teams("basketball_nba", "Lakers", "Celtics")

        assert game is not None
        assert game.home_team == "Los Angeles Lakers"

    @pytest.mark.asyncio
    async def test_returns_none_when_not_found(self) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, _scoreboard_json()))
        espn = ESPNClient(http_client=mock_client)

        game = await espn.get_game_by_teams("basketball_nba", "Bulls", "Heat")

        assert game is None


# ---------------------------------------------------------------------------
# All 4 Major Sports
# ---------------------------------------------------------------------------


class TestAllSports:
    @pytest.mark.asyncio
    async def test_nfl_parsing(self) -> None:
        event = _make_event(home="Kansas City Chiefs", away="Buffalo Bills")
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, _scoreboard_json([event])))
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("americanfootball_nfl")
        assert len(games) == 1
        assert games[0].home_team == "Kansas City Chiefs"

    @pytest.mark.asyncio
    async def test_mlb_parsing(self) -> None:
        event = _make_event(home="New York Yankees", away="Boston Red Sox")
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, _scoreboard_json([event])))
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("baseball_mlb")
        assert len(games) == 1

    @pytest.mark.asyncio
    async def test_nhl_parsing(self) -> None:
        event = _make_event(home="Boston Bruins", away="Toronto Maple Leafs")
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_make_response(200, _scoreboard_json([event])))
        espn = ESPNClient(http_client=mock_client)

        games = await espn.get_scoreboard("icehockey_nhl")
        assert len(games) == 1


# ---------------------------------------------------------------------------
# Edge Cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    @pytest.mark.asyncio
    async def test_close_owned_client(self) -> None:
        espn = ESPNClient()
        await espn.close()  # Should not raise

    @pytest.mark.asyncio
    async def test_close_injected_client(self) -> None:
        mock_client = AsyncMock()
        espn = ESPNClient(http_client=mock_client)
        await espn.close()  # Should NOT close injected client
        mock_client.aclose.assert_not_called()

    def test_espn_game_defaults(self) -> None:
        game = ESPNGame(espn_id="1", home_team="A", away_team="B")
        assert game.home_score is None
        assert game.away_score is None
        assert game.status == "pending"
        assert game.start_time == ""
