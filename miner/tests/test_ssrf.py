"""Tests for SSRF protection in AttestRequest URL validation.

Verifies that the AttestRequest model rejects URLs pointing to
private/internal addresses, including localhost, link-local,
cloud metadata endpoints, and DNS rebinding targets.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from pydantic import ValidationError

from djinn_miner.api.models import AttestRequest


class TestSSRFBlockedURLs:
    """URLs that must be rejected to prevent SSRF attacks."""

    def test_localhost_rejected(self) -> None:
        with pytest.raises(ValidationError, match="private/internal"):
            AttestRequest(url="https://localhost/secret", request_id="test-1")

    def test_127_0_0_1_rejected(self) -> None:
        with pytest.raises(ValidationError, match="private/internal"):
            AttestRequest(url="https://127.0.0.1/secret", request_id="test-2")

    def test_zero_ip_rejected(self) -> None:
        with pytest.raises(ValidationError, match="private/internal"):
            AttestRequest(url="https://0.0.0.0/secret", request_id="test-3")

    def test_ipv6_loopback_rejected(self) -> None:
        with pytest.raises(ValidationError, match="private/internal"):
            AttestRequest(url="https://[::1]/secret", request_id="test-4")

    def test_private_10_network_rejected(self) -> None:
        with pytest.raises(ValidationError, match="private/internal"):
            AttestRequest(url="https://10.0.0.1/secret", request_id="test-5")

    def test_private_172_network_rejected(self) -> None:
        with pytest.raises(ValidationError, match="private/internal"):
            AttestRequest(url="https://172.16.0.1/secret", request_id="test-6")

    def test_private_192_168_rejected(self) -> None:
        with pytest.raises(ValidationError, match="private/internal"):
            AttestRequest(url="https://192.168.1.1/secret", request_id="test-7")

    def test_link_local_rejected(self) -> None:
        with pytest.raises(ValidationError, match="private/internal"):
            AttestRequest(url="https://169.254.169.254/latest/meta-data", request_id="test-8")

    def test_ip6_localhost_blocked(self) -> None:
        with pytest.raises(ValidationError, match="private/internal"):
            AttestRequest(url="https://ip6-localhost/secret", request_id="test-9")

    def test_http_rejected(self) -> None:
        with pytest.raises(ValidationError, match="HTTPS"):
            AttestRequest(url="http://example.com/page", request_id="test-10")

    def test_dns_rebinding_private_ip(self) -> None:
        """DNS resolution returning a private IP should be rejected."""
        import socket

        fake_result = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", 0))]
        with patch("socket.getaddrinfo", return_value=fake_result):
            with pytest.raises(ValidationError, match="private/internal"):
                AttestRequest(url="https://evil-rebind.example.com/", request_id="test-11")

    def test_dns_rebinding_link_local(self) -> None:
        """DNS resolution returning a link-local IP should be rejected."""
        import socket

        fake_result = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("169.254.169.254", 0))]
        with patch("socket.getaddrinfo", return_value=fake_result):
            with pytest.raises(ValidationError, match="private/internal"):
                AttestRequest(url="https://metadata.example.com/", request_id="test-12")


class TestSSRFAllowedURLs:
    """URLs that should pass SSRF validation."""

    def test_public_https_allowed(self) -> None:
        """Public HTTPS URL should be accepted."""
        import socket

        fake_result = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 0))]
        with patch("socket.getaddrinfo", return_value=fake_result):
            req = AttestRequest(url="https://example.com/page", request_id="test-ok-1")
            assert req.url == "https://example.com/page"

    def test_public_ip_allowed(self) -> None:
        """Direct public IP should be accepted."""
        req = AttestRequest(url="https://93.184.216.34/page", request_id="test-ok-2")
        assert "93.184.216.34" in req.url

    def test_dns_failure_rejects(self) -> None:
        """DNS resolution failure should reject the URL at validation time."""
        import socket

        with patch("socket.getaddrinfo", side_effect=socket.gaierror("DNS failed")):
            with pytest.raises(ValidationError, match="could not be resolved"):
                AttestRequest(url="https://nonexistent.example.com/page", request_id="test-ok-3")


class TestAttestRequestBasicValidation:
    """Basic field validation for AttestRequest."""

    def test_request_id_required(self) -> None:
        with pytest.raises(ValidationError):
            AttestRequest(url="https://example.com/page")  # type: ignore[call-arg]

    def test_url_required(self) -> None:
        with pytest.raises(ValidationError):
            AttestRequest(request_id="test")  # type: ignore[call-arg]

    def test_url_max_length(self) -> None:
        with pytest.raises(ValidationError):
            AttestRequest(url="https://example.com/" + "x" * 2048, request_id="test")

    def test_empty_hostname_rejected(self) -> None:
        with pytest.raises(ValidationError):
            AttestRequest(url="https:///path", request_id="test")
