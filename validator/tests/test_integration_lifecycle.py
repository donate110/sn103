"""Integration test: full signal lifecycle through the validator API.

Exercises the complete flow:
1. Store key share for a signal (Shamir share of the real index)
2. Run MPC availability check
3. Purchase signal (release encrypted key share)
4. Verify returned key share matches what was stored
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from djinn_validator.api.server import create_app
from djinn_validator.core.mpc_coordinator import MPCCoordinator
from djinn_validator.core.outcomes import OutcomeAttestor
from djinn_validator.core.purchase import PurchaseOrchestrator
from djinn_validator.core.shares import ShareStore
from djinn_validator.utils.crypto import (
    Share,
    generate_signal_index_shares,
    reconstruct_secret,
    split_secret,
)


@pytest.fixture
def share_store():
    store = ShareStore()  # in-memory for tests
    yield store
    store.close()


@pytest.fixture
def client(share_store: ShareStore) -> TestClient:
    purchase_orch = PurchaseOrchestrator(share_store)
    outcome_attestor = OutcomeAttestor(sports_api_key="test-key")
    mpc_coordinator = MPCCoordinator()
    app = create_app(
        share_store=share_store,
        purchase_orch=purchase_orch,
        outcome_attestor=outcome_attestor,
        mpc_coordinator=mpc_coordinator,
    )
    return TestClient(app)


class TestSignalLifecycle:
    """End-to-end test of the signal creation → purchase → decrypt flow."""

    def test_full_lifecycle_available(self, client: TestClient, share_store: ShareStore) -> None:
        """Signal is available at sportsbook → purchase succeeds and key is returned."""
        real_index = 3  # The genius's real pick is line #3
        signal_id = "lifecycle-available-001"
        genius_address = "0x" + "cc" * 20
        encrypted_aes_key = b"this-is-the-encrypted-aes-key!!"

        # In single-validator dev mode, the MPC prototype reconstructs from
        # a single share with threshold=1. We store the raw secret directly
        # as share (x=1, y=real_index) so the prototype can evaluate correctly.
        share = Share(x=1, y=real_index)

        # Store the share via API
        resp = client.post("/v1/signal", json={
            "signal_id": signal_id,
            "genius_address": genius_address,
            "share_x": share.x,
            "share_y": hex(share.y)[2:],
            "encrypted_key_share": encrypted_aes_key.hex(),
        })
        assert resp.status_code == 200
        assert resp.json()["stored"] is True

        # Purchase — available_indices includes the real index (3)
        resp = client.post(f"/v1/signal/{signal_id}/purchase", json={
            "buyer_address": "0x" + "b1" * 20,
            "sportsbook": "DraftKings",
            "available_indices": [1, 2, 3, 5, 7],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "complete"
        assert data["available"] is True
        assert data["encrypted_key_share"] is not None

        # Verify the returned key matches what was stored
        recovered_key = bytes.fromhex(data["encrypted_key_share"])
        assert recovered_key == encrypted_aes_key

    def test_full_lifecycle_unavailable(self, client: TestClient, share_store: ShareStore) -> None:
        """Signal is NOT available at sportsbook → purchase returns unavailable."""
        real_index = 5
        signal_id = "lifecycle-unavailable-001"
        encrypted_aes_key = b"should-not-be-released"

        share = Share(x=1, y=real_index)

        # Store share
        client.post("/v1/signal", json={
            "signal_id": signal_id,
            "genius_address": "0x" + "aa" * 20,
            "share_x": share.x,
            "share_y": hex(share.y)[2:],
            "encrypted_key_share": encrypted_aes_key.hex(),
        })

        # Purchase — available_indices does NOT include the real index (5)
        resp = client.post(f"/v1/signal/{signal_id}/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DraftKings",
            "available_indices": [1, 2, 3, 4, 7, 8, 9],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "unavailable"
        assert data["available"] is False
        assert data["encrypted_key_share"] is None

    def test_double_purchase_returns_same_key(self, client: TestClient, share_store: ShareStore) -> None:
        """Same buyer purchasing twice gets the same key share."""
        real_index = 2
        signal_id = "lifecycle-double-001"
        encrypted_aes_key = b"consistent-key-share"

        share = Share(x=1, y=real_index)

        client.post("/v1/signal", json={
            "signal_id": signal_id,
            "genius_address": "0x" + "aa" * 20,
            "share_x": share.x,
            "share_y": hex(share.y)[2:],
            "encrypted_key_share": encrypted_aes_key.hex(),
        })

        # First purchase
        resp1 = client.post(f"/v1/signal/{signal_id}/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DraftKings",
            "available_indices": [1, 2, 3],
        })
        key1 = resp1.json()["encrypted_key_share"]

        # Second purchase (same buyer)
        resp2 = client.post(f"/v1/signal/{signal_id}/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DraftKings",
            "available_indices": [1, 2, 3],
        })
        key2 = resp2.json()["encrypted_key_share"]

        assert key1 == key2

    def test_shamir_index_roundtrip(self) -> None:
        """Verify that signal index shares reconstruct correctly."""
        for real_index in range(1, 11):
            shares = generate_signal_index_shares(real_index, n=10, k=7)
            # Any 7 shares should reconstruct
            assert reconstruct_secret(shares[:7]) == real_index
            assert reconstruct_secret(shares[3:10]) == real_index

    def test_health_with_shares(self, client: TestClient, share_store: ShareStore) -> None:
        """Health endpoint reflects share count."""
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["shares_held"] == 0

        share_store.store("sig-health", "0xG", Share(x=1, y=12345), b"enc")

        resp = client.get("/health")
        assert resp.json()["shares_held"] == 1

    def test_purchase_nonexistent_signal(self, client: TestClient) -> None:
        """Purchasing a nonexistent signal returns 404."""
        resp = client.post("/v1/signal/nonexistent/purchase", json={
            "buyer_address": "0x" + "b0" * 20,
            "sportsbook": "DraftKings",
            "available_indices": [1],
        })
        assert resp.status_code == 404

    def test_register_and_resolve(self, client: TestClient) -> None:
        """Register a signal for outcome tracking."""
        resp = client.post("/v1/signal/test-123/register", json={
            "sport": "basketball_nba",
            "event_id": "evt-abc",
            "home_team": "Lakers",
            "away_team": "Celtics",
            "lines": [
                "Lakers -3.5 (-110)", "Celtics +3.5 (-110)", "Over 218.5 (-110)",
                "Under 218.5 (-110)", "Lakers ML (-150)", "Celtics ML (+130)",
                "Lakers -1.5 (-105)", "Celtics +1.5 (-115)", "Over 215.0 (-110)",
                "Under 215.0 (-110)",
            ],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["registered"] is True
        assert data["signal_id"] == "test-123"
