"""Audit trail entry point for the rest of the code base.

Services call AuditService.record(); the record travels over the event bus so
that request handling never waits on audit storage.
"""
from __future__ import annotations

from ..events import types as topics
from ..events.types import AuditEvent
from ..utils.ids import new_id


class AuditService:
    def __init__(self, bus, clock):
        self._bus = bus
        self._clock = clock

    def record(self, actor: str, action: str, target: str, **details) -> str:
        event = AuditEvent(
            id=new_id("aud"),
            at=self._clock.now(),
            actor=actor or "system",
            action=action,
            target=str(target),
            details=details,
        )
        self._bus.publish(topics.AUDIT_RECORDED, event)
        return event.id
