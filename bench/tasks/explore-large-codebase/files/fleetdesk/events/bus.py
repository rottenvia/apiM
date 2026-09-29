"""Synchronous in-process publish/subscribe."""
from __future__ import annotations

from collections import defaultdict

from ..utils.logging import get_logger

log = get_logger(__name__)


class EventBus:
    def __init__(self):
        self._subscribers = defaultdict(list)

    def subscribe(self, topic: str, handler) -> None:
        self._subscribers[topic].append(handler)

    def publish(self, topic: str, payload) -> int:
        delivered = 0
        for handler in list(self._subscribers.get(topic, ())):
            try:
                handler(payload)
                delivered += 1
            except Exception:  # noqa: BLE001 - one bad subscriber must not break the publisher
                log.exception("subscriber %r failed for %s", handler, topic)
        return delivered
