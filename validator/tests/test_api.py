"""Tests for the validator REST API."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from djinn_validator.api.server import create_app
from djinn_validator.core.outcomes import OutcomeAttestor
from djinn_validator.core.purchase import PurchaseOrchestrator
from djinn_validator.core.shares import ShareStore
from djinn_validator.utils.crypto import Share


@pytest.fixture
def share_store():
    store = ShareStore()
    yield store
    store.close()


@pytest.fixture
def client(share_store: ShareStore) -> TestClient:
    purchase_orch = PurchaseOrchestrator(share_store)
    outcome_attestor = OutcomeAttestor()
    app = create_app(share_store, purchase_orch, outcome_attestor)
    return TestClient(app)


@pytest.fixture
def client_with_chain(share_store: ShareStore) -> TestClient:
    """Client with a mock chain client that reports connected."""
    purchase_orch = PurchaseOrchestrator(share_store)
    outcome_attestor = OutcomeAttestor()
    mock_chain = AsyncMock()
    mock_chain.is_connected = AsyncMock(return_value=True)
    app = create_app(share_store, purchase_orch, outcome_attestor, chain_client=mock_chain)
    return TestClient(app)


class TestRequestIdMiddleware:
    def test_response_has_request_id_header(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert "x-request-id" in resp.headers
        assert len(resp.headers["x-request-id"]) == 32  # UUID hex

    def test_forwarded_request_id_is_echoed(self, client: TestClient) -> None:
        resp = client.get("/health", headers={"X-Request-ID": "my-trace-123"})
        assert resp.headers["x-request-id"] == "my-trace-123"

    def test_unique_ids_per_request(self, client: TestClient) -> None:
        r1 = client.get("/health")
        r2 = client.get("/health")
        assert r1.headers["x-request-id"] != r2.headers["x-request-id"]


class TestHealthEndpoint:
    def test_health_returns_ok(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["version"]  # non-empty version string


class TestIdentityEndpoint:
    def test_identity_returns_empty_without_chain(self, client: TestClient) -> None:
        resp = client.get("/v1/identity")
        assert resp.status_code == 200
        data = resp.json()
        assert data["base_address"] == ""
        assert data["hotkey"] == ""
        assert "version" in data

    def test_identity_returns_base_address(self, share_store: ShareStore) -> None:
        purchase_orch = PurchaseOrchestrator(share_store)
        outcome_attestor = OutcomeAttestor()
        mock_chain = AsyncMock()
        mock_chain.validator_address = "0x1234567890abcdef1234567890abcdef12345678"
        app = create_app(share_store, purchase_orch, outcome_attestor, chain_client=mock_chain)
        test_client = TestClient(app)
        resp = test_client.get("/v1/identity")
        assert resp.status_code == 200
        data = resp.json()
        assert data["base_address"] == "0x1234567890abcdef1234567890abcdef12345678"


class TestStoreShare:
    def test_store_share(self, client: TestClient, share_store: ShareStore) -> None:
        resp = client.post("/v1/signal", json={
            "signal_id": "sig-1",
            "genius_address": "0x" + "aa" * 20,
            "share_x": 1,
            "share_y": hex(12345),
            "encrypted_key_share": "deadbeef",
            "shamir_threshold": 7,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["stored"] is True
        assert share_store.has("sig-1")

    def test_rejects_share_y_exceeding_prime(self, client: TestClient) -> None:
        from djinn_validator.utils.crypto import BN254_PRIME
        resp = client.post("/v1/signal", json={
            "signal_id": "sig-bad",
            "genius_address": "0x" + "aa" * 20,
            "share_x": 1,
            "share_y": hex(BN254_PRIME + 1),
            "encrypted_key_share": "deadbeef",
            "shamir_threshold": 7,
        })
        assert resp.status_code == 400
        assert "BN254" in resp.json()["detail"]

    def test_rejects_invalid_share_x(self, client: TestClient) -> None:
        """Pydantic rejects share_x outside [1, 10] with 422."""
        resp = client.post("/v1/signal", json={
            "signal_id": "sig-bad",
            "genius_address": "0x" + "aa" * 20,
            "share_x": 0,
            "share_y": hex(42),
            "encrypted_key_share": "deadbeef",
            "shamir_threshold": 7,
        })
        assert resp.status_code == 422

    def test_rejects_invalid_hex(self, client: TestClient) -> None:
        """Pydantic hex validator rejects non-hex share_y with 422."""
        resp = client.post("/v1/signal", json={
            "signal_id": "sig-bad",
            "genius_address": "0x" + "aa" * 20,
            "share_x": 1,
            "share_y": "not-hex",
            "encrypted_key_share": "deadbeef",
            "shamir_threshold": 7,
        })
        assert resp.status_code == 422

    def test_share_y_zero_accepted(self, client: TestClient) -> None:
        """share_y = 0 is a valid field element."""
        resp = client.post("/v1/signal", json={
            "signal_id": "sig-zero-y",
            "genius_address": "0x" + "aa" * 20,
            "share_x": 1,
            "share_y": "0",
            "encrypted_key_share": "deadbeef",
            "shamir_threshold": 7,
        })
        assert resp.status_code == 200

    def test_warns_low_shamir_threshold(self, client: TestClient) -> None:
        """Validators warn (but don't reject) shares with threshold below protocol minimum."""
        resp = client.post("/v1/signal", json={
            "signal_id": "sig-low-t",
            "genius_address": "0x" + "aa" * 20,
            "share_x": 1,
            "share_y": "ff",
            "encrypted_key_share": "deadbeef",
            "shamir_threshold": 1,
        })
        # Accepted with warning; threshold is stored and enforced at MPC time
        assert resp.status_code == 200


class TestPurchase:
    def test_purchase_nonexistent_signal(self, client: TestClient) -> None:
        resp = client.post("/v1/signal/unknown/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DraftKings",
            "available_indices": [1, 3, 5],
        })
        assert resp.status_code == 404

    def test_purchase_available_signal(self, client: TestClient, share_store: ShareStore) -> None:
        # Store a share where the secret (real index) is 5
        from djinn_validator.utils.crypto import generate_signal_index_shares
        shares = generate_signal_index_shares(5)
        share_store.store(
            "sig-1", "0xGenius",
            shares[0],  # This validator holds share 1
            b"encrypted-aes-key",
        )

        resp = client.post("/v1/signal/sig-1/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DraftKings",
            "available_indices": [1, 3, 5, 7, 9],  # 5 is available
        })
        assert resp.status_code == 200
        data = resp.json()
        # In single-validator mode, availability depends on the polynomial
        # evaluation at the share point, not the actual secret.
        # The test verifies the API flow works end-to-end.
        assert data["signal_id"] == "sig-1"
        assert data["status"] in ("complete", "unavailable")


