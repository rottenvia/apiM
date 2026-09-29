from __future__ import annotations

from ..errors import DuplicateVinError, InvalidVinError, NotFoundError, StateError, ValidationError
from ..events import types as topics
from ..repositories.vehicle_repo import Vehicle
from ..utils.cache import CacheStore
from ..utils.ids import new_id
from ..utils.validation import is_valid_vin, normalize_plate, normalize_vin, require


class VehicleService:
    def __init__(self, repo, audit, bus, clock):
        self._repo = repo
        self._audit = audit
        self._bus = bus
        self._clock = clock
        self._cache = CacheStore(ttl_s=30, clock=clock)

    def list(self, depot=None, limit=100):
        return self._repo.list(depot=depot, limit=limit)

    def get(self, vehicle_id: str) -> Vehicle:
        cached = self._cache.get(vehicle_id)
        if cached is not None:
            return cached
        vehicle = self._repo.get(vehicle_id)
        if vehicle is None:
            raise NotFoundError("vehicle", vehicle_id)
        self._cache.put(vehicle_id, vehicle)
        return vehicle

    def register(self, data: dict, actor: str) -> Vehicle:
        require(data, "vin", "plate", "model")
        vin = normalize_vin(data["vin"])
        if not is_valid_vin(vin):
            raise InvalidVinError(vin)
        if self._repo.find_by_vin(vin) is not None:
            raise DuplicateVinError(vin)
        vehicle = Vehicle(
            id=new_id("veh"),
            vin=vin,
            plate=normalize_plate(data["plate"]),
            model=data["model"].strip(),
            depot=data.get("depot"),
            status="active",
            registered_at=self._clock.now(),
        )
        self._repo.insert(vehicle)
        self._audit.record(actor, "vehicle.registered", vehicle.id, vin=vin)
        self._bus.publish(topics.VEHICLE_REGISTERED, vehicle)
        return vehicle

    def update(self, vehicle_id: str, changes: dict, actor: str) -> Vehicle:
        vehicle = self.get(vehicle_id)
        if "vin" in changes:
            raise ValidationError("the VIN of a vehicle cannot change", field="vin")
        if "plate" in changes:
            vehicle.plate = normalize_plate(changes["plate"])
        if "depot" in changes:
            vehicle.depot = changes["depot"]
        self._repo.update(vehicle)
        self._cache.invalidate(vehicle_id)
        self._audit.record(actor, "vehicle.updated", vehicle_id, fields=sorted(changes))
        return vehicle

    def retire(self, vehicle_id: str, reason: str, actor: str) -> None:
        vehicle = self.get(vehicle_id)
        if vehicle.status == "retired":
            raise StateError(f"vehicle {vehicle_id} is already retired")
        vehicle.status = "retired"
        self._repo.update(vehicle)
        self._cache.invalidate(vehicle_id)
        self._audit.record(actor, "vehicle.retired", vehicle_id, reason=reason)

    def delete(self, vehicle_id: str, actor: str) -> None:
        self.get(vehicle_id)
        self._repo.delete(vehicle_id)
        self._cache.invalidate(vehicle_id)
        self._audit.record(actor, "vehicle.deleted", vehicle_id)

    def refresh_cache(self) -> int:
        return self._cache.purge_expired()
