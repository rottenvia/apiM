from __future__ import annotations

from ..errors import NotFoundError, StateError, ValidationError
from ..events import types as topics
from ..repositories.ticket_repo import Ticket
from ..utils.ids import new_id

SEVERITIES = ("low", "normal", "high", "critical")


class MaintenanceService:
    def __init__(self, tickets, vehicles, audit, bus, clock):
        self._tickets = tickets
        self._vehicles = vehicles
        self._audit = audit
        self._bus = bus
        self._clock = clock

    def list_tickets(self, status=None):
        return self._tickets.list(status=status)

    def open_ticket(self, vehicle_id, summary, severity, actor):
        if severity not in SEVERITIES:
            raise ValidationError(f"severity must be one of {SEVERITIES}", field="severity")
        if self._vehicles.get(vehicle_id) is None:
            raise NotFoundError("vehicle", vehicle_id)
        ticket = Ticket(id=new_id("tkt"), vehicle_id=vehicle_id, summary=summary, severity=severity,
                        status="open", opened_at=self._clock.now())
        self._tickets.insert(ticket)
        self._audit.record(actor, "ticket.opened", ticket.id, severity=severity)
        self._bus.publish(topics.TICKET_OPENED, ticket)
        return ticket

    def _get(self, ticket_id):
        ticket = self._tickets.get(ticket_id)
        if ticket is None:
            raise NotFoundError("ticket", ticket_id)
        return ticket

    def assign(self, ticket_id, mechanic, actor):
        ticket = self._get(ticket_id)
        if ticket.status == "closed":
            raise StateError("ticket is closed")
        ticket.assignee, ticket.status = mechanic, "assigned"
        self._tickets.update(ticket)
        self._audit.record(actor, "ticket.assigned", ticket_id, mechanic=mechanic)
        return ticket

    def close(self, ticket_id, resolution, cost_cents, actor):
        ticket = self._get(ticket_id)
        if ticket.status == "closed":
            raise StateError("ticket is already closed")
        if cost_cents < 0:
            raise ValidationError("cost_cents must not be negative", field="cost_cents")
        ticket.status, ticket.resolution, ticket.cost_cents = "closed", resolution, cost_cents
        ticket.closed_at = self._clock.now()
        self._tickets.update(ticket)
        self._audit.record(actor, "ticket.closed", ticket_id, cost_cents=cost_cents)
        return ticket