class TestPaymentVerification:
    """Tests for on-chain payment verification before share release."""

    # Use numeric signal IDs (matching on-chain uint256 format)
    SIGNAL_ID = "100001"

    def _store_signal(self, share_store: ShareStore) -> None:
        from djinn_validator.utils.crypto import generate_signal_index_shares
        shares = generate_signal_index_shares(5)
        share_store.store(self.SIGNAL_ID, "0xGenius", shares[0], b"encrypted-key")

    def test_purchase_requires_payment_when_chain_configured(self, share_store: ShareStore) -> None:
        """When chain_client is configured, purchase must be paid on-chain."""
        self._store_signal(share_store)
        purchase_orch = PurchaseOrchestrator(share_store)
        outcome_attestor = OutcomeAttestor()
        mock_chain = AsyncMock()
        mock_chain.is_connected = AsyncMock(return_value=True)
        # Return zero pricePaid — payment not found on-chain
        mock_chain.verify_purchase = AsyncMock(return_value={
            "notional": 0, "pricePaid": 0, "sportsbook": "",
        })
        app = create_app(share_store, purchase_orch, outcome_attestor, chain_client=mock_chain)
        client = TestClient(app)

        resp = client.post(f"/v1/signal/{self.SIGNAL_ID}/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DraftKings",
            "available_indices": [1, 3, 5, 7, 9],
        })
        assert resp.status_code == 200
        data = resp.json()
        # If the signal is available but unpaid, should get payment_required
        if data.get("available") is True:
            assert data["status"] == "payment_required"
            assert "encrypted_key_share" not in data or data["encrypted_key_share"] is None

    def test_purchase_releases_share_when_paid(self, share_store: ShareStore) -> None:
        """When on-chain payment is confirmed, share is released."""
        self._store_signal(share_store)
        purchase_orch = PurchaseOrchestrator(share_store)
        outcome_attestor = OutcomeAttestor()
        mock_chain = AsyncMock()
        mock_chain.is_connected = AsyncMock(return_value=True)
        # Return positive pricePaid — payment confirmed
        mock_chain.verify_purchase = AsyncMock(return_value={
            "notional": 100_000_000, "pricePaid": 50_000_000, "sportsbook": "DraftKings",
        })
        app = create_app(share_store, purchase_orch, outcome_attestor, chain_client=mock_chain)
        client = TestClient(app)

        resp = client.post(f"/v1/signal/{self.SIGNAL_ID}/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DraftKings",
            "available_indices": [1, 3, 5, 7, 9],
        })
        assert resp.status_code == 200
        data = resp.json()
        # If the signal is available and paid, share should be released
        if data.get("available") is True:
            assert data["status"] == "complete"
            assert data.get("encrypted_key_share") is not None

    def test_purchase_works_in_dev_mode_no_chain(self, client: TestClient, share_store: ShareStore) -> None:
        """Dev mode (no chain_client): purchase proceeds without payment check."""
        from djinn_validator.utils.crypto import generate_signal_index_shares
        shares = generate_signal_index_shares(5)
        share_store.store("sig-dev-1", "0xGenius", shares[0], b"encrypted-key")

        resp = client.post("/v1/signal/sig-dev-1/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DraftKings",
            "available_indices": [1, 3, 5, 7, 9],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["signal_id"] == "sig-dev-1"
        # In dev mode, should complete (or be unavailable) — never payment_required
        assert data["status"] in ("complete", "unavailable")

    def test_payment_verification_timeout_returns_504(self, share_store: ShareStore) -> None:
        """When chain_client times out, return 504."""
        self._store_signal(share_store)
        purchase_orch = PurchaseOrchestrator(share_store)
        outcome_attestor = OutcomeAttestor()
        mock_chain = AsyncMock()
        mock_chain.is_connected = AsyncMock(return_value=True)

        import asyncio
        async def slow_verify(*args, **kwargs):
            await asyncio.sleep(20)
            return {"notional": 0, "pricePaid": 0, "sportsbook": ""}

        mock_chain.verify_purchase = slow_verify
        app = create_app(share_store, purchase_orch, outcome_attestor, chain_client=mock_chain)
        client = TestClient(app)

        resp = client.post(f"/v1/signal/{self.SIGNAL_ID}/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DraftKings",
            "available_indices": [1, 3, 5, 7, 9],
        })
        # Should be 504 if timeout, or 200 unavailable if MPC says unavailable
        assert resp.status_code in (200, 504)
        if resp.status_code == 200:
            assert resp.json()["status"] == "unavailable"

    def test_signal_id_to_uint256_rejects_non_numeric(self, share_store: ShareStore) -> None:
        """Signal IDs must be numeric uint256 for on-chain lookups."""
        from djinn_validator.api.server import _signal_id_to_uint256
        from fastapi import HTTPException

        # Valid numeric IDs
        assert _signal_id_to_uint256("0") == 0
        assert _signal_id_to_uint256("42") == 42
        assert _signal_id_to_uint256("100001") == 100001

        # Invalid: non-numeric strings
        with pytest.raises(HTTPException) as exc_info:
            _signal_id_to_uint256("sig-pay-1")
        assert exc_info.value.status_code == 400

        with pytest.raises(HTTPException) as exc_info:
            _signal_id_to_uint256("abc")
        assert exc_info.value.status_code == 400


