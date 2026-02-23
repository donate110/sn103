"""SQLite ledger for consumed alpha burn transactions.

Prevents double-spend by tracking which extrinsic hashes have already been
used to pay for attestation requests.  Supports multi-credit burns: a single
burn transaction of N * min_amount grants N attestation credits.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

import structlog

log = structlog.get_logger()


class BurnLedger:
    """SQLite-backed ledger of consumed alpha burn transactions.

    Supports multi-credit burns: if a user burns 0.0013 TAO (13x the minimum
    0.0001 TAO), they get 13 attestation credits from a single tx hash.

    Follows the same pattern as ShareStore for SQLite lifecycle management.
    """

    def __init__(self, db_path: str | Path | None = None) -> None:
        self._lock = threading.Lock()
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
            CREATE TABLE IF NOT EXISTS consumed_burns (
                tx_hash        TEXT PRIMARY KEY,
                coldkey        TEXT NOT NULL,
                amount         REAL NOT NULL,
                total_credits  INTEGER NOT NULL DEFAULT 1,
                used_credits   INTEGER NOT NULL DEFAULT 0,
                created_at     INTEGER NOT NULL
            )
        """)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS attestation_log (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                tx_hash       TEXT NOT NULL,
                coldkey       TEXT NOT NULL,
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
        # Migrate old schema: add total_credits/used_credits if missing
        cols = {
            row[1]
            for row in self._conn.execute("PRAGMA table_info(consumed_burns)")
        }
        if "total_credits" not in cols:
            self._conn.execute(
                "ALTER TABLE consumed_burns ADD COLUMN total_credits INTEGER NOT NULL DEFAULT 1"
            )
        if "used_credits" not in cols:
            self._conn.execute(
                "ALTER TABLE consumed_burns ADD COLUMN used_credits INTEGER NOT NULL DEFAULT 0"
            )
        self._conn.commit()

    def is_consumed(self, tx_hash: str) -> bool:
        """Check whether a burn transaction has exhausted all credits."""
        with self._lock:
            row = self._conn.execute(
                "SELECT total_credits, used_credits FROM consumed_burns WHERE tx_hash = ?",
                (tx_hash,),
            ).fetchone()
            if row is None:
                return False
            return row[1] >= row[0]

    def remaining_credits(self, tx_hash: str) -> int:
        """Return the number of unused attestation credits for a burn tx."""
        with self._lock:
            row = self._conn.execute(
                "SELECT total_credits, used_credits FROM consumed_burns WHERE tx_hash = ?",
                (tx_hash,),
            ).fetchone()
            if row is None:
                return 0
            return max(0, row[0] - row[1])

    def record_burn(
        self, tx_hash: str, coldkey: str, amount: float, min_amount: float = 0.0001
    ) -> bool:
        """Record a burn transaction and consume one credit.

        On first call: inserts the burn with total_credits = floor(amount / min_amount)
        and used_credits = 1.  On subsequent calls: increments used_credits if credits
        remain.

        Returns True if a credit was consumed successfully.
        Returns False if all credits are exhausted (double-spend).
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT total_credits, used_credits FROM consumed_burns WHERE tx_hash = ?",
                (tx_hash,),
            ).fetchone()

            if row is None:
                # First use — register the burn
                # Use integer division (floor) to prevent dust-spam — partial credits
                # are not awarded.  amount and min_amount are in TAO (floats) so we
                # scale to rao (int) first.
                amount_rao = int(amount * 1_000_000_000)
                min_rao = int(min_amount * 1_000_000_000)
                total = max(1, amount_rao // min_rao) if min_rao > 0 else 1
                self._conn.execute(
                    "INSERT INTO consumed_burns (tx_hash, coldkey, amount, total_credits, used_credits, created_at) "
                    "VALUES (?, ?, ?, ?, 1, ?)",
                    (tx_hash, coldkey, amount, total, int(time.time())),
                )
                self._conn.commit()
                log.info(
                    "burn_recorded",
                    tx_hash=tx_hash[:16] + "...",
                    total_credits=total,
                    remaining=total - 1,
                )
                return True

            total_credits, used_credits = row
            if used_credits >= total_credits:
                return False

            self._conn.execute(
                "UPDATE consumed_burns SET used_credits = used_credits + 1 WHERE tx_hash = ?",
                (tx_hash,),
            )
            self._conn.commit()
            log.info(
                "burn_credit_consumed",
                tx_hash=tx_hash[:16] + "...",
                used=used_credits + 1,
                total=total_credits,
            )
            return True

    def refund_credit(self, tx_hash: str) -> bool:
        """Refund one credit for a burn transaction (e.g., on miner failure).

        Decrements used_credits by 1 so the credit can be reused.
        Returns True if a credit was refunded, False if nothing to refund.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT used_credits FROM consumed_burns WHERE tx_hash = ?",
                (tx_hash,),
            ).fetchone()
            if row is None or row[0] < 1:
                return False
            self._conn.execute(
                "UPDATE consumed_burns SET used_credits = used_credits - 1 WHERE tx_hash = ?",
                (tx_hash,),
            )
            self._conn.commit()
            log.info("burn_credit_refunded", tx_hash=tx_hash[:16] + "...")
            return True

    def log_attestation(
        self,
        *,
        tx_hash: str,
        coldkey: str,
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
                "(tx_hash, coldkey, url, request_id, success, verified, "
                "server_name, miner_uid, elapsed_s, error, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    tx_hash, coldkey, url, request_id,
                    int(success), int(verified),
                    server_name, miner_uid, elapsed_s, error,
                    int(time.time()),
                ),
            )
            self._conn.commit()

    def recent_attestations(self, limit: int = 50) -> list[dict]:
        """Return recent attestation requests, newest first."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, tx_hash, coldkey, url, request_id, success, verified, "
                "server_name, miner_uid, elapsed_s, error, created_at "
                "FROM attestation_log ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {
                "id": r[0],
                "tx_hash": r[1],
                "coldkey": r[2],
                "url": r[3],
                "request_id": r[4],
                "success": bool(r[5]),
                "verified": bool(r[6]),
                "server_name": r[7],
                "miner_uid": r[8],
                "elapsed_s": r[9],
                "error": r[10],
                "created_at": r[11],
            }
            for r in rows
        ]

    def hourly_burn_stats(self, days: int = 7) -> list[dict]:
        """Aggregate burn collections by hour for the last N days."""
        cutoff = int(time.time()) - days * 86400
        with self._lock:
            rows = self._conn.execute(
                "SELECT (created_at / 3600) * 3600 AS hour, "
                "COUNT(*) AS count, SUM(amount) AS total_amount "
                "FROM consumed_burns WHERE created_at >= ? "
                "GROUP BY hour ORDER BY hour DESC",
                (cutoff,),
            ).fetchall()
        return [
            {"hour": r[0], "count": r[1], "amount": round(r[2] or 0, 10)}
            for r in rows
        ]

    def close(self) -> None:
        """Close the database connection."""
        try:
            self._conn.close()
        except Exception as e:
            log.warning("burn_ledger_close_error", error=str(e))
