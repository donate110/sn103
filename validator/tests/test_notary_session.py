"""Tests for POST /v1/notary/session endpoint and JWT auth."""

from __future__ import annotations

import os
import time
from unittest.mock import AsyncMock, MagicMock, patch

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from djinn_validator.api.server import create_app
from djinn_validator.core.challenges import PeerNotary
from djinn_validator.core.outcomes import OutcomeAttestor
from djinn_validator.core.purchase import PurchaseOrchestrator
from djinn_validator.core.shares import ShareStore


# Generate a test Ed25519 keypair
_private_key = Ed25519PrivateKey.generate()
_public_key = _private_key.public_key()
_pubkey_hex = _private_key.public_key().public_bytes_raw().hex()


def _make_token(exp: int | None = None, **extra_claims: object) -> str:
    """Create a signed JWT with the test private key."""
    payload = {"sub": "test_user", "exp": exp or int(time.time()) + 60, **extra_claims}
    return jwt.encode(payload, _private_key, algorithm="EdDSA")


def _make_expired_token() -> str:
    return _make_token(exp=int(time.time()) - 10)


@pytest.fixture
def mock_neuron() -> MagicMock:
    neuron = MagicMock()
    neuron.metagraph = MagicMock()
    # Coldkeys indexed by UID (0=validator, 1-3=miners)
    neuron.metagraph.coldkeys = ["cold_validator", "cold_operator_A", "cold_operator_B", "cold_operator_A"]
    neuron.uid = 0
    neuron.wallet = None
    neuron.get_miner_uids.return_value = [1, 2, 3]
    neuron.get_axon_info.side_effect = lambda uid: {
        1: {"ip": "1.2.3.4", "port": 8422, "hotkey": "hotkey_1"},
        2: {"ip": "5.6.7.8", "port": 8422, "hotkey": "hotkey_2"},
        3: {"ip": "9.10.11.12", "port": 8422, "hotkey": "hotkey_3"},
    }[uid]
    return neuron


@pytest.fixture
def client(mock_neuron: MagicMock) -> TestClient:
    share_store = ShareStore()
    purchase_orch = PurchaseOrchestrator(share_store)
    outcome_attestor = OutcomeAttestor()
    app = create_app(
        share_store, purchase_orch, outcome_attestor, neuron=mock_neuron,
    )
    return TestClient(app)


SAMPLE_NOTARIES = [
    PeerNotary(uid=1, ip="1.2.3.4", port=8422, notary_port=7047, pubkey_hex="02" + "ab" * 32),
    PeerNotary(uid=2, ip="5.6.7.8", port=8422, notary_port=7047, pubkey_hex="02" + "cd" * 32),
]


class TestNotarySessionAuth:
    """JWT authentication tests."""

    def test_missing_auth_header(self, client: TestClient) -> None:
        resp = client.post("/v1/notary/session")
        assert resp.status_code == 401
        assert "Bearer" in resp.json()["detail"]

    def test_invalid_token(self, client: TestClient) -> None:
        with patch.dict(os.environ, {"NOTARY_AUTH_PUBKEY": _pubkey_hex}):
            # Force reimport to pick up env var
            import importlib
            from djinn_validator.api import jwt_auth
            importlib.reload(jwt_auth)
            try:
                resp = client.post(
                    "/v1/notary/session",
                    headers={"Authorization": "Bearer garbage.token.here"},
                )
                assert resp.status_code == 401
            finally:
                importlib.reload(jwt_auth)

    def test_expired_token(self, client: TestClient) -> None:
        with patch.dict(os.environ, {"NOTARY_AUTH_PUBKEY": _pubkey_hex}):
            import importlib
            from djinn_validator.api import jwt_auth
            importlib.reload(jwt_auth)
            try:
                token = _make_expired_token()
                resp = client.post(
                    "/v1/notary/session",
                    headers={"Authorization": f"Bearer {token}"},
                )
                assert resp.status_code == 401
                assert "expired" in resp.json()["detail"].lower()
            finally:
                importlib.reload(jwt_auth)

    def test_no_pubkey_configured(self, client: TestClient) -> None:
        """When NOTARY_AUTH_PUBKEY is not set, all requests are rejected."""
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("NOTARY_AUTH_PUBKEY", None)
            import importlib
            from djinn_validator.api import jwt_auth
            importlib.reload(jwt_auth)
            try:
                token = _make_token()
                resp = client.post(
                    "/v1/notary/session",
                    headers={"Authorization": f"Bearer {token}"},
                )
                assert resp.status_code == 401
                assert "not configured" in resp.json()["detail"].lower()
            finally:
                importlib.reload(jwt_auth)


