from __future__ import annotations

from ..errors import NotFoundError, StateError, ValidationError
from ..events import types as topics
from ..repositories.trip_repo import Trip
from ..utils.ids import new_id
from ..utils.logging import get_logger

log = get_logger(__name__)


class TripService:
    def __init__(self, trips, vehicles, telematics, audit, bus, clock):
        self._trips = trips
        self._vehicles = vehicles
        self._telematics = telematics
        self._audit = audit
        self._bus = bus
        self._clock = clock
        self._last_position_at = None

    def search(self, vehicle_id=None, driver_id=None, since=None, limit=100):
        return self._trips.search(vehicle_id=vehicle_id, driver_id=driver_id, since=since, limit=limit)

    def start(self, vehicle_id, driver_id, purpose, actor):
        vehicle = self._vehicles.get(vehicle_id)
        if vehicle is None:
            raise NotFoundError("vehicle", vehicle_id)
        if vehicle.status != "active":
            raise StateError(f"vehicle {vehicle_id} is {vehicle.status}")
        if self._trips.open_trip_for(vehicle_id):
            raise StateError(f"vehicle {vehicle_id} already has an open trip")
        trip = Trip(id=new_id("trp"), vehicle_id=vehicle_id, driver_id=driver_id, purpose=purpose,
                    started_at=self._clock.now())
        self._trips.insert(trip)
        self._audit.record(actor, "trip.started", trip.id, vehicle=vehicle_id)
        return trip

    def finish(self, trip_id, odometer_km, actor):
        trip = self._trips.get(trip_id)
        if trip is None:
            raise NotFoundError("trip", trip_id)
        if trip.finished_at is not None:
            raise StateError(f"trip {trip_id} already finished")
        if odometer_km is not None and odometer_km < 0:
            raise ValidationError("odometer_km must be positive", field="odometer_km")
        trip.finished_at = self._clock.now()
        trip.distance_km = self._telematics.distance_km(trip.vehicle_id, trip.started_at, trip.finished_at)
        self._trips.update(trip)
        self._audit.record(actor, "trip.finished", trip_id, distance_km=trip.distance_km)
        self._bus.publish(topics.TRIP_COMPLETED, trip)
        return trip

    def add_note(self, trip_id, text, actor):
        if not text.strip():
            raise ValidationError("empty note", field="text")
        self._trips.add_note(trip_id, text.strip(), author=actor, at=self._clock.now())

    def ingest_positions(self, events):
        accepted = 0
        for event in events:
            if "vehicle_id" not in event or "lat" not in event or "lon" not in event:
                log.warning("dropping malformed telematics event: %r", event)
                continue
            self._trips.append_position(event["vehicle_id"], event["lat"], event["lon"], event.get("ts"))
            accepted += 1
        if accepted:
            self._last_position_at = self._clock.now()
        return accepted

    def replay_window(self, start, end, vehicle_id=None):
        events = self._telematics.fetch_events(start, end, vehicle_id=vehicle_id)
        return self.ingest_positions(events)

    def last_position_at(self):
        return self._last_position_at
