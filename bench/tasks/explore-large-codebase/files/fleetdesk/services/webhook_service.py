"""Outgoing webhooks to customer endpoints (vehicle registered, ticket opened...)."""
from __future__ import annotations

import json

from ..utils.logging import get_logger
from ..utils.retry import RetryPolicy, retry_call

log = get_logger(__name__)


class DeliveryFailed(Exception):
    pass


class WebhookDispatcher:
    CONFIG_PREFIX = "webhooks.delivery"

    def __init__(self, repo, http, config, clock):
        self._repo = repo
        self._http = http
        self._clock = clock
        self._policy = RetryPolicy.from_config(config, self.CONFIG_PREFIX)
        self._timeout_ms = config.get(f"{self.CONFIG_PREFIX}.timeout_ms")

    def subscribers(self, event_type: str):
        return self._repo.subscriptions_for(event_type)

    def deliver(self, subscription, event_type: str, payload: dict) -> bool:
        body = json.dumps({"type": event_type, "data": payload}, default=str).encode()

        def attempt():
            status = self._http.post(subscription["url"], body, timeout_ms=self._timeout_ms,
                                     headers={"X-Fleetdesk-Event": event_type})
            if status >= 500 or status == 429:
                raise DeliveryFailed(f"{subscription['url']} answered {status}")
            return status

        try:
            status = retry_call(attempt, self._policy, retry_on=(DeliveryFailed, TimeoutError))
        except (DeliveryFailed, TimeoutError) as exc:
            log.warning("giving up on webhook %s: %s", subscription["id"], exc)
            self._repo.record_delivery(subscription["id"], event_type, ok=False, at=self._clock.now())
            return False
        self._repo.record_delivery(subscription["id"], event_type, ok=200 <= status < 300, at=self._clock.now())
        return True

    def on_vehicle_registered(self, vehicle):
        for sub in self.subscribers("vehicle.registered"):
            self.deliver(sub, "vehicle.registered", vehicle.to_dict())

    def on_ticket_opened(self, ticket):
        for sub in self.subscribers("ticket.opened"):
            self.deliver(sub, "ticket.opened", ticket.to_dict())