class TestNotarySessionAssignment:
    """Miner assignment tests (with valid auth)."""

    def _authed_post(self, client: TestClient) -> object:
        """POST with a valid JWT, mocking jwt_auth.verify_token."""
        with patch("djinn_validator.api.jwt_auth.verify_token", return_value={"sub": "test"}):
            return client.post(
                "/v1/notary/session",
                headers={"Authorization": "Bearer valid.test.token"},
            )

    @patch(
        "djinn_validator.core.challenges.discover_peer_notaries",
        new_callable=AsyncMock,
        return_value=SAMPLE_NOTARIES,
    )
    def test_success(self, mock_discover: AsyncMock, client: TestClient) -> None:
        resp = self._authed_post(client)
        assert resp.status_code == 200
        data = resp.json()
        assert "session_id" in data
        assert data["miner_port"] == 8422
        assert data["miner_ws_path"] == "/v1/notary/ws"
        assert data["notary_public_key"].startswith("02")
        assert data["miner_hotkey"] in ("hotkey_1", "hotkey_2", "hotkey_3")
        assert data["expires_at"] > int(time.time())

    @patch(
        "djinn_validator.core.challenges.discover_peer_notaries",
        new_callable=AsyncMock,
        return_value=[],
    )
    def test_no_notary_sidecars(self, mock_discover: AsyncMock, client: TestClient) -> None:
        resp = self._authed_post(client)
        assert resp.status_code == 503
        assert "notary" in resp.json()["detail"].lower()

    def test_no_neuron(self) -> None:
        """When validator isn't connected to BT, return 503."""
        share_store = ShareStore()
        purchase_orch = PurchaseOrchestrator(share_store)
        outcome_attestor = OutcomeAttestor()
        app = create_app(share_store, purchase_orch, outcome_attestor, neuron=None)
        no_neuron_client = TestClient(app)

        with patch("djinn_validator.api.jwt_auth.verify_token", return_value={"sub": "test"}):
            resp = no_neuron_client.post(
                "/v1/notary/session",
                headers={"Authorization": "Bearer valid.test.token"},
            )
        assert resp.status_code == 503
        assert "network" in resp.json()["detail"].lower()

    def test_no_miners(self, client: TestClient, mock_neuron: MagicMock) -> None:
        """When metagraph has no miners, return 503."""
        mock_neuron.get_miner_uids.return_value = []
        with patch("djinn_validator.api.jwt_auth.verify_token", return_value={"sub": "test"}):
            resp = client.post(
                "/v1/notary/session",
                headers={"Authorization": "Bearer valid.test.token"},
            )
        assert resp.status_code == 503

    @patch(
        "djinn_validator.core.challenges.discover_peer_notaries",
        new_callable=AsyncMock,
        return_value=SAMPLE_NOTARIES,
    )
    def test_response_has_miner_hotkey(self, mock_discover: AsyncMock, client: TestClient) -> None:
        resp = self._authed_post(client)
        data = resp.json()
        # The hotkey should correspond to the chosen miner's UID
        chosen_ip = data["miner_ip"]
        if chosen_ip == "1.2.3.4":
            assert data["miner_hotkey"] == "hotkey_1"
        elif chosen_ip == "5.6.7.8":
            assert data["miner_hotkey"] == "hotkey_2"


