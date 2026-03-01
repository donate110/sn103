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
                elapsed_s     REAL,
                error         TEXT,
                created_at    INTEGER NOT NULL
            )
        """)
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
        elapsed_s: float | None = None,
        error: str | None = None,
    ) -> None:
        """Log a completed attestation request for admin dashboard."""
        with self._lock:
            self._conn.execute(
                "INSERT INTO attestation_log "
                "(url, request_id, success, verified, "
                "server_name, miner_uid, elapsed_s, error, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    url, request_id,
                    int(success), int(verified),
                    server_name, miner_uid, elapsed_s, error,
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
                "server_name, miner_uid, elapsed_s, error, created_at "
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
                "elapsed_s": r[7],
                "error": r[8],
                "created_at": r[9],
            }
            for r in rows
        ]

    def close(self) -> None:
        """Close the database connection."""
        try:
            self._conn.close()
        except Exception as e:
            log.warning("attestation_log_close_error", error=str(e))
