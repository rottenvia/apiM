from __future__ import annotations

from ..utils.logging import get_logger

log = get_logger(__name__)


class NotificationService:
    """Sends operator notifications. E-mail delivery is stubbed: messages are logged."""

    def __init__(self, config):
        self._sender = config.get("notifications.from_address")
        self.outbox = []

    def send(self, to: str, subject: str, body: str) -> None:
        self.outbox.append((to, subject, body))
        log.info("mail from=%s to=%s subject=%r", self._sender, to, subject)

    def on_ticket_opened(self, ticket):
        if ticket.severity in ("high", "critical"):
            self.send("workshop@fleetdesk.example", f"[{ticket.severity}] ticket {ticket.id}", ticket.summary)
