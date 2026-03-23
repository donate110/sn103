"""SQLite log for attestation requests.

Tracks every attestation request dispatched to miners — URL, which miner
handled it, latency, success/failure, and proof verification status.
Used by the admin dashboard to monitor attestation health.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

import structlog

log = structlog.get_logger()


class AttestationLog:
    """SQLite-backed attestation request log for admin monitoring.

    Follows the same pattern as ShareStore for SQLite lifecycle management.
    """

    _PRUNE_THRESHOLD = 10_000
    _PRUNE_AGE_SECONDS = 30 * 24 * 3600  # 30 days
    _PRUNE_CHECK_INTERVAL = 100  # check every N inserts

    def __init__(self, db_path: str | Path | None = None) -> None:
        self._lock = threading.Lock()
        self._insert_count = 0
        if db_path is not None:
            path = Path(db_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(str(path), check_same_thread=False)
        else:
            self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._create_tables()

    def _create_tables(self) -> None:
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS attestation_log (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                url           TEXT NOT NULL,
                request_id    TEXT NOT NULL,
                success       INTEGER NOT NULL DEFAULT 0,
                verified      INTEGER NOT NULL DEFAULT 0,
                server_name   TEXT,
                miner_uid     INTEGER,
                notary_uid    INTEGER,
                elapsed_s     REAL,
                error         TEXT,
                created_at    INTEGER NOT NULL
            )
        """)
        # Migration: add notary_uid column if upgrading from older schema
        try:
            self._conn.execute("ALTER TABLE attestation_log ADD COLUMN notary_uid INTEGER")
        except sqlite3.OperationalError:
            pass  # Column already exists
        # Index for efficient per-miner failure streak queries
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_attestation_miner_time "
            "ON attestation_log (miner_uid, created_at)"
        )
        self._conn.commit()

    def log_attestation(
        self,
        *,
        url: str,
        request_id: str,
        success: bool,
        verified: bool,
        server_name: str | None = None,
        miner_uid: int | None = None,
        notary_uid: int | None = None,
        elapsed_s: float | None = None,
        error: str | None = None,
    ) -> None:
        """Log a completed attestation request for admin dashboard."""
        with self._lock:
            self._conn.execute(
                "INSERT INTO attestation_log "
                "(url, request_id, success, verified, "
                "server_name, miner_uid, notary_uid, elapsed_s, error, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    url, request_id,
                    int(success), int(verified),
                    server_name, miner_uid, notary_uid, elapsed_s, error,
                    int(time.time()),
                ),
            )
            self._conn.commit()
            self._maybe_prune()

    def _maybe_prune(self) -> None:
        """Lazy pruning: delete rows >30d when count >10k. Caller holds _lock."""
        self._insert_count += 1
        if self._insert_count % self._PRUNE_CHECK_INTERVAL != 0:
            return
        try:
            row = self._conn.execute("SELECT COUNT(*) FROM attestation_log").fetchone()
            if row and row[0] > self._PRUNE_THRESHOLD:
                cutoff = int(time.time()) - self._PRUNE_AGE_SECONDS
                self._conn.execute("DELETE FROM attestation_log WHERE created_at < ?", (cutoff,))
                self._conn.commit()
        except Exception:
            pass

    def recent_attestations(self, limit: int = 50) -> list[dict]:
        """Return recent attestation requests, newest first."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, url, request_id, success, verified, "
                "server_name, miner_uid, notary_uid, elapsed_s, error, created_at "
                "FROM attestation_log ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {
                "id": r[0],
                "url": r[1],
                "request_id": r[2],
                "success": bool(r[3]),
                "verified": bool(r[4]),
                "server_name": r[5],
                "miner_uid": r[6],
                "notary_uid": r[7],
                "elapsed_s": r[8],
                "error": r[9],
                "created_at": r[10],
            }
            for r in rows
        ]

    def timeseries(self, since: int | None = None, bucket_seconds: int = 3600) -> list[dict]:
        """Return attestation stats bucketed by time period.

        Args:
            since: Unix timestamp to start from. Defaults to 7 days ago.
            bucket_seconds: Bucket width in seconds. Default 1 hour.

        Returns:
            List of dicts with t, total, success, verified, avg_latency,
            peer_notary, errors — one per bucket, oldest first.
        """
        if since is None:
            since = int(time.time()) - 7 * 24 * 3600
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT
                    (created_at / ?) * ? AS bucket,
                    COUNT(*) AS total,
                    SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_count,
                    SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified_count,
                    AVG(CASE WHEN elapsed_s > 0 THEN elapsed_s END) AS avg_latency,
                    SUM(CASE WHEN notary_uid IS NOT NULL THEN 1 ELSE 0 END) AS peer_notary,
                    SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors
                FROM attestation_log
                WHERE created_at >= ?
                GROUP BY bucket
                ORDER BY bucket
                """,
                (bucket_seconds, bucket_seconds, since),
            ).fetchall()
        return [
            {
                "t": r[0],
                "total": r[1],
                "success": r[2],
                "verified": r[3],
                "avg_latency": round(r[4], 2) if r[4] else None,
                "peer_notary": r[5],
                "errors": r[6],
            }
            for r in rows
        ]

    def miner_failure_streaks(self, lookback_seconds: int = 3600) -> dict[int, int]:
        """Return consecutive recent failure counts per miner UID.

        Scans attestations from the last ``lookback_seconds`` (default 1 hour)
        and counts consecutive failures from the most recent attestation for
        each miner.  A single success breaks the streak.

        Returns:
            Mapping of miner_uid -> consecutive failure count (only miners
            with at least 1 failure are included).
        """
        cutoff = int(time.time()) - lookback_seconds
        with self._lock:
            rows = self._conn.execute(
                "SELECT miner_uid, success FROM attestation_log "
                "WHERE miner_uid IS NOT NULL AND created_at >= ? "
                "ORDER BY id DESC",
                (cutoff,),
            ).fetchall()

        streaks: dict[int, int] = {}
        seen_success: set[int] = set()
        for uid, success in rows:
            if uid in seen_success:
                continue
            if success:
                seen_success.add(uid)
            else:
                streaks[uid] = streaks.get(uid, 0) + 1
        return streaks

    def close(self) -> None:
        """Close the database connection."""
        try:
            self._conn.close()
        except Exception as e:
            log.warning("attestation_log_close_error", error=str(e))
