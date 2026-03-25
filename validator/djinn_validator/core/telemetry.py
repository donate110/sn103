"""SQLite-backed telemetry store for persistent event logging.

Provides append-only event storage that survives restarts. Events are
structured as (timestamp, category, summary, details_json) and queryable
by time range, category, and limit.

Usage:
    store = TelemetryStore("telemetry.db")
    store.record("challenge_received", "Got /v1/check with 10 lines", sport="nfl")
    events = store.query(limit=100, category="challenge_received")
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

import structlog

logger = structlog.get_logger()


class TelemetryStore:
    """Thread-safe, SQLite-backed event store."""

    _PRUNE_THRESHOLD = 10_000
    _PRUNE_AGE_SECONDS = 30 * 24 * 3600  # 30 days
    _PRUNE_CHECK_INTERVAL = 100  # check every N inserts

    def __init__(self, db_path: str | Path = "telemetry.db") -> None:
        self._db_path = str(db_path)
        self._local = threading.local()
        self._insert_count = 0
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn") or self._local.conn is None:
            self._local.conn = sqlite3.connect(self._db_path)
            self._local.conn.execute("PRAGMA journal_mode=WAL")
            self._local.conn.execute("PRAGMA synchronous=NORMAL")
        return self._local.conn

    def _init_db(self) -> None:
        conn = self._get_conn()
        conn.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                category TEXT NOT NULL,
                summary TEXT NOT NULL,
                details TEXT NOT NULL DEFAULT '{}'
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_events_ts ON events (timestamp)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_events_cat ON events (category)
        """)
        # Per-miner weight history for fast lookups (avoids scanning all
        # miners in every weight_set event when querying one miner).
        conn.execute("""
            CREATE TABLE IF NOT EXISTS miner_weights (
                uid INTEGER NOT NULL,
                timestamp REAL NOT NULL,
                weight REAL NOT NULL,
                accuracy REAL,
                speed REAL,
                coverage REAL,
                uptime REAL,
                sports_score REAL,
                attestation_score REAL,
                PRIMARY KEY (uid, timestamp)
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_mw_ts ON miner_weights (timestamp)
        """)
        conn.commit()

    def record(self, category: str, summary: str, **details: Any) -> None:
        """Append an event. Safe to call from any thread."""
        ts = time.time()
        details_json = json.dumps(details, default=str)
        try:
            conn = self._get_conn()
            conn.execute(
                "INSERT INTO events (timestamp, category, summary, details) VALUES (?, ?, ?, ?)",
                (ts, category, summary, details_json),
            )
            conn.commit()
            self._maybe_prune(conn)
        except Exception as e:
            logger.warning("telemetry record failed", error=str(e))

    def _maybe_prune(self, conn: sqlite3.Connection) -> None:
        """Lazy pruning: delete rows >30d when count >10k. Runs every N inserts."""
        self._insert_count += 1
        if self._insert_count % self._PRUNE_CHECK_INTERVAL != 0:
            return
        try:
            row = conn.execute("SELECT COUNT(*) FROM events").fetchone()
            if row and row[0] > self._PRUNE_THRESHOLD:
                cutoff = time.time() - self._PRUNE_AGE_SECONDS
                conn.execute("DELETE FROM events WHERE timestamp < ?", (cutoff,))
                conn.execute("DELETE FROM miner_weights WHERE timestamp < ?", (cutoff,))
                conn.commit()
        except Exception:
            pass

    def query(
        self,
        limit: int = 200,
        since: float | None = None,
        category: str | None = None,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Return events newest-first, with optional filters."""
        conn = self._get_conn()
        conditions: list[str] = []
        params: list[Any] = []

        if since is not None:
            conditions.append("timestamp >= ?")
            params.append(since)
        if category:
            conditions.append("category = ?")
            params.append(category)

        where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
        params.extend([max(1, min(limit, 1000)), max(0, offset)])

        rows = conn.execute(
            f"SELECT id, timestamp, category, summary, details FROM events{where} ORDER BY timestamp DESC LIMIT ? OFFSET ?",
            params,
        ).fetchall()

        return [
            {
                "id": row[0],
                "timestamp": row[1],
                "category": row[2],
                "summary": row[3],
                "details": json.loads(row[4]),
            }
            for row in rows
        ]

    def timeseries(
        self,
        categories: list[str],
        since: float | None = None,
        bucket_seconds: int = 3600,
    ) -> dict[str, list[dict]]:
        """Return event counts bucketed by time period, grouped by category.

        Args:
            categories: List of event categories to include.
            since: Unix timestamp to start from. Defaults to 7 days ago.
            bucket_seconds: Bucket width in seconds. Default 1 hour.

        Returns:
            Dict mapping category -> list of {t, count, details} buckets.
        """
        if since is None:
            since = time.time() - 7 * 24 * 3600
        conn = self._get_conn()
        placeholders = ",".join("?" for _ in categories)
        rows = conn.execute(
            f"""
            SELECT
                CAST(timestamp / ? AS INTEGER) * ? AS bucket,
                category,
                COUNT(*) AS cnt,
                GROUP_CONCAT(details, '|||') AS all_details
            FROM events
            WHERE timestamp >= ? AND category IN ({placeholders})
            GROUP BY bucket, category
            ORDER BY bucket
            """,
            [bucket_seconds, bucket_seconds, since, *categories],
        ).fetchall()

        result: dict[str, list[dict]] = {c: [] for c in categories}
        for r in rows:
            bucket_t, cat, cnt, raw_details = r[0], r[1], r[2], r[3]
            # Parse concatenated JSON details to extract numeric aggregates
            parsed = []
            if raw_details:
                for chunk in raw_details.split("|||"):
                    try:
                        parsed.append(json.loads(chunk))
                    except (json.JSONDecodeError, ValueError):
                        pass
            result.setdefault(cat, []).append({
                "t": int(bucket_t),
                "count": cnt,
                "details": parsed,
            })
        return result

    def record_miner_weights(self, miners: list[dict[str, Any]]) -> None:
        """Batch-insert per-miner weight records for fast history lookups.

        Called alongside the weight_set event so per-miner data is
        queryable without scanning the full event JSON.
        """
        if not miners:
            return
        ts = time.time()
        try:
            conn = self._get_conn()
            conn.executemany(
                """INSERT OR REPLACE INTO miner_weights
                   (uid, timestamp, weight, accuracy, speed, coverage,
                    uptime, sports_score, attestation_score)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [
                    (
                        m.get("uid", 0),
                        ts,
                        m.get("weight", 0),
                        m.get("accuracy"),
                        m.get("speed"),
                        m.get("coverage"),
                        m.get("uptime"),
                        m.get("sports_score"),
                        m.get("attestation_score"),
                    )
                    for m in miners
                ],
            )
            conn.commit()
        except Exception:
            pass

    def miner_history(
        self, uid: int, since: float, limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Return weight history for a single miner, oldest first.

        Uses the indexed miner_weights table instead of scanning
        weight_set events.
        """
        conn = self._get_conn()
        rows = conn.execute(
            """SELECT timestamp, weight, accuracy, speed, coverage,
                      uptime, sports_score, attestation_score
               FROM miner_weights
               WHERE uid = ? AND timestamp >= ?
               ORDER BY timestamp
               LIMIT ?""",
            (uid, since, max(1, min(limit, 2000))),
        ).fetchall()
        return [
            {
                "t": row[0],
                "weight": row[1],
                "accuracy": row[2],
                "speed": row[3],
                "coverage": row[4],
                "uptime": row[5],
                "sports_score": row[6],
                "attestation_score": row[7],
            }
            for row in rows
        ]

    def count(self, category: str | None = None) -> int:
        conn = self._get_conn()
        if category:
            row = conn.execute("SELECT COUNT(*) FROM events WHERE category = ?", (category,)).fetchone()
        else:
            row = conn.execute("SELECT COUNT(*) FROM events").fetchone()
        return row[0] if row else 0
