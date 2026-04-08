"""Odds Broadcaster — single-process service that fetches odds and pushes to Redis.

Run ONE instance of this service. It pre-fetches odds for all active sports
every BROADCAST_INTERVAL seconds and pushes updates to Redis. All miners
subscribe to Redis and get near-instant updates with zero API calls.

Usage:
    python -m djinn_miner.data.odds_broadcaster

Environment:
    ODDS_API_KEY         - Required. Your The Odds API key.
    REDIS_URL            - Redis connection URL (default: redis://localhost:6379)
    BROADCAST_INTERVAL   - Seconds between fetches (default: 15)
    ACTIVE_SPORTS        - Comma-separated sports to fetch (default: all supported)
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import time
from typing import Any

import httpx
import redis.asyncio as redis
from datetime import datetime, timedelta, timezone

import structlog

from djinn_miner.data.odds_api import SUPPORTED_SPORTS

log = structlog.get_logger()

# Redis key prefixes
CACHE_PREFIX = "djinn:odds:"
HISTORICAL_PREFIX = "djinn:historical:"
PUBSUB_CHANNEL = "djinn:odds:updates"
HEALTH_KEY = "djinn:odds:broadcaster:health"

# Historical odds config
HISTORICAL_LOOKBACK_HOURS = 36  # How far back to fetch historical data
HISTORICAL_FETCH_INTERVAL = 3600  # Fetch historical every hour (vs 30s for live)


class OddsBroadcaster:
    """Fetches odds from The Odds API and broadcasts to Redis."""

    def __init__(
        self,
        api_key: str,
        redis_url: str = "redis://localhost:6379",
        broadcast_interval: float = 15.0,
        active_sports: list[str] | None = None,
        historical_enabled: bool = True,
    ) -> None:
        self._api_key = api_key
        self._redis_url = redis_url
        self._broadcast_interval = broadcast_interval
        self._active_sports = active_sports or list(SUPPORTED_SPORTS.keys())
        self._historical_enabled = historical_enabled
        self._base_url = "https://api.the-odds-api.com"
        self._http: httpx.AsyncClient | None = None
        self._redis: redis.Redis | None = None
        self._running = False
        self._last_historical_fetch = 0.0
        self._stats = {
            "fetches": 0,
            "historical_fetches": 0,
            "errors": 0,
            "last_fetch": 0.0,
            "api_calls": 0,
        }

    async def start(self) -> None:
        """Initialize connections."""
        self._http = httpx.AsyncClient(timeout=10.0)
        self._redis = redis.from_url(self._redis_url, decode_responses=True)
        
        # Test Redis connection
        await self._redis.ping()
        log.info(
            "broadcaster_started",
            redis_url=self._redis_url.split("@")[-1],  # Hide password
            sports=self._active_sports,
            interval=self._broadcast_interval,
        )

    async def stop(self) -> None:
        """Clean up connections."""
        self._running = False
        if self._http:
            await self._http.aclose()
        if self._redis:
            await self._redis.aclose()
        log.info("broadcaster_stopped", stats=self._stats)

    async def fetch_sport(self, sport: str) -> dict[str, Any] | None:
        """Fetch odds for a single sport."""
        api_sport = SUPPORTED_SPORTS.get(sport, sport)
        url = f"{self._base_url}/v4/sports/{api_sport}/odds"
        params = {
            "apiKey": self._api_key,
            "regions": "us",  # Use single region to reduce API quota (3x savings)
            "markets": "spreads,totals,h2h",
            "oddsFormat": "decimal",
        }

        try:
            resp = await self._http.get(url, params=params)
            self._stats["api_calls"] += 1
            
            if resp.status_code == 200:
                data = resp.json()
                # Log remaining quota from headers
                remaining = resp.headers.get("x-requests-remaining", "?")
                used = resp.headers.get("x-requests-used", "?")
                log.debug(
                    "odds_fetched",
                    sport=sport,
                    events=len(data),
                    api_remaining=remaining,
                    api_used=used,
                )
                return {
                    "sport": sport,
                    "events": data,
                    "fetched_at": time.time(),
                    "query_id": f"{sport}:{int(time.time())}",
                }
            elif resp.status_code == 429:
                log.warning("odds_api_rate_limited", sport=sport)
                return None
            else:
                log.warning(
                    "odds_api_error",
                    sport=sport,
                    status=resp.status_code,
                    body=resp.text[:200],
                )
                return None
        except Exception as e:
            log.error("odds_fetch_error", sport=sport, error=str(e))
            self._stats["errors"] += 1
            return None

    async def fetch_historical_sport(
        self,
        sport: str,
        hours_back: int = 24,
    ) -> list[dict[str, Any]]:
        """Fetch historical odds snapshots for the past N hours.

        Returns a merged list of all events seen in the time range.
        Historical API costs 10x per call, so we sample every 2 hours.
        """
        api_sport = SUPPORTED_SPORTS.get(sport, sport)
        all_events: dict[str, dict[str, Any]] = {}  # Dedupe by event_id

        # Sample at 2-hour intervals to capture game odds over time
        sample_intervals = range(0, hours_back, 2)

        for hours_ago in sample_intervals:
            target_time = datetime.now(timezone.utc) - timedelta(hours=hours_ago)
            date_str = target_time.strftime("%Y-%m-%dT%H:%M:%SZ")

            url = f"{self._base_url}/v4/historical/sports/{api_sport}/odds"
            params = {
                "apiKey": self._api_key,
                "regions": "us",
                "markets": "spreads,totals,h2h",
                "oddsFormat": "decimal",
                "date": date_str,
            }

            try:
                resp = await self._http.get(url, params=params)
                self._stats["api_calls"] += 1

                if resp.status_code == 200:
                    data = resp.json()
                    events = data.get("data", [])
                    timestamp = data.get("timestamp", date_str)

                    log.debug(
                        "historical_fetched",
                        sport=sport,
                        hours_ago=hours_ago,
                        events=len(events),
                        snapshot_ts=timestamp,
                    )

                    # Merge events, keeping the latest odds per event
                    for event in events:
                        event_id = event.get("id")
                        if event_id:
                            all_events[event_id] = event

                elif resp.status_code == 429:
                    log.warning("historical_rate_limited", sport=sport)
                    break
                elif resp.status_code == 422:
                    # Historical not available for this sport/time
                    log.debug("historical_not_available", sport=sport, date=date_str)
                    continue
                else:
                    log.warning(
                        "historical_api_error",
                        sport=sport,
                        status=resp.status_code,
                    )

                # Small delay between historical calls
                await asyncio.sleep(0.2)

            except Exception as e:
                log.error("historical_fetch_error", sport=sport, error=str(e))
                self._stats["errors"] += 1

        return list(all_events.values())

    async def broadcast_cycle(self) -> None:
        """Fetch all sports and push to Redis."""
        start = time.monotonic()
        
        # Fetch all sports concurrently (but stagger to avoid burst)
        tasks = []
        for i, sport in enumerate(self._active_sports):
            # Stagger by 100ms to avoid API burst
            await asyncio.sleep(0.1)
            tasks.append(self.fetch_sport(sport))
        
        results = await asyncio.gather(*tasks)
        
        # Push successful results to Redis
        pipe = self._redis.pipeline()
        published = 0
        
        for result in results:
            if result is None:
                continue
            
            sport = result["sport"]
            cache_key = f"{CACHE_PREFIX}{sport}"
            
            # Store in cache with 60s TTL (long enough to survive missed cycles)
            pipe.setex(cache_key, 60, json.dumps(result))
            published += 1
        
        # Publish update notification
        update_msg = json.dumps({
            "type": "update",
            "sports": [r["sport"] for r in results if r],
            "timestamp": time.time(),
        })
        pipe.publish(PUBSUB_CHANNEL, update_msg)
        
        # Update health key
        pipe.setex(HEALTH_KEY, 30, json.dumps({
            "last_broadcast": time.time(),
            "sports_updated": published,
            "total_api_calls": self._stats["api_calls"],
        }))
        
        await pipe.execute()
        
        elapsed = time.monotonic() - start
        self._stats["fetches"] += 1
        self._stats["last_fetch"] = time.time()
        
        log.info(
            "broadcast_complete",
            sports_updated=published,
            elapsed_ms=round(elapsed * 1000),
            total_api_calls=self._stats["api_calls"],
        )

    async def historical_cycle(self) -> None:
        """Fetch historical odds for all sports and push to Redis.

        Called less frequently than live odds (every hour vs every 30s).
        Historical data helps answer challenges for recently completed games.
        """
        if not self._historical_enabled:
            return

        start = time.monotonic()
        log.info("historical_cycle_start", sports=len(self._active_sports))

        pipe = self._redis.pipeline()
        total_events = 0

        for sport in self._active_sports:
            events = await self.fetch_historical_sport(sport, hours_back=HISTORICAL_LOOKBACK_HOURS)
            if events:
                cache_key = f"{HISTORICAL_PREFIX}{sport}"
                cache_data = {
                    "sport": sport,
                    "events": events,
                    "fetched_at": time.time(),
                    "query_id": f"historical:{sport}:{int(time.time())}",
                }
                # Historical cache TTL = 2 hours (longer than fetch interval)
                pipe.setex(cache_key, 7200, json.dumps(cache_data))
                total_events += len(events)

            # Delay between sports to avoid rate limiting
            await asyncio.sleep(1.0)

        await pipe.execute()

        elapsed = time.monotonic() - start
        self._stats["historical_fetches"] += 1
        self._last_historical_fetch = time.time()

        log.info(
            "historical_cycle_complete",
            total_events=total_events,
            elapsed_s=round(elapsed, 1),
            total_api_calls=self._stats["api_calls"],
        )

    async def run(self) -> None:
        """Main loop — fetch and broadcast on interval."""
        self._running = True
        
        # Initial fetch immediately
        await self.broadcast_cycle()

        # Initial historical fetch
        if self._historical_enabled:
            asyncio.create_task(self._run_historical_loop())
        
        while self._running:
            try:
                await asyncio.sleep(self._broadcast_interval)
                if self._running:
                    await self.broadcast_cycle()
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.error("broadcast_loop_error", error=str(e))
                self._stats["errors"] += 1
                await asyncio.sleep(5)  # Back off on error

    async def _run_historical_loop(self) -> None:
        """Background task for historical data fetching."""
        # Initial historical fetch after a short delay
        await asyncio.sleep(10)
        await self.historical_cycle()

        while self._running:
            try:
                await asyncio.sleep(HISTORICAL_FETCH_INTERVAL)
                if self._running:
                    await self.historical_cycle()
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.error("historical_loop_error", error=str(e))
                await asyncio.sleep(60)


async def main() -> None:
    """Entry point for the broadcaster service."""
    api_key = os.getenv("ODDS_API_KEY")
    if not api_key:
        print("ERROR: ODDS_API_KEY environment variable is required", file=sys.stderr)
        sys.exit(1)

    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
    interval = float(os.getenv("BROADCAST_INTERVAL", "30"))  # 30s default to reduce API quota
    
    active_sports_str = os.getenv("ACTIVE_SPORTS", "")
    active_sports = (
        [s.strip() for s in active_sports_str.split(",") if s.strip()]
        if active_sports_str
        else None
    )

    broadcaster = OddsBroadcaster(
        api_key=api_key,
        redis_url=redis_url,
        broadcast_interval=interval,
        active_sports=active_sports,
    )

    # Handle shutdown signals
    loop = asyncio.get_event_loop()
    
    def handle_signal() -> None:
        log.info("shutdown_signal_received")
        asyncio.create_task(broadcaster.stop())
    
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, handle_signal)

    try:
        await broadcaster.start()
        await broadcaster.run()
    finally:
        await broadcaster.stop()


if __name__ == "__main__":
    asyncio.run(main())
