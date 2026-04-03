"""Tests for validator-side URL resolution and fallback."""

from djinn_tunnel_shield.config import ShieldConfig
from djinn_tunnel_shield.resolver import ShieldResolver


def test_direct_only_when_no_tunnel():
    resolver = ShieldResolver()
    urls = resolver.urls(1, "1.2.3.4", 8422, "/health")
    assert urls == ["http://1.2.3.4:8422/health"]


def test_direct_first_then_tunnel():
    resolver = ShieldResolver()
    resolver.cache_from_health(1, {"tunnel_url": "https://abc.trycloudflare.com"})
    urls = resolver.urls(1, "1.2.3.4", 8422, "/health")
    assert urls == [
        "http://1.2.3.4:8422/health",
        "https://abc.trycloudflare.com/health",
    ]


def test_switch_to_tunnel_after_failures():
    config = ShieldConfig(direct_failure_threshold=2)
    resolver = ShieldResolver(config)
    resolver.cache_from_health(1, {"tunnel_url": "https://abc.trycloudflare.com"})

    resolver.record_failure(1)
    urls = resolver.urls(1, "1.2.3.4", 8422, "/health")
    assert urls[0] == "http://1.2.3.4:8422/health"  # Still direct first

    resolver.record_failure(1)
    urls = resolver.urls(1, "1.2.3.4", 8422, "/health")
    assert urls[0] == "https://abc.trycloudflare.com/health"  # Tunnel first


def test_switch_back_on_success():
    config = ShieldConfig(direct_failure_threshold=1)
    resolver = ShieldResolver(config)
    resolver.cache_from_health(1, {"tunnel_url": "https://abc.trycloudflare.com"})

    resolver.record_failure(1)
    urls = resolver.urls(1, "1.2.3.4", 8422, "/health")
    assert urls[0].startswith("https://")  # Tunnel first

    resolver.record_success(1)
    urls = resolver.urls(1, "1.2.3.4", 8422, "/health")
    assert urls[0].startswith("http://1.")  # Back to direct


def test_commitment_overrides_health():
    resolver = ShieldResolver()
    resolver.cache_from_health(1, {"tunnel_url": "https://health-url.com"})
    assert resolver.get_tunnel_url(1) == "https://health-url.com"

    resolver.cache_from_commitment(1, "https://committed-url.com")
    assert resolver.get_tunnel_url(1) == "https://committed-url.com"

    # Health response doesn't override commitment
    resolver.cache_from_health(1, {"tunnel_url": "https://new-health-url.com"})
    assert resolver.get_tunnel_url(1) == "https://committed-url.com"


def test_no_tunnel_url_in_health():
    resolver = ShieldResolver()
    resolver.cache_from_health(1, {"status": "ok"})
    assert resolver.get_tunnel_url(1) is None


def test_independent_per_miner():
    resolver = ShieldResolver()
    resolver.cache_from_health(1, {"tunnel_url": "https://miner1.com"})
    resolver.cache_from_health(2, {"tunnel_url": "https://miner2.com"})
    assert resolver.get_tunnel_url(1) == "https://miner1.com"
    assert resolver.get_tunnel_url(2) == "https://miner2.com"
    assert resolver.get_tunnel_url(3) is None
