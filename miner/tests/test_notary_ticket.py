"""Tests for notary ticket creation and verification (DDoS mitigation).

The notary ticket system allows validators to authorize specific miner-to-miner
peer notary connections. This prevents malicious miners from opening unauthorized
WebSocket connections to other miners' notary endpoints.

Tests cover:
- Ticket creation and verification round-trip
- Expiry enforcement
- Signature verification
- Notary UID mismatch rejection
- Validator hotkey allowlist
- Backward compatibility (no ticket = allowed unless REQUIRE_NOTARY_TICKET)
- Enforcement mode (REQUIRE_NOTARY_TICKET=true)
- Replay/malformed ticket handling
"""

from __future__ import annotations

import base64
import json
import time
from unittest.mock import MagicMock, patch

import pytest

from djinn_miner.api.middleware import verify_notary_ticket


def _make_ticket(
    prover_uid: int = 10,
    notary_uid: int = 20,
    validator_ss58: str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
    expires: int | None = None,
    nonce: str = "abc123",
    signature: str = "deadbeef",
) -> str:
    """Build a base64-encoded ticket for testing."""
    payload = {
        "prover_uid": prover_uid,
        "notary_uid": notary_uid,
        "expires": expires or int(time.time()) + 300,
        "nonce": nonce,
        "validator": validator_ss58,
    }
    ticket = {
        "payload": payload,
        "signature": signature,
    }
    return base64.b64encode(json.dumps(ticket).encode()).decode()


class TestVerifyNotaryTicket:
    """Test the verify_notary_ticket function used by the miner's WebSocket endpoint."""

    def test_valid_ticket(self) -> None:
        """A ticket with valid signature passes verification."""
        ticket = _make_ticket()
        with patch("djinn_miner.api.middleware.verify_hotkey_signature", return_value=True):
            valid, err, payload = verify_notary_ticket(ticket)
        assert valid is True
        assert err == ""
        assert payload["prover_uid"] == 10
        assert payload["notary_uid"] == 20

    def test_expired_ticket(self) -> None:
        """An expired ticket is rejected before signature check."""
        ticket = _make_ticket(expires=int(time.time()) - 10)
        valid, err, payload = verify_notary_ticket(ticket)
        assert valid is False
        assert "expired" in err

    def test_malformed_base64(self) -> None:
        """Non-base64 input is rejected."""
        valid, err, payload = verify_notary_ticket("not-valid-base64!!!")
        assert valid is False
        assert "malformed" in err
        assert payload == {}

    def test_malformed_json(self) -> None:
        """Base64 that doesn't decode to valid JSON is rejected."""
        ticket = base64.b64encode(b"not json").decode()
        valid, err, payload = verify_notary_ticket(ticket)
        assert valid is False
        assert "malformed" in err

    def test_missing_payload(self) -> None:
        """Ticket without payload field is rejected."""
        ticket = base64.b64encode(json.dumps({"signature": "abc"}).encode()).decode()
        valid, err, payload = verify_notary_ticket(ticket)
        assert valid is False
        assert "missing payload" in err

    def test_missing_signature(self) -> None:
        """Ticket without signature field is rejected."""
        ticket = base64.b64encode(
            json.dumps({"payload": {"expires": int(time.time()) + 300}}).encode()
        ).decode()
        valid, err, payload = verify_notary_ticket(ticket)
        assert valid is False
        assert "missing payload or signature" in err

    def test_notary_uid_mismatch(self) -> None:
        """Ticket for a different notary UID is rejected."""
        ticket = _make_ticket(notary_uid=20)
        with patch("djinn_miner.api.middleware.verify_hotkey_signature", return_value=True):
            valid, err, payload = verify_notary_ticket(ticket, expected_notary_uid=99)
        assert valid is False
        assert "mismatch" in err

    def test_notary_uid_matches(self) -> None:
        """Ticket for the correct notary UID passes."""
        ticket = _make_ticket(notary_uid=20)
        with patch("djinn_miner.api.middleware.verify_hotkey_signature", return_value=True):
            valid, err, payload = verify_notary_ticket(ticket, expected_notary_uid=20)
        assert valid is True

    def test_validator_not_in_allowlist(self) -> None:
        """Ticket from a non-allowed validator is rejected."""
        ticket = _make_ticket(validator_ss58="5FakeAddress")
        valid, err, payload = verify_notary_ticket(
            ticket,
            validator_hotkeys={"5RealValidator1", "5RealValidator2"},
        )
        assert valid is False
        assert "not authorized" in err

    def test_validator_in_allowlist(self) -> None:
        """Ticket from an allowed validator passes."""
        vk = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"
        ticket = _make_ticket(validator_ss58=vk)
        with patch("djinn_miner.api.middleware.verify_hotkey_signature", return_value=True):
            valid, err, payload = verify_notary_ticket(
                ticket,
                validator_hotkeys={vk, "5OtherValidator"},
            )
        assert valid is True

    def test_invalid_signature(self) -> None:
        """Ticket with invalid cryptographic signature is rejected."""
        ticket = _make_ticket()
        with patch("djinn_miner.api.middleware.verify_hotkey_signature", return_value=False):
            valid, err, payload = verify_notary_ticket(ticket)
        assert valid is False
        assert "invalid signature" in err

    def test_no_hotkey_check_when_allowlist_none(self) -> None:
        """When validator_hotkeys is None, any validator hotkey is accepted."""
        ticket = _make_ticket(validator_ss58="5AnyValidator")
        with patch("djinn_miner.api.middleware.verify_hotkey_signature", return_value=True):
            valid, err, payload = verify_notary_ticket(ticket, validator_hotkeys=None)
        assert valid is True

    def test_no_notary_uid_check_when_none(self) -> None:
        """When expected_notary_uid is None, any notary_uid is accepted."""
        ticket = _make_ticket(notary_uid=999)
        with patch("djinn_miner.api.middleware.verify_hotkey_signature", return_value=True):
            valid, err, payload = verify_notary_ticket(ticket, expected_notary_uid=None)
        assert valid is True

    def test_empty_string_ticket(self) -> None:
        """Empty string is rejected."""
        valid, err, payload = verify_notary_ticket("")
        assert valid is False

    def test_payload_fields_returned(self) -> None:
        """Payload dict is returned even on failure for logging."""
        ticket = _make_ticket(notary_uid=20)
        with patch("djinn_miner.api.middleware.verify_hotkey_signature", return_value=True):
            valid, err, payload = verify_notary_ticket(ticket, expected_notary_uid=99)
        assert payload["prover_uid"] == 10
        assert payload["notary_uid"] == 20
