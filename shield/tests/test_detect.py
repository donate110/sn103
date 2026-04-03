"""Tests for DDoS detection via ping silence."""

import time
from unittest.mock import patch

from djinn_tunnel_shield.config import ShieldConfig
from djinn_tunnel_shield.detect import PingSilenceDetector


def test_no_ddos_when_pings_regular():
    config = ShieldConfig(expected_ping_interval=10, min_missed_pings=3)
    detector = PingSilenceDetector(config)
    detector.record_ping()
    assert not detector.is_ddos_detected


def test_ddos_detected_after_silence():
    config = ShieldConfig(expected_ping_interval=1, min_missed_pings=3)
    detector = PingSilenceDetector(config)
    detector.record_ping()
    # Simulate 4 seconds of silence (threshold = 1 * 3 = 3s)
    with patch("djinn_tunnel_shield.detect.time") as mock_time:
        mock_time.monotonic.return_value = time.monotonic() + 4
        assert detector.is_ddos_detected


def test_recovery_after_cooldown():
    config = ShieldConfig(
        expected_ping_interval=1,
        min_missed_pings=3,
        recovery_cooldown=2,
    )
    detector = PingSilenceDetector(config)
    base = time.monotonic()

    # Trigger DDoS
    detector._last_ping = base
    with patch("djinn_tunnel_shield.detect.time") as mt:
        mt.monotonic.return_value = base + 5
        assert detector.is_ddos_detected

    # Ping resumes
    with patch("djinn_tunnel_shield.detect.time") as mt:
        mt.monotonic.return_value = base + 6
        detector._last_ping = base + 6
        detector.record_ping()

    # After cooldown
    with patch("djinn_tunnel_shield.detect.time") as mt:
        mt.monotonic.return_value = base + 9
        detector._last_ping = base + 9
        assert not detector.is_ddos_detected


def test_detection_disabled_when_interval_zero():
    config = ShieldConfig(expected_ping_interval=0)
    detector = PingSilenceDetector(config)
    # Even after long silence, detection stays off
    detector._last_ping = time.monotonic() - 9999
    assert not detector.is_ddos_detected
