from __future__ import annotations

from datetime import date

from ..errors import LicenseError, NotFoundError, StateError
from ..repositories.driver_repo import Driver
from ..utils.ids import new_id
from ..utils.validation import parse_date, require


class DriverService:
    def __init__(self, repo, audit, clock):
        self._repo = repo
        self._audit = audit
        self._clock = clock

    def list(self, active_only=True, limit=100):
        return self._repo.list(active_only=active_only, limit=limit)

    def get(self, driver_id):
        driver = self._repo.get(driver_id)
        if driver is None:
            raise NotFoundError("driver", driver_id)
        return driver

    def hire(self, data: dict, actor: str) -> Driver:
        require(data, "name", "license_number", "license_expires")
        expires = parse_date(data["license_expires"])
        if expires <= self._clock.today():
            raise LicenseError("license already expired", field="license_expires")
        driver = Driver(id=new_id("drv"), name=data["name"].strip(), license_number=data["license_number"],
                        license_expires=expires, active=True)
        self._repo.insert(driver)
        self._audit.record(actor, "driver.hired", driver.id)
        return driver

    def update_license(self, driver_id, number, expires, actor):
        driver = self.get(driver_id)
        expires = parse_date(expires) if not isinstance(expires, date) else expires
        if expires <= self._clock.today():
            raise LicenseError("license already expired", field="expires")
        driver.license_number, driver.license_expires = number, expires
        self._repo.update(driver)
        self._audit.record(actor, "driver.license_updated", driver_id)
        return driver

    def suspend(self, driver_id, reason, actor):
        driver = self.get(driver_id)
        if not driver.active:
            raise StateError(f"driver {driver_id} is already suspended")
        driver.active = False
        self._repo.update(driver)
        self._audit.record(actor, "driver.suspended", driver_id, reason=reason)

    def expiring_licenses(self, within_days=30):
        today = self._clock.today()
        return [d for d in self._repo.list(active_only=True, limit=10_000)
                if (d.license_expires - today).days <= within_days]