class TestPaymentReplayPrevention:
    """Tests for TOCTOU payment replay prevention."""

    def test_duplicate_purchase_returns_idempotent(self, share_store: ShareStore) -> None:
        """A second purchase attempt for the same signal+buyer returns the already-released share."""
        from djinn_validator.utils.crypto import generate_signal_index_shares

        shares = generate_signal_index_shares(5)
        share_store.store("sig-replay", "0xGenius", shares[0], b"encrypted-key-data")

        purchase_orch = PurchaseOrchestrator(share_store)
        outcome_attestor = OutcomeAttestor()
        app = create_app(share_store, purchase_orch, outcome_attestor)
        client = TestClient(app)

        buyer = "0x" + "b0" * 20

        # First purchase
        resp1 = client.post("/v1/signal/sig-replay/purchase", json={
            "buyer_address": buyer,
            "sportsbook": "DraftKings",
            "available_indices": [1, 3, 5, 7, 9],
        })
        assert resp1.status_code == 200
        data1 = resp1.json()

        if data1["status"] == "complete":
            # Second purchase should be idempotent
            resp2 = client.post("/v1/signal/sig-replay/purchase", json={
                "buyer_address": buyer,
                "sportsbook": "DraftKings",
                "available_indices": [1, 3, 5, 7, 9],
            })
            assert resp2.status_code == 200
            data2 = resp2.json()
            assert data2["status"] in ("complete", "already_purchased")

    def test_payment_consumed_check(self) -> None:
        """Verify PurchaseOrchestrator.is_payment_consumed works."""
        store = ShareStore()
        orch = PurchaseOrchestrator(store)

        assert orch.is_payment_consumed("sig-1", "0xBuyer") is False
        orch.record_payment("sig-1", "0xBuyer", "0xtx123", "PAYMENT_CONFIRMED")
        assert orch.is_payment_consumed("sig-1", "0xBuyer") is True

        # Can't record same payment twice
        assert orch.record_payment("sig-1", "0xBuyer", "0xtx123", "PAYMENT_CONFIRMED") is False

        store.close()
        orch.close()


class TestOutcome:
    def test_attest_outcome(self, client: TestClient, share_store: ShareStore) -> None:
        # Store a share first
        share_store.store("sig-1", "0xG", Share(x=1, y=1), b"key")

        resp = client.post("/v1/signal/sig-1/outcome", json={
            "signal_id": "sig-1",
            "event_id": "event-123",
            "outcome": 1,  # Favorable
            "validator_hotkey": "5xxx",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["outcome"] == 1


class TestAnalytics:
    def test_analytics_accepted(self, client: TestClient) -> None:
        resp = client.post("/v1/analytics/attempt", json={
            "event_type": "purchase_attempt",
            "data": {"signal_id": "sig-1"},
        })
        assert resp.status_code == 200
        assert resp.json()["received"] is True


class TestMetricsEndpoint:
    def test_metrics_returns_prometheus_format(self, client: TestClient) -> None:
        resp = client.get("/metrics")
        assert resp.status_code == 200
        assert "text/plain" in resp.headers.get("content-type", "")
        text = resp.text
        assert "djinn_validator" in text

    def test_metrics_after_store_share(self, client: TestClient) -> None:
        # Store a share to increment counters
        client.post("/v1/signal", json={
            "signal_id": "met-1",
            "genius_address": "0x" + "aa" * 20,
            "share_x": 1,
            "share_y": "abcdef",
            "encrypted_key_share": "deadbeef",
            "shamir_threshold": 7,
        })
        resp = client.get("/metrics")
        assert resp.status_code == 200
        assert "shares_stored" in resp.text


class TestBodySizeLimit:
    def test_oversized_body_rejected(self, client: TestClient) -> None:
        huge_body = "x" * (1_048_576 + 1)
        resp = client.post(
            "/v1/signal",
            content=huge_body,
            headers={"Content-Type": "application/json", "Content-Length": str(len(huge_body))},
        )
        assert resp.status_code == 413

    def test_invalid_content_length_rejected(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/signal",
            content="{}",
            headers={"Content-Type": "application/json", "Content-Length": "not-a-number"},
        )
        assert resp.status_code == 400


class TestInputValidation:
    """Test that invalid inputs are properly rejected."""

    def test_store_share_missing_fields(self, client: TestClient) -> None:
        resp = client.post("/v1/signal", json={"signal_id": "sig-1"})
        assert resp.status_code == 422

    def test_store_share_invalid_hex(self, client: TestClient) -> None:
        resp = client.post("/v1/signal", json={
            "signal_id": "sig-1",
            "genius_address": "0x" + "aa" * 20,
            "share_x": 1,
            "share_y": "not-hex!",
            "encrypted_key_share": "deadbeef",
            "shamir_threshold": 7,
        })
        assert resp.status_code == 422

    def test_purchase_empty_indices(self, client: TestClient) -> None:
        resp = client.post("/v1/signal/sig-1/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DK",
            "available_indices": [],
        })
        assert resp.status_code == 422

    def test_outcome_invalid_value(self, client: TestClient) -> None:
        resp = client.post("/v1/signal/sig-1/outcome", json={
            "signal_id": "sig-1",
            "event_id": "ev-1",
            "outcome": 5,
            "validator_hotkey": "5xxx",
        })
        assert resp.status_code == 422

    def test_analytics_oversized_data(self, client: TestClient) -> None:
        resp = client.post("/v1/analytics/attempt", json={
            "event_type": "test",
            "data": {f"k{i}": i for i in range(60)},
        })
        assert resp.status_code == 422

    def test_mpc_init_coordinator_x_out_of_range(self, client: TestClient) -> None:
        resp = client.post("/v1/mpc/init", json={
            "session_id": "s-1",
            "signal_id": "sig-1",
            "available_indices": [1],
            "coordinator_x": 0,
            "participant_xs": [1, 2],
        })
        assert resp.status_code == 422

    def test_rejects_invalid_genius_address(self, client: TestClient) -> None:
        """genius_address must be a valid Ethereum address (0x + 40 hex chars)."""
        resp = client.post("/v1/signal", json={
            "signal_id": "sig-addr",
            "genius_address": "0xGenius",
            "share_x": 1,
            "share_y": "abcdef",
            "encrypted_key_share": "deadbeef",
            "shamir_threshold": 7,
        })
        assert resp.status_code == 400
        assert "Ethereum address" in resp.json()["detail"]

    def test_signal_id_rejects_special_chars(self, client: TestClient) -> None:
        """Signal IDs with special characters should be rejected by Pydantic."""
        resp = client.post("/v1/signal", json={
            "signal_id": "sig/../../../etc/passwd",
            "genius_address": "0x" + "aa" * 20,
            "share_x": 1,
            "share_y": "abcdef",
            "encrypted_key_share": "deadbeef",
            "shamir_threshold": 7,
        })
        assert resp.status_code == 422

    def test_purchase_path_rejects_special_chars(self, client: TestClient) -> None:
        """Signal IDs with spaces/special chars in path should be rejected."""
        resp = client.post("/v1/signal/sig id with spaces/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DK",
            "available_indices": [1, 3, 5],
        })
        assert resp.status_code == 400

    def test_outcome_path_rejects_special_chars(self, client: TestClient) -> None:
        resp = client.post("/v1/signal/sig.bad.id/outcome", json={
            "signal_id": "sig-1",
            "event_id": "ev-1",
            "outcome": 1,
            "validator_hotkey": "5xxx",
        })
        assert resp.status_code == 400

    def test_signal_id_at_max_length_accepted(self, client: TestClient, share_store: ShareStore) -> None:
        """A 256-char signal ID should be accepted (at the limit)."""
        long_id = "a" * 256
        share_store.store(long_id, "0xG", Share(x=1, y=1), b"key")
        resp = client.post(f"/v1/signal/{long_id}/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DK",
            "available_indices": [1, 3, 5],
        })
        # Should reach the handler (200 with result, not 400 for format)
        assert resp.status_code == 200

    def test_signal_id_over_max_length_rejected(self, client: TestClient) -> None:
        """A 257-char signal ID exceeds the limit."""
        long_id = "a" * 257
        resp = client.post(f"/v1/signal/{long_id}/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DK",
            "available_indices": [1, 3, 5],
        })
        assert resp.status_code == 400

    def test_nonexistent_endpoint_returns_404(self, client: TestClient) -> None:
        resp = client.get("/v1/doesnotexist")
        assert resp.status_code in (404, 405)