class TestNotarySessionExclusions:
    """Miner exclusion by hotkey and coldkey."""

    @patch(
        "djinn_validator.core.challenges.discover_peer_notaries",
        new_callable=AsyncMock,
        return_value=[SAMPLE_NOTARIES[1]],  # only miner 2 left after exclusion
    )
    def test_exclude_by_hotkey(self, mock_discover: AsyncMock, client: TestClient) -> None:
        """Miners with excluded hotkeys are filtered before discovery."""
        claims = {"sub": "test", "exclude_hotkeys": ["hotkey_1"]}
        with patch("djinn_validator.api.jwt_auth.verify_token", return_value=claims):
            resp = client.post(
                "/v1/notary/session",
                headers={"Authorization": "Bearer valid.test.token"},
            )
        assert resp.status_code == 200
        # discover_peer_notaries should only have received axons without hotkey_1
        called_axons = mock_discover.call_args[0][1]
        hotkeys_sent = {a["hotkey"] for a in called_axons}
        assert "hotkey_1" not in hotkeys_sent

    @patch(
        "djinn_validator.core.challenges.discover_peer_notaries",
        new_callable=AsyncMock,
        return_value=[SAMPLE_NOTARIES[1]],  # only miner 2 survives
    )
    def test_exclude_by_coldkey(self, mock_discover: AsyncMock, client: TestClient) -> None:
        """Miners sharing a coldkey with excluded coldkeys are filtered out.

        In our fixture: miners 1 and 3 share cold_operator_A, miner 2 has cold_operator_B.
        Excluding cold_operator_A should remove miners 1 and 3.
        """
        claims = {"sub": "test", "exclude_coldkeys": ["cold_operator_A"]}
        with patch("djinn_validator.api.jwt_auth.verify_token", return_value=claims):
            resp = client.post(
                "/v1/notary/session",
                headers={"Authorization": "Bearer valid.test.token"},
            )
        assert resp.status_code == 200
        called_axons = mock_discover.call_args[0][1]
        # Only miner 2 (cold_operator_B) should remain
        uids_sent = {a["uid"] for a in called_axons}
        assert uids_sent == {2}

    def test_exclude_all_miners_returns_503(self, client: TestClient) -> None:
        """If exclusions remove all miners, return 503."""
        claims = {"sub": "test", "exclude_hotkeys": ["hotkey_1", "hotkey_2", "hotkey_3"]}
        with patch("djinn_validator.api.jwt_auth.verify_token", return_value=claims):
            resp = client.post(
                "/v1/notary/session",
                headers={"Authorization": "Bearer valid.test.token"},
            )
        assert resp.status_code == 503
        assert "exclusion" in resp.json()["detail"].lower()

    @patch(
        "djinn_validator.core.challenges.discover_peer_notaries",
        new_callable=AsyncMock,
        return_value=SAMPLE_NOTARIES,
    )
    def test_no_exclusions_uses_all_miners(self, mock_discover: AsyncMock, client: TestClient) -> None:
        """Without exclusion claims, all miners are considered."""
        claims = {"sub": "test"}
        with patch("djinn_validator.api.jwt_auth.verify_token", return_value=claims):
            resp = client.post(
                "/v1/notary/session",
                headers={"Authorization": "Bearer valid.test.token"},
            )
        assert resp.status_code == 200
        called_axons = mock_discover.call_args[0][1]
        assert len(called_axons) == 3

    @patch(
        "djinn_validator.core.challenges.discover_peer_notaries",
        new_callable=AsyncMock,
        return_value=[SAMPLE_NOTARIES[1]],  # only miner 2 after dedup
    )
    def test_exclude_miners_request_body_dedup(self, mock_discover: AsyncMock, client: TestClient) -> None:
        """exclude_miners in request body filters previously assigned miners."""
        claims = {"sub": "test"}
        with patch("djinn_validator.api.jwt_auth.verify_token", return_value=claims):
            resp = client.post(
                "/v1/notary/session",
                headers={"Authorization": "Bearer valid.test.token"},
                json={"exclude_miners": ["hotkey_1", "hotkey_3"]},
            )
        assert resp.status_code == 200
        called_axons = mock_discover.call_args[0][1]
        hotkeys_sent = {a["hotkey"] for a in called_axons}
        assert "hotkey_1" not in hotkeys_sent
        assert "hotkey_3" not in hotkeys_sent
        assert "hotkey_2" in hotkeys_sent
