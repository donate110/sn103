"""End-to-end audit cycle test: 10 signals from creation through batch settlement.

Tests the complete Genius -> Idiot -> 10-game audit cycle through the
validator orchestration layer, exercising:

1. Signal creation with Shamir shares (Genius stores key shares)
2. Purchase with MPC availability check (Idiot buys signal)
3. Registration for blind outcome tracking (10 decoy lines per signal)
4. Game resolution with mocked ESPN data (100 outcomes = 10 signals x 10 lines)
5. Batch settlement with quality score verification

Everything is real except ESPN (deterministic game results via FakeESPNClient).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest
from fastapi.testclient import TestClient

from djinn_validator.api.server import create_app
from djinn_validator.core.audit_set import AuditSetStore
from djinn_validator.core.espn import ESPNGame
from djinn_validator.core.mpc_audit import batch_settle_audit_set
from djinn_validator.core.mpc_coordinator import MPCCoordinator
from djinn_validator.core.outcomes import Outcome, OutcomeAttestor
from djinn_validator.core.purchase import PurchaseOrchestrator
from djinn_validator.core.shares import ShareStore
from djinn_validator.utils.crypto import Share


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GENIUS = "0x" + "aa" * 20
IDIOT = "0x" + "bb" * 20
CYCLE = 0

# 10 NBA matchups: (home_mascot, away_mascot, home_full, away_full)
NBA_MATCHUPS = [
    ("Lakers", "Celtics", "Los Angeles Lakers", "Boston Celtics"),
    ("Warriors", "Nets", "Golden State Warriors", "Brooklyn Nets"),
    ("Bucks", "Heat", "Milwaukee Bucks", "Miami Heat"),
    ("Suns", "Nuggets", "Phoenix Suns", "Denver Nuggets"),
    ("Mavericks", "76ers", "Dallas Mavericks", "Philadelphia 76ers"),
    ("Bulls", "Clippers", "Chicago Bulls", "Los Angeles Clippers"),
    ("Hawks", "Raptors", "Atlanta Hawks", "Toronto Raptors"),
    ("Pacers", "Wizards", "Indiana Pacers", "Washington Wizards"),
    ("Magic", "Pistons", "Orlando Magic", "Detroit Pistons"),
    ("Thunder", "Pelicans", "Oklahoma City Thunder", "New Orleans Pelicans"),
]


# ---------------------------------------------------------------------------
# Fake ESPN Client
# ---------------------------------------------------------------------------


class FakeESPNClient:
    """Deterministic ESPN client returning preset game results."""

    def __init__(self, games: dict[tuple[str, str], ESPNGame]) -> None:
        self._games = games

    async def get_game_by_teams(
        self,
        sport: str,
        home_team: str,
        away_team: str,
        date: str | None = None,
    ) -> ESPNGame | None:
        for (h, a), game in self._games.items():
            if _fuzzy_match(home_team, h) and _fuzzy_match(away_team, a):
                return game
        return None

    async def close(self) -> None:
        pass


def _fuzzy_match(query: str, target: str) -> bool:
    """Word-boundary match: 'Lakers' matches 'Los Angeles Lakers'."""
    q = query.lower()
    t = target.lower()
    if q == t:
        return True
    if q in t.split():
        return True
    if t in q.split():
        return True
    return False


# ---------------------------------------------------------------------------
# Signal Scenario
# ---------------------------------------------------------------------------


@dataclass
class SignalScenario:
    """Configuration for one signal in the audit cycle."""

    signal_id: str
    real_index: int  # 1-based: which of the 10 lines is the real pick
    home_team: str
    away_team: str
    home_full: str
    away_full: str
    event_id: str
    home_score: int | None  # None = game not yet played
    away_score: int | None
    game_status: str  # "final", "postponed", etc.
    lines: list[str] = field(default_factory=list)  # 10 pick strings
    expected_outcome: Outcome = Outcome.PENDING
    notional: int = 1_000_000  # $1 in 6-decimal
    odds: int = 2_000_000  # Even money (2.0)
    sla_bps: int = 10_000  # 100% SLA


def _build_lines(home: str, away: str) -> list[str]:
    """Build 10 deterministic pick strings for a matchup."""
    return [
        f"{home} -3.5 (-110)",    # 1: home spread
        f"{away} +3.5 (-110)",    # 2: away spread
        "Over 218.5 (-110)",      # 3: over
        "Under 218.5 (-110)",     # 4: under
        f"{home} ML (-150)",      # 5: home moneyline
        f"{away} ML (+130)",      # 6: away moneyline
        f"{home} -1.5 (-105)",    # 7: alt home spread
        f"{away} +1.5 (-115)",    # 8: alt away spread
        "Over 215.5 (-110)",      # 9: alt over
        "Under 215.5 (-110)",     # 10: alt under
    ]


def build_scenarios(variation: str) -> list[SignalScenario]:
    """Build 10 signal scenarios for a given test variation.

    With home=110, away=100 (total=210):
      Line 5 (home ML): FAVORABLE (home wins)
      Line 6 (away ML): UNFAVORABLE (away loses)
      Line 1 (home -3.5): FAVORABLE (110 - 3.5 = 106.5 > 100)
      Line 3 (Over 218.5): UNFAVORABLE (210 < 218.5)
      Line 4 (Under 218.5): FAVORABLE (210 < 218.5)
    """
    scenarios = []
    for i, (home, away, home_full, away_full) in enumerate(NBA_MATCHUPS):
        signal_id = f"audit-{variation}-{i:02d}"
        event_id = f"espn-nba-{i:04d}"
        lines = _build_lines(home, away)

        if variation == "all_wins":
            # Real pick = line 5 (home ML), home wins → FAVORABLE
            scenarios.append(SignalScenario(
                signal_id=signal_id, real_index=5,
                home_team=home, away_team=away,
                home_full=home_full, away_full=away_full,
                event_id=event_id,
                home_score=110, away_score=100, game_status="final",
                lines=lines, expected_outcome=Outcome.FAVORABLE,
            ))

        elif variation == "all_losses":
            # Real pick = line 6 (away ML), home wins → UNFAVORABLE
            scenarios.append(SignalScenario(
                signal_id=signal_id, real_index=6,
                home_team=home, away_team=away,
                home_full=home_full, away_full=away_full,
                event_id=event_id,
                home_score=110, away_score=100, game_status="final",
                lines=lines, expected_outcome=Outcome.UNFAVORABLE,
            ))

        elif variation == "mixed":
            if i < 6:
                # First 6: home ML wins
                scenarios.append(SignalScenario(
                    signal_id=signal_id, real_index=5,
                    home_team=home, away_team=away,
                    home_full=home_full, away_full=away_full,
                    event_id=event_id,
                    home_score=110, away_score=100, game_status="final",
                    lines=lines, expected_outcome=Outcome.FAVORABLE,
                ))
            elif i < 8:
                # Next 2: away ML loses
                scenarios.append(SignalScenario(
                    signal_id=signal_id, real_index=6,
                    home_team=home, away_team=away,
                    home_full=home_full, away_full=away_full,
                    event_id=event_id,
                    home_score=110, away_score=100, game_status="final",
                    lines=lines, expected_outcome=Outcome.UNFAVORABLE,
                ))
            else:
                # Last 2: postponed → VOID
                scenarios.append(SignalScenario(
                    signal_id=signal_id, real_index=5,
                    home_team=home, away_team=away,
                    home_full=home_full, away_full=away_full,
                    event_id=event_id,
                    home_score=None, away_score=None, game_status="postponed",
                    lines=lines, expected_outcome=Outcome.VOID,
                ))

        elif variation == "all_voids":
            # All games postponed → VOID
            scenarios.append(SignalScenario(
                signal_id=signal_id, real_index=5,
                home_team=home, away_team=away,
                home_full=home_full, away_full=away_full,
                event_id=event_id,
                home_score=None, away_score=None, game_status="postponed",
                lines=lines, expected_outcome=Outcome.VOID,
            ))

        else:
            raise ValueError(f"Unknown variation: {variation}")

    return scenarios


def build_fake_espn(scenarios: list[SignalScenario]) -> FakeESPNClient:
    """Build a FakeESPNClient from a list of scenarios."""
    games: dict[tuple[str, str], ESPNGame] = {}
    for s in scenarios:
        games[(s.home_full, s.away_full)] = ESPNGame(
            espn_id=s.event_id,
            home_team=s.home_full,
            away_team=s.away_full,
            home_score=s.home_score,
            away_score=s.away_score,
            status=s.game_status,
        )
    return FakeESPNClient(games)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@dataclass
class E2EHarness:
    """All components for the audit cycle test."""

    share_store: ShareStore
    audit_set_store: AuditSetStore
    outcome_attestor: OutcomeAttestor
    purchase_orch: PurchaseOrchestrator
    client: TestClient


@pytest.fixture
def harness_factory():
    """Factory that builds a test harness with a given FakeESPNClient."""
    stores: list[ShareStore] = []

    def _build(fake_espn: FakeESPNClient) -> E2EHarness:
        share_store = ShareStore()  # in-memory
        stores.append(share_store)
        audit_set_store = AuditSetStore()
        outcome_attestor = OutcomeAttestor(espn_client=fake_espn)
        purchase_orch = PurchaseOrchestrator(share_store)
        mpc_coordinator = MPCCoordinator()
        app = create_app(
            share_store=share_store,
            purchase_orch=purchase_orch,
            outcome_attestor=outcome_attestor,
            mpc_coordinator=mpc_coordinator,
            audit_set_store=audit_set_store,
        )
        client = TestClient(app)
        return E2EHarness(
            share_store=share_store,
            audit_set_store=audit_set_store,
            outcome_attestor=outcome_attestor,
            purchase_orch=purchase_orch,
            client=client,
        )

    yield _build
    for store in stores:
        store.close()


# ---------------------------------------------------------------------------
# Helper: run full cycle phases
# ---------------------------------------------------------------------------


def _store_shares(h: E2EHarness, scenarios: list[SignalScenario]) -> None:
    """Phase 1: Genius stores Shamir shares for all signals."""
    for s in scenarios:
        h.share_store.store(
            signal_id=s.signal_id,
            genius_address=GENIUS,
            share=Share(x=1, y=s.real_index),
            encrypted_key_share=f"aes-key-{s.signal_id}".encode(),
            encrypted_index_share=s.real_index.to_bytes(32, "big"),
        )


def _purchase_all(h: E2EHarness, scenarios: list[SignalScenario]) -> None:
    """Phase 2: Idiot purchases all signals via the API."""
    for s in scenarios:
        resp = h.client.post(f"/v1/signal/{s.signal_id}/purchase", json={
            "buyer_address": IDIOT,
            "sportsbook": "DraftKings",
            "available_indices": list(range(1, 11)),
        })
        assert resp.status_code == 200, f"Purchase failed for {s.signal_id}: {resp.text}"
        data = resp.json()
        assert data["available"] is True, f"Signal {s.signal_id} not available"
        assert data["status"] == "complete"
        assert data.get("encrypted_key_share"), f"No key share for {s.signal_id}"


def _register_all(h: E2EHarness, scenarios: list[SignalScenario]) -> None:
    """Phase 3: Register all signals for blind outcome tracking."""
    for s in scenarios:
        resp = h.client.post(f"/v1/signal/{s.signal_id}/register", json={
            "sport": "basketball_nba",
            "event_id": s.event_id,
            "home_team": s.home_full,
            "away_team": s.away_full,
            "lines": s.lines,
            "genius_address": GENIUS,
            "idiot_address": IDIOT,
            "notional": s.notional,
            "odds": s.odds,
            "sla_bps": s.sla_bps,
            "cycle": CYCLE,
        })
        assert resp.status_code == 200, f"Register failed for {s.signal_id}: {resp.text}"
        assert resp.json()["registered"] is True


def _resolve_games(h: E2EHarness) -> int:
    """Phase 4: Resolve all pending signals via the API. Returns resolved count."""
    resp = h.client.post("/v1/signals/resolve")
    assert resp.status_code == 200, f"Resolve failed: {resp.text}"
    data = resp.json()
    return data.get("resolved_count", 0)


def _settle(h: E2EHarness):
    """Phase 5: Run batch settlement."""
    audit_set = h.audit_set_store.get_set(GENIUS, IDIOT, CYCLE)
    assert audit_set is not None, "Audit set not found"
    assert audit_set.ready_for_settlement, (
        f"Audit set not ready: {len(audit_set.signals)} signals, "
        f"all_resolved={audit_set.all_resolved}, settled={audit_set.settled}"
    )
    return batch_settle_audit_set(audit_set, h.share_store, threshold=1)


# ---------------------------------------------------------------------------
# Tests: Full Audit Cycle
# ---------------------------------------------------------------------------


class TestFullAuditCycle:
    """Full 10-signal audit cycle from creation through batch settlement."""

    @pytest.mark.parametrize("variation,expected_wins,expected_losses,expected_voids,expected_qs", [
        ("all_wins", 10, 0, 0, 10_000_000),
        ("all_losses", 0, 10, 0, -10_000_000),
        ("mixed", 6, 2, 2, 4_000_000),
        ("all_voids", 0, 0, 10, 0),
    ])
    def test_audit_cycle(
        self,
        harness_factory,
        variation: str,
        expected_wins: int,
        expected_losses: int,
        expected_voids: int,
        expected_qs: int,
    ) -> None:
        """Drive 10 signals through the complete lifecycle and verify settlement."""
        scenarios = build_scenarios(variation)
        fake_espn = build_fake_espn(scenarios)
        h = harness_factory(fake_espn)

        # Phase 1: Genius stores shares
        _store_shares(h, scenarios)

        # Phase 2: Idiot purchases all 10
        _purchase_all(h, scenarios)

        # Phase 3: Register for outcome tracking
        _register_all(h, scenarios)

        # Verify audit set has all 10 signals
        audit_set = h.audit_set_store.get_set(GENIUS, IDIOT, CYCLE)
        assert audit_set is not None
        assert audit_set.is_full
        assert not audit_set.all_resolved

        # Phase 4: Games resolve
        resolved_count = _resolve_games(h)
        assert resolved_count == 10, f"Expected 10 resolved, got {resolved_count}"

        # Verify all 10 signals have 10 outcomes each
        for s in scenarios:
            meta = h.outcome_attestor.get_signal(s.signal_id)
            assert meta is not None, f"Signal {s.signal_id} not found"
            assert meta.resolved, f"Signal {s.signal_id} not resolved"
            assert meta.outcomes is not None
            assert len(meta.outcomes) == 10, f"Expected 10 outcomes, got {len(meta.outcomes)}"

        # Phase 5: Batch settlement
        result = _settle(h)
        assert result is not None

        # Verify aggregate statistics
        assert result.n == 10
        assert result.genius == GENIUS
        assert result.idiot == IDIOT
        assert result.cycle == CYCLE
        assert result.wins == expected_wins, f"wins: {result.wins} != {expected_wins}"
        assert result.losses == expected_losses, f"losses: {result.losses} != {expected_losses}"
        assert result.voids == expected_voids, f"voids: {result.voids} != {expected_voids}"
        assert result.wins + result.losses + result.voids == 10
        assert result.quality_score == expected_qs, (
            f"quality_score: {result.quality_score} != {expected_qs}"
        )

    def test_individual_outcomes_match(self, harness_factory) -> None:
        """Verify that each signal's real outcome matches expectations."""
        scenarios = build_scenarios("mixed")
        fake_espn = build_fake_espn(scenarios)
        h = harness_factory(fake_espn)

        _store_shares(h, scenarios)
        _purchase_all(h, scenarios)
        _register_all(h, scenarios)
        _resolve_games(h)

        for s in scenarios:
            meta = h.outcome_attestor.get_signal(s.signal_id)
            assert meta is not None
            # The real outcome is at real_index - 1 (0-based)
            real_outcome = meta.outcomes[s.real_index - 1]
            assert real_outcome == s.expected_outcome, (
                f"{s.signal_id}: real_index={s.real_index}, "
                f"outcome={real_outcome.name}, expected={s.expected_outcome.name}"
            )


