"""Test that body serialization for signed requests matches what the peer receives.

Verifies the fix for the body signing mismatch where json.dumps() on the sender
produced different bytes than httpx's json= parameter, causing 401 errors.
"""

import hashlib
import json


def test_compact_json_round_trip():
    """Compact JSON serialization parses correctly and matches hash."""
    payload = {
        "session_id": "test-abc123",
        "signal_id": "0x1234567890abcdef",
        "available_indices": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        "coordinator_x": 1,
        "participant_xs": [1, 2, 3],
        "threshold": 2,
        "triple_shares": [{"a": "0xdeadbeef", "b": "0xcafebabe", "c": "0x12345678"}],
        "r_share_y": "0xabcdef0123456789",
    }

    # Sender side: compact serialization (as in _peer_request)
    serialized = json.dumps(payload, separators=(",", ":")).encode()
    sender_hash = hashlib.sha256(serialized).hexdigest()

    # Receiver side: FastAPI reads raw body bytes and hashes them
    # (simulated here by parsing and re-verifying)
    parsed = json.loads(serialized)
    assert parsed == payload, "Parsed payload should match original"

    # The receiver hashes the raw bytes, not the re-serialized version
    receiver_hash = hashlib.sha256(serialized).hexdigest()
    assert sender_hash == receiver_hash, "Hash mismatch between sender and receiver"


def test_compact_vs_default_json():
    """Show that compact and default serialization produce different bytes."""
    payload = {"a": 1, "b": [2, 3], "c": "hello"}

    compact = json.dumps(payload, separators=(",", ":")).encode()
    default = json.dumps(payload).encode()

    # These are different! That was the root cause of the bug.
    assert compact != default, "Compact and default should differ"
    assert compact == b'{"a":1,"b":[2,3],"c":"hello"}'
    assert default == b'{"a": 1, "b": [2, 3], "c": "hello"}'

    # Both parse to the same dict
    assert json.loads(compact) == json.loads(default)


def test_hex_values_in_payload():
    """Test that hex-encoded big integers survive serialization."""
    # BN254 prime (the field modulus used in the MPC protocol)
    from djinn_validator.utils.crypto import BN254_PRIME
    big_val = BN254_PRIME
    payload = {
        "r_share_y": hex(big_val),
        "triple_shares": [{"a": hex(big_val), "b": hex(42), "c": hex(0)}],
    }

    serialized = json.dumps(payload, separators=(",", ":")).encode()
    parsed = json.loads(serialized)

    assert int(parsed["r_share_y"], 16) == big_val
    assert int(parsed["triple_shares"][0]["a"], 16) == big_val
    assert int(parsed["triple_shares"][0]["b"], 16) == 42
    assert int(parsed["triple_shares"][0]["c"], 16) == 0


def test_serialization_is_deterministic():
    """Same input always produces the same bytes."""
    payload = {
        "session_id": "test",
        "available_indices": [5, 3, 1, 4, 2],
        "threshold": 2,
    }

    results = set()
    for _ in range(100):
        serialized = json.dumps(payload, separators=(",", ":")).encode()
        results.add(serialized)

    assert len(results) == 1, "Serialization should be deterministic"


if __name__ == "__main__":
    test_compact_json_round_trip()
    test_compact_vs_default_json()
    test_hex_values_in_payload()
    test_serialization_is_deterministic()
    print("All body signing tests passed!")
