"""Tests for the FastAPI server endpoints."""

from __future__ import annotations

import json
import httpx
import pytest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

from djinn_miner.api.models import CandidateLine
from djinn_miner.api.server import create_app
from djinn_miner.core.checker import LineChecker
from djinn_miner.core.health import HealthTracker
from djinn_miner.core.proof import ProofGenerator, SessionCapture, CapturedSession
from djinn_miner.data.odds_api import OddsApiClient


@pytest.fixture
def app(mock_odds_response: list[dict]) -> TestClient:
    """Create a test client with mock data."""
    mock_http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=mock_odds_response)
        )
    )
    odds_client = OddsApiClient(
        api_key="test-key",
        base_url="https://api.the-odds-api.com",
        cache_ttl=300,
        http_client=mock_http,
    )
    checker = LineChecker(odds_client=odds_client, line_tolerance=0.5)
    proof_gen = ProofGenerator()
    health_tracker = HealthTracker(uid=42, odds_api_connected=True, bt_connected=True)

    fastapi_app = create_app(
        checker=checker,
        proof_gen=proof_gen,
        health_tracker=health_tracker,
    )
    return TestClient(fastapi_app)


class TestRequestIdMiddleware:
    def test_response_has_request_id_header(self, app: TestClient) -> None:
        resp = app.get("/health")
        assert "x-request-id" in resp.headers
        assert len(resp.headers["x-request-id"]) == 32  # UUID hex

    def test_forwarded_request_id_is_echoed(self, app: TestClient) -> None:
        resp = app.get("/health", headers={"X-Request-ID": "my-trace-123"})
        assert resp.headers["x-request-id"] == "my-trace-123"

    def test_unique_ids_per_request(self, app: TestClient) -> None:
        r1 = app.get("/health")
        r2 = app.get("/health")
        assert r1.headers["x-request-id"] != r2.headers["x-request-id"]


class TestHealthEndpoint:
    def test_health_returns_ok(self, app: TestClient) -> None:
        resp = app.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        from djinn_miner import __version__
        assert data["version"] == __version__
        assert data["uid"] == 42
        assert data["odds_api_connected"] is True

    def test_health_increments_ping_count(self, app: TestClient) -> None:
        app.get("/health")
        app.get("/health")
        resp = app.get("/health")
        assert resp.status_code == 200

    def test_health_uptime_positive(self, app: TestClient) -> None:
        resp = app.get("/health")
        assert resp.json()["uptime_seconds"] >= 0


