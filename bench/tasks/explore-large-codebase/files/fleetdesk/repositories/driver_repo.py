from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date

from .base import BaseRepository


@dataclass
class Driver:
    id: str
    name: str
    license_number: str
    license_expires: date
    active: bool

    def to_dict(self):
        return asdict(self)


class DriverRepository(BaseRepository):
    table = "drivers"
    model = Driver

    def list(self, active_only=True, limit=100):
        where = "WHERE active = 1" if active_only else ""
        rows = self._db.query(f"SELECT * FROM {self.table} {where} ORDER BY name LIMIT ?", (limit,))
        return [self._to_model(r) for r in rows]