# ---------------------------------------------------------------------------
# Tests: Edge Cases
# ---------------------------------------------------------------------------


class TestAuditCycleEdgeCases:
    """Edge cases that prevent or affect settlement."""

    def test_partial_set_no_settlement(self, harness_factory) -> None:
        """Only 8 signals → audit set not full → settlement returns None."""
        scenarios = build_scenarios("all_wins")[:8]  # Only 8 of 10
        fake_espn = build_fake_espn(scenarios)
        h = harness_factory(fake_espn)

        _store_shares(h, scenarios)
        _purchase_all(h, scenarios)
        _register_all(h, scenarios)
        _resolve_games(h)

        audit_set = h.audit_set_store.get_set(GENIUS, IDIOT, CYCLE)
        assert audit_set is not None
        assert not audit_set.is_full  # Only 8 signals
        assert not audit_set.ready_for_settlement

        result = batch_settle_audit_set(audit_set, h.share_store, threshold=1)
        assert result is None

    def test_unresolved_blocks_settlement(self, harness_factory) -> None:
        """10 signals registered but 2 games pending → settlement blocked."""
        # First 8 games are final, last 2 are "pending" (not postponed!)
        scenarios = build_scenarios("all_wins")
        # Override last 2 to have status="pending" (game not played yet)
        for s in scenarios[8:]:
            s.game_status = "pending"
            s.home_score = None
            s.away_score = None

        fake_espn = build_fake_espn(scenarios)
        h = harness_factory(fake_espn)

        _store_shares(h, scenarios)
        _purchase_all(h, scenarios)
        _register_all(h, scenarios)
        _resolve_games(h)

        audit_set = h.audit_set_store.get_set(GENIUS, IDIOT, CYCLE)
        assert audit_set is not None
        assert audit_set.is_full  # All 10 registered
        assert not audit_set.all_resolved  # 2 still pending
        assert not audit_set.ready_for_settlement

        result = batch_settle_audit_set(audit_set, h.share_store, threshold=1)
        assert result is None

    def test_nonuniform_economics(self, harness_factory) -> None:
        """Each signal has different notional/odds/sla → verify quality score formula."""
        scenarios = build_scenarios("all_wins")

        # Customize economics per signal
        economics = [
            # (notional, odds, sla_bps)
            (500_000, 1_910_000, 10_000),   # $0.50 @ -110 (1.91)
            (1_000_000, 2_500_000, 10_000),  # $1.00 @ +150 (2.50)
            (2_000_000, 1_500_000, 10_000),  # $2.00 @ -200 (1.50)
            (100_000, 3_000_000, 10_000),    # $0.10 @ +200 (3.00)
            (750_000, 2_000_000, 10_000),    # $0.75 @ even (2.00)
            (300_000, 1_800_000, 15_000),    # $0.30 @ -125 (1.80), 150% SLA
            (1_500_000, 2_200_000, 5_000),   # $1.50 @ +120 (2.20), 50% SLA
            (400_000, 1_700_000, 20_000),    # $0.40 @ -143 (1.70), 200% SLA
            (800_000, 2_100_000, 10_000),    # $0.80 @ +100 (2.10)
            (600_000, 1_950_000, 10_000),    # $0.60 @ -105 (1.95)
        ]

        expected_qs = 0
        for i, (notional, odds, sla_bps) in enumerate(economics):
            scenarios[i].notional = notional
            scenarios[i].odds = odds
            scenarios[i].sla_bps = sla_bps
            # All wins: FAVORABLE → +notional * (odds - 1_000_000) / 1_000_000
            expected_qs += notional * (odds - 1_000_000) // 1_000_000

        fake_espn = build_fake_espn(scenarios)
        h = harness_factory(fake_espn)

        _store_shares(h, scenarios)
        _purchase_all(h, scenarios)
        _register_all(h, scenarios)
        _resolve_games(h)

        result = _settle(h)
        assert result is not None
        assert result.wins == 10
        assert result.quality_score == expected_qs, (
            f"quality_score: {result.quality_score} != {expected_qs}"
        )

    def test_multi_cycle_independence(self, harness_factory) -> None:
        """Two independent audit cycles settle independently."""
        scenarios_c0 = build_scenarios("all_wins")
        scenarios_c1 = build_scenarios("all_losses")
        # Give cycle 1 different signal IDs
        for s in scenarios_c1:
            s.signal_id = s.signal_id.replace("all_losses", "cycle1")

        all_scenarios = scenarios_c0 + scenarios_c1
        fake_espn = build_fake_espn(all_scenarios)
        h = harness_factory(fake_espn)

        # Store and purchase both cycles
        _store_shares(h, all_scenarios)
        _purchase_all(h, all_scenarios)

        # Register cycle 0
        for s in scenarios_c0:
            resp = h.client.post(f"/v1/signal/{s.signal_id}/register", json={
                "sport": "basketball_nba",
                "event_id": s.event_id,
                "home_team": s.home_full,
                "away_team": s.away_full,
                "lines": s.lines,
                "genius_address": GENIUS,
                "idiot_address": IDIOT,
                "notional": s.notional,
                "odds": s.odds,
                "sla_bps": s.sla_bps,
                "cycle": 0,
            })
            assert resp.status_code == 200

        # Register cycle 1
        for s in scenarios_c1:
            resp = h.client.post(f"/v1/signal/{s.signal_id}/register", json={
                "sport": "basketball_nba",
                "event_id": s.event_id,
                "home_team": s.home_full,
                "away_team": s.away_full,
                "lines": s.lines,
                "genius_address": GENIUS,
                "idiot_address": IDIOT,
                "notional": s.notional,
                "odds": s.odds,
                "sla_bps": s.sla_bps,
                "cycle": 1,
            })
            assert resp.status_code == 200

        # Resolve all
        _resolve_games(h)

        # Settle cycle 0 (all wins)
        audit_c0 = h.audit_set_store.get_set(GENIUS, IDIOT, 0)
        assert audit_c0 is not None and audit_c0.ready_for_settlement
        result_c0 = batch_settle_audit_set(audit_c0, h.share_store, threshold=1)
        assert result_c0 is not None
        assert result_c0.wins == 10
        assert result_c0.quality_score == 10_000_000

        # Settle cycle 1 (all losses)
        audit_c1 = h.audit_set_store.get_set(GENIUS, IDIOT, 1)
        assert audit_c1 is not None and audit_c1.ready_for_settlement
        result_c1 = batch_settle_audit_set(audit_c1, h.share_store, threshold=1)
        assert result_c1 is not None
        assert result_c1.losses == 10
        assert result_c1.quality_score == -10_000_000