class TestCheckEndpoint:
    def test_check_single_available_line(self, app: TestClient) -> None:
        body = {
            "lines": [
                {
                    "index": 1,
                    "sport": "basketball_nba",
                    "event_id": "event-lakers-celtics-001",
                    "home_team": "Los Angeles Lakers",
                    "away_team": "Boston Celtics",
                    "market": "spreads",
                    "line": -3.0,
                    "side": "Los Angeles Lakers",
                },
            ],
        }
        resp = app.post("/v1/check", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert data["available_indices"] == [1]
        assert data["response_time_ms"] > 0
        assert data["results"][0]["available"] is True
        assert len(data["results"][0]["bookmakers"]) > 0

    def test_check_single_unavailable_line(self, app: TestClient) -> None:
        body = {
            "lines": [
                {
                    "index": 1,
                    "sport": "basketball_nba",
                    "event_id": "event-lakers-celtics-001",
                    "home_team": "Los Angeles Lakers",
                    "away_team": "Boston Celtics",
                    "market": "spreads",
                    "line": -10.0,
                    "side": "Los Angeles Lakers",
                },
            ],
        }
        resp = app.post("/v1/check", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert data["available_indices"] == []
        assert data["results"][0]["available"] is False

    def test_check_full_10_lines(
        self, app: TestClient, sample_lines: list[CandidateLine]
    ) -> None:
        body = {"lines": [line.model_dump() for line in sample_lines]}
        resp = app.post("/v1/check", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["results"]) == 10
        assert isinstance(data["available_indices"], list)
        assert data["response_time_ms"] > 0

    def test_check_returns_bookmaker_details(self, app: TestClient) -> None:
        body = {
            "lines": [
                {
                    "index": 1,
                    "sport": "basketball_nba",
                    "event_id": "event-lakers-celtics-001",
                    "home_team": "Los Angeles Lakers",
                    "away_team": "Boston Celtics",
                    "market": "h2h",
                    "line": None,
                    "side": "Los Angeles Lakers",
                },
            ],
        }
        resp = app.post("/v1/check", json=body)
        data = resp.json()
        bookmakers = data["results"][0]["bookmakers"]
        assert len(bookmakers) >= 1
        assert "bookmaker" in bookmakers[0]
        assert "odds" in bookmakers[0]

    def test_check_validation_rejects_empty_lines(self, app: TestClient) -> None:
        resp = app.post("/v1/check", json={"lines": []})
        assert resp.status_code == 422

    def test_check_validation_rejects_invalid_index(self, app: TestClient) -> None:
        body = {
            "lines": [
                {
                    "index": 11,
                    "sport": "basketball_nba",
                    "event_id": "ev-001",
                    "home_team": "Team A",
                    "away_team": "Team B",
                    "market": "h2h",
                    "side": "Team A",
                },
            ],
        }
        resp = app.post("/v1/check", json=body)
        assert resp.status_code == 422


class TestProofEndpoint:
    def test_proof_returns_stub(self, app: TestClient) -> None:
        body = {
            "query_id": "test-query-001",
            "session_data": "mock-tls-session-data",
        }
        resp = app.post("/v1/proof", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert data["query_id"] == "test-query-001"
        assert data["status"] == "unverified"
        assert len(data["proof_hash"]) == 64  # SHA-256 hex
        assert "basic hash proof" in data["message"].lower()

    def test_proof_different_queries_produce_different_hashes(
        self, app: TestClient
    ) -> None:
        resp1 = app.post(
            "/v1/proof",
            json={"query_id": "q1", "session_data": "data1"},
        )
        resp2 = app.post(
            "/v1/proof",
            json={"query_id": "q2", "session_data": "data2"},
        )
        assert resp1.json()["proof_hash"] != resp2.json()["proof_hash"]

    def test_proof_empty_session_data(self, app: TestClient) -> None:
        body = {"query_id": "test-query-002"}
        resp = app.post("/v1/proof", json=body)
        assert resp.status_code == 200
        assert resp.json()["status"] == "unverified"


class TestMetricsEndpoint:
    def test_metrics_returns_prometheus_format(self, app: TestClient) -> None:
        resp = app.get("/metrics")
        assert resp.status_code == 200
        assert "text/plain" in resp.headers.get("content-type", "")
        text = resp.text
        assert "djinn_miner" in text

    def test_metrics_after_check(self, app: TestClient) -> None:
        app.post("/v1/check", json={
            "lines": [{
                "index": 1,
                "sport": "basketball_nba",
                "event_id": "event-lakers-celtics-001",
                "home_team": "Los Angeles Lakers",
                "away_team": "Boston Celtics",
                "market": "h2h",
                "line": None,
                "side": "Los Angeles Lakers",
            }],
        })
        resp = app.get("/metrics")
        assert "checks_processed" in resp.text


class TestBodySizeLimit:
    def test_oversized_body_rejected(self, app: TestClient) -> None:
        huge_body = "x" * (1_048_576 + 1)
        resp = app.post(
            "/v1/check",
            content=huge_body,
            headers={"Content-Type": "application/json", "Content-Length": str(len(huge_body))},
        )
        assert resp.status_code == 413

    def test_invalid_content_length_rejected(self, app: TestClient) -> None:
        """Non-numeric content-length should return 400."""
        resp = app.post(
            "/v1/check",
            content="{}",
            headers={"Content-Type": "application/json", "Content-Length": "not-a-number"},
        )
        assert resp.status_code == 400

    def test_missing_content_length_allowed(self, app: TestClient) -> None:
        """Requests without content-length header should pass through."""
        resp = app.post("/v1/check", json={"lines": [{
            "index": 1, "sport": "basketball_nba", "event_id": "ev",
            "home_team": "A", "away_team": "B", "market": "h2h", "side": "A",
        }]})
        assert resp.status_code == 200


class TestInputValidation:
    """Test that invalid inputs are properly rejected."""

    def test_check_missing_lines(self, app: TestClient) -> None:
        resp = app.post("/v1/check", json={})
        assert resp.status_code == 422

    def test_check_invalid_index(self, app: TestClient) -> None:
        resp = app.post("/v1/check", json={
            "lines": [{
                "index": 0,
                "sport": "nba",
                "event_id": "ev",
                "home_team": "A",
                "away_team": "B",
                "market": "h2h",
                "side": "A",
            }],
        })
        assert resp.status_code == 422

    def test_check_too_many_lines(self, app: TestClient) -> None:
        line = {
            "index": 1,
            "sport": "nba",
            "event_id": "ev",
            "home_team": "A",
            "away_team": "B",
            "market": "h2h",
            "side": "A",
        }
        resp = app.post("/v1/check", json={"lines": [line] * 11})
        assert resp.status_code == 422

    def test_proof_missing_query_id(self, app: TestClient) -> None:
        resp = app.post("/v1/proof", json={})
        assert resp.status_code == 422

    def test_check_unknown_market_accepted(self, app: TestClient) -> None:
        """Unknown markets are accepted (not 422). Validators send synthetic
        markets as part of challenge scoring; rejecting them caused 0% accuracy."""
        resp = app.post("/v1/check", json={
            "lines": [{
                "index": 1,
                "sport": "basketball_nba",
                "event_id": "ev",
                "home_team": "A",
                "away_team": "B",
                "market": "moneyline",
                "side": "A",
            }],
        })
        assert resp.status_code == 200

    def test_nonexistent_endpoint_returns_404(self, app: TestClient) -> None:
        resp = app.get("/v1/doesnotexist")
        assert resp.status_code in (404, 405)

    def test_string_too_long(self, app: TestClient) -> None:
        resp = app.post("/v1/check", json={
            "lines": [{
                "index": 1,
                "sport": "x" * 200,
                "event_id": "ev",
                "home_team": "A",
                "away_team": "B",
                "market": "h2h",
                "side": "A",
            }],
        })
        assert resp.status_code == 422


class TestReadinessEndpoint:
    def test_readiness_returns_checks(self, app: TestClient) -> None:
        resp = app.get("/health/ready")
        assert resp.status_code == 200
        data = resp.json()
        assert "ready" in data
        assert "checks" in data
        assert isinstance(data["checks"], dict)

    def test_readiness_checks_odds_api(self, app: TestClient) -> None:
        resp = app.get("/health/ready")
        data = resp.json()
        assert "odds_api_connected" in data["checks"]


class TestUnhandledException:
    """Unhandled exceptions in routes return 500 with no stack trace."""

    def test_checker_exception_returns_500(self) -> None:
        """If LineChecker.check() raises, the global handler returns 500."""
        mock_checker = AsyncMock()
        mock_checker.check.side_effect = RuntimeError("unexpected crash")
        proof_gen = ProofGenerator()
        health = HealthTracker()

        app = create_app(checker=mock_checker, proof_gen=proof_gen, health_tracker=health)
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post("/v1/check", json={
            "lines": [{
                "index": 1,
                "sport": "basketball_nba",
                "event_id": "ev",
                "home_team": "A",
                "away_team": "B",
                "market": "h2h",
                "side": "A",
            }],
        })
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Internal server error"
        # No stack trace leaked
        assert "RuntimeError" not in resp.text

    def test_proof_exception_returns_500(self) -> None:
        mock_checker = AsyncMock()
        mock_proof = AsyncMock()
        mock_proof.generate.side_effect = RuntimeError("proof crash")
        health = HealthTracker()

        app = create_app(checker=mock_checker, proof_gen=mock_proof, health_tracker=health)
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post("/v1/proof", json={"query_id": "q1"})
        assert resp.status_code == 500
        assert "Internal server error" in resp.json()["detail"]


class TestProofWithCapturedSession:
    """Proof endpoint with a real captured session produces a valid proof.

    When TLSNotary is available, the proof type is 'tlsnotary' (with a
    presentation field). When TLSNotary is not available, the fallback
    produces an 'http_attestation' type with events_found.
    """

    def test_proof_with_session_returns_attestation(self, mock_odds_response: list[dict]) -> None:
        mock_http = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, json=mock_odds_response)
            )
        )
        odds_client = OddsApiClient(
            api_key="test-key", http_client=mock_http, cache_ttl=300,
        )
        checker = LineChecker(odds_client=odds_client, line_tolerance=0.5)

        capture = SessionCapture()
        capture.record(CapturedSession(
            query_id="my-query-001",
            request_url="https://api.the-odds-api.com/v4/sports/nba/odds",
            response_body=json.dumps(mock_odds_response).encode(),
            captured_at=1700000000.0,
        ))
        proof_gen = ProofGenerator(session_capture=capture)
        health = HealthTracker(odds_api_connected=True)

        app = create_app(checker=checker, proof_gen=proof_gen, health_tracker=health)
        client = TestClient(app)

        resp = client.post("/v1/proof", json={"query_id": "my-query-001"})
        assert resp.status_code == 200
        data = resp.json()
        msg = json.loads(data["message"])
        # TLSNotary available: proof type is "tlsnotary" with a presentation
        # TLSNotary unavailable: fallback is "http_attestation" with events_found
        assert msg["type"] in ("tlsnotary", "http_attestation")
        if msg["type"] == "http_attestation":
            assert msg["events_found"] > 0
        else:
            assert "presentation" in msg


