"""The Odds API integration for real-time sportsbook odds.

Queries api.the-odds-api.com/v4/sports/{sport}/odds to fetch live odds
from multiple bookmakers. Caches responses for a configurable TTL.
Includes a circuit breaker to prevent retry storms during prolonged outages.
"""

from __future__ import annotations

import asyncio
import enum
import math
import random
import time
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx
import structlog

if TYPE_CHECKING:
    from djinn_miner.core.proof import SessionCapture

log = structlog.get_logger()


class CircuitState(enum.Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitBreaker:
    """Simple circuit breaker to protect against prolonged external API outages.

    - CLOSED: normal operation, requests pass through
    - OPEN: requests immediately fail with CircuitOpenError
    - HALF_OPEN: one request allowed through to test recovery
    """

    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
    ) -> None:
        self._failure_threshold = failure_threshold
        self._recovery_timeout = recovery_timeout
        self._state = CircuitState.CLOSED
        self._failures = 0
        self._opened_at: float = 0.0
        self._half_open_in_flight = False

    @property
    def state(self) -> CircuitState:
        if self._state == CircuitState.OPEN:
            if time.monotonic() - self._opened_at >= self._recovery_timeout:
                return CircuitState.HALF_OPEN
        return self._state

    def check(self) -> None:
        """Check if a request is allowed. Raises CircuitOpenError if OPEN."""
        current = self.state
        if current == CircuitState.OPEN:
            raise CircuitOpenError(
                f"Circuit open — {self._recovery_timeout - (time.monotonic() - self._opened_at):.0f}s until retry"
            )
        if current == CircuitState.HALF_OPEN:
            if self._half_open_in_flight:
                raise CircuitOpenError("Circuit half-open — test request in flight")
            self._half_open_in_flight = True

    def _update_gauge(self) -> None:
        """Update Prometheus gauge for circuit breaker state."""
        try:
            from djinn_miner.api.metrics import CIRCUIT_BREAKER_STATE

            CIRCUIT_BREAKER_STATE.labels(target="odds_api").set(
                1 if self._state == CircuitState.OPEN else 0
            )
        except ImportError:
            pass

    def record_success(self) -> None:
        """Record a successful request — reset circuit to CLOSED."""
        self._failures = 0
        self._state = CircuitState.CLOSED
        self._half_open_in_flight = False
        self._update_gauge()

    def record_failure(self) -> None:
        """Record a failed request — trip to OPEN after threshold."""
        self._half_open_in_flight = False
        self._failures += 1
        if self._failures >= self._failure_threshold:
            self._state = CircuitState.OPEN
            self._opened_at = time.monotonic()
            log.warning(
                "circuit_breaker_opened",
                failures=self._failures,
                recovery_timeout_s=self._recovery_timeout,
            )
        self._update_gauge()

    def reset(self) -> None:
        """Reset the circuit breaker to initial state."""
        self._state = CircuitState.CLOSED
        self._failures = 0
        self._half_open_in_flight = False


class CircuitOpenError(Exception):
    """Raised when the circuit breaker is open and rejecting requests."""


# Supported sports mapped to The Odds API sport keys
SUPPORTED_SPORTS: dict[str, str] = {
    "basketball_nba": "basketball_nba",
    "football_nfl": "americanfootball_nfl",
    "football_ncaaf": "americanfootball_ncaaf",
    "basketball_ncaab": "basketball_ncaab",
    "baseball_mlb": "baseball_mlb",
    "hockey_nhl": "icehockey_nhl",
    "soccer_epl": "soccer_epl",
    "mma_ufc": "mma_mixed_martial_arts",
}


@dataclass
class CachedOdds:
    """A cached odds response with its expiry time."""

    data: list[dict[str, Any]]
    expires_at: float


@dataclass
class CachedError:
    """A cached error response — re-raised on cache hit to prevent retry storms."""

    error: Exception
    expires_at: float


@dataclass
class BookmakerOdds:
    """Parsed odds from a single bookmaker for a single outcome."""

    bookmaker_key: str
    bookmaker_title: str
    market: str  # "spreads", "totals", "h2h"
    name: str  # Team name or "Over"/"Under"
    price: float  # Decimal odds
    point: float | None = None  # Spread or total line value


