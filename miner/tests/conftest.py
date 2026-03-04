"""Shared fixtures for miner tests."""

from __future__ import annotations

import os

import pytest

# Ensure tests don't fail when .env sets BT_NETWORK=finney.
os.environ.setdefault("CORS_ORIGINS", "http://localhost:3000,http://localhost:3001")

from djinn_miner.api.models import CandidateLine


MOCK_NBA_ODDS_RESPONSE: list[dict] = [
    {
        "id": "event-lakers-celtics-001",
        "sport_key": "basketball_nba",
        "sport_title": "NBA",
        "commence_time": "2099-02-15T00:00:00Z",
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
                            {"name": "Boston Celtics", "price": 1.91, "point": 3.0},
                        ],
                    },
                    {
                        "key": "totals",
                        "outcomes": [
                            {"name": "Over", "price": 1.91, "point": 218.5},
                            {"name": "Under", "price": 1.91, "point": 218.5},
                        ],
                    },
                    {
                        "key": "h2h",
                        "outcomes": [
                            {"name": "Los Angeles Lakers", "price": 1.45},
                            {"name": "Boston Celtics", "price": 2.80},
                        ],
                    },
                ],
            },
            {
                "key": "draftkings",
                "title": "DraftKings",
                "markets": [
                    {
                        "key": "spreads",
                        "outcomes": [
                            {"name": "Los Angeles Lakers", "price": 1.90, "point": -3.5},
                            {"name": "Boston Celtics", "price": 1.92, "point": 3.5},
                        ],
                    },
                    {
                        "key": "totals",
                        "outcomes": [
                            {"name": "Over", "price": 1.87, "point": 219.0},
                            {"name": "Under", "price": 1.95, "point": 219.0},
                        ],
                    },
                    {
                        "key": "h2h",
                        "outcomes": [
                            {"name": "Los Angeles Lakers", "price": 1.50},
                            {"name": "Boston Celtics", "price": 2.65},
                        ],
                    },
                ],
            },
        ],
    },
    {
        "id": "event-heat-warriors-002",
        "sport_key": "basketball_nba",
        "sport_title": "NBA",
        "commence_time": "2099-02-15T02:00:00Z",
        "home_team": "Miami Heat",
        "away_team": "Golden State Warriors",
        "bookmakers": [
            {
                "key": "fanduel",
                "title": "FanDuel",
                "markets": [
                    {
                        "key": "spreads",
                        "outcomes": [
                            {"name": "Miami Heat", "price": 1.95, "point": -2.0},
                            {"name": "Golden State Warriors", "price": 1.87, "point": 2.0},
                        ],
                    },
                    {
                        "key": "h2h",
                        "outcomes": [
                            {"name": "Miami Heat", "price": 1.55},
                            {"name": "Golden State Warriors", "price": 2.50},
                        ],
                    },
                ],
            },
        ],
    },
]


@pytest.fixture
def mock_odds_response() -> list[dict]:
    """Return a mock Odds API response with two NBA events."""
    return MOCK_NBA_ODDS_RESPONSE


@pytest.fixture
def sample_lines() -> list[CandidateLine]:
    """Return a set of 10 candidate lines for testing."""
    return [
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
        CandidateLine(
            index=2,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="spreads",
            line=3.0,
            side="Boston Celtics",
        ),
        CandidateLine(
            index=3,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="h2h",
            line=None,
            side="Los Angeles Lakers",
        ),
        CandidateLine(
            index=4,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="totals",
            line=218.5,
            side="Over",
        ),
        CandidateLine(
            index=5,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="spreads",
            line=-3.0,
            side="Los Angeles Lakers",
        ),
        CandidateLine(
            index=6,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="totals",
            line=218.5,
            side="Under",
        ),
        CandidateLine(
            index=7,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="spreads",
            line=5.0,
            side="Boston Celtics",
        ),
        CandidateLine(
            index=8,
            sport="basketball_nba",
            event_id="event-heat-warriors-002",
            home_team="Miami Heat",
            away_team="Golden State Warriors",
            market="spreads",
            line=-2.0,
            side="Miami Heat",
        ),
        CandidateLine(
            index=9,
            sport="basketball_nba",
            event_id="event-heat-warriors-002",
            home_team="Miami Heat",
            away_team="Golden State Warriors",
            market="h2h",
            line=None,
            side="Golden State Warriors",
        ),
        CandidateLine(
            index=10,
            sport="basketball_nba",
            event_id="event-lakers-celtics-001",
            home_team="Los Angeles Lakers",
            away_team="Boston Celtics",
            market="spreads",
            line=-4.5,
            side="Los Angeles Lakers",
        ),
    ]