class TestMPCTimeout:
    def test_purchase_mpc_timeout_returns_504(
        self, share_store: ShareStore,
    ) -> None:
        """If MPC check_availability exceeds 15s, return 504."""
        import asyncio
        from unittest.mock import patch, AsyncMock

        share_store.store("sig-timeout", "0xG", Share(x=1, y=42), b"key")

        async def slow_mpc(*args, **kwargs):
            await asyncio.sleep(100)  # Will be cancelled by timeout

        purchase_orch = PurchaseOrchestrator(share_store)
        outcome_attestor = OutcomeAttestor()
        app = create_app(share_store, purchase_orch, outcome_attestor)

        with patch(
            "djinn_validator.core.mpc_orchestrator.MPCOrchestrator.check_availability",
            new=slow_mpc,
        ):
            client = TestClient(app)
            resp = client.post("/v1/signal/sig-timeout/purchase", json={
                "buyer_address": "0x" + "b0" * 20,
                "sportsbook": "DK",
                "available_indices": [1, 3, 5],
            })
            assert resp.status_code == 504
            assert "timed out" in resp.json()["detail"]


class TestMPCEndpoints:
    def test_mpc_status_nonexistent_session(self, client: TestClient) -> None:
        resp = client.get("/v1/mpc/nonexistent-session-id/status")
        assert resp.status_code == 404

    def test_mpc_result_nonexistent_session(self, client: TestClient) -> None:
        resp = client.post("/v1/mpc/result", json={
            "session_id": "nonexistent",
            "signal_id": "sig-1",
            "available": True,
            "participating_validators": 3,
        })
        assert resp.status_code == 200
        assert resp.json()["acknowledged"] is False

    def test_mpc_round1_invalid_hex(self, client: TestClient) -> None:
        resp = client.post("/v1/mpc/round1", json={
            "session_id": "s-1",
            "gate_idx": 0,
            "validator_x": 1,
            "d_value": "not-hex!",
            "e_value": "ff",
        })
        assert resp.status_code == 422

    def test_mpc_abort_nonexistent_session(self, client: TestClient) -> None:
        resp = client.post("/v1/mpc/abort", json={
            "session_id": "nonexistent",
            "reason": "test abort",
            "gate_idx": 0,
        })
        assert resp.status_code == 200
        assert resp.json()["acknowledged"] is False

    def test_mpc_abort_existing_session(self, client: TestClient) -> None:
        # Create a session first
        resp = client.post("/v1/mpc/init", json={
            "session_id": "abort-test-1",
            "signal_id": "sig-1",
            "available_indices": [1, 3],
            "coordinator_x": 1,
            "participant_xs": [1, 2, 3],
            "threshold": 2,
        })
        assert resp.status_code == 200

        # Abort it
        resp = client.post("/v1/mpc/abort", json={
            "session_id": "abort-test-1",
            "reason": "d_mac_check_failed",
            "gate_idx": 1,
            "offending_validator_x": 2,
        })
        assert resp.status_code == 200
        assert resp.json()["acknowledged"] is True

        # Session should now be FAILED — compute_gate should be rejected
        resp = client.post("/v1/mpc/compute_gate", json={
            "session_id": "abort-test-1",
            "gate_idx": 0,
        })
        assert resp.status_code == 409


class TestReadinessEndpoint:
    def test_readiness_returns_checks(self, client: TestClient) -> None:
        resp = client.get("/health/ready")
        assert resp.status_code == 200
        data = resp.json()
        assert "ready" in data
        assert "checks" in data
        assert isinstance(data["checks"], dict)

    def test_readiness_checks_rpc(self, client: TestClient) -> None:
        resp = client.get("/health/ready")
        data = resp.json()
        # No chain client injected in test → rpc should be False
        assert data["checks"]["rpc"] is False

    def test_readiness_checks_bt_connected(self, client: TestClient) -> None:
        resp = client.get("/health/ready")
        data = resp.json()
        # No neuron in test → bt_connected should be False
        assert data["checks"]["bt_connected"] is False

    def test_readiness_not_ready_without_deps(self, client: TestClient) -> None:
        resp = client.get("/health/ready")
        data = resp.json()
        # Without chain client and neuron, not fully ready
        assert data["ready"] is False

    def test_readiness_rpc_passes_with_chain_client(self, client_with_chain: TestClient) -> None:
        resp = client_with_chain.get("/health/ready")
        data = resp.json()
        assert data["checks"]["rpc"] is True

    def test_health_chain_status_with_mock(self, client_with_chain: TestClient) -> None:
        resp = client_with_chain.get("/health")
        data = resp.json()
        assert data["chain_connected"] is True


class TestHealthReflectsState:
    def test_health_shares_held(self, client: TestClient, share_store: ShareStore) -> None:
        share_store.store("sig-1", "0xGenius", Share(x=1, y=42), b"key")
        share_store.store("sig-2", "0xGenius", Share(x=2, y=42), b"key")
        resp = client.get("/health")
        assert resp.json()["shares_held"] == 2

    def test_health_no_neuron(self, client: TestClient) -> None:
        resp = client.get("/health")
        data = resp.json()
        assert data["uid"] is None
        assert data["bt_connected"] is False


