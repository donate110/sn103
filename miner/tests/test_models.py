"""Tests for Pydantic request/response model validation."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from djinn_miner.api.models import (
    CandidateLine,
    CheckRequest,
    CheckResponse,
    LineResult,
    ProofRequest,
)


class TestCandidateLine:
    def test_valid_line(self) -> None:
        line = CandidateLine(
            index=1,
            sport="basketball_nba",
            event_id="ev-1",
            home_team="Lakers",
            away_team="Celtics",
            market="spreads",
            line=-3.5,
            side="Lakers",
        )
        assert line.index == 1

    def test_index_too_low(self) -> None:
        with pytest.raises(ValidationError, match="index"):
            CandidateLine(
                index=0,
                sport="basketball_nba",
                event_id="ev-1",
                home_team="Lakers",
                away_team="Celtics",
                market="spreads",
                line=-3.5,
                side="Lakers",
            )

    def test_index_too_high(self) -> None:
        with pytest.raises(ValidationError, match="index"):
            CandidateLine(
                index=2001,
                sport="basketball_nba",
                event_id="ev-1",
                home_team="Lakers",
                away_team="Celtics",
                market="spreads",
                line=-3.5,
                side="Lakers",
            )

    def test_h2h_line_can_be_none(self) -> None:
        line = CandidateLine(
            index=1,
            sport="basketball_nba",
            event_id="ev-1",
            home_team="Lakers",
            away_team="Celtics",
            market="h2h",
            line=None,
            side="Lakers",
        )
        assert line.line is None


class TestCheckRequest:
    def test_valid_request(self) -> None:
        req = CheckRequest(
            lines=[
                CandidateLine(
                    index=1,
                    sport="basketball_nba",
                    event_id="ev-1",
                    home_team="Lakers",
                    away_team="Celtics",
                    market="spreads",
                    line=-3.5,
                    side="Lakers",
                ),
            ],
        )
        assert len(req.lines) == 1

    def test_empty_lines_rejected(self) -> None:
        with pytest.raises(ValidationError, match="lines"):
            CheckRequest(lines=[])

    def test_too_many_lines_rejected(self) -> None:
        line = CandidateLine(
            index=1,
            sport="basketball_nba",
            event_id="ev-1",
            home_team="Lakers",
            away_team="Celtics",
            market="spreads",
            line=-3.5,
            side="Lakers",
        )
        with pytest.raises(ValidationError, match="lines"):
            CheckRequest(lines=[line] * 2001)


class TestProofRequest:
    def test_valid_request(self) -> None:
        req = ProofRequest(query_id="q-1")
        assert req.session_data == ""

    def test_with_session_data(self) -> None:
        req = ProofRequest(query_id="q-1", session_data="some-session")
        assert req.session_data == "some-session"

    def test_query_id_too_long(self) -> None:
        with pytest.raises(ValidationError):
            ProofRequest(query_id="x" * 300)

    def test_session_data_too_long(self) -> None:
        with pytest.raises(ValidationError):
            ProofRequest(query_id="q-1", session_data="x" * 20_000)


class TestMarketValidation:
    def test_valid_markets(self) -> None:
        for market in ("spreads", "totals", "h2h"):
            line = CandidateLine(
                index=1, sport="basketball_nba", event_id="ev-1",
                home_team="A", away_team="B", market=market, side="A",
            )
            assert line.market == market

    def test_unknown_market_accepted(self) -> None:
        """Unknown markets are accepted (not rejected) so validators can send
        synthetic challenge markets without getting 422 errors."""
        line = CandidateLine(
            index=1, sport="basketball_nba", event_id="ev-1",
            home_team="A", away_team="B", market="moneyline", side="A",
        )
        assert line.market == "moneyline"

    def test_empty_market_accepted(self) -> None:
        """Empty market string is accepted; miner reports it as unavailable."""
        line = CandidateLine(
            index=1, sport="basketball_nba", event_id="ev-1",
            home_team="A", away_team="B", market="", side="A",
        )
        assert line.market == ""


class TestCheckResponseQueryId:
    """Tests for CheckResponse.query_id field."""

    def test_query_id_default_none(self) -> None:
        resp = CheckResponse(
            results=[], available_indices=[], response_time_ms=1.0
        )
        assert resp.query_id is None

    def test_query_id_set(self) -> None:
        resp = CheckResponse(
            results=[], available_indices=[], response_time_ms=1.0,
            query_id="basketball_nba:h2h:abc12345",
        )
        assert resp.query_id == "basketball_nba:h2h:abc12345"

    def test_query_id_too_long(self) -> None:
        with pytest.raises(ValidationError):
            CheckResponse(
                results=[], available_indices=[], response_time_ms=1.0,
                query_id="x" * 300,
            )

    def test_query_id_in_json(self) -> None:
        resp = CheckResponse(
            results=[LineResult(index=1, available=True, bookmakers=[])],
            available_indices=[1],
            response_time_ms=5.0,
            query_id="test-q",
        )
        data = resp.model_dump()
        assert data["query_id"] == "test-q"

    def test_query_id_absent_in_json(self) -> None:
        resp = CheckResponse(
            results=[], available_indices=[], response_time_ms=1.0,
        )
        data = resp.model_dump()
        assert data["query_id"] is None


class TestStringLengthLimits:
    """Verify max_length constraints on CandidateLine fields."""

    def test_sport_too_long(self) -> None:
        with pytest.raises(ValidationError):
            CandidateLine(
                index=1,
                sport="x" * 200,
                event_id="ev-1",
                home_team="A",
                away_team="B",
                market="h2h",
                side="A",
            )

    def test_event_id_too_long(self) -> None:
        with pytest.raises(ValidationError):
            CandidateLine(
                index=1,
                sport="nba",
                event_id="x" * 300,
                home_team="A",
                away_team="B",
                market="h2h",
                side="A",
            )

    def test_team_name_too_long(self) -> None:
        with pytest.raises(ValidationError):
            CandidateLine(
                index=1,
                sport="nba",
                event_id="ev-1",
                home_team="x" * 300,
                away_team="B",
                market="h2h",
                side="A",
            )

    def test_market_too_long(self) -> None:
        with pytest.raises(ValidationError):
            CandidateLine(
                index=1,
                sport="nba",
                event_id="ev-1",
                home_team="A",
                away_team="B",
                market="x" * 100,
                side="A",
            )
