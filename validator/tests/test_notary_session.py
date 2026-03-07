"""Tests for POST /v1/notary/session endpoint with burn-gate auth."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from djinn_validator.api.server import create_app
from djinn_validator.core.challenges import PeerNotary
from djinn_validator.core.outcomes import OutcomeAttestor
from djinn_validator.core.purchase import PurchaseOrchestrator
from djinn_validator.core.shares import ShareStore


BURN_AUTH_HEADERS = {
    "X-Coldkey": "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    "X-Burn-Tx": "0xabc123def456",
    "X-Signature": "0x" + "aa" * 64,
}


def _mock_auth_success(coldkey: str, tx_hash: str, sig: str, substrate: object) -> tuple[bool, str]:
    return True, ""


def _mock_auth_fail(coldkey: str, tx_hash: str, sig: str, substrate: object) -> tuple[bool, str]:
    return False, "Invalid signature"


@pytest.fixture
def mock_neuron() -> MagicMock:
    neuron = MagicMock()
    neuron.metagraph = MagicMock()
    neuron.metagraph.coldkeys = ["cold_validator", "cold_operator_A", "cold_operator_B", "cold_operator_A"]
    neuron.uid = 0
    neuron.wallet = None
    neuron.subtensor = MagicMock()
    neuron.subtensor.substrate = MagicMock()
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


class TestBurnGateAuth:
    """Burn-gate authentication tests."""

    def test_missing_headers(self, client: TestClient) -> None:
        resp = client.post("/v1/notary/session")
        assert resp.status_code == 401
        assert "Missing" in resp.json()["detail"]

    def test_missing_coldkey(self, client: TestClient) -> None:
        headers = {k: v for k, v in BURN_AUTH_HEADERS.items() if k != "X-Coldkey"}
        resp = client.post("/v1/notary/session", headers=headers)
        assert resp.status_code == 401

    def test_missing_tx_hash(self, client: TestClient) -> None:
        headers = {k: v for k, v in BURN_AUTH_HEADERS.items() if k != "X-Burn-Tx"}
        resp = client.post("/v1/notary/session", headers=headers)
        assert resp.status_code == 401

    def test_missing_signature(self, client: TestClient) -> None:
        headers = {k: v for k, v in BURN_AUTH_HEADERS.items() if k != "X-Signature"}
        resp = client.post("/v1/notary/session", headers=headers)
        assert resp.status_code == 401

    def test_invalid_signature(self, client: TestClient) -> None:
        with patch("djinn_validator.api.burn_gate.authenticate_request", side_effect=_mock_auth_fail):
            resp = client.post("/v1/notary/session", headers=BURN_AUTH_HEADERS)
        assert resp.status_code == 401
        assert "Invalid signature" in resp.json()["detail"]

    @patch(
        "djinn_validator.core.challenges.discover_peer_notaries",
        new_callable=AsyncMock,
        return_value=SAMPLE_NOTARIES,
    )
    def test_valid_burn_auth(self, mock_discover: AsyncMock, client: TestClient) -> None:
        with patch("djinn_validator.api.burn_gate.authenticate_request", side_effect=_mock_auth_success):
            resp = client.post("/v1/notary/session", headers=BURN_AUTH_HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert "session_id" in data
        assert data["miner_port"] == 8422


class TestNotarySessionAssignment:
    """Miner assignment tests (with mocked auth)."""

    def _authed_post(self, client: TestClient, **kwargs: object) -> object:
        with patch("djinn_validator.api.burn_gate.authenticate_request", side_effect=_mock_auth_success):
            return client.post(
                "/v1/notary/session",
                headers=BURN_AUTH_HEADERS,
                **kwargs,
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
        share_store = ShareStore()
        purchase_orch = PurchaseOrchestrator(share_store)
        outcome_attestor = OutcomeAttestor()
        app = create_app(share_store, purchase_orch, outcome_attestor, neuron=None)
        no_neuron_client = TestClient(app)

        with patch("djinn_validator.api.burn_gate.authenticate_request", side_effect=_mock_auth_success):
            resp = no_neuron_client.post(
                "/v1/notary/session",
                headers=BURN_AUTH_HEADERS,
            )
        assert resp.status_code == 503
        assert "network" in resp.json()["detail"].lower()

    def test_no_miners(self, client: TestClient, mock_neuron: MagicMock) -> None:
        mock_neuron.get_miner_uids.return_value = []
        resp = self._authed_post(client)
        assert resp.status_code == 503

    @patch(
        "djinn_validator.core.challenges.discover_peer_notaries",
        new_callable=AsyncMock,
        return_value=SAMPLE_NOTARIES,
    )
    def test_response_has_miner_hotkey(self, mock_discover: AsyncMock, client: TestClient) -> None:
        resp = self._authed_post(client)
        data = resp.json()
        chosen_ip = data["miner_ip"]
        if chosen_ip == "1.2.3.4":
            assert data["miner_hotkey"] == "hotkey_1"
        elif chosen_ip == "5.6.7.8":
            assert data["miner_hotkey"] == "hotkey_2"


class TestNotarySessionExclusions:
    """Miner exclusion and dedup tests."""

    def _authed_post(self, client: TestClient, **kwargs: object) -> object:
        with patch("djinn_validator.api.burn_gate.authenticate_request", side_effect=_mock_auth_success):
            return client.post(
                "/v1/notary/session",
                headers=BURN_AUTH_HEADERS,
                **kwargs,
            )

    @patch(
        "djinn_validator.core.challenges.discover_peer_notaries",
        new_callable=AsyncMock,
        return_value=SAMPLE_NOTARIES,
    )
    def test_no_exclusions_uses_all_miners(self, mock_discover: AsyncMock, client: TestClient) -> None:
        resp = self._authed_post(client)
        assert resp.status_code == 200
        called_axons = mock_discover.call_args[0][1]
        assert len(called_axons) == 3

    @patch(
        "djinn_validator.core.challenges.discover_peer_notaries",
        new_callable=AsyncMock,
        return_value=[SAMPLE_NOTARIES[1]],
    )
    def test_exclude_miners_request_body_dedup(self, mock_discover: AsyncMock, client: TestClient) -> None:
        resp = self._authed_post(client, json={"exclude_miners": ["hotkey_1", "hotkey_3"]})
        assert resp.status_code == 200
        called_axons = mock_discover.call_args[0][1]
        hotkeys_sent = {a["hotkey"] for a in called_axons}
        assert "hotkey_1" not in hotkeys_sent
        assert "hotkey_3" not in hotkeys_sent
        assert "hotkey_2" in hotkeys_sent

    @patch(
        "djinn_validator.core.challenges.discover_peer_notaries",
        new_callable=AsyncMock,
        return_value=[SAMPLE_NOTARIES[1]],
    )
    def test_exclude_ips_dedup(self, mock_discover: AsyncMock, client: TestClient) -> None:
        resp = self._authed_post(client, json={"exclude_ips": ["1.2.3.4", "9.10.11.12"]})
        assert resp.status_code == 200
        called_axons = mock_discover.call_args[0][1]
        ips_sent = {a["ip"] for a in called_axons}
        assert "1.2.3.4" not in ips_sent
        assert "9.10.11.12" not in ips_sent
        assert "5.6.7.8" in ips_sent

    def test_exclude_all_miners_returns_503(self, client: TestClient) -> None:
        resp = self._authed_post(client, json={"exclude_miners": ["hotkey_1", "hotkey_2", "hotkey_3"]})
        assert resp.status_code == 503
        assert "exclusion" in resp.json()["detail"].lower()


class TestBurnGateUnit:
    """Unit tests for burn_gate module functions."""

    def test_verify_signature_bad_coldkey(self) -> None:
        from djinn_validator.api.burn_gate import verify_signature
        assert verify_signature("not_an_ss58", "abcd", "ee" * 64) is False

    def test_cache_eviction(self) -> None:
        from djinn_validator.api.burn_gate import _cache, _cache_set, CACHE_TTL_SECONDS
        _cache.clear()
        old_ts = time.time() - CACHE_TTL_SECONDS - 10
        for i in range(1010):
            _cache[f"tx_{i}"] = {"valid": True, "error": "", "coldkey": "x", "block_ts": 0, "checked_at": old_ts}
        _cache_set("tx_new", {"valid": True, "error": "", "coldkey": "x", "block_ts": 0})
        assert len(_cache) <= 2

    def test_authenticate_missing_fields(self) -> None:
        from djinn_validator.api.burn_gate import authenticate_request
        valid, err = authenticate_request("", "", "", None)
        assert not valid
        assert "Missing" in err

    def test_verify_burn_tx_caches_result(self) -> None:
        from djinn_validator.api.burn_gate import _cache, _cache_set, verify_burn_tx
        _cache.clear()
        import time as _t
        _cache_set("0xtest123", {
            "valid": True,
            "error": "",
            "coldkey": "5GoodColdkey",
            "amount": 2.0,
            "block_ts": _t.time() - 100,
        })
        valid, err = verify_burn_tx("0xtest123", "5GoodColdkey", None)
        assert valid
        assert err == ""

    def test_verify_burn_tx_cached_wrong_coldkey(self) -> None:
        from djinn_validator.api.burn_gate import _cache, _cache_set, verify_burn_tx
        _cache.clear()
        import time as _t
        _cache_set("0xtest456", {
            "valid": True,
            "error": "",
            "coldkey": "5GoodColdkey",
            "amount": 2.0,
            "block_ts": _t.time() - 100,
        })
        valid, err = verify_burn_tx("0xtest456", "5DifferentColdkey", None)
        assert not valid
        assert "coldkey" in err.lower()

    def test_verify_burn_tx_cached_expired(self) -> None:
        from djinn_validator.api.burn_gate import _cache, _cache_set, verify_burn_tx, BURN_WINDOW_SECONDS
        _cache.clear()
        import time as _t
        _cache_set("0xold789", {
            "valid": True,
            "error": "",
            "coldkey": "5GoodColdkey",
            "amount": 2.0,
            "block_ts": _t.time() - BURN_WINDOW_SECONDS - 100,
        })
        valid, err = verify_burn_tx("0xold789", "5GoodColdkey", None)
        assert not valid
        assert "old" in err.lower()
