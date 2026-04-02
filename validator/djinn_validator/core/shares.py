"""Key share storage and management.

Each Genius signal has its encryption key split into 10 Shamir shares,
distributed across validators. This module manages a validator's local
share store with SQLite persistence.
"""

from __future__ import annotations

import re
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import structlog

from djinn_validator.utils.crypto import Share

_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,256}$")

log = structlog.get_logger()


@dataclass
class PrecomputedTriple:
    """A Beaver triple for MPC gate computation, pre-computed at signal creation."""
    a: int
    b: int
    c: int


@dataclass
class SignalShareRecord:
    """A validator's share for a single signal."""

    signal_id: str
    genius_address: str
    share: Share
    encrypted_key_share: bytes  # Share of the AES key, encrypted to this validator
    encrypted_index_share: bytes = b""  # Share of the real index, for MPC executability check
    shamir_threshold: int = 7  # Declared Shamir reconstruction threshold from genius
    stored_at: float = field(default_factory=time.time)
    released_to: set[str] = field(default_factory=set)
    precomputed_triples: list[PrecomputedTriple] = field(default_factory=list)


class ShareStore:
    """SQLite-backed store for signal key shares held by this validator.

    Falls back to in-memory SQLite when no db_path is provided (useful for tests).
    """

    _MAX_CONNECT_RETRIES = 3

    def __init__(self, db_path: str | Path | None = None) -> None:
        self._lock = threading.Lock()
        if db_path is not None:
            path = Path(db_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            self._conn = self._connect_with_retry(str(path))
        else:
            self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA wal_autocheckpoint=1000")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._create_tables()

    @staticmethod
    def _connect_with_retry(path: str) -> sqlite3.Connection:
        """Connect to SQLite with retry on OperationalError."""
        for attempt in range(ShareStore._MAX_CONNECT_RETRIES):
            try:
                return sqlite3.connect(path, check_same_thread=False)
            except sqlite3.OperationalError:
                if attempt == ShareStore._MAX_CONNECT_RETRIES - 1:
                    raise
                delay = 2**attempt
                log.warning("db_connect_retry", attempt=attempt + 1, delay_s=delay, path=path)
                time.sleep(delay)
        raise RuntimeError("unreachable")

    SCHEMA_VERSION = 5

    def _create_tables(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS shares (
                signal_id TEXT NOT NULL,
                genius_address TEXT NOT NULL,
                share_x INTEGER NOT NULL,
                share_y TEXT NOT NULL,
                encrypted_key_share BLOB NOT NULL,
                encrypted_index_share BLOB NOT NULL DEFAULT x'',
                stored_at REAL NOT NULL,
                PRIMARY KEY (signal_id, share_x)
            );
            CREATE TABLE IF NOT EXISTS releases (
                signal_id TEXT NOT NULL,
                buyer_address TEXT NOT NULL,
                released_at REAL NOT NULL,
                PRIMARY KEY (signal_id, buyer_address)
            );
            CREATE INDEX IF NOT EXISTS idx_releases_signal_id ON releases(signal_id);
        """)
        self._conn.commit()
        self._migrate()

    def _get_schema_version(self) -> int:
        row = self._conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
        ).fetchone()
        return row[0] if row else 0

    def _set_schema_version(self, version: int) -> None:
        self._conn.execute("DELETE FROM schema_version")
        self._conn.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))
        self._conn.commit()

    def _migrate(self) -> None:
        """Run schema migrations up to SCHEMA_VERSION."""
        current = self._get_schema_version()
        if current >= self.SCHEMA_VERSION:
            return

        if current < 1:
            # v1: initial schema (tables already created above)
            log.info("schema_migration", from_version=current, to_version=1)

        if current < 2:
            # v2: add index on releases.signal_id for faster lookups
            log.info("schema_migration", from_version=max(current, 1), to_version=2)
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_releases_signal_id ON releases(signal_id)")
            self._conn.commit()

        if current < 3:
            # v3: change PK from signal_id to (signal_id, share_x) so one validator
            # can store multiple shares per signal (needed for single-validator testing
            # and for future multi-share configurations)
            log.info("schema_migration", from_version=max(current, 2), to_version=3)
            self._conn.execute("PRAGMA foreign_keys=OFF")
            self._conn.executescript("""
                CREATE TABLE IF NOT EXISTS shares_v3 (
                    signal_id TEXT NOT NULL,
                    genius_address TEXT NOT NULL,
                    share_x INTEGER NOT NULL,
                    share_y TEXT NOT NULL,
                    encrypted_key_share BLOB NOT NULL,
                    encrypted_index_share BLOB NOT NULL DEFAULT x'',
                    stored_at REAL NOT NULL,
                    PRIMARY KEY (signal_id, share_x)
                );
                INSERT OR IGNORE INTO shares_v3
                    (signal_id, genius_address, share_x, share_y, encrypted_key_share, stored_at)
                    SELECT signal_id, genius_address, share_x, share_y, encrypted_key_share, stored_at
                    FROM shares;
                DROP TABLE shares;
                ALTER TABLE shares_v3 RENAME TO shares;
            """)
            # Recreate releases without FK constraint (use index instead)
            self._conn.executescript("""
                CREATE TABLE IF NOT EXISTS releases_v3 (
                    signal_id TEXT NOT NULL,
                    buyer_address TEXT NOT NULL,
                    released_at REAL NOT NULL,
                    PRIMARY KEY (signal_id, buyer_address)
                );
                INSERT OR IGNORE INTO releases_v3 SELECT * FROM releases;
                DROP TABLE IF EXISTS releases;
                ALTER TABLE releases_v3 RENAME TO releases;
                CREATE INDEX IF NOT EXISTS idx_releases_signal_id ON releases(signal_id);
            """)
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.commit()

        if current < 4:
            # v4: add encrypted_index_share column for MPC executability check
            log.info("schema_migration", from_version=max(current, 3), to_version=4)
            try:
                self._conn.execute(
                    "ALTER TABLE shares ADD COLUMN encrypted_index_share BLOB NOT NULL DEFAULT x''"
                )
            except sqlite3.OperationalError:
                pass  # Column already exists
            self._conn.commit()

        if current < 5:
            # v5: add shamir_threshold column so MPC uses per-signal threshold
            log.info("schema_migration", from_version=max(current, 4), to_version=5)
            try:
                self._conn.execute(
                    "ALTER TABLE shares ADD COLUMN shamir_threshold INTEGER NOT NULL DEFAULT 7"
                )
            except sqlite3.OperationalError:
                pass  # Column already exists
            self._conn.commit()

        self._set_schema_version(self.SCHEMA_VERSION)
        log.info("schema_version_set", version=self.SCHEMA_VERSION)

    def store(
        self,
        signal_id: str,
        genius_address: str,
        share: Share,
        encrypted_key_share: bytes,
        encrypted_index_share: bytes = b"",
        shamir_threshold: int = 7,
        precomputed_triples: list[PrecomputedTriple] | None = None,
    ) -> None:
        """Store a new key share for a signal."""
        if not _SAFE_ID_RE.match(signal_id):
            raise ValueError("Invalid signal_id: must match [a-zA-Z0-9_-]{1,256}")
        if not genius_address or not genius_address.strip():
            raise ValueError("genius_address must not be empty")
        if not encrypted_key_share:
            raise ValueError("encrypted_key_share must not be empty")

        import json as _json
        triples_json = _json.dumps(
            [{"a": hex(t.a), "b": hex(t.b), "c": hex(t.c)} for t in (precomputed_triples or [])]
        )

        with self._lock:
            # Auto-migrate: add precomputed_triples column if missing
            try:
                self._conn.execute("SELECT precomputed_triples FROM shares LIMIT 0")
            except sqlite3.OperationalError:
                self._conn.execute("ALTER TABLE shares ADD COLUMN precomputed_triples TEXT DEFAULT '[]'")
                self._conn.commit()

            try:
                self._conn.execute(
                    "INSERT INTO shares (signal_id, genius_address, share_x, share_y, "
                    "encrypted_key_share, encrypted_index_share, stored_at, shamir_threshold, "
                    "precomputed_triples) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (signal_id, genius_address, share.x, str(share.y),
                     encrypted_key_share, encrypted_index_share, time.time(),
                     shamir_threshold, triples_json),
                )
                self._conn.commit()
                log.info("share_stored", signal_id=signal_id, genius=genius_address,
                         has_index_share=len(encrypted_index_share) > 0,
                         shamir_threshold=shamir_threshold,
                         precomputed_triples=len(precomputed_triples or []))
            except sqlite3.IntegrityError:
                log.warning("share_already_stored", signal_id=signal_id)
                raise ValueError(f"Share already stored for signal {signal_id}")

    def get(self, signal_id: str) -> SignalShareRecord | None:
        """Retrieve a share record by signal ID."""
        with self._lock:
            # Try with precomputed_triples column; fall back without if not migrated yet
            try:
                row = self._conn.execute(
                    "SELECT signal_id, genius_address, share_x, share_y, encrypted_key_share, "
                    "encrypted_index_share, stored_at, shamir_threshold, precomputed_triples "
                    "FROM shares WHERE signal_id = ?",
                    (signal_id,),
                ).fetchone()
            except sqlite3.OperationalError:
                row = self._conn.execute(
                    "SELECT signal_id, genius_address, share_x, share_y, encrypted_key_share, "
                    "encrypted_index_share, stored_at, shamir_threshold "
                    "FROM shares WHERE signal_id = ?",
                    (signal_id,),
                ).fetchone()
            if row is None:
                return None

            released = {
                r[0]
                for r in self._conn.execute(
                    "SELECT buyer_address FROM releases WHERE signal_id = ?",
                    (signal_id,),
                ).fetchall()
            }

        import json as _json
        triples: list[PrecomputedTriple] = []
        if len(row) > 8 and row[8]:
            try:
                raw = _json.loads(row[8])
                triples = [PrecomputedTriple(a=int(t["a"], 16), b=int(t["b"], 16), c=int(t["c"], 16)) for t in raw]
            except (ValueError, KeyError, TypeError):
                pass

        return SignalShareRecord(
            signal_id=row[0],
            genius_address=row[1],
            share=Share(x=row[2], y=int(row[3])),
            encrypted_key_share=row[4],
            encrypted_index_share=row[5] or b"",
            shamir_threshold=row[7] if len(row) > 7 else 7,
            stored_at=row[6],
            released_to=released,
            precomputed_triples=triples,
        )

    def get_all(self, signal_id: str) -> list[SignalShareRecord]:
        """Retrieve all share records for a signal (may be multiple if shares
        are co-located in the same database, e.g. testnet single-machine setup)."""
        with self._lock:
            # Include precomputed_triples column; fall back without if not migrated
            try:
                rows = self._conn.execute(
                    "SELECT signal_id, genius_address, share_x, share_y, encrypted_key_share, "
                    "encrypted_index_share, stored_at, shamir_threshold, precomputed_triples "
                    "FROM shares WHERE signal_id = ? ORDER BY share_x",
                    (signal_id,),
                ).fetchall()
            except sqlite3.OperationalError:
                rows = self._conn.execute(
                    "SELECT signal_id, genius_address, share_x, share_y, encrypted_key_share, "
                    "encrypted_index_share, stored_at, shamir_threshold "
                    "FROM shares WHERE signal_id = ? ORDER BY share_x",
                    (signal_id,),
                ).fetchall()
            if not rows:
                return []

            released = {
                r[0]
                for r in self._conn.execute(
                    "SELECT buyer_address FROM releases WHERE signal_id = ?",
                    (signal_id,),
                ).fetchall()
            }

        import json as _json
        records = []
        for row in rows:
            triples: list[PrecomputedTriple] = []
            if len(row) > 8 and row[8]:
                try:
                    raw = _json.loads(row[8])
                    triples = [PrecomputedTriple(a=int(t["a"], 16), b=int(t["b"], 16), c=int(t["c"], 16)) for t in raw]
                except (ValueError, KeyError, TypeError):
                    pass

            records.append(SignalShareRecord(
                signal_id=row[0],
                genius_address=row[1],
                share=Share(x=row[2], y=int(row[3])),
                encrypted_key_share=row[4],
                encrypted_index_share=row[5] or b"",
                shamir_threshold=row[7] if len(row) > 7 else 7,
                stored_at=row[6],
                released_to=released,
                precomputed_triples=triples,
            ))
        return records

    def has(self, signal_id: str) -> bool:
        """Check if we hold a share for this signal."""
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM shares WHERE signal_id = ? LIMIT 1",
                (signal_id,),
            ).fetchone()
            return row is not None

    def release(self, signal_id: str, buyer_address: str) -> bytes | None:
        """Release the encrypted key share to a buyer.

        Returns the encrypted key share bytes, or None if not found.
        Records the release to prevent double-claiming.
        Uses a transaction to ensure atomicity of lookup+check+insert.
        """
        if not signal_id or not buyer_address:
            return None

        with self._lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")

                row = self._conn.execute(
                    "SELECT encrypted_key_share FROM shares WHERE signal_id = ?",
                    (signal_id,),
                ).fetchone()
                if row is None:
                    self._conn.execute("COMMIT")
                    log.warning("share_not_found", signal_id=signal_id)
                    return None

                encrypted_key_share = row[0]

                existing = self._conn.execute(
                    "SELECT 1 FROM releases WHERE signal_id = ? AND buyer_address = ?",
                    (signal_id, buyer_address),
                ).fetchone()
                if existing:
                    self._conn.execute("COMMIT")
                    log.warning("share_already_released", signal_id=signal_id, buyer=buyer_address)
                    return encrypted_key_share

                self._conn.execute(
                    "INSERT INTO releases (signal_id, buyer_address, released_at) VALUES (?, ?, ?)",
                    (signal_id, buyer_address, time.time()),
                )
                self._conn.execute("COMMIT")
                log.info("share_released", signal_id=signal_id, buyer=buyer_address)
                return encrypted_key_share
            except Exception as e:
                log.error("share_release_error", signal_id=signal_id, buyer=buyer_address, error=str(e))
                try:
                    self._conn.execute("ROLLBACK")
                except Exception as rb_err:
                    log.error("share_release_rollback_failed", signal_id=signal_id, error=str(rb_err))
                raise

    def remove(self, signal_id: str) -> None:
        """Remove a share (e.g., signal voided or expired).

        Uses an explicit transaction to ensure both deletes are atomic.
        """
        with self._lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                self._conn.execute("DELETE FROM releases WHERE signal_id = ?", (signal_id,))
                self._conn.execute("DELETE FROM shares WHERE signal_id = ?", (signal_id,))
                self._conn.execute("COMMIT")
            except Exception:
                try:
                    self._conn.execute("ROLLBACK")
                except Exception as rollback_err:
                    log.error("share_remove_rollback_failed", signal_id=signal_id, error=str(rollback_err))
                raise

    @property
    def count(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COUNT(*) FROM shares").fetchone()
            return row[0] if row else 0

    def active_signals(self) -> list[str]:
        """List all signal IDs we hold shares for."""
        with self._lock:
            rows = self._conn.execute("SELECT signal_id FROM shares").fetchall()
            return [r[0] for r in rows]

    def close(self) -> None:
        """Close the database connection."""
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception as e:
                log.warning("share_store_close_error", error=str(e))
            self._conn = None
