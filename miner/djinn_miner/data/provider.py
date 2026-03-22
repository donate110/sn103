"""Sports data provider protocol.

Defines the interface that any sports data source must implement to work
with the Djinn miner. The default implementation is OddsApiClient (The Odds API).
Miners who want to use a different data source (OddsJam, Sportradar, direct
sportsbook scraping, etc.) can implement this protocol and configure the
miner to use it via the SPORTS_DATA_PROVIDER environment variable.

The validator scores miners via cross-miner consensus, not by checking
against any specific API. So miners using different data sources will be
scored fairly as long as their answers agree with the majority.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable


@dataclass
class BookmakerOdds:
    """Parsed odds from a single bookmaker for a single outcome.

    This is the standard data format that all providers must produce.
    The LineChecker consumes these to determine line availability.
    """

    bookmaker_key: str
    bookmaker_title: str
    market: str  # "spreads", "totals", "h2h"
    name: str  # Team name or "Over"/"Under"
    price: float  # Decimal odds
    point: float | None = None  # Spread or total line value


@runtime_checkable
class SportsDataProvider(Protocol):
    """Protocol for sports data providers.

    Any class implementing these methods can be used as the miner's
    data source. See OddsApiClient for the reference implementation.
    """

    @property
    def last_query_id(self) -> str | None:
        """ID of the most recent query, used for proof generation."""
        ...

    async def get_odds(
        self,
        sport: str,
        markets: str = "spreads,totals,h2h",
    ) -> list[dict[str, Any]]:
        """Fetch live odds for a sport.

        Args:
            sport: Internal sport key (e.g. "basketball_nba", "hockey_nhl")
            markets: Comma-separated market types to fetch

        Returns:
            List of event dicts, each containing bookmaker odds data.
            The exact schema follows The Odds API v4 format:
            [{"id": "...", "home_team": "...", "away_team": "...",
              "commence_time": "...", "bookmakers": [...]}]
        """
        ...

    def parse_bookmaker_odds(
        self,
        events: list[dict[str, Any]],
        event_id: str | None = None,
        home_team: str | None = None,
        away_team: str | None = None,
    ) -> list[BookmakerOdds]:
        """Parse raw event data into structured BookmakerOdds.

        Args:
            events: Raw event data from get_odds()
            event_id: Filter to a specific event ID
            home_team: Filter by home team name
            away_team: Filter by away team name

        Returns:
            List of BookmakerOdds matching the filters.
        """
        ...

    async def close(self) -> None:
        """Release resources (HTTP clients, connections, etc.)."""
        ...
