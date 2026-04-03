"""DDoS detection via validator ping silence."""

from __future__ import annotations

import time

import structlog

from djinn_tunnel_shield.config import ShieldConfig

log = structlog.get_logger()


class PingSilenceDetector:
    """Detects probable DDoS by monitoring gaps in validator health pings.

    When validators stop reaching the miner for longer than the configured
    threshold, this signals a likely volumetric DDoS on the direct IP.
    """

    def __init__(self, config: ShieldConfig) -> None:
        self._config = config
        self._last_ping: float = time.monotonic()
        self._ddos_detected: bool = False
        self._recovery_start: float = 0

    def record_ping(self) -> None:
        """Call this on every incoming validator health ping."""
        self._last_ping = time.monotonic()
        if self._ddos_detected and self._recovery_start == 0:
            self._recovery_start = time.monotonic()
            log.info("ddos_recovery_started")

    @property
    def is_ddos_detected(self) -> bool:
        """True if we believe the miner is under DDoS."""
        if self._config.expected_ping_interval <= 0:
            return False  # Detection disabled

        now = time.monotonic()
        silence = now - self._last_ping

        if not self._ddos_detected:
            if silence >= self._config.ping_silence_threshold:
                self._ddos_detected = True
                self._recovery_start = 0
                log.warning(
                    "ddos_detected",
                    silence_seconds=round(silence, 1),
                    threshold=self._config.ping_silence_threshold,
                )
            return self._ddos_detected

        # Already in DDoS state: check for recovery
        if self._recovery_start > 0:
            recovered_for = now - self._recovery_start
            if recovered_for >= self._config.recovery_cooldown:
                self._ddos_detected = False
                self._recovery_start = 0
                log.info(
                    "ddos_recovered",
                    cooldown=self._config.recovery_cooldown,
                )
        else:
            # Pings stopped again during recovery
            if silence >= self._config.ping_silence_threshold:
                self._recovery_start = 0

        return self._ddos_detected

    @property
    def silence_seconds(self) -> float:
        return time.monotonic() - self._last_ping
