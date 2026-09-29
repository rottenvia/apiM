"""Built-in defaults. Profiles (profiles.py), the config file and FLEETDESK__*
environment variables are layered on top of these by loader.load_config()."""

DEFAULTS = {
    # storage
    "db.dsn": "sqlite:///fleetdesk.db",
    "db.timeout_s": 5,
    "audit.batch_size": 50,

    # http layer
    "http.timeout_ms": 8000,
    "http.public_prefixes": ["/api/v1/health", "/api/v1/webhooks/"],
    "http.retry.max_attempts": 3,
    "http.retry.backoff_initial_ms": 200,
    "http.retry.backoff_multiplier": 2.0,
    "http.retry.backoff_max_ms": 10_000,

    # outgoing webhooks
    "webhooks.retry_backoff_s": 30,
    "webhooks.delivery.max_attempts": 8,
    "webhooks.delivery.backoff_max_ms": 600_000,
    "webhooks.delivery.timeout_ms": 5_000,
    # inbound webhooks
    "webhooks.telematics.secret": "",
    "webhooks.payments.secret": "",

    # integrations
    "integrations.telematics.base_url": "https://telematics.example.net/v3",
    "integrations.telematics.backoff_initial_ms": 250,
    "integrations.telematics.max_attempts": 4,

    # sessions & auth
    "sessions.ttl_minutes": 720,
    "sessions.purge_every": 500,
    "auth.token_ttl_minutes": 60,
    "auth.refresh_ttl_days": 14,

    # retention
    "retention.sessions_days": 30,
    "retention.trips_archive_days": 400,

    # misc
    "cache.default_ttl_s": 60,
    "presence.ttl_s": 90,
    "billing.currency": "EUR",
    "billing.vat_rate": 0.21,
    "reports.max_rows": 50_000,
    "notifications.from_address": "noreply@fleetdesk.example",
    "log.level": "INFO",
}
