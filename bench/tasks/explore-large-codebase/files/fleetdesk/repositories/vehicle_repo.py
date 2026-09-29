from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime

from .base import BaseRepository


@dataclass
class Vehicle:
    id: str
    vin: str
    plate: str
    model: str
    depot: str | None
    status: str
    registered_at: datetime

    def to_dict(self):
        return asdict(self)


class VehicleRepository(BaseRepository):
    table = "vehicles"
    model = Vehicle

    def list(self, depot=None, limit=100):
        if depot:
            rows = self._db.query(f"SELECT * FROM {self.table} WHERE depot = ? ORDER BY plate LIMIT ?", (depot, limit))
        else:
            rows = self._db.query(f"SELECT * FROM {self.table} ORDER BY plate LIMIT ?", (limit,))
        return [self._to_model(r) for r in rows]

    def find_by_vin(self, vin):
        return self._to_model(self._db.query_one(f"SELECT * FROM {self.table} WHERE vin = ?", (vin,)))

    def find_by_plate(self, plate):
        return self._to_model(self._db.query_one(f"SELECT * FROM {self.table} WHERE plate = ?", (plate,)))
