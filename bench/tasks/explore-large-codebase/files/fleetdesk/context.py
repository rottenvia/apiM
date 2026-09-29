from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class Services:
    vehicles: Any
    drivers: Any
    trips: Any
    maintenance: Any
    billing: Any
    reports: Any
    audit: Any
    sessions: Any
    retention: Any
    webhooks: Any
    users: Any
    auth: Any
    presence: Any
    notifications: Any


@dataclass
class AppContext:
    """Everything a handler may need. One instance per application."""
    config: Any
    repos: Any
    services: Services
    bus: Any
    clock: Any
    journal: Any = None
