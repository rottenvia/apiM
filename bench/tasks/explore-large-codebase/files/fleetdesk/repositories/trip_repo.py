from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime

from .base import BaseRepository


@dataclass
class Trip:
    id: str
    vehicle_id: str
    driver_id: str
    purpose: str
    started_at: datetime
    finished_at: datetime | None = None
    distance_km: float | None = None

    def to_dict(self):
        return asdict(self)


class TripRepository(BaseRepository):
    table = "trips"
    model = Trip
    POSITIONS = "telematics_positions"

    def __init__(self, db, journal):
        super().__init__(db)
        self._journal = journal

    def search(self, vehicle_id=None, driver_id=None, since=None, limit=100):
        clauses, params = [], []
        if vehicle_id:
            clauses.append("vehicle_id = ?")
            params.append(vehicle_id)
        if driver_id:
            clauses.append("driver_id = ?")
            params.append(driver_id)
        if since:
            clauses.append("started_at >= ?")
            params.append(since)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = self._db.query(f"SELECT * FROM {self.table} {where} ORDER BY started_at DESC LIMIT ?", (*params, limit))
        return [self._to_model(r) for r in rows]

    def open_trip_for(self, vehicle_id):
        row = self._db.query_one(f"SELECT * FROM {self.table} WHERE vehicle_id = ? AND finished_at IS NULL", (vehicle_id,))
        return self._to_model(row)

    def add_note(self, trip_id, text, author, at):
        self._db.execute("INSERT INTO trip_notes (trip_id, text, author, at) VALUES (?, ?, ?, ?)", (trip_id, text, author, at))

    def append_position(self, vehicle_id, lat, lon, ts):
        self._journal.enqueue(self.POSITIONS, {"vehicle_id": vehicle_id, "lat": lat, "lon": lon, "ts": ts})

    def total_distance(self, customer_id, start, end):
        row = self._db.query_one(
            "SELECT COALESCE(SUM(t.distance_km), 0) AS km FROM trips t JOIN vehicles v ON v.id = t.vehicle_id "
            "WHERE v.depot IN (SELECT depot FROM customer_depots WHERE customer_id = ?) AND t.started_at BETWEEN ? AND ?",
            (customer_id, start, end),
        )
        return row["km"] if row else 0

    def utilisation(self, start, end):
        return self._db.query(
            "SELECT vehicle_id, COUNT(*) AS trips, SUM(distance_km) AS km FROM trips "
            "WHERE started_at BETWEEN ? AND ? GROUP BY vehicle_id ORDER BY km DESC", (start, end))

    def archive_before(self, cutoff) -> int:
        moved = self._db.execute("INSERT INTO trips_archive SELECT * FROM trips WHERE finished_at < ?", (cutoff,))
        self._delete_where("finished_at < ?", (cutoff,))
        return moved
