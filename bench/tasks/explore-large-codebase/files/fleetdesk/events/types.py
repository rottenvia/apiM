from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime

AUDIT_RECORDED = "audit.recorded"
VEHICLE_REGISTERED = "vehicle.registered"
TRIP_COMPLETED = "trip.completed"
TICKET_OPENED = "ticket.opened"


@dataclass(frozen=True)
class AuditEvent:
    id: str
    at: datetime
    actor: str
    action: str
    target: str
    details: dict = field(default_factory=dict)

    def details_json(self) -> str:
        return json.dumps(self.details, sort_keys=True, default=str)
