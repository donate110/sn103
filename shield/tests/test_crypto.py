"""Tests for signed tunnel URL commitments."""

import json
import time

from djinn_tunnel_shield.crypto import build_commitment, parse_commitment


def test_build_commitment_without_wallet():
    data = build_commitment("https://test.trycloudflare.com", "5Miner")
    parsed = json.loads(data)
    assert parsed["v"] == 2
    assert parsed["url"] == "https://test.trycloudflare.com"
    assert parsed["miner"] == "5Miner"
    assert abs(parsed["ts"] - time.time()) < 5
    assert "sig" not in parsed  # No wallet, no signature


def test_parse_commitment_roundtrip():
    data = build_commitment("https://abc.trycloudflare.com", "5Miner")
    url = parse_commitment(data, max_age=0)
    assert url == "https://abc.trycloudflare.com"


def test_parse_rejects_old_commitment():
    old = json.dumps({"v": 2, "url": "https://old.com", "ts": int(time.time()) - 10000, "miner": "5M"})
    url = parse_commitment(old, max_age=3600)
    assert url is None


def test_parse_rejects_bad_version():
    data = json.dumps({"v": 99, "url": "https://bad.com", "ts": int(time.time())})
    url = parse_commitment(data, max_age=0)
    assert url is None


def test_parse_rejects_invalid_json():
    assert parse_commitment("not json", max_age=0) is None
    assert parse_commitment("", max_age=0) is None


def test_parse_accepts_v1():
    data = json.dumps({"v": 1, "url": "https://v1.com", "ts": int(time.time())})
    url = parse_commitment(data, max_age=0)
    assert url == "https://v1.com"


def test_max_age_zero_accepts_old():
    old = json.dumps({"v": 2, "url": "https://old.com", "ts": 1000000, "miner": "5M"})
    url = parse_commitment(old, max_age=0)
    assert url == "https://old.com"
