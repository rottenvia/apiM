"""Default wiring of domain events to their consumers."""
from __future__ import annotations

from ..utils.logging import audit_log
from . import types as topics


def _persist_audit(audit_repo):
    def handle(event):
        audit_repo.append(event)
    return handle


def _log_audit(event):
    audit_log(event.action, actor=event.actor, target=event.target)


def register_default_subscribers(bus, repos, services) -> None:
    bus.subscribe(topics.AUDIT_RECORDED, _persist_audit(repos.audit))
    bus.subscribe(topics.AUDIT_RECORDED, _log_audit)
    bus.subscribe(topics.VEHICLE_REGISTERED, services.webhooks.on_vehicle_registered)
    bus.subscribe(topics.TICKET_OPENED, services.webhooks.on_ticket_opened)
    bus.subscribe(topics.TICKET_OPENED, services.notifications.on_ticket_opened)
    bus.subscribe(topics.TRIP_COMPLETED, services.billing.on_trip_completed)
