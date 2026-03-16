"""Outcome attestation — queries ESPN and builds consensus.

Validators independently query ESPN's free public scoreboard API, then
reach 2/3+ consensus before writing outcomes on-chain.

Outcome determination logic:
- SPREADS: Team must cover the spread (score diff > spread for favorites,
           or lose by fewer than spread for underdogs). Push = VOID.
- TOTALS:  Combined score must be over/under the total. Push = VOID.
- H2H:     Selected team must win outright. Tie = VOID.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import sqlite3
import time
from dataclasses import dataclass, field
from enum import IntEnum
from typing import TYPE_CHECKING, Any

import structlog

if TYPE_CHECKING:
    from djinn_validator.core.espn import ESPNClient

log = structlog.get_logger()


class Outcome(IntEnum):
    """Signal outcome matching the smart contract enum."""

    PENDING = 0
    FAVORABLE = 1
    UNFAVORABLE = 2
    VOID = 3


@dataclass
class EventResult:
    """Result of a sporting event relevant to a signal."""

    event_id: str
    home_team: str = ""
    away_team: str = ""
    home_score: int | None = None
    away_score: int | None = None
    status: str = "pending"  # pending, final, postponed, cancelled
    raw_data: dict[str, Any] = field(default_factory=dict)


@dataclass
class ParsedPick:
    """A structured representation of a signal pick string.

    Examples:
        "Lakers -3.5 (-110)"  → market=spreads, team=Lakers, line=-3.5
        "Over 218.5 (-110)"   → market=totals, side=Over, line=218.5
        "Celtics ML (-150)"   → market=h2h, team=Celtics
    """

    market: str  # "spreads", "totals", "h2h"
    team: str = ""  # Team name (for spreads/h2h)
    side: str = ""  # "Over"/"Under" (for totals)
    line: float | None = None  # Spread or total line
    odds: int | None = None  # American odds (informational only)


@dataclass
class SignalMetadata:
    """Metadata for a purchased signal, used for blind outcome resolution.

    Stores ALL 10 decoy lines (already public on-chain).  The validator
    resolves every line against game results, producing 10 outcomes.
    The real outcome is selected later by batch MPC at the audit-set level,
    so no individual signal outcome is ever revealed.
    """

    signal_id: str
    sport: str  # The Odds API sport key, e.g., "basketball_nba"
    event_id: str  # The Odds API event ID
    home_team: str
    away_team: str
    lines: list[ParsedPick]  # All 10 public decoy lines
    purchased_at: float = field(default_factory=time.time)
    resolved: bool = False
    outcomes: list[Outcome] | None = None  # 10 outcomes once game resolves


@dataclass
class OutcomeAttestation:
    """A validator's attestation of a signal's outcome."""

    signal_id: str
    validator_hotkey: str
    outcome: Outcome
    event_result: EventResult
    timestamp: float = field(default_factory=time.time)


# ---------------------------------------------------------------------------
# Pick Parsing
# ---------------------------------------------------------------------------

_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_\-:.]{1,256}$")

# Supported sport keys — must have an ESPN mapping.
# Import lazily to avoid circular imports at module level.
def _get_supported_sports() -> frozenset[str]:
    from djinn_validator.core.espn import SUPPORTED_SPORTS as _ESPN_SPORTS
    return _ESPN_SPORTS

SUPPORTED_SPORTS: frozenset[str] = frozenset(
    {
        "americanfootball_nfl",
        "americanfootball_ncaaf",
        "basketball_nba",
        "basketball_ncaab",
        "baseball_mlb",
        "icehockey_nhl",
        "soccer_epl",
        "soccer_usa_mls",
    }
)

# Regex patterns for different pick formats
_SPREAD_RE = re.compile(r"^(.+?)\s+([+-]?\d+(?:\.\d+)?)\s*\(([+-]?\d+)\)$")
_TOTAL_RE = re.compile(r"^(Over|Under)\s+(\d+(?:\.\d+)?)\s*\(([+-]?\d+)\)$", re.IGNORECASE)
_ML_RE = re.compile(r"^(.+?)\s+ML\s*\(([+-]?\d+)\)$", re.IGNORECASE)


def parse_pick(pick_str: str) -> ParsedPick:
    """Parse a pick string into structured data.

    Supports formats:
        "Lakers -3.5 (-110)"   → spreads
        "Over 218.5 (-110)"    → totals
        "Under 218.5 (-110)"   → totals
        "Celtics ML (-150)"    → h2h (moneyline)
    """
    pick_str = pick_str.strip()

    # Try totals first (Over/Under)
    m = _TOTAL_RE.match(pick_str)
    if m:
        return ParsedPick(
            market="totals",
            side=m.group(1).capitalize(),
            line=float(m.group(2)),
            odds=int(m.group(3)),
        )

    # Try moneyline
    m = _ML_RE.match(pick_str)
    if m:
        return ParsedPick(
            market="h2h",
            team=m.group(1).strip(),
            odds=int(m.group(2)),
        )

    # Try spread (most common)
    m = _SPREAD_RE.match(pick_str)
    if m:
        return ParsedPick(
            market="spreads",
            team=m.group(1).strip(),
            line=float(m.group(2)),
            odds=int(m.group(3)),
        )

    # Fallback: treat as moneyline without explicit ML tag
    return ParsedPick(market="h2h", team=pick_str)


# ---------------------------------------------------------------------------
# Outcome Determination
# ---------------------------------------------------------------------------


def determine_outcome(
    pick: ParsedPick,
    result: EventResult,
    home_team: str,
    away_team: str,
) -> Outcome:
    """Determine signal outcome from pick + game result.

    Returns VOID for postponed/cancelled games or pushes (exact line hit).
    """
    if result.status in ("postponed", "cancelled"):
        return Outcome.VOID

    if result.status != "final":
        return Outcome.PENDING

    if result.home_score is None or result.away_score is None:
        return Outcome.PENDING

    home = result.home_score
    away = result.away_score

    if pick.market == "spreads":
        return _determine_spread(pick, home, away, home_team, away_team)
    elif pick.market == "totals":
        return _determine_total(pick, home, away)
    elif pick.market == "h2h":
        return _determine_h2h(pick, home, away, home_team, away_team)

    return Outcome.PENDING


def determine_all_outcomes(
    lines: list[ParsedPick],
    result: EventResult,
    home_team: str,
    away_team: str,
) -> list[Outcome]:
    """Determine outcomes for ALL decoy lines against a single game result.

    Returns a list of outcomes, one per line.  The real outcome is at the
    secret index, but no single party knows which index that is.
    """
    return [
        determine_outcome(line, result, home_team, away_team)
        for line in lines
    ]


def _determine_spread(
    pick: ParsedPick,
    home: int,
    away: int,
    home_team: str,
    away_team: str,
) -> Outcome:
    """Spreads: team + spread vs opponent score."""
    if pick.line is None:
        return Outcome.VOID

    # Determine which team was picked
    is_home = _team_matches(pick.team, home_team)
    is_away = _team_matches(pick.team, away_team)

    if not is_home and not is_away:
        log.warning("team_not_found", pick_team=pick.team, home=home_team, away=away_team)
        return Outcome.VOID
    if is_home and is_away:
        log.warning("ambiguous_team_match", pick_team=pick.team, home=home_team, away=away_team)
        return Outcome.VOID

    if is_home:
        adjusted = home + pick.line
        diff = adjusted - away
    else:
        adjusted = away + pick.line
        diff = adjusted - home

    if abs(diff) < 1e-9:
        return Outcome.VOID  # Push
    return Outcome.FAVORABLE if diff > 0 else Outcome.UNFAVORABLE


def _determine_total(pick: ParsedPick, home: int, away: int) -> Outcome:
    """Totals: combined score over/under the line."""
    if pick.line is None:
        return Outcome.VOID

    total = home + away

    if abs(total - pick.line) < 1e-9:
        return Outcome.VOID  # Push

    if pick.side == "Over":
        return Outcome.FAVORABLE if total > pick.line else Outcome.UNFAVORABLE
    else:
        return Outcome.FAVORABLE if total < pick.line else Outcome.UNFAVORABLE


def _determine_h2h(
    pick: ParsedPick,
    home: int,
    away: int,
    home_team: str,
    away_team: str,
) -> Outcome:
    """Head-to-head (moneyline): picked team must win outright."""
    if home == away:
        return Outcome.VOID  # Tie

    is_home = _team_matches(pick.team, home_team)
    is_away = _team_matches(pick.team, away_team)

    if not is_home and not is_away:
        log.warning("team_not_found", pick_team=pick.team, home=home_team, away=away_team)
        return Outcome.VOID
    if is_home and is_away:
        log.warning("ambiguous_team_match", pick_team=pick.team, home=home_team, away=away_team)
        return Outcome.VOID

    if is_home:
        return Outcome.FAVORABLE if home > away else Outcome.UNFAVORABLE
    else:
        return Outcome.FAVORABLE if away > home else Outcome.UNFAVORABLE


def _team_matches(pick_team: str, full_name: str) -> bool:
    """Word-boundary match: pick might use city or mascot, full_name is "City Mascot"."""
    pick_lower = pick_team.lower()
    full_lower = full_name.lower()
    # Exact match
    if pick_lower == full_lower:
        return True
    # Word-boundary match (e.g., "Lakers" matches "Los Angeles Lakers")
    words = full_lower.split()
    if pick_lower in words:
        return True
    # Multi-word pick (e.g., "Kansas City" in "Kansas City Chiefs")
    if len(pick_lower.split()) > 1 and full_lower.startswith(pick_lower + " "):
        return True
    return False


# ---------------------------------------------------------------------------
# OutcomeAttestor
# ---------------------------------------------------------------------------


class OutcomeAttestor:
    """Manages outcome attestation and consensus building."""

    MAX_PENDING_SIGNALS = 10_000
    MAX_ATTESTATIONS_PER_SIGNAL = 100

    def __init__(
        self,
        espn_client: ESPNClient | None = None,
        sports_api_key: str = "",  # Deprecated, kept for backwards compat
        db_path: str | None = None,
    ) -> None:
        if espn_client is not None:
            self._espn = espn_client
        else:
            from djinn_validator.core.espn import ESPNClient as _ESPNClient
            self._espn = _ESPNClient()
        if sports_api_key:
            log.warning("sports_api_key_deprecated",
                        msg="SPORTS_API_KEY is no longer used; validator uses ESPN for scores")
        self._attestations: dict[str, list[OutcomeAttestation]] = {}
        self._pending_signals: dict[str, SignalMetadata] = {}
        self._lock = asyncio.Lock()

        # Optional SQLite persistence for signal registrations
        self._db: sqlite3.Connection | None = None
        if db_path:
            import sqlite3 as _sqlite3
            from pathlib import Path as _Path
            _Path(db_path).parent.mkdir(parents=True, exist_ok=True)
            self._db = _sqlite3.connect(db_path, check_same_thread=False)
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA busy_timeout=5000")
            self._db.execute("""
                CREATE TABLE IF NOT EXISTS signal_registrations (
                    signal_id TEXT PRIMARY KEY,
                    sport TEXT NOT NULL,
                    event_id TEXT NOT NULL,
                    home_team TEXT NOT NULL,
                    away_team TEXT NOT NULL,
                    lines_json TEXT NOT NULL,
                    registered_at REAL NOT NULL,
                    resolved INTEGER NOT NULL DEFAULT 0
                )
            """)
            self._db.commit()
            self._load_persisted_signals()

    def _load_persisted_signals(self) -> None:
        """Load persisted signal registrations from SQLite on startup."""
        if not self._db:
            return
        try:
            cursor = self._db.execute(
                "SELECT signal_id, sport, event_id, home_team, away_team, "
                "lines_json, registered_at, resolved FROM signal_registrations"
            )
            loaded = 0
            for row in cursor:
                signal_id, sport, event_id, home_team, away_team, lines_json, registered_at, resolved = row
                try:
                    raw_lines = json.loads(lines_json)
                    parsed_lines = [parse_pick(line) for line in raw_lines]
                    meta = SignalMetadata(
                        signal_id=signal_id,
                        sport=sport,
                        event_id=event_id,
                        home_team=home_team,
                        away_team=away_team,
                        lines=parsed_lines,
                        purchased_at=registered_at,
                        resolved=bool(resolved),
                    )
                    self._pending_signals[signal_id] = meta
                    loaded += 1
                except Exception as e:
                    log.debug("signal_load_skip", signal_id=signal_id, err=str(e)[:80])
            if loaded:
                log.info("signals_loaded_from_db", count=loaded)
        except Exception as e:
            log.error("signal_db_load_failed", err=str(e))

    def _persist_signal(self, metadata: SignalMetadata) -> None:
        """Persist a signal registration to SQLite."""
        if not self._db:
            return
        try:
            lines_raw = [
                f"{p.team or p.side} {p.line or ''} ({p.odds})" if p.odds
                else f"{p.team or p.side} {p.line or ''}"
                for p in metadata.lines
            ]
            self._db.execute(
                "INSERT OR REPLACE INTO signal_registrations "
                "(signal_id, sport, event_id, home_team, away_team, lines_json, registered_at, resolved) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    metadata.signal_id,
                    metadata.sport,
                    metadata.event_id,
                    metadata.home_team,
                    metadata.away_team,
                    json.dumps(lines_raw),
                    metadata.purchased_at,
                    int(metadata.resolved),
                ),
            )
            self._db.commit()
        except Exception as e:
            log.debug("signal_persist_failed", signal_id=metadata.signal_id, err=str(e)[:80])

    def register_signal(self, metadata: SignalMetadata) -> None:
        """Register a purchased signal for outcome tracking."""
        if len(self._pending_signals) >= self.MAX_PENDING_SIGNALS:
            # Synchronous eviction of already-resolved signals at capacity
            now = time.time()
            stale = [
                sid for sid, m in list(self._pending_signals.items())
                if m.resolved and now - m.purchased_at > 3600
            ]
            for sid in stale:
                del self._pending_signals[sid]
                self._attestations.pop(sid, None)
            if not stale:
                log.warning("pending_signals_at_capacity", max=self.MAX_PENDING_SIGNALS)
        self._pending_signals[metadata.signal_id] = metadata
        self._persist_signal(metadata)
        log.info(
            "signal_registered_for_outcome",
            signal_id=metadata.signal_id,
            sport=metadata.sport,
            event_id=metadata.event_id,
            lines_count=len(metadata.lines),
        )

    def get_signal(self, signal_id: str) -> SignalMetadata | None:
        """Look up a signal by ID (pending or resolved)."""
        return self._pending_signals.get(signal_id)

    def get_pending_signals(self) -> list[SignalMetadata]:
        """Return all unresolved signals."""
        return [s for s in self._pending_signals.values() if not s.resolved]

    async def fetch_event_result(
        self,
        event_id: str,
        sport: str = "basketball_nba",
        home_team: str = "",
        away_team: str = "",
    ) -> EventResult:
        """Fetch event result from ESPN's public scoreboard API.

        Matches games by team names + date (ESPN IDs differ from Odds API IDs).
        The event_id is preserved for tracking but not used for ESPN lookup.
        """
        if not _SAFE_ID_RE.match(event_id):
            log.warning("invalid_event_id", event_id=event_id[:50])
            return EventResult(event_id=event_id, status="error")
        if sport not in SUPPORTED_SPORTS:
            log.warning("unsupported_sport_key", sport=sport[:50])
            return EventResult(event_id=event_id, status="error")

        if not home_team or not away_team:
            log.warning("missing_team_names", event_id=event_id)
            return EventResult(event_id=event_id, status="pending")

        try:
            game = await self._espn.get_game_by_teams(
                sport=sport,
                home_team=home_team,
                away_team=away_team,
            )
        except Exception as e:
            log.warning("espn_fetch_error", event_id=event_id, error=str(e))
            return EventResult(event_id=event_id, status="pending")

        if game is None:
            log.debug("espn_game_not_found", event_id=event_id,
                       home=home_team, away=away_team)
            return EventResult(event_id=event_id, status="pending")

        if game.status in ("postponed",):
            return EventResult(
                event_id=event_id,
                home_team=game.home_team,
                away_team=game.away_team,
                status="postponed",
                raw_data=game.raw_data,
            )
        if game.status in ("cancelled",):
            return EventResult(
                event_id=event_id,
                home_team=game.home_team,
                away_team=game.away_team,
                status="cancelled",
                raw_data=game.raw_data,
            )
        if game.status != "final":
            return EventResult(
                event_id=event_id,
                home_team=game.home_team,
                away_team=game.away_team,
                status="pending",
                raw_data=game.raw_data,
            )

        return EventResult(
            event_id=event_id,
            home_team=game.home_team,
            away_team=game.away_team,
            home_score=game.home_score,
            away_score=game.away_score,
            status="final",
            raw_data=game.raw_data,
        )

    async def resolve_signal(
        self,
        signal_id: str,
        validator_hotkey: str,
    ) -> str | None:
        """Fetch scores and determine all 10 line outcomes for a signal.

        Blind resolution: resolves ALL 10 decoy lines against the game result
        and stores outcomes on the signal metadata.  The real outcome is NOT
        selected here — that happens later during batch MPC settlement at the
        audit-set level, so no individual signal outcome is ever revealed.

        Returns the signal_id if newly resolved, or None.
        """
        async with self._lock:
            meta = self._pending_signals.get(signal_id)
            if meta is None:
                log.warning("signal_not_registered", signal_id=signal_id)
                return None

            if meta.resolved:
                return None

        result = await self.fetch_event_result(
            meta.event_id, meta.sport,
            home_team=meta.home_team, away_team=meta.away_team,
        )

        if result.status not in ("final", "postponed", "cancelled"):
            return None

        # Blind resolution: resolve ALL lines, not just one
        all_outcomes = determine_all_outcomes(
            meta.lines, result, meta.home_team, meta.away_team,
        )

        # If every line is still PENDING, game isn't truly finished
        if all(o == Outcome.PENDING for o in all_outcomes):
            return None

        async with self._lock:
            if meta.resolved:
                return None  # Another coroutine resolved it while we were fetching
            meta.resolved = True
            meta.outcomes = all_outcomes
            log.info("signal_outcomes_resolved", signal_id=signal_id,
                     outcomes=[o.name for o in all_outcomes])
            return signal_id

    async def resolve_all_pending(
        self,
        validator_hotkey: str,
    ) -> list[str]:
        """Check all pending signals and resolve any with completed games.

        Returns a list of signal_ids that were newly resolved (outcomes stored
        on their metadata).  Settlement happens later at the audit-set level.
        """
        resolved: list[str] = []
        for meta in self.get_pending_signals():
            signal_id = await self.resolve_signal(
                meta.signal_id, validator_hotkey,
            )
            if signal_id is not None:
                resolved.append(signal_id)
        return resolved

    def attest(
        self,
        signal_id: str,
        validator_hotkey: str,
        outcome: Outcome,
        event_result: EventResult,
    ) -> OutcomeAttestation:
        """Record this validator's outcome attestation."""
        # Check for duplicate attestation from same validator
        existing = self._attestations.get(signal_id, [])
        for att in existing:
            if att.validator_hotkey == validator_hotkey:
                log.warning(
                    "duplicate_attestation_skipped",
                    signal_id=signal_id,
                    validator_hotkey=validator_hotkey,
                    existing_outcome=att.outcome.name,
                )
                return att

        attestation = OutcomeAttestation(
            signal_id=signal_id,
            validator_hotkey=validator_hotkey,
            outcome=outcome,
            event_result=event_result,
        )

        if signal_id not in self._attestations:
            self._attestations[signal_id] = []
        if len(self._attestations[signal_id]) < self.MAX_ATTESTATIONS_PER_SIGNAL:
            self._attestations[signal_id].append(attestation)

        log.info(
            "outcome_attested",
            signal_id=signal_id,
            outcome=outcome.name,
        )
        return attestation

    def check_consensus(
        self,
        signal_id: str,
        total_validators: int,
        quorum: float = 2 / 3,
    ) -> Outcome | None:
        """Check if 2/3+ consensus has been reached for a signal.

        Returns the consensus outcome, or None if not yet reached.
        """
        attestations = self._attestations.get(signal_id, [])
        if not attestations:
            return None

        if total_validators <= 0:
            return None

        # ≥ 2/3 quorum: ceil ensures we round up for non-integer products.
        # Previous formula (int(x) + 1) was off-by-one when total_validators
        # * quorum was exact (e.g. 3 * 2/3 = 2 → required 3/3 instead of 2/3).
        threshold = math.ceil(total_validators * quorum)

        # Count votes per outcome
        votes: dict[Outcome, int] = {}
        for a in attestations:
            votes[a.outcome] = votes.get(a.outcome, 0) + 1

        for outcome, count in votes.items():
            if count >= threshold:
                log.info(
                    "consensus_reached",
                    signal_id=signal_id,
                    outcome=outcome.name,
                    votes=count,
                    threshold=threshold,
                )
                return outcome

        return None

    async def cleanup_resolved(self, max_age_seconds: float = 86400) -> int:
        """Remove resolved signals and old attestations to prevent memory growth.

        Removes signals resolved more than max_age_seconds ago (default: 24h).
        Returns count of removed entries.  Protected by the same lock as
        resolve_signal to prevent TOCTOU races.
        """
        async with self._lock:
            now = time.time()
            removed = 0

            stale_ids = [
                sid
                for sid, meta in list(self._pending_signals.items())
                if meta.resolved and now - meta.purchased_at > max_age_seconds
            ]
            for sid in stale_ids:
                del self._pending_signals[sid]
                self._attestations.pop(sid, None)
                removed += 1

            if removed:
                log.info("outcomes_cleaned", removed=removed)

            return removed

    async def close(self) -> None:
        try:
            await asyncio.wait_for(self._espn.close(), timeout=5.0)
        except TimeoutError:
            log.warning("outcome_attestor_close_timeout")
        except Exception as e:
            log.warning("outcome_attestor_close_error", error=str(e))
