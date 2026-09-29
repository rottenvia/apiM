"""Light validation of the merged configuration."""
from __future__ import annotations

REQUIRED_POSITIVE = (
    "db.timeout_s",
    "audit.batch_size",
    "http.timeout_ms",
    "http.retry.max_attempts",
    "webhooks.delivery.max_attempts",
    "sessions.purge_every",
)


class ConfigError(Exception):
    pass


def validate(values: dict) -> None:
    for key in REQUIRED_POSITIVE:
        value = values.get(key)
        if not isinstance(value, (int, float)) or value <= 0:
            raise ConfigError(f"{key} must be a positive number, got {value!r}")
    prefixes = values.get("http.public_prefixes")
    if not isinstance(prefixes, list) or not all(isinstance(p, str) and p.startswith("/") for p in prefixes):
        raise ConfigError("http.public_prefixes must be a list of absolute paths")
    if not 0 <= values.get("billing.vat_rate", 0) < 1:
        raise ConfigError("billing.vat_rate must be a fraction")
