"""Tests for notary ticket creation and verification on the validator side.

The validator creates signed tickets when assigning peer notaries. These
tickets authorize specific prover-to-notary connections, preventing DDoS
attacks from malicious miners opening unauthorized WebSocket connections.
"""

from __future__ import annotations

import base64
import json
import time
from unittest.mock import MagicMock, patch

import pytest

from djinn_validator.api.middleware import (
    create_notary_ticket,
    verify_notary_ticket,
)


def _mock_wallet(ss58: str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty") -> MagicMock:
    """Create a mock wallet with a hotkey that signs and verifies."""
    wallet = MagicMock()
    wallet.hotkey.ss58_address = ss58
    # Deterministic mock signature for testing
    wallet.hotkey.sign.return_value = b"\xde\xad\xbe\xef" * 16
    return wallet


class TestCreateNotaryTicket:
    """Test ticket creation by the validator."""

    def test_creates_valid_base64(self) -> None:
        """Ticket is valid base64-encoded JSON."""
        wallet = _mock_wallet()
        ticket_b64 = create_notary_ticket(prover_uid=10, notary_uid=20, wallet=wallet)
        raw = base64.b64decode(ticket_b64)
        ticket = json.loads(raw)
        assert "payload" in ticket
        assert "signature" in ticket

    def test_payload_contains_required_fields(self) -> None:
        """Payload includes prover_uid, notary_uid, expires, nonce, validator."""
        wallet = _mock_wallet()
        ticket_b64 = create_notary_ticket(prover_uid=10, notary_uid=20, wallet=wallet)
        ticket = json.loads(base64.b64decode(ticket_b64))
        payload = ticket["payload"]
        assert payload["prover_uid"] == 10
        assert payload["notary_uid"] == 20
        assert payload["expires"] > int(time.time())
        assert len(payload["nonce"]) == 32  # UUID hex
        assert payload["validator"] == wallet.hotkey.ss58_address

    def test_ttl_applied(self) -> None:
        """Custom TTL affects expiry timestamp."""
        wallet = _mock_wallet()
        before = int(time.time())
        ticket_b64 = create_notary_ticket(prover_uid=1, notary_uid=2, wallet=wallet, ttl_seconds=60)
        ticket = json.loads(base64.b64decode(ticket_b64))
        expires = ticket["payload"]["expires"]
        assert before + 55 <= expires <= before + 65

    def test_signs_sorted_payload(self) -> None:
        """Wallet.hotkey.sign is called with sort_keys=True JSON."""
        wallet = _mock_wallet()
        create_notary_ticket(prover_uid=10, notary_uid=20, wallet=wallet)
        call_args = wallet.hotkey.sign.call_args[0][0]
        # Verify it's valid JSON with sorted keys
        parsed = json.loads(call_args)
        assert list(parsed.keys()) == sorted(parsed.keys())

    def test_unique_nonces(self) -> None:
        """Each ticket gets a unique nonce."""
        wallet = _mock_wallet()
        t1 = json.loads(base64.b64decode(create_notary_ticket(1, 2, wallet)))
        t2 = json.loads(base64.b64decode(create_notary_ticket(1, 2, wallet)))
        assert t1["payload"]["nonce"] != t2["payload"]["nonce"]


class TestCreateAndVerifyRoundTrip:
    """Test that tickets created by the validator verify correctly."""

    def test_round_trip(self) -> None:
        """A ticket created by create_notary_ticket passes verify_notary_ticket."""
        wallet = _mock_wallet()
        ticket_b64 = create_notary_ticket(prover_uid=10, notary_uid=20, wallet=wallet)

        with patch("djinn_validator.api.middleware.verify_hotkey_signature", return_value=True):
            valid, err, payload = verify_notary_ticket(ticket_b64, expected_notary_uid=20)
        assert valid is True
        assert err == ""
        assert payload["prover_uid"] == 10

    def test_round_trip_wrong_notary(self) -> None:
        """Ticket fails when presented to wrong notary."""
        wallet = _mock_wallet()
        ticket_b64 = create_notary_ticket(prover_uid=10, notary_uid=20, wallet=wallet)

        with patch("djinn_validator.api.middleware.verify_hotkey_signature", return_value=True):
            valid, err, payload = verify_notary_ticket(ticket_b64, expected_notary_uid=99)
        assert valid is False
        assert "mismatch" in err

    def test_round_trip_expired(self) -> None:
        """Ticket with negative TTL is already expired."""
        wallet = _mock_wallet()
        ticket_b64 = create_notary_ticket(prover_uid=10, notary_uid=20, wallet=wallet, ttl_seconds=-5)
        valid, err, payload = verify_notary_ticket(ticket_b64)
        assert valid is False
        assert "expired" in err

    def test_round_trip_with_validator_allowlist(self) -> None:
        """Ticket passes when validator is in the allowlist."""
        vk = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"
        wallet = _mock_wallet(ss58=vk)
        ticket_b64 = create_notary_ticket(prover_uid=10, notary_uid=20, wallet=wallet)

        with patch("djinn_validator.api.middleware.verify_hotkey_signature", return_value=True):
            valid, err, payload = verify_notary_ticket(
                ticket_b64, validator_hotkeys={vk}
            )
        assert valid is True

    def test_round_trip_validator_not_in_allowlist(self) -> None:
        """Ticket fails when validator is not in the allowlist."""
        wallet = _mock_wallet(ss58="5NotAllowed")
        ticket_b64 = create_notary_ticket(prover_uid=10, notary_uid=20, wallet=wallet)

        valid, err, payload = verify_notary_ticket(
            ticket_b64, validator_hotkeys={"5OnlyThisOne"}
        )
        assert valid is False
        assert "not authorized" in err


class TestVerifyNotaryTicketEdgeCases:
    """Edge cases for verify_notary_ticket."""

    def test_malformed_base64(self) -> None:
        valid, err, _ = verify_notary_ticket("!!!not-base64!!!")
        assert valid is False
        assert "malformed" in err

    def test_empty_string(self) -> None:
        valid, err, _ = verify_notary_ticket("")
        assert valid is False

    def test_valid_base64_invalid_json(self) -> None:
        ticket = base64.b64encode(b"not json at all").decode()
        valid, err, _ = verify_notary_ticket(ticket)
        assert valid is False

    def test_missing_payload_key(self) -> None:
        ticket = base64.b64encode(json.dumps({"signature": "abc"}).encode()).decode()
        valid, err, _ = verify_notary_ticket(ticket)
        assert valid is False
        assert "missing" in err

    def test_missing_signature_key(self) -> None:
        ticket = base64.b64encode(
            json.dumps({"payload": {"expires": int(time.time()) + 300}}).encode()
        ).decode()
        valid, err, _ = verify_notary_ticket(ticket)
        assert valid is False
        assert "missing" in err