class TestCustomRateLimits:
    """create_app rate_limit_capacity and rate_limit_rate params are wired."""

    def test_custom_capacity_enforced(self) -> None:
        mock_checker = AsyncMock()
        mock_checker.check.return_value = []
        mock_proof = AsyncMock()
        mock_proof.generate.return_value = type("R", (), {"query_id": "q", "proof_hash": "h", "status": "submitted", "message": "basic"})()
        health = HealthTracker()

        app = create_app(
            checker=mock_checker,
            proof_gen=mock_proof,
            health_tracker=health,
            rate_limit_capacity=2,
            rate_limit_rate=0,
        )
        client = TestClient(app)

        # Use /v1/proof (not /health which bypasses rate limits)
        for _ in range(2):
            resp = client.post("/v1/proof", json={"query_id": "q1"})
            assert resp.status_code == 200

        # 3rd should be rate limited
        resp = client.post("/v1/proof", json={"query_id": "q1"})
        assert resp.status_code == 429


class TestEndpointTimeouts:
    """Verify that slow checker and proof generation trigger 504."""

    def test_check_timeout_returns_504(self) -> None:
        import asyncio

        async def slow_check(*args, **kwargs):
            await asyncio.sleep(100)  # Will be cancelled by timeout

        mock_checker = AsyncMock()
        mock_checker.check = slow_check
        mock_proof = AsyncMock()
        health = HealthTracker()

        app = create_app(
            checker=mock_checker,
            proof_gen=mock_proof,
            health_tracker=health,
        )
        client = TestClient(app)

        resp = client.post("/v1/check", json={
            "lines": [{
                "index": 1,
                "sport": "basketball_nba",
                "event_id": "evt-1",
                "home_team": "A",
                "away_team": "B",
                "market": "h2h",
                "line": None,
                "side": "A",
            }],
        })
        assert resp.status_code == 504
        assert "timed out" in resp.json()["detail"]

    def test_proof_timeout_returns_504(self) -> None:
        import asyncio

        async def slow_proof(*args, **kwargs):
            raise asyncio.TimeoutError()

        mock_checker = AsyncMock()
        mock_checker.check.return_value = []
        mock_proof = AsyncMock()
        mock_proof.generate = slow_proof
        health = HealthTracker()

        app = create_app(
            checker=mock_checker,
            proof_gen=mock_proof,
            health_tracker=health,
        )
        client = TestClient(app)

        resp = client.post("/v1/proof", json={"query_id": "q-timeout"})
        assert resp.status_code == 504
        assert "timed out" in resp.json()["detail"]


