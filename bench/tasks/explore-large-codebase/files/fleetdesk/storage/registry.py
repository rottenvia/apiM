from __future__ import annotations

from dataclasses import dataclass

from ..repositories.audit_repo import AuditRepository
from ..repositories.driver_repo import DriverRepository
from ..repositories.invoice_repo import InvoiceRepository
from ..repositories.session_repo import SessionRepository
from ..repositories.ticket_repo import TicketRepository
from ..repositories.token_repo import TokenRepository
from ..repositories.trip_repo import TripRepository
from ..repositories.user_repo import UserRepository
from ..repositories.vehicle_repo import VehicleRepository
from ..repositories.webhook_repo import WebhookRepository


@dataclass
class Repositories:
    vehicles: VehicleRepository
    drivers: DriverRepository
    trips: TripRepository
    tickets: TicketRepository
    invoices: InvoiceRepository
    audit: AuditRepository
    sessions: SessionRepository
    tokens: TokenRepository
    users: UserRepository
    webhooks: WebhookRepository


def build_repositories(db, journal) -> Repositories:
    return Repositories(
        vehicles=VehicleRepository(db),
        drivers=DriverRepository(db),
        trips=TripRepository(db, journal),
        tickets=TicketRepository(db),
        invoices=InvoiceRepository(db),
        audit=AuditRepository(db, journal),
        sessions=SessionRepository(db),
        tokens=TokenRepository(db),
        users=UserRepository(db),
        webhooks=WebhookRepository(db),
    )
