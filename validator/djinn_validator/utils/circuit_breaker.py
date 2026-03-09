"""Circuit breaker for external service calls.

Prevents cascading failures by tracking consecutive errors and
temporarily halting requests to unhealthy endpoints.

States:
- CLOSED: Normal operation, requests flow through
- OPEN: Requests rejected immediately (endpoint assumed down)
- HALF_OPEN: One test request allowed to probe recovery
"""

from __future__ import annotations

import time
from enum import Enum

import structlog

log = structlog.get_logger()


class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitBreaker:
    """Simple circuit breaker with failure threshold and recovery timeout."""

    def __init__(
        self,
        name: str,
        failure_threshold: int = 5,
        recovery_timeout: float = 30.0,
        half_open_max: int = 1,
        max_recovery_timeout: float = 600.0,
    ) -> None:
        self.name = name
        self._failure_threshold = failure_threshold
        self._base_recovery_timeout = recovery_timeout
        self._recovery_timeout = recovery_timeout
        self._max_recovery_timeout = max_recovery_timeout
        self._half_open_max = half_open_max
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._last_failure_time = 0.0
        self._half_open_attempts = 0

    @property
    def state(self) -> CircuitState:
        if self._state == CircuitState.OPEN:
            if time.monotonic() - self._last_failure_time >= self._recovery_timeout:
                self._state = CircuitState.HALF_OPEN
                self._half_open_attempts = 0
                log.info("circuit_breaker_half_open", name=self.name)
        return self._state

    @property
    def is_open(self) -> bool:
        return self.state == CircuitState.OPEN

    def allow_request(self) -> bool:
        """Check if a request should be allowed through."""
        state = self.state
        if state == CircuitState.CLOSED:
            return True
        if state == CircuitState.HALF_OPEN:
            if self._half_open_attempts < self._half_open_max:
                self._half_open_attempts += 1
                return True
            return False
        return False  # OPEN

    def _update_gauge(self) -> None:
        """Update Prometheus gauge for circuit breaker state."""
        try:
            from djinn_validator.api.metrics import CIRCUIT_BREAKER_STATE

            CIRCUIT_BREAKER_STATE.labels(target=self.name).set(
                1 if self._state == CircuitState.OPEN else 0
            )
        except ImportError:
            pass

    def record_success(self) -> None:
        """Record a successful request. Resets backoff to base timeout."""
        if self._state in (CircuitState.HALF_OPEN, CircuitState.OPEN):
            log.info("circuit_breaker_closed", name=self.name)
        self._failure_count = 0
        self._recovery_timeout = self._base_recovery_timeout
        self._state = CircuitState.CLOSED
        self._update_gauge()

    def record_failure(self) -> None:
        """Record a failed request. Doubles backoff on repeated half-open failures."""
        self._failure_count += 1
        self._last_failure_time = time.monotonic()
        if self._state == CircuitState.HALF_OPEN:
            # Probe failed; double the recovery timeout (exponential backoff)
            self._recovery_timeout = min(
                self._recovery_timeout * 2, self._max_recovery_timeout,
            )
            self._state = CircuitState.OPEN
            log.warning(
                "circuit_breaker_reopened",
                name=self.name,
                next_probe_s=self._recovery_timeout,
            )
        elif self._failure_count >= self._failure_threshold:
            self._state = CircuitState.OPEN
            log.warning(
                "circuit_breaker_opened",
                name=self.name,
                failures=self._failure_count,
            )
        self._update_gauge()

    def reset(self) -> None:
        """Reset the circuit breaker to closed state."""
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._half_open_attempts = 0
        self._recovery_timeout = self._base_recovery_timeout