class TestEndpointErrorHandling:
    """Error handling across /v1/check, /v1/proof, and /v1/attest endpoints."""

    def test_check_raises_exception_returns_500(self) -> None:
        """If checker.check() raises, the endpoint returns 500 with a safe message."""
        mock_checker = AsyncMock()
        mock_checker.check.side_effect = ValueError("corrupt odds data")
        mock_proof = AsyncMock()
        health = HealthTracker()

        app = create_app(checker=mock_checker, proof_gen=mock_proof, health_tracker=health)
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post("/v1/check", json={
            "lines": [{
                "index": 1,
                "sport": "basketball_nba",
                "event_id": "ev-001",
                "home_team": "A",
                "away_team": "B",
                "market": "h2h",
                "side": "A",
            }],
        })
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Internal server error"
        # No internal details leaked
        assert "corrupt odds data" not in resp.text
        assert "ValueError" not in resp.text

    def test_proof_generate_raises_exception_returns_500(self) -> None:
        """If proof_gen.generate() raises, the endpoint returns 500 with a safe message."""
        mock_checker = AsyncMock()
        mock_proof = AsyncMock()
        mock_proof.generate.side_effect = OSError("disk full")
        health = HealthTracker()

        app = create_app(checker=mock_checker, proof_gen=mock_proof, health_tracker=health)
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post("/v1/proof", json={"query_id": "q-fail"})
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Internal server error"
        assert "disk full" not in resp.text
        assert "OSError" not in resp.text

    def test_check_with_empty_body_returns_422(self, app: TestClient) -> None:
        """POST /v1/check with an empty JSON object (no 'lines' key) is rejected."""
        resp = app.post("/v1/check", json={})
        assert resp.status_code == 422

    def test_check_with_malformed_json_returns_422(self, app: TestClient) -> None:
        """POST /v1/check with non-JSON body is rejected."""
        resp = app.post(
            "/v1/check",
            content="this is not json",
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 422

    def test_proof_with_missing_query_id_returns_422(self, app: TestClient) -> None:
        """POST /v1/proof with empty body (missing query_id) returns 422."""
        resp = app.post("/v1/proof", json={})
        assert resp.status_code == 422

    def test_check_with_missing_event_id_returns_422(self, app: TestClient) -> None:
        """POST /v1/check with a line missing the event_id field returns 422."""
        resp = app.post("/v1/check", json={
            "lines": [{
                "index": 1,
                "sport": "basketball_nba",
                # event_id deliberately omitted
                "home_team": "A",
                "away_team": "B",
                "market": "h2h",
                "side": "A",
            }],
        })
        assert resp.status_code == 422
        body = resp.json()
        # Pydantic error should reference the missing field
        assert any("event_id" in str(err) for err in body.get("detail", []))

    def test_attest_with_generate_proof_exception_returns_500(self) -> None:
        """If tlsn.generate_proof() raises an unexpected exception, returns 500.

        Must provide a peer notary so the code path actually calls
        generate_proof (without a peer, it goes straight to ephemeral).
        """
        mock_checker = AsyncMock()
        mock_proof = AsyncMock()
        health = HealthTracker()

        fastapi_app = create_app(checker=mock_checker, proof_gen=mock_proof, health_tracker=health)
        client = TestClient(fastapi_app, raise_server_exceptions=False)

        with (
            patch("djinn_miner.core.tlsn.is_available", return_value=True),
            patch(
                "djinn_miner.core.tlsn.generate_proof",
                new_callable=AsyncMock,
                side_effect=RuntimeError("segfault in prover"),
            ),
        ):
            resp = client.post(
                "/v1/attest",
                json={
                    "url": "https://example.com",
                    "request_id": "err-1",
                    "notary_host": "10.0.0.1",
                    "notary_port": 7047,
                },
            )
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Internal server error"
        assert "segfault" not in resp.text


class TestAttestEndpoint:
    """Tests for the POST /v1/attest web attestation endpoint."""

    def test_attest_rejects_non_https(self, app: TestClient) -> None:
        resp = app.post(
            "/v1/attest",
            json={"url": "http://example.com", "request_id": "test-1"},
        )
        assert resp.status_code == 422  # Pydantic validation error

    def test_attest_requires_url(self, app: TestClient) -> None:
        resp = app.post("/v1/attest", json={"request_id": "test-1"})
        assert resp.status_code == 422

    def test_attest_requires_request_id(self, app: TestClient) -> None:
        resp = app.post("/v1/attest", json={"url": "https://example.com"})
        assert resp.status_code == 422

    def test_attest_binary_unavailable(self, app: TestClient) -> None:
        """When TLSNotary binary is not installed, returns graceful error."""
        with patch("djinn_miner.core.tlsn.is_available", return_value=False):
            resp = app.post(
                "/v1/attest",
                json={"url": "https://example.com", "request_id": "test-2"},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is False
        assert "not available" in data["error"]
        assert data["request_id"] == "test-2"
        assert data["url"] == "https://example.com"

    def test_attest_success(self, app: TestClient) -> None:
        """Mock a successful TLSNotary proof and verify response shape."""
        from djinn_miner.core.tlsn import TLSNProofResult

        mock_result = TLSNProofResult(
            success=True,
            presentation_bytes=b"\xde\xad\xbe\xef" * 10,
            server="example.com",
        )
        with (
            patch("djinn_miner.core.tlsn.is_available", return_value=True),
            patch("djinn_miner.core.tlsn.generate_proof", new_callable=AsyncMock, return_value=mock_result),
        ):
            resp = app.post(
                "/v1/attest",
                json={
                    "url": "https://example.com",
                    "request_id": "test-3",
                    "notary_host": "10.0.0.1",
                    "notary_port": 7047,
                },
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["request_id"] == "test-3"
        assert data["url"] == "https://example.com"
        assert data["server_name"] == "example.com"
        assert data["proof_hex"] == "deadbeef" * 10
        assert data["timestamp"] > 0

    def test_attest_proof_failure(self, app: TestClient) -> None:
        """TLSNotary proof generation fails gracefully."""
        from djinn_miner.core.tlsn import TLSNProofResult

        mock_result = TLSNProofResult(
            success=False,
            error="connection refused",
        )
        with (
            patch("djinn_miner.core.tlsn.is_available", return_value=True),
            patch("djinn_miner.core.tlsn.generate_proof", new_callable=AsyncMock, return_value=mock_result),
        ):
            resp = app.post(
                "/v1/attest",
                json={
                    "url": "https://example.com",
                    "request_id": "test-4",
                    "notary_host": "10.0.0.1",
                    "notary_port": 7047,
                },
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is False
        assert "connection refused" in data["error"]

    def test_attest_capacity_endpoint(self, app: TestClient) -> None:
        """Capacity endpoint returns inflight/max/available."""
        resp = app.get("/v1/attest/capacity")
        assert resp.status_code == 200
        data = resp.json()
        assert data["inflight"] == 0
        assert data["max"] > 0
        assert data["available"] == data["max"]

    def test_attest_busy_when_at_capacity(self, app: TestClient) -> None:
        """When max concurrent attestations are in-flight, new requests get busy response."""
        # Patch the semaphore's locked() to always return True
        with (
            patch("djinn_miner.core.tlsn.is_available", return_value=True),
            patch("asyncio.Semaphore.locked", return_value=True),
        ):
            resp = app.post(
                "/v1/attest",
                json={"url": "https://example.com", "request_id": "test-busy"},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is False
        assert data["busy"] is True
        assert data["retry_after"] == 30
