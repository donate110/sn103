"""Tests for ECIES encryption/decryption of tunnel URLs."""

import json
import time

import pytest

try:
    import ecies
    HAS_ECIES = True
except ImportError:
    HAS_ECIES = False

from djinn_tunnel_shield.crypto import (
    decrypt_tunnel_url,
    encrypt_for_validators,
)


@pytest.mark.skipif(not HAS_ECIES, reason="eciespy not installed")
class TestCrypto:
    def _make_keypair(self):
        """Generate a test ECIES keypair (raw secp256k1)."""
        private_key = ecies.utils.generate_key()
        public_key_hex = private_key.public_key.format(True).hex()
        private_key_bytes = private_key.secret
        return public_key_hex, private_key_bytes

    def test_encrypt_decrypt_roundtrip(self):
        pub, priv = self._make_keypair()
        # We need an SS58 address for the API, but for testing we'll
        # patch the conversion. Use raw public key directly.
        url = "https://abc-def.trycloudflare.com"
        payload = json.dumps({"url": url, "ts": int(time.time())}).encode()

        encrypted = ecies.encrypt(bytes.fromhex(pub), payload)
        decrypted = ecies.decrypt(priv, encrypted)
        result = json.loads(decrypted)
        assert result["url"] == url

    def test_wrong_key_fails(self):
        pub1, priv1 = self._make_keypair()
        _pub2, priv2 = self._make_keypair()

        payload = b'{"url":"https://test.com","ts":1234}'
        encrypted = ecies.encrypt(bytes.fromhex(pub1), payload)

        with pytest.raises(Exception):
            ecies.decrypt(priv2, encrypted)

    def test_decrypt_rejects_old_commitment(self):
        pub, priv = self._make_keypair()
        old_ts = int(time.time()) - 10000  # Way in the past

        commitment = {
            "v": 1,
            "miner": "5Test",
            "ts": old_ts,
            "entries": {},
        }
        data = json.dumps(commitment).encode()

        result = decrypt_tunnel_url(data, "5Val", priv, max_age=3600)
        assert result is None

    def test_decrypt_rejects_wrong_version(self):
        commitment = {"v": 99, "ts": int(time.time()), "entries": {}}
        data = json.dumps(commitment).encode()
        result = decrypt_tunnel_url(data, "5Val", b"\x00" * 32, max_age=0)
        assert result is None

    def test_decrypt_returns_none_for_missing_entry(self):
        commitment = {
            "v": 1,
            "miner": "5Miner",
            "ts": int(time.time()),
            "entries": {"5OtherValidator": "deadbeef"},
        }
        data = json.dumps(commitment).encode()
        result = decrypt_tunnel_url(data, "5MyValidator", b"\x00" * 32, max_age=0)
        assert result is None
