"""Nightly housekeeping, run by cron:  python -m fleetdesk.jobs.nightly"""
from __future__ import annotations

from ..app import create_app
from ..utils.logging import configure, get_logger

log = get_logger(__name__)


def nightly(ctx) -> dict:
    # expired sessions/tokens and old trips: RetentionService.run takes care of all three
    result = ctx.services.retention.run()
    expiring = ctx.services.drivers.expiring_licenses(within_days=30)
    for driver in expiring:
        ctx.services.notifications.send("hr@fleetdesk.example", "License expiring",
                                        f"{driver.name}: {driver.license_expires}")
    ctx.journal.flush()
    result["licenses_expiring"] = len(expiring)
    log.info("nightly done: %s", result)
    return result


if __name__ == "__main__":
    configure()
    app = create_app()
    nightly(app.ctx)
