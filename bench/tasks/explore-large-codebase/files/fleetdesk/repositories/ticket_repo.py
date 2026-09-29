from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime

from .base import BaseRepository


@dataclass
class Ticket:
    id: str
    vehicle_id: str
    summary: str
    severity: str
    status: str
    opened_at: datetime
    assignee: str | None = None
    resolution: str | None = None
    cost_cents: int = 0
    closed_at: datetime | None = None

    def to_dict(self):
        return asdict(self)


class TicketRepository(BaseRepository):
    table = "maintenance_tickets"
    model = Ticket

    def list(self, status=None):
        if status:
            rows = self._db.query(f"SELECT * FROM {self.table} WHERE status = ? ORDER BY opened_at", (status,))
        else:
            rows = self._db.query(f"SELECT * FROM {self.table} ORDER BY opened_at", ())
        return [self._to_model(r) for r in rows]

    def costs_by_vehicle(self, year=None):
        if year:
            return self._db.query(
                f"SELECT vehicle_id, SUM(cost_cents) AS cost FROM {self.table} "
                "WHERE strftime('%Y', closed_at) = ? GROUP BY vehicle_id", (str(year),))
        return self._db.query(f"SELECT vehicle_id, SUM(cost_cents) AS cost FROM {self.table} GROUP BY vehicle_id", ())