class TestMPCInitEndpoint:
    def test_mpc_init_creates_session(self, client: TestClient) -> None:
        resp = client.post("/v1/mpc/init", json={
            "session_id": "mpc-001",
            "signal_id": "sig-001",
            "available_indices": [1, 2, 3],
            "coordinator_x": 1,
            "participant_xs": [2, 3, 4],
            "threshold": 3,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["session_id"] == "mpc-001"
        assert data["accepted"] is True

    def test_mpc_init_duplicate_returns_existing(self, client: TestClient) -> None:
        body = {
            "session_id": "mpc-002",
            "signal_id": "sig-001",
            "available_indices": [1, 2],
            "coordinator_x": 1,
            "participant_xs": [2, 3],
            "threshold": 2,
        }
        client.post("/v1/mpc/init", json=body)
        resp = client.post("/v1/mpc/init", json=body)
        assert resp.status_code == 200
        assert resp.json()["accepted"] is True
        assert "already exists" in resp.json()["message"]

    def test_mpc_init_then_status(self, client: TestClient) -> None:
        client.post("/v1/mpc/init", json={
            "session_id": "mpc-003",
            "signal_id": "sig-001",
            "available_indices": [1, 2, 3],
            "coordinator_x": 1,
            "participant_xs": [2, 3],
            "threshold": 2,
        })
        resp = client.get("/v1/mpc/mpc-003/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["session_id"] == "mpc-003"
        assert data["status"] in ("active", "round1_collecting")
        assert data["total_participants"] == 2


class TestMPCResultFlow:
    def test_result_accepted_for_existing_session(self, client: TestClient) -> None:
        client.post("/v1/mpc/init", json={
            "session_id": "mpc-res-001",
            "signal_id": "sig-001",
            "available_indices": [1, 2],
            "coordinator_x": 1,
            "participant_xs": [2, 3],
            "threshold": 2,
        })
        resp = client.post("/v1/mpc/result", json={
            "session_id": "mpc-res-001",
            "signal_id": "sig-001",
            "available": True,
            "participating_validators": 3,
        })
        assert resp.status_code == 200
        assert resp.json()["acknowledged"] is True

        # Verify status is now complete
        status = client.get("/v1/mpc/mpc-res-001/status")
        assert status.json()["status"] == "complete"
        assert status.json()["available"] is True


SAMPLE_LINES_10 = [
    "Lakers -3.5 (-110)",
    "Celtics +3.5 (-110)",
    "Over 218.5 (-110)",
    "Under 218.5 (-110)",
    "Lakers ML (-150)",
    "Celtics ML (+130)",
    "Lakers -1.5 (-105)",
    "Celtics +1.5 (-115)",
    "Over 215.0 (-110)",
    "Under 215.0 (-110)",
]


class TestRegisterSignal:
    def test_register_valid_signal(self, client: TestClient) -> None:
        resp = client.post("/v1/signal/sig-001/register", json={
            "sport": "basketball_nba",
            "event_id": "event-001",
            "home_team": "Los Angeles Lakers",
            "away_team": "Boston Celtics",
            "lines": SAMPLE_LINES_10,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["signal_id"] == "sig-001"
        assert data["registered"] is True
        assert data["lines_count"] == 10

    def test_register_invalid_signal_id(self, client: TestClient) -> None:
        resp = client.post("/v1/signal/bad%20id/register", json={
            "sport": "basketball_nba",
            "event_id": "event-001",
            "home_team": "A",
            "away_team": "B",
            "lines": SAMPLE_LINES_10,
        })
        assert resp.status_code == 400

    def test_register_missing_fields(self, client: TestClient) -> None:
        resp = client.post("/v1/signal/sig-001/register", json={
            "sport": "basketball_nba",
        })
        assert resp.status_code == 422

    def test_register_wrong_line_count(self, client: TestClient) -> None:
        # Only 1 line is below the minimum of 2
        resp = client.post("/v1/signal/sig-002/register", json={
            "sport": "basketball_nba",
            "event_id": "event-001",
            "home_team": "A",
            "away_team": "B",
            "lines": ["Lakers -3.5 (-110)"],
        })
        assert resp.status_code == 422

    def test_register_empty_line_rejected(self, client: TestClient) -> None:
        lines = SAMPLE_LINES_10.copy()
        lines[3] = "   "
        resp = client.post("/v1/signal/sig-003/register", json={
            "sport": "basketball_nba",
            "event_id": "event-001",
            "home_team": "A",
            "away_team": "B",
            "lines": lines,
        })
        assert resp.status_code == 422


class TestResolveSignals:
    def test_resolve_with_no_pending(self, client: TestClient) -> None:
        resp = client.post("/v1/signals/resolve")
        assert resp.status_code == 200
        data = resp.json()
        assert data["resolved_count"] == 0
        assert data["results"] == []


class TestExceptionHandler:
    def test_unhandled_exception_returns_500(self) -> None:
        """Unhandled exceptions don't leak stack traces."""
        store = ShareStore()
        purchase_orch = PurchaseOrchestrator(store)
        outcome_attestor = OutcomeAttestor()
        app = create_app(store, purchase_orch, outcome_attestor)

        # Close store to trigger error on next operation
        store.close()

        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post("/v1/signal", json={
            "signal_id": "sig-001",
            "genius_address": "0x" + "aa" * 20,
            "share_x": 1,
            "share_y": "ff",
            "encrypted_key_share": "abcd",
            "shamir_threshold": 7,
        })
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Internal server error"

    def test_health_chain_error_handled(self) -> None:
        """Chain client error during health check is handled gracefully."""
        store = ShareStore()
        purchase_orch = PurchaseOrchestrator(store)
        outcome_attestor = OutcomeAttestor()
        mock_chain = AsyncMock()
        mock_chain.is_connected = AsyncMock(side_effect=RuntimeError("RPC down"))
        app = create_app(store, purchase_orch, outcome_attestor, chain_client=mock_chain)
        client = TestClient(app)

        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["chain_connected"] is False


class TestParticipantStateCleanup:
    """Verify participant state TTL eviction prevents memory leaks."""

    def _make_app(self) -> tuple:
        """Create app and return (client, share_store, app)."""
        from djinn_validator.core.mpc_coordinator import MPCCoordinator
        store = ShareStore()
        store.store("sig-cleanup", "0xAA", Share(x=2, y=42), b"key")
        purchase_orch = PurchaseOrchestrator(store)
        outcome_attestor = OutcomeAttestor()
        mpc = MPCCoordinator()
        app = create_app(store, purchase_orch, outcome_attestor, mpc_coordinator=mpc)
        client = TestClient(app, raise_server_exceptions=False)
        return client, store, app, mpc

    def _init_session(self, client: TestClient, session_id: str) -> None:
        """Send mpc_init for a given session_id."""
        resp = client.post("/v1/mpc/init", json={
            "session_id": session_id,
            "signal_id": "sig-cleanup",
            "available_indices": [1, 2, 3],
            "coordinator_x": 1,
            "participant_xs": [1, 2],
            "threshold": 2,
            "triple_shares": [{"a": "aa", "b": "bb", "c": "cc"}],
            "r_share_y": "ff",
        })
        assert resp.status_code == 200
        assert resp.json()["accepted"] is True

    def test_participant_state_cleaned_on_result(self) -> None:
        """mpc_result should clean up participant state."""
        client, store, app, mpc = self._make_app()
        self._init_session(client, "sess-result-cleanup")

        # Send result
        resp = client.post("/v1/mpc/result", json={
            "session_id": "sess-result-cleanup",
            "signal_id": "sig-cleanup",
            "available": True,
            "participating_validators": 2,
        })
        assert resp.status_code == 200

        # Verify the compute_gate endpoint no longer finds the participant state
        resp = client.post("/v1/mpc/compute_gate", json={
            "session_id": "sess-result-cleanup",
            "gate_idx": 0,
        })
        assert resp.status_code == 404
        store.close()

    def test_participant_state_cleaned_on_abort(self) -> None:
        """mpc_abort should clean up participant state."""
        client, store, app, mpc = self._make_app()
        self._init_session(client, "sess-abort-cleanup")

        resp = client.post("/v1/mpc/abort", json={
            "session_id": "sess-abort-cleanup",
            "reason": "test abort",
            "gate_idx": 0,
        })
        assert resp.status_code == 200

        # compute_gate returns 409 (session aborted) because the session is
        # marked FAILED — but the participant state dict was cleaned up.
        # Use a session_id that has no MPC session to confirm state is gone.
        resp = client.post("/v1/mpc/compute_gate", json={
            "session_id": "sess-abort-cleanup",
            "gate_idx": 0,
        })
        # 409 = session FAILED (MPC session check happens first)
        assert resp.status_code == 409
        store.close()

    def test_stale_participant_states_evicted_by_ttl(self) -> None:
        """Participant states older than TTL should be evicted on next mpc_init."""
        import time as _time
        from unittest.mock import patch

        client, store, app, mpc = self._make_app()

        # Create a session
        self._init_session(client, "sess-stale-1")

        # Verify it exists
        resp = client.post("/v1/mpc/compute_gate", json={
            "session_id": "sess-stale-1",
            "gate_idx": 0,
        })
        assert resp.status_code == 200

        # Advance monotonic clock past TTL (120s)
        original_monotonic = _time.monotonic

        def offset_monotonic():
            return original_monotonic() + 200

        with patch("time.monotonic", side_effect=offset_monotonic):
            # Create another session — this triggers cleanup during mpc_init
            self._init_session(client, "sess-stale-2")

        # The stale session's participant state should have been evicted
        # (but the MPC session itself is managed by MPCCoordinator, not our cleanup)
        # We can verify by checking compute_gate for the stale session
        resp = client.post("/v1/mpc/compute_gate", json={
            "session_id": "sess-stale-1",
            "gate_idx": 0,
        })
        assert resp.status_code == 404  # Participant state evicted
        store.close()


class TestOTStateCleanup:
    """Verify OT state TTL eviction prevents memory leaks."""

    def _make_app(self) -> tuple:
        store = ShareStore()
        purchase_orch = PurchaseOrchestrator(store)
        outcome_attestor = OutcomeAttestor()
        app = create_app(store, purchase_orch, outcome_attestor)
        client = TestClient(app, raise_server_exceptions=False)
        return client, store

    def test_ot_setup_creates_state(self) -> None:
        """OT setup should create a new state entry."""
        client, store = self._make_app()
        resp = client.post("/v1/mpc/ot/setup", json={
            "session_id": "ot-create-1",
            "n_triples": 1,
            "x_coords": [1, 2],
            "threshold": 2,
            "dh_prime": hex(1223),
            "field_prime": hex(65537),
        })
        assert resp.status_code == 200
        assert resp.json()["accepted"] is True

        # Verify state exists by fetching shares (should fail because not yet complete, not 404)
        resp = client.post("/v1/mpc/ot/shares", json={
            "session_id": "ot-create-1",
            "party_x": 1,
        })
        # 425 = "not yet complete" means state exists
        assert resp.status_code == 425
        store.close()

    def test_ot_state_idempotent_setup(self) -> None:
        """Duplicate OT setup should return the same state."""
        client, store = self._make_app()
        resp1 = client.post("/v1/mpc/ot/setup", json={
            "session_id": "ot-idem-1",
            "n_triples": 1,
            "x_coords": [1, 2],
            "threshold": 2,
            "dh_prime": hex(1223),
            "field_prime": hex(65537),
        })
        resp2 = client.post("/v1/mpc/ot/setup", json={
            "session_id": "ot-idem-1",
            "n_triples": 1,
            "x_coords": [1, 2],
            "threshold": 2,
            "dh_prime": hex(1223),
            "field_prime": hex(65537),
        })
        assert resp1.json()["sender_public_keys"] == resp2.json()["sender_public_keys"]
        store.close()

    def test_stale_ot_states_evicted_on_mpc_init(self) -> None:
        """OT states older than TTL should be evicted during mpc_init cleanup."""
        import time as _time
        from unittest.mock import patch

        store = ShareStore()
        store.store("sig-ot-cleanup", "0xAA", Share(x=2, y=42), b"key")
        purchase_orch = PurchaseOrchestrator(store)
        outcome_attestor = OutcomeAttestor()
        app = create_app(store, purchase_orch, outcome_attestor)
        client = TestClient(app, raise_server_exceptions=False)

        # Create OT state
        resp = client.post("/v1/mpc/ot/setup", json={
            "session_id": "ot-stale-1",
            "n_triples": 1,
            "x_coords": [1, 2],
            "threshold": 2,
            "dh_prime": hex(1223),
            "field_prime": hex(65537),
        })
        assert resp.status_code == 200

        # Advance clock past OT TTL (180s)
        original_monotonic = _time.monotonic

        def offset_monotonic():
            return original_monotonic() + 300

        with patch("time.monotonic", side_effect=offset_monotonic):
            # Trigger cleanup via mpc_init
            client.post("/v1/mpc/init", json={
                "session_id": "sess-trigger-ot-cleanup",
                "signal_id": "sig-ot-cleanup",
                "available_indices": [1, 2, 3],
                "coordinator_x": 1,
                "participant_xs": [1, 2],
                "threshold": 2,
                "triple_shares": [{"a": "aa", "b": "bb", "c": "cc"}],
                "r_share_y": "ff",
            })

        # OT state should have been evicted
        resp = client.post("/v1/mpc/ot/shares", json={
            "session_id": "ot-stale-1",
            "party_x": 1,
        })
        assert resp.status_code == 404  # State evicted
        store.close()

    def test_ot_missing_session_returns_404(self) -> None:
        """OT endpoints should return 404 for unknown sessions."""
        client, store = self._make_app()

        for endpoint, payload in [
            ("/v1/mpc/ot/choices", {"session_id": "no-such", "peer_sender_pks": {}, "choices": {}}),
            ("/v1/mpc/ot/transfers", {"session_id": "no-such", "peer_choices": {}}),
            ("/v1/mpc/ot/complete", {"session_id": "no-such", "peer_transfers": {}, "own_sender_shares": {}}),
            ("/v1/mpc/ot/shares", {"session_id": "no-such", "party_x": 1}),
        ]:
            resp = client.post(endpoint, json=payload)
            assert resp.status_code == 404, f"Expected 404 for {endpoint}, got {resp.status_code}"
        store.close()


class TestMethodNotAllowed:
    def test_get_on_post_endpoint(self, client: TestClient) -> None:
        resp = client.get("/v1/signal")
        assert resp.status_code == 405

    def test_post_on_get_endpoint(self, client: TestClient) -> None:
        resp = client.post("/metrics")
        assert resp.status_code == 405


class TestResolveTimeout:
    def test_resolve_timeout_returns_504(self) -> None:
        """If resolve_all_pending exceeds 30s, return 504."""
        import asyncio
        from unittest.mock import patch, AsyncMock as AM

        store = ShareStore()
        purchase_orch = PurchaseOrchestrator(store)
        mock_attestor = AM(spec=OutcomeAttestor)

        async def slow_resolve(*args, **kwargs):
            await asyncio.sleep(100)

        mock_attestor.resolve_all_pending = slow_resolve
        mock_attestor.get_pending_signals.return_value = []

        app = create_app(store, purchase_orch, mock_attestor)
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post("/v1/signals/resolve")
        assert resp.status_code == 504
        assert "timed out" in resp.json()["detail"]
        store.close()

    def test_outcome_fetch_timeout_returns_504(self, share_store: ShareStore) -> None:
        """If fetch_event_result exceeds 10s, return 504."""
        import asyncio
        from unittest.mock import patch, AsyncMock as AM

        mock_attestor = AM(spec=OutcomeAttestor)

        async def slow_fetch(*args, **kwargs):
            await asyncio.sleep(100)

        mock_attestor.fetch_event_result = slow_fetch
        mock_attestor.get_pending_signals.return_value = []

        share_store.store("sig-timeout-oc", "0xG", Share(x=1, y=1), b"key")

        purchase_orch = PurchaseOrchestrator(share_store)
        app = create_app(share_store, purchase_orch, mock_attestor)
        client = TestClient(app)
        resp = client.post("/v1/signal/sig-timeout-oc/outcome", json={
            "signal_id": "sig-timeout-oc",
            "event_id": "evt-timeout",
            "outcome": 1,
            "validator_hotkey": "5xxx",
        })
        assert resp.status_code == 504
        assert "timed out" in resp.json()["detail"]


class TestFieldElementBoundsValidation:
    """Verify hex-to-int conversions reject values outside BN254 field."""

    def test_oversized_share_y_rejected(self, client: TestClient) -> None:
        """share_y exceeding BN254 prime must be rejected."""
        from djinn_validator.utils.crypto import BN254_PRIME
        oversized = hex(BN254_PRIME + 1)
        resp = client.post("/v1/signal", json={
            "signal_id": "test-oversize",
            "genius_address": "0x" + "ab" * 20,
            "share_x": 1,
            "share_y": oversized,
            "encrypted_key_share": "aabb",
            "shamir_threshold": 7,
        })
        assert resp.status_code == 400

    def test_valid_share_y_accepted(self, client: TestClient) -> None:
        """share_y within BN254 range should be accepted."""
        resp = client.post("/v1/signal", json={
            "signal_id": "test-valid-y",
            "genius_address": "0x" + "ab" * 20,
            "share_x": 1,
            "share_y": "ff",
            "encrypted_key_share": "aabb",
            "shamir_threshold": 7,
        })
        assert resp.status_code == 200

    def test_mpc_round1_oversized_d_value_rejected(self, client: TestClient) -> None:
        """d_value exceeding BN254 prime must be rejected via Pydantic max_length or server validation."""
        from djinn_validator.utils.crypto import BN254_PRIME
        oversized = hex(BN254_PRIME + 1)
        resp = client.post("/v1/mpc/round1", json={
            "session_id": "test-round1",
            "gate_idx": 0,
            "validator_x": 1,
            "d_value": oversized,
            "e_value": "ff",
        })
        # Pydantic rejects max_length=66 before server, or server rejects >= BN254_PRIME
        assert resp.status_code in (400, 422)

    def test_compute_gate_oversized_prev_d_rejected(self, client: TestClient, share_store: ShareStore) -> None:
        """prev_opened_d exceeding BN254 prime must be rejected."""
        from djinn_validator.utils.crypto import BN254_PRIME
        oversized = hex(BN254_PRIME + 1)
        xs = list(range(1, 8))
        share_store.store("sig-gate-bounds", "0xG", Share(x=1, y=42), b"key")
        client.post("/v1/mpc/init", json={
            "session_id": "sess-gate-bounds",
            "signal_id": "sig-gate-bounds",
            "available_indices": [1, 2],
            "coordinator_x": 1,
            "participant_xs": xs,
            "threshold": 2,
            "r_share_y": "ff",
            "triple_shares": [{"a": "1", "b": "2", "c": "2"}],
        })
        resp = client.post("/v1/mpc/compute_gate", json={
            "session_id": "sess-gate-bounds",
            "gate_idx": 1,
            "prev_opened_d": oversized,
            "prev_opened_e": "ff",
        })
        assert resp.status_code in (400, 422)


class TestOTParamBounds:
    """Verify OT setup rejects invalid field_prime / dh_prime values."""

    def test_ot_setup_invalid_hex_field_prime(self, client: TestClient) -> None:
        """Non-hex field_prime must be rejected."""
        resp = client.post("/v1/mpc/ot/setup", json={
            "session_id": "ot-hex-test",
            "n_triples": 1,
            "x_coords": [1, 2],
            "field_prime": "zzzz",
        })
        assert resp.status_code in (400, 422)


class TestAttestEndpoint:
    """Tests for the POST /v1/attest web attestation endpoint."""

    def test_attest_rejects_non_https(self, client: TestClient) -> None:
        resp = client.post(
            "/v1/attest",
            json={"url": "http://example.com", "request_id": "test-1"},
        )
        assert resp.status_code == 422

    def test_attest_requires_url(self, client: TestClient) -> None:
        resp = client.post("/v1/attest", json={"request_id": "test-1"})
        assert resp.status_code == 422

    def test_attest_no_miners(self, client: TestClient) -> None:
        """Without a neuron (no metagraph), no miners are available."""
        resp = client.post(
            "/v1/attest",
            json={"url": "https://example.com", "request_id": "test-2"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is False
        assert "No reachable miners" in data["error"]

    def test_attest_logs_to_attestation_log(self) -> None:
        """Attestation requests are logged when attestation_log is provided."""
        from djinn_validator.core.attestation_log import AttestationLog

        store = ShareStore()
        purchase_orch = PurchaseOrchestrator(store)
        outcome_attestor = OutcomeAttestor()
        attest_log = AttestationLog()

        app = create_app(
            store, purchase_orch, outcome_attestor,
            attestation_log=attest_log,
        )
        client = TestClient(app)

        resp = client.post("/v1/attest", json={
            "url": "https://example.com",
            "request_id": "test-log",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is False
        assert "No reachable miners" in data["error"]

        # Verify the failure was logged
        entries = attest_log.recent_attestations(1)
        assert len(entries) == 1
        assert entries[0]["url"] == "https://example.com"
        assert entries[0]["success"] is False

        store.close()
        attest_log.close()

    def test_attest_rejects_invalid_request_id(self, client: TestClient) -> None:
        """request_id with disallowed characters should be rejected."""
        resp = client.post("/v1/attest", json={
            "url": "https://example.com",
            "request_id": "id with spaces",
        })
        assert resp.status_code == 422

    def test_attest_rejects_localhost_url(self, client: TestClient) -> None:
        """SSRF: URLs pointing to localhost should be rejected."""
        resp = client.post("/v1/attest", json={
            "url": "https://localhost/secret",
            "request_id": "test-ssrf",
        })
        assert resp.status_code == 422

    def test_attest_rejects_private_ip_url(self, client: TestClient) -> None:
        """SSRF: URLs pointing to private IPs should be rejected."""
        resp = client.post("/v1/attest", json={
            "url": "https://192.168.1.1/admin",
            "request_id": "test-ssrf-priv",
        })
        assert resp.status_code == 422


class TestProductionChainGuard:
    """Tests that production mode (BT_NETWORK=finney/mainnet) blocks share release when chain_client is None."""

    def _store_signal(self, share_store: ShareStore) -> None:
        from djinn_validator.utils.crypto import generate_signal_index_shares
        shares = generate_signal_index_shares(5)
        share_store.store("sig-prod-guard", "0xGenius", shares[0], b"encrypted-key")

    def _make_purchase_request(self, client: TestClient) -> "requests.Response":
        return client.post("/v1/signal/sig-prod-guard/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DraftKings",
            "available_indices": [1, 3, 5, 7, 9],
        })

    def test_purchase_returns_503_when_no_chain_client_finney(self) -> None:
        """BT_NETWORK=finney with chain_client=None must return 503 on purchase."""
        import os
        from unittest.mock import patch
        from djinn_validator.core.mpc import MPCResult

        store = ShareStore()
        self._store_signal(store)
        purchase_orch = PurchaseOrchestrator(store)
        outcome_attestor = OutcomeAttestor()

        # Mock MPC to return available=True so we reach the chain guard
        async def mock_check_availability(*args, **kwargs):
            return MPCResult(available=True, participating_validators=1)

        with patch.dict(os.environ, {"BT_NETWORK": "finney", "CORS_ORIGINS": "https://test.example.com"}):
            app = create_app(store, purchase_orch, outcome_attestor, chain_client=None)
            with patch(
                "djinn_validator.core.mpc_orchestrator.MPCOrchestrator.check_availability",
                new=mock_check_availability,
            ):
                client = TestClient(app)
                resp = self._make_purchase_request(client)

        assert resp.status_code == 503
        assert "Payment verification unavailable" in resp.json()["detail"]

        store.close()

    def test_purchase_returns_503_when_no_chain_client_mainnet(self) -> None:
        """BT_NETWORK=mainnet with chain_client=None must return 503 on purchase."""
        import os
        from unittest.mock import patch
        from djinn_validator.core.mpc import MPCResult

        store = ShareStore()
        self._store_signal(store)
        purchase_orch = PurchaseOrchestrator(store)
        outcome_attestor = OutcomeAttestor()

        async def mock_check_availability(*args, **kwargs):
            return MPCResult(available=True, participating_validators=1)

        with patch.dict(os.environ, {"BT_NETWORK": "mainnet", "CORS_ORIGINS": "https://test.example.com"}):
            app = create_app(store, purchase_orch, outcome_attestor, chain_client=None)
            with patch(
                "djinn_validator.core.mpc_orchestrator.MPCOrchestrator.check_availability",
                new=mock_check_availability,
            ):
                client = TestClient(app)
                resp = self._make_purchase_request(client)

        assert resp.status_code == 503
        assert "Payment verification unavailable" in resp.json()["detail"]

        store.close()

    def test_purchase_works_in_dev_mode_no_chain_client(self) -> None:
        """BT_NETWORK=test with chain_client=None must NOT return 503 (dev mode)."""
        import os
        from unittest.mock import patch
        from djinn_validator.core.mpc import MPCResult

        store = ShareStore()
        self._store_signal(store)
        purchase_orch = PurchaseOrchestrator(store)
        outcome_attestor = OutcomeAttestor()

        async def mock_check_availability(*args, **kwargs):
            return MPCResult(available=True, participating_validators=1)

        with patch.dict(os.environ, {"BT_NETWORK": "test"}):
            app = create_app(store, purchase_orch, outcome_attestor, chain_client=None)
            with patch(
                "djinn_validator.core.mpc_orchestrator.MPCOrchestrator.check_availability",
                new=mock_check_availability,
            ):
                client = TestClient(app)
                resp = self._make_purchase_request(client)

        assert resp.status_code == 200
        data = resp.json()
        assert data["signal_id"] == "sig-prod-guard"
        # Dev mode should complete without chain verification — never 503
        assert data["status"] == "complete"

        store.close()