class OddsApiClient:
    """Async client for The Odds API with response caching and retry."""

    MAX_RETRIES = 3
    RETRY_BASE_DELAY = 0.5  # seconds
    RETRY_MAX_DELAY = 8.0  # seconds
    MAX_CACHE_ENTRIES = 100
    ERROR_CACHE_TTL = 10  # seconds — short TTL for failed responses

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.the-odds-api.com",
        cache_ttl: int = 30,
        http_client: httpx.AsyncClient | None = None,
        session_capture: SessionCapture | None = None,
        max_retries: int = MAX_RETRIES,
        circuit_failure_threshold: int = 5,
        circuit_recovery_timeout: float = 60.0,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._cache_ttl = cache_ttl
        self._cache: dict[str, CachedOdds] = {}
        self._error_cache: dict[str, CachedError] = {}
        self._cache_lock = asyncio.Lock()
        self._client = http_client or httpx.AsyncClient(timeout=10.0)
        self._owns_client = http_client is None
        self._session_capture = session_capture
        self._max_retries = max_retries
        self._circuit = CircuitBreaker(
            failure_threshold=circuit_failure_threshold,
            recovery_timeout=circuit_recovery_timeout,
        )
        self._last_query_id: str | None = None

    @property
    def last_query_id(self) -> str | None:
        """The query_id from the most recent successful get_odds() call."""
        return self._last_query_id

    async def close(self) -> None:
        """Close the HTTP client if we own it."""
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> "OddsApiClient":
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    def _evict_stale_cache(self) -> None:
        """Remove expired entries and enforce max cache size."""
        now = time.monotonic()
        stale = [k for k, v in self._cache.items() if v.expires_at <= now]
        for k in stale:
            del self._cache[k]
        stale_errors = [k for k, v in self._error_cache.items() if v.expires_at <= now]
        for k in stale_errors:
            del self._error_cache[k]
        if len(self._cache) > self.MAX_CACHE_ENTRIES:
            oldest = sorted(self._cache, key=lambda k: self._cache[k].expires_at)
            for k in oldest[: len(self._cache) - self.MAX_CACHE_ENTRIES]:
                del self._cache[k]

    async def _request_with_retry(
        self,
        url: str,
        params: dict[str, str],
        sport: str,
    ) -> httpx.Response:
        """Execute an HTTP GET with exponential backoff retry and circuit breaker.

        Retries on network errors and 5xx responses. Does NOT retry 4xx
        (client errors like 401/429 won't fix themselves).
        Circuit breaker trips after repeated failures to prevent retry storms.
        """
        self._circuit.check()  # Raises CircuitOpenError if circuit is open

        last_exc: Exception | None = None
        for attempt in range(self._max_retries + 1):
            try:
                resp = await self._client.get(url, params=params)
                if resp.status_code < 500:
                    resp.raise_for_status()
                    self._circuit.record_success()
                    return resp
                # 5xx: retry
                log.warning(
                    "odds_api_server_error",
                    status=resp.status_code,
                    sport=sport,
                    attempt=attempt + 1,
                )
                last_exc = httpx.HTTPStatusError(
                    f"Server error {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            except httpx.HTTPStatusError:
                self._circuit.record_failure()
                raise  # 4xx — don't retry
            except httpx.RequestError as e:
                log.warning(
                    "odds_api_request_error",
                    error=str(e),
                    sport=sport,
                    attempt=attempt + 1,
                )
                last_exc = e

            if attempt < self._max_retries:
                delay = min(
                    self.RETRY_BASE_DELAY * (2**attempt) + random.uniform(0, 0.5),
                    self.RETRY_MAX_DELAY,
                )
                await asyncio.sleep(delay)

        self._circuit.record_failure()
        log.error(
            "odds_api_retries_exhausted",
            sport=sport,
            url=url,
            attempts=self._max_retries + 1,
            last_error=str(last_exc),
            circuit_state=self._circuit.state.value,
        )
        if last_exc is None:
            raise httpx.RequestError(f"All {self._max_retries + 1} retries exhausted for {url}")
        raise last_exc

    def _resolve_sport_key(self, sport: str) -> str:
        """Map an internal sport key to The Odds API sport key."""
        return SUPPORTED_SPORTS.get(sport, sport)

    async def get_odds(
        self,
        sport: str,
        markets: str = "spreads,totals,h2h",
    ) -> list[dict[str, Any]]:
        """Fetch live odds for a sport from The Odds API.

        Returns raw event data from the API, using cache when available.
        Uses an asyncio lock to prevent duplicate API calls on cache miss.
        """
        api_sport = self._resolve_sport_key(sport)
        cache_key = f"{api_sport}:{markets}"

        from djinn_miner.api.metrics import CACHE_OPERATIONS

        now = time.monotonic()

        # Fast path: check cache without lock
        cached = self._cache.get(cache_key)
        if cached and cached.expires_at > now:
            CACHE_OPERATIONS.labels(result="hit").inc()
            log.debug("odds_cache_hit", sport=api_sport)
            return cached.data

        # Fast path: check error cache — re-raise to avoid retry storms
        cached_err = self._error_cache.get(cache_key)
        if cached_err and cached_err.expires_at > now:
            CACHE_OPERATIONS.labels(result="hit").inc()
            log.debug("odds_error_cache_hit", sport=api_sport)
            raise cached_err.error

        async with self._cache_lock:
            now = time.monotonic()
            # Re-check under lock (another coroutine may have populated it)
            cached = self._cache.get(cache_key)
            if cached and cached.expires_at > now:
                CACHE_OPERATIONS.labels(result="hit").inc()
                log.debug("odds_cache_hit", sport=api_sport)
                return cached.data
            cached_err = self._error_cache.get(cache_key)
            if cached_err and cached_err.expires_at > now:
                CACHE_OPERATIONS.labels(result="hit").inc()
                raise cached_err.error
            CACHE_OPERATIONS.labels(result="miss").inc()

            url = f"{self._base_url}/v4/sports/{api_sport}/odds"
            params = {
                "apiKey": self._api_key,
                "regions": "us",
                "markets": markets,
                "oddsFormat": "decimal",
            }

            from djinn_miner.api.metrics import ODDS_API_QUERIES

            try:
                resp = await self._request_with_retry(url, params, api_sport)
                ODDS_API_QUERIES.labels(status="success").inc()
            except Exception as exc:
                ODDS_API_QUERIES.labels(status="error").inc()
                self._evict_stale_cache()
                self._error_cache[cache_key] = CachedError(
                    error=exc,
                    expires_at=time.monotonic() + self.ERROR_CACHE_TTL,
                )
                raise
            try:
                data = resp.json()
            except Exception as exc:
                log.error("odds_api_json_decode_error", sport=api_sport, error=str(exc))
                self._evict_stale_cache()
                self._error_cache[cache_key] = CachedError(
                    error=exc,
                    expires_at=time.monotonic() + self.ERROR_CACHE_TTL,
                )
                raise

            # Capture the raw HTTP session for proof generation
            query_id = f"{api_sport}:{markets}:{uuid.uuid4().hex[:8]}"
            self._last_query_id = query_id
            if self._session_capture is not None:
                from djinn_miner.core.proof import CapturedSession

                safe_url = url  # params are separate, URL itself has no key
                self._session_capture.record(
                    CapturedSession(
                        query_id=query_id,
                        request_url=safe_url,
                        request_params={k: v for k, v in params.items() if k != "apiKey"},
                        response_status=resp.status_code,
                        response_body=resp.content,
                        response_headers=dict(resp.headers),
                    )
                )

            self._evict_stale_cache()
            self._cache[cache_key] = CachedOdds(
                data=data,
                expires_at=time.monotonic() + self._cache_ttl,
            )

            log.info("odds_fetched", sport=api_sport, events=len(data))
            return data

    def parse_bookmaker_odds(
        self,
        events: list[dict[str, Any]],
        event_id: str | None = None,
        home_team: str | None = None,
        away_team: str | None = None,
    ) -> list[BookmakerOdds]:
        """Parse raw API events into structured BookmakerOdds.

        Filters to a specific event if event_id or team names are provided.
        """
        results: list[BookmakerOdds] = []

        for event in events:
            if not isinstance(event, dict):
                continue
            if event_id and event.get("id") != event_id:
                # Also try matching by teams if event_id doesn't match
                if not self._teams_match(event, home_team, away_team):
                    continue
            elif home_team and away_team:
                if not self._teams_match(event, home_team, away_team):
                    continue

            for bookmaker in event.get("bookmakers", []):
                if not isinstance(bookmaker, dict):
                    continue
                bk_key = bookmaker.get("key", "")
                bk_title = bookmaker.get("title", bk_key)

                for market in bookmaker.get("markets", []):
                    if not isinstance(market, dict):
                        continue
                    market_key = market.get("key", "")
                    for outcome in market.get("outcomes", []):
                        if not isinstance(outcome, dict):
                            continue
                        try:
                            price = float(outcome.get("price", 0))
                        except (ValueError, TypeError):
                            log.debug(
                                "invalid_odds_price",
                                bookmaker=bk_key,
                                raw_price=outcome.get("price"),
                            )
                            price = 0.0
                        if not math.isfinite(price):
                            price = 0.0
                        raw_point = outcome.get("point")
                        point: float | None = None
                        if raw_point is not None:
                            try:
                                point = float(raw_point)
                                if not math.isfinite(point):
                                    point = None
                            except (ValueError, TypeError):
                                point = None
                        results.append(
                            BookmakerOdds(
                                bookmaker_key=bk_key,
                                bookmaker_title=bk_title,
                                market=market_key,
                                name=outcome.get("name", ""),
                                price=price,
                                point=point,
                            )
                        )

        return results

    @staticmethod
    def _teams_match(
        event: dict[str, Any],
        home_team: str | None,
        away_team: str | None,
    ) -> bool:
        """Check if an event matches the given team names (case-insensitive)."""
        if not home_team or not away_team:
            return False
        ev_home = (event.get("home_team") or "").lower()
        ev_away = (event.get("away_team") or "").lower()
        return ev_home == home_team.lower() and ev_away == away_team.lower()

    def clear_cache(self) -> None:
        """Clear all cached data."""
        self._cache.clear()
        self._error_cache.clear()
