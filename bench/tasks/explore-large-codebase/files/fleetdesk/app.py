"""Application factory: wires config, storage, repositories, services and routes."""
from __future__ import annotations

import sys

from .config.loader import load_config
from .context import AppContext, Services
from .events.bus import EventBus
from .events.subscribers import register_default_subscribers
from .handlers import admin, auth, drivers, health, invoices, maintenance, reports, trips, users, vehicles, webhooks
from .http.middleware import AuthMiddleware, ErrorMiddleware, RequestLogMiddleware
from .http.router import App
from .integrations.http_client import HttpClient
from .integrations.telematics import TelematicsClient
from .services.audit_service import AuditService
from .services.auth_service import AuthService
from .services.billing_service import BillingService
from .services.driver_service import DriverService
from .services.maintenance_service import MaintenanceService
from .services.notification_service import NotificationService
from .services.presence_service import PresenceService
from .services.report_service import ReportService
from .services.retention_service import RetentionService
from .services.session_service import SessionService
from .services.trip_service import TripService
from .services.user_service import UserService
from .services.vehicle_service import VehicleService
from .services.webhook_service import WebhookDispatcher
from .storage.db import Database
from .storage.journal import JournalWriter
from .storage.registry import build_repositories
from .utils.clock import SystemClock

API_VERSION = 1
API = f"/api/v{API_VERSION}"


def create_app(env=None, config_path=None) -> App:
    config = load_config(config_path, env=env)
    db = Database(config.get("db.dsn"), timeout=config.get("db.timeout_s"))
    journal = JournalWriter(db, batch_size=config.get("audit.batch_size"))
    repos = build_repositories(db, journal)
    bus = EventBus()
    clock = SystemClock()
    http = HttpClient(timeout_ms=config.get("http.timeout_ms"))

    audit = AuditService(bus, clock)
    sessions = SessionService(repos.sessions, repos.tokens, clock, purge_every=config.get("sessions.purge_every"))
    services = Services(
        vehicles=VehicleService(repos.vehicles, audit, bus, clock),
        drivers=DriverService(repos.drivers, audit, clock),
        trips=TripService(repos.trips, repos.vehicles, TelematicsClient(http, config), audit, bus, clock),
        maintenance=MaintenanceService(repos.tickets, repos.vehicles, audit, bus, clock),
        billing=BillingService(repos.invoices, repos.trips, audit, config, clock),
        reports=ReportService(repos, config),
        audit=audit,
        sessions=sessions,
        retention=RetentionService(repos, config, clock),
        webhooks=WebhookDispatcher(repos.webhooks, http, config, clock),
        users=UserService(repos.users, audit, clock),
        auth=AuthService(repos.users, repos.tokens, sessions, clock, config),
        presence=PresenceService(clock, ttl_s=config.get("presence.ttl_s")),
        notifications=NotificationService(config),
    )
    register_default_subscribers(bus, repos, services)
    ctx = AppContext(config=config, repos=repos, services=services, bus=bus, clock=clock, journal=journal)

    app = App(ctx)
    app.use(RequestLogMiddleware())
    app.use(ErrorMiddleware())
    app.use(AuthMiddleware(services.auth, public_prefixes=config.get("http.public_prefixes")))

    app.mount(API + "/auth", auth.router)
    app.mount(API + "/users", users.router)
    app.mount(API + "/vehicles", vehicles.router)
    app.mount(API + "/drivers", drivers.router)
    app.mount(API + "/trips", trips.router)
    app.mount(API + "/maintenance", maintenance.router)
    app.mount(API + "/invoices", invoices.router)
    app.mount(API + "/reports", reports.router)
    app.mount(API + "/admin", admin.router)
    app.mount(API + "/webhooks", webhooks.router)
    app.mount(API + "/health", health.router)
    # handlers/legacy.py (the retired v0 import API) is intentionally not mounted.

    app.after_request(journal.flush_if_needed)
    return app


if __name__ == "__main__":
    application = create_app()
    if "--routes" in sys.argv:
        for method, path, handler in application.routes():
            print(f"{method:7} {path:45} {handler.__module__}.{handler.__name__}")
