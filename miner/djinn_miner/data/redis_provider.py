"""Redis-backed Odds Provider — consumes data from the broadcaster service.

This provider is designed for multi-miner setups where a single OddsBroadcaster
fetches data and all miners consume from Redis. Provides:

1. L1 in-memory cache (sub-millisecond reads)
2. L2 Redis cache (shared across all miners)
3. Pub/Sub subscription for instant updates (no polling delay)
4. Optional fallback to direct API if Redis is unavailable

Usage:
    Set SPORTS_DATA_PROVIDER=djinn_miner.data.redis_provider.RedisOddsProvider

Environment:
    REDIS_URL          - Redis connection URL (default: redis://localhost:6379)
    ODDS_L1_TTL        - Local cache TTL in seconds (default: 5)
    ODDS_FALLBACK_API  - If "true", fall back to direct API when Redis fails
    ODDS_API_KEY       - Required only if ODDS_FALLBACK_API=true
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass
from threading import Lock
from typing import Any

import redis.asyncio as redis
import structlog

from djinn_miner.data.provider import BookmakerOdds, SportsDataProvider

log = structlog.get_logger()

# Must match broadcaster keys
CACHE_PREFIX = "djinn:odds:"
HISTORICAL_PREFIX = "djinn:historical:"
PUBSUB_CHANNEL = "djinn:odds:updates"

# Reverse mapping: The Odds API sport keys -> internal broadcaster keys
# Broadcaster stores using internal names, validators query with API names
API_TO_INTERNAL_SPORT: dict[str, str] = {
    "americanfootball_nfl": "football_nfl",
    "americanfootball_ncaaf": "football_ncaaf",
    "icehockey_nhl": "hockey_nhl",
    "mma_mixed_martial_arts": "mma_ufc",
    # These are the same in both
    "basketball_nba": "basketball_nba",
    "basketball_ncaab": "basketball_ncaab",
    "baseball_mlb": "baseball_mlb",
    "soccer_epl": "soccer_epl",
}


@dataclass
class L1CacheEntry:
    """Local in-memory cache entry."""
    data: dict[str, Any]
    expires_at: float


class RedisOddsProvider:
    """Odds provider that reads from Redis broadcaster cache.
    
    Implements the SportsDataProvider protocol for seamless integration.
    Uses a two-level cache:
      L1: In-memory dict (per-process, ~0.01ms)
      L2: Redis (shared, ~1-2ms)
    
    The pub/sub listener proactively refreshes L1 cache when updates arrive,
    so most reads hit warm L1 cache with zero latency penalty.
    """

    def __init__(
        self,
        config: Any = None,
        session_capture: Any = None,  # Required by protocol but unused
        redis_url: str | None = None,
        l1_ttl: float = 5.0,
        fallback_to_api: bool = False,
        api_key: str | None = None,
    ) -> None:
        self._redis_url = redis_url or os.getenv("REDIS_URL", "redis://localhost:6379")
        self._l1_ttl = l1_ttl if l1_ttl else float(os.getenv("ODDS_L1_TTL", "5"))
        self._fallback_to_api = fallback_to_api or os.getenv("ODDS_FALLBACK_API", "").lower() == "true"
        self._api_key = api_key or os.getenv("ODDS_API_KEY", "")
        
        # L1 cache (thread-safe for sync access from health checks)
        self._l1_cache: dict[str, L1CacheEntry] = {}
        self._l1_lock = Lock()
        
        # Redis connections (created lazily)
        self._redis: redis.Redis | None = None
        self._pubsub: redis.client.PubSub | None = None
        self._pubsub_task: asyncio.Task | None = None
        
        # Fallback API client
        self._fallback_client: Any = None
        
        # Query tracking
        self._last_query_id: str | None = None
        
        # Stats
        self._stats = {
            "l1_hits": 0,
            "l2_hits": 0,
            "l2_misses": 0,
            "historical_hits": 0,
            "fallback_calls": 0,
            "pubsub_updates": 0,
        }

    @property
    def last_query_id(self) -> str | None:
        return self._last_query_id

    async def _ensure_redis(self) -> redis.Redis:
        """Lazily connect to Redis."""
        if self._redis is None:
            self._redis = redis.from_url(self._redis_url, decode_responses=True)
            # Start pub/sub listener in background
            self._pubsub_task = asyncio.create_task(self._pubsub_listener())
            log.info("redis_provider_connected", redis_url=self._redis_url.split("@")[-1])
        return self._redis

    async def _pubsub_listener(self) -> None:
        """Background task: listen for updates and refresh L1 cache."""
        try:
            r = await self._ensure_redis()
            self._pubsub = r.pubsub()
            await self._pubsub.subscribe(PUBSUB_CHANNEL)
            
            async for message in self._pubsub.listen():
                if message["type"] != "message":
                    continue
                try:
                    data = json.loads(message["data"])
                    if data.get("type") == "update":
                        # Pre-fetch updated sports into L1
                        for sport in data.get("sports", []):
                            await self._refresh_l1(sport)
                        self._stats["pubsub_updates"] += 1
                except Exception as e:
                    log.debug("pubsub_parse_error", error=str(e))
        except asyncio.CancelledError:
            pass
        except Exception as e:
            log.warning("pubsub_listener_error", error=str(e))

    async def _refresh_l1(self, sport: str) -> dict[str, Any] | None:
        """Fetch from Redis and populate L1 cache."""
        try:
            r = await self._ensure_redis()
            cache_key = f"{CACHE_PREFIX}{sport}"
            raw = await r.get(cache_key)
            
            if raw:
                data = json.loads(raw)
                with self._l1_lock:
                    self._l1_cache[sport] = L1CacheEntry(
                        data=data,
                        expires_at=time.monotonic() + self._l1_ttl,
                    )
                return data
        except Exception as e:
            log.debug("l1_refresh_error", sport=sport, error=str(e))
        return None

    def _get_l1(self, sport: str) -> dict[str, Any] | None:
        """Check L1 cache (synchronous, lock-free read path)."""
        with self._l1_lock:
            entry = self._l1_cache.get(sport)
            if entry and entry.expires_at > time.monotonic():
                return entry.data
        return None

    async def _fallback_api(self, sport: str, markets: str) -> list[dict[str, Any]]:
        """Fall back to direct API call when Redis is unavailable."""
        if not self._fallback_to_api or not self._api_key:
            raise RuntimeError("Redis unavailable and fallback disabled")

        if self._fallback_client is None:
            from djinn_miner.data.odds_api import OddsApiClient
            self._fallback_client = OddsApiClient(
                api_key=self._api_key,
                cache_ttl=30,
            )
            log.warning("redis_unavailable_using_fallback_api")

        self._stats["fallback_calls"] += 1
        return await self._fallback_client.get_odds(sport, markets)

    async def get_odds(
        self,
        sport: str,
        markets: str = "spreads,totals,h2h",
    ) -> list[dict[str, Any]]:
        """Fetch odds — L1 -> L2 (Redis) -> historical -> fallback API.
        
        In steady state with pub/sub working, most calls hit L1 cache
        and return in <0.1ms. Redis round-trip is ~1-2ms backup.
        
        Also checks historical cache for recently completed games that
        validators may challenge on.
        """
        # Translate API sport key to internal broadcaster key
        # e.g., "icehockey_nhl" -> "hockey_nhl"
        internal_sport = API_TO_INTERNAL_SPORT.get(sport, sport)
        
        live_events: list[dict[str, Any]] = []
        historical_events: list[dict[str, Any]] = []
        
        # L1 check (fast path)
        l1_data = self._get_l1(internal_sport)
        if l1_data:
            self._stats["l1_hits"] += 1
            self._last_query_id = l1_data.get("query_id")
            live_events = l1_data.get("events", [])
        else:
            # L2 check (Redis)
            try:
                data = await self._refresh_l1(internal_sport)
                if data:
                    self._stats["l2_hits"] += 1
                    self._last_query_id = data.get("query_id")
                    live_events = data.get("events", [])
            except Exception as e:
                log.warning("redis_read_error", sport=internal_sport, error=str(e))

        # Also fetch historical data to cover recently completed games
        try:
            historical_data = await self._get_historical(internal_sport)
            if historical_data:
                historical_events = historical_data.get("events", [])
        except Exception as e:
            log.debug("historical_read_error", sport=internal_sport, error=str(e))

        # Merge live and historical, preferring live data for duplicates
        merged = self._merge_events(live_events, historical_events)

        if not merged:
            self._stats["l2_misses"] += 1
            # Fallback to direct API if configured
            if self._fallback_to_api:
                return await self._fallback_api(sport, markets)
            log.warning("odds_cache_miss", sport=sport, msg="No data in Redis, fallback disabled")
        
        return merged

    async def _get_historical(self, sport: str) -> dict[str, Any] | None:
        """Fetch historical odds from Redis cache."""
        try:
            r = await self._ensure_redis()
            cache_key = f"{HISTORICAL_PREFIX}{sport}"
            raw = await r.get(cache_key)
            if raw:
                self._stats["historical_hits"] += 1
                return json.loads(raw)
        except Exception:
            pass
        return None

    @staticmethod
    def _merge_events(
        live: list[dict[str, Any]],
        historical: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Merge live and historical events, preferring live data for duplicates."""
        seen_ids: set[str] = set()
        merged: list[dict[str, Any]] = []

        # Add all live events first (they have fresher odds)
        for event in live:
            event_id = event.get("id")
            if event_id:
                seen_ids.add(event_id)
            merged.append(event)

        # Add historical events not already in live
        for event in historical:
            event_id = event.get("id")
            if event_id and event_id not in seen_ids:
                merged.append(event)
                seen_ids.add(event_id)

        return merged

    def parse_bookmaker_odds(
        self,
        events: list[dict[str, Any]],
        event_id: str | None = None,
        home_team: str | None = None,
        away_team: str | None = None,
    ) -> list[BookmakerOdds]:
        """Parse raw event data into structured BookmakerOdds.
        
        Matches OddsApiClient logic: if event_id doesn't match, falls back
        to team name matching. This is critical because validators use ESPN
        event IDs which differ from Odds API IDs.
        """
        results: list[BookmakerOdds] = []

        for event in events:
            # Filter by event_id if specified, with fallback to team matching
            if event_id and event.get("id") != event_id:
                # Also try matching by teams if event_id doesn't match
                if not self._teams_match(event, home_team, away_team):
                    continue
            elif home_team and away_team:
                if not self._teams_match(event, home_team, away_team):
                    continue

            for bookmaker in event.get("bookmakers", []):
                bk_key = bookmaker.get("key", "")
                bk_title = bookmaker.get("title", "")

                for market in bookmaker.get("markets", []):
                    market_key = market.get("key", "")

                    for outcome in market.get("outcomes", []):
                        results.append(
                            BookmakerOdds(
                                bookmaker_key=bk_key,
                                bookmaker_title=bk_title,
                                market=market_key,
                                name=outcome.get("name", ""),
                                price=outcome.get("price", 0.0),
                                point=outcome.get("point"),
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

    async def close(self) -> None:
        """Clean up connections."""
        if self._pubsub_task:
            self._pubsub_task.cancel()
            try:
                await self._pubsub_task
            except asyncio.CancelledError:
                pass
        if self._pubsub:
            await self._pubsub.close()
        if self._redis:
            await self._redis.aclose()
        if self._fallback_client:
            await self._fallback_client.close()
        
        log.info("redis_provider_closed", stats=self._stats)

    def get_stats(self) -> dict[str, int]:
        """Return cache statistics for debugging."""
        return dict(self._stats)
