"""Deployment profiles, selected with FLEETDESK_PROFILE."""

DEFAULT_PROFILE = "development"

PROFILES = {
    "development": {
        "db.dsn": "sqlite:///dev.db",
        "log.level": "DEBUG",
        "http.retry.max_attempts": 2,
        "http.retry.backoff_initial_ms": 100,
        "sessions.purge_every": 50,
    },
    "test": {
        "db.dsn": "sqlite:///:memory:",
        "http.retry.max_attempts": 1,
        "audit.batch_size": 1,
    },
    "production": {
        "db.timeout_s": 15,
        "http.retry.backoff_initial_ms": 300,
        "webhooks.delivery.backoff_initial_ms": 2_000,
        "log.level": "INFO",
    },
}
