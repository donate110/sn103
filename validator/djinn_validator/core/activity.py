"""In-memory ring buffer for validator activity events.

Provides a bounded, thread-safe event log that the admin dashboard
queries via GET /v1/activity. Events are automatically evicted when
the buffer reaches capacity (oldest first).
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ActivityCategory(str, Enum):
    CHALLENGE_ROUND = "challenge_round"
    HEALTH_CHECK = "health_check"
    OUTCOME_RESOLUTION = "outcome_resolution"
    WEIGHT_SET = "weight_set"
    ATTESTATION_CHALLENGE = "attestation_challenge"
    PURCHASE = "purchase"
    SHARE_STORED = "share_stored"


@dataclass(frozen=True)
class ActivityEvent:
    """Single activity log entry."""

    category: ActivityCategory
    summary: str
    timestamp: float = field(default_factory=time.time)
    details: dict[str, Any] = field(default_factory=dict)


class ActivityBuffer:
    """Thread-safe bounded ring buffer for activity events.

    Uses a deque with maxlen for O(1) append and automatic eviction.
    500 events at ~200 bytes each = ~100KB max memory.
    """

    DEFAULT_MAX_SIZE = 500

    def __init__(self, max_size: int = DEFAULT_MAX_SIZE) -> None:
        self._events: deque[ActivityEvent] = deque(maxlen=max_size)
        self._lock = threading.Lock()

    def record(self, category: ActivityCategory, summary: str, **details: Any) -> None:
        """Append an event. O(1), never blocks producers."""
        event = ActivityEvent(
            category=category,
            summary=summary,
            details=details,
        )
        with self._lock:
            self._events.append(event)

    def recent(self, limit: int = 100, category: str | None = None) -> list[dict[str, Any]]:
        """Return most recent events, newest first.

        Args:
            limit: Max events to return.
            category: Optional category filter (e.g. "challenge_round").
        """
        with self._lock:
            events = list(self._events)

        if category:
            events = [e for e in events if e.category.value == category]

        events.reverse()
        events = events[:limit]

        return [
            {
                "category": e.category.value,
                "summary": e.summary,
                "timestamp": e.timestamp,
                "details": e.details,
            }
            for e in events
        ]

    def __len__(self) -> int:
        with self._lock:
            return len(self._events)
