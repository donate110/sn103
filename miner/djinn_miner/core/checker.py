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
from dataclasses import dataclass
from datetime import datetime, timezone
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


@dataclass
class CheckResult:
    """Result bundle from a check operation: line results plus any API-level error."""

    results: list[LineResult]
    api_error: str | None = None


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

    async def check(self, lines: list[CandidateLine]) -> CheckResult:
        """Check availability of all candidate lines.

        Groups lines by sport to minimize API calls, then checks each line
        against the fetched odds data. Returns a CheckResult that includes
        both per-line results and any upstream API error encountered.
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
        api_errors: list[str] = []
        for sport, result in zip(fetch_tasks.keys(), results_map):
            if isinstance(result, Exception):
                log.error("sport_fetch_failed", sport=sport, error=str(result))
                odds_by_sport[sport] = []
                api_errors.append(self._describe_api_error(result))
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

        # Surface a single api_error string when ALL fetches failed (upstream is broken)
        api_error: str | None = None
        if api_errors and not any_success:
            # Deduplicate and join
            unique_errors = list(dict.fromkeys(api_errors))
            api_error = "; ".join(unique_errors)

        return CheckResult(results=results, api_error=api_error)

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

        try:
            events = await self._odds.get_odds(sport, markets=markets_str)
        except Exception:
            # Some markets (e.g. player_prop) aren't available for every
            # sport. If the full set fails, retry with core markets only.
            core = markets_needed & {"h2h", "spreads", "totals"}
            if core and core != markets_needed:
                events = await self._odds.get_odds(
                    sport, markets=",".join(sorted(core)),
                )
            else:
                raise

        # Filter out events where the game has already started.
        # This prevents geniuses from creating signals with expired lines.
        now = datetime.now(timezone.utc)
        filtered_events = []
        for ev in events:
            ct = ev.get("commence_time")
            if ct:
                try:
                    game_start = datetime.fromisoformat(ct.replace("Z", "+00:00"))
                    if game_start <= now:
                        continue  # Game already started — skip
                except (ValueError, TypeError):
                    pass
            filtered_events.append(ev)
        events = filtered_events

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
        # Track match failure reasons for diagnostics
        found_event = False
        found_market = False
        found_side = False
        closest_line: float | None = None

        for odds in sport_odds:
            # Track how far we got matching this line
            found_event = True  # We have odds data for this sport/event
            if odds.market == line.market:
                found_market = True
                if self._side_matches(line.side, odds.name):
                    found_side = True
                    # Track closest line value for "line_moved" diagnostics
                    if line.market in ("spreads", "totals") and odds.point is not None:
                        if closest_line is None or (
                            line.line is not None
                            and abs(odds.point - line.line) < abs(closest_line - line.line)
                        ):
                            closest_line = odds.point

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

        # Determine specific reason when unavailable
        reason: str | None = None
        if not matching_bookmakers:
            if not found_event:
                reason = "game_started"  # No odds at all; game likely started or was removed
            elif not found_market:
                reason = "market_unavailable"
            elif not found_side:
                reason = "market_unavailable"
            elif found_side and closest_line is not None and line.line is not None and closest_line != line.line:
                reason = "line_moved"
            else:
                reason = "no_data"

        return LineResult(
            index=line.index,
            available=len(matching_bookmakers) > 0,
            bookmakers=matching_bookmakers,
            unavailable_reason=reason,
        )

    def _line_matches(self, line: CandidateLine, odds: BookmakerOdds) -> bool:
        """Determine if a BookmakerOdds entry matches a CandidateLine.

        Matching rules:
        - Market type must match (spreads, totals, h2h)
        - Side must match (team name or Over/Under)
        - For spreads/totals: line value must match exactly
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
            if line.line != odds.point:
                return False

        return True

    @staticmethod
    def _describe_api_error(exc: Exception) -> str:
        """Extract a human-readable error description from an upstream API exception."""
        import httpx

        from djinn_miner.data.odds_api import CircuitOpenError

        if isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
            reason = exc.response.reason_phrase or "Unknown"
            return f"Odds API returned {status} {reason}"
        if isinstance(exc, CircuitOpenError):
            return f"Odds API circuit breaker open: {exc}"
        if isinstance(exc, httpx.RequestError):
            return f"Odds API request failed: {exc}"
        return f"Odds API error: {exc}"

    @staticmethod
    def _side_matches(candidate_side: str, odds_name: str) -> bool:
        """Case-insensitive comparison of the side/name."""
        return candidate_side.lower() == odds_name.lower()
