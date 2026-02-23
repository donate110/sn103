"""Line availability checker — the miner's core responsibility.

Phase 1 (immediate, <3-5s): Query sportsbook data via The Odds API,
return which of the 10 candidate lines are currently available and
at which bookmakers.

Phase 2 (seconds later): Generate a TLSNotary proof of the same TLS
session. Handled by proof.py (stub for now).
"""

from __future__ import annotations

import asyncio
import math
from typing import TYPE_CHECKING

import structlog

from djinn_miner.api.models import (
    BookmakerAvailability,
    CandidateLine,
    LineResult,
)
from djinn_miner.core.health import HealthTracker
from djinn_miner.data.odds_api import BookmakerOdds, OddsApiClient

if TYPE_CHECKING:
    pass

log = structlog.get_logger()


class LineChecker:
    """Checks candidate lines against live sportsbook odds data."""

    def __init__(
        self,
        odds_client: OddsApiClient,
        line_tolerance: float = 0.5,
        health_tracker: HealthTracker | None = None,
    ) -> None:
        self._odds = odds_client
        self._tolerance = line_tolerance
        self._health = health_tracker

    @property
    def last_query_id(self) -> str | None:
        """The query_id from the most recent odds fetch, for proof requests."""
        return self._odds.last_query_id

    async def check(self, lines: list[CandidateLine]) -> list[LineResult]:
        """Check availability of all candidate lines.

        Groups lines by sport to minimize API calls, then checks each line
        against the fetched odds data.
        """
        sports = {line.sport for line in lines}

        # Fetch odds for all relevant sports concurrently
        odds_by_sport: dict[str, list[BookmakerOdds]] = {}
        fetch_tasks = {sport: self._fetch_sport_odds(sport, lines) for sport in sports}

        results_map = await asyncio.gather(
            *fetch_tasks.values(),
            return_exceptions=True,
        )

        any_success = False
        for sport, result in zip(fetch_tasks.keys(), results_map):
            if isinstance(result, Exception):
                log.error("sport_fetch_failed", sport=sport, error=str(result))
                odds_by_sport[sport] = []
            else:
                odds_by_sport[sport] = result
                if not result:
                    log.warning(
                        "sport_odds_empty",
                        sport=sport,
                        msg="API returned no odds — all lines for this sport will be unavailable",
                    )
                any_success = True

        if self._health:
            if any_success:
                self._health.record_api_success()
            elif sports:  # All fetches failed
                self._health.record_api_failure()

        # Check each line against the odds data
        results: list[LineResult] = []
        for line in lines:
            sport_odds = odds_by_sport.get(line.sport, [])
            result = self._check_single_line(line, sport_odds)
            results.append(result)

        return results

    async def _fetch_sport_odds(
        self,
        sport: str,
        lines: list[CandidateLine],
    ) -> list[BookmakerOdds]:
        """Fetch and parse odds for a single sport."""
        sport_lines = [l for l in lines if l.sport == sport]
        if not sport_lines:
            return []

        # Determine which markets to fetch
        markets_needed = {l.market for l in sport_lines}
        markets_str = ",".join(sorted(markets_needed))

        events = await self._odds.get_odds(sport, markets=markets_str)

        # Parse all events into BookmakerOdds
        all_odds: list[BookmakerOdds] = []
        for line in sport_lines:
            parsed = self._odds.parse_bookmaker_odds(
                events,
                event_id=line.event_id,
                home_team=line.home_team,
                away_team=line.away_team,
            )
            all_odds.extend(parsed)

        return all_odds

    def _check_single_line(
        self,
        line: CandidateLine,
        sport_odds: list[BookmakerOdds],
    ) -> LineResult:
        """Check if a single candidate line is available at any bookmaker."""
        matching_bookmakers: list[BookmakerAvailability] = []
        seen_bookmakers: set[str] = set()

        for odds in sport_odds:
            if odds.bookmaker_key in seen_bookmakers:
                continue

            if self._line_matches(line, odds):
                matching_bookmakers.append(
                    BookmakerAvailability(
                        bookmaker=odds.bookmaker_title,
                        odds=odds.price,
                    )
                )
                seen_bookmakers.add(odds.bookmaker_key)

        return LineResult(
            index=line.index,
            available=len(matching_bookmakers) > 0,
            bookmakers=matching_bookmakers,
        )

    def _line_matches(self, line: CandidateLine, odds: BookmakerOdds) -> bool:
        """Determine if a BookmakerOdds entry matches a CandidateLine.

        Matching rules:
        - Market type must match (spreads, totals, h2h)
        - Side must match (team name or Over/Under)
        - For spreads/totals: line value must be within tolerance
        - For h2h: no line value to check
        """
        if odds.market != line.market:
            return False

        if not self._side_matches(line.side, odds.name):
            return False

        if line.market in ("spreads", "totals"):
            if line.line is None or odds.point is None:
                return False
            if not math.isfinite(line.line) or not math.isfinite(odds.point):
                return False
            if abs(line.line - odds.point) > self._tolerance:
                return False

        return True

    @staticmethod
    def _side_matches(candidate_side: str, odds_name: str) -> bool:
        """Case-insensitive comparison of the side/name."""
        return candidate_side.lower() == odds_name.lower()
