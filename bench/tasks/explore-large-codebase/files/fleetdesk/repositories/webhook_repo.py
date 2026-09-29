from __future__ import annotations


class WebhookRepository:
    def __init__(self, db):
        self._db = db

    def subscriptions_for(self, event_type):
        return self._db.query("SELECT * FROM webhook_subscriptions WHERE event_type = ? AND active = 1", (event_type,))

    def record_delivery(self, subscription_id, event_type, ok, at):
        self._db.execute(
            "INSERT INTO webhook_deliveries (subscription_id, event_type, ok, at) VALUES (?, ?, ?, ?)",
            (subscription_id, event_type, 1 if ok else 0, at))
