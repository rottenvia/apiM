"""Configuration loading.

Precedence, lowest to highest:
    DEFAULTS -> profile (FLEETDESK_PROFILE) -> config file -> FLEETDESK__* env vars
Derived defaults are filled in last, and only for keys still unset.
"""
from __future__ import annotations

import json
import os

from .defaults import DEFAULTS
from .profiles import DEFAULT_PROFILE, PROFILES
from .schema import validate

ENV_PREFIX = "FLEETDESK__"


class Config:
    def __init__(self, values: dict):
        self._values = dict(values)

    def get(self, key: str, default=None):
        return self._values.get(key, default)

    def section(self, prefix: str) -> dict:
        prefix = prefix.rstrip(".") + "."
        return {k[len(prefix):]: v for k, v in self._values.items() if k.startswith(prefix)}

    def as_dict(self) -> dict:
        return dict(self._values)


def _read_file(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return _flatten(data)


def _flatten(data: dict, prefix: str = "") -> dict:
    out = {}
    for key, value in data.items():
        full = f"{prefix}{key}"
        if isinstance(value, dict):
            out.update(_flatten(value, full + "."))
        else:
            out[full] = value
    return out


def _env_overrides(env) -> dict:
    """FLEETDESK__HTTP__RETRY__MAX_ATTEMPTS=5 -> http.retry.max_attempts = 5"""
    out = {}
    for name, raw in env.items():
        if not name.startswith(ENV_PREFIX):
            continue
        key = name[len(ENV_PREFIX):].lower().replace("__", ".")
        try:
            out[key] = json.loads(raw)
        except ValueError:
            out[key] = raw
    return out


def _apply_derived(values: dict) -> None:
    """Keys whose default depends on another key. Explicit settings win."""
    values.setdefault("webhooks.delivery.backoff_initial_ms", values["http.retry.backoff_initial_ms"] * 5)
    values.setdefault("webhooks.delivery.backoff_multiplier", values["http.retry.backoff_multiplier"])
    values.setdefault("reports.cache_ttl_s", values["cache.default_ttl_s"] * 4)
    values.setdefault("sessions.cookie_max_age_s", values["sessions.ttl_minutes"] * 60)


def load_config(path: str | None = None, env=None) -> Config:
    env = os.environ if env is None else env
    values = dict(DEFAULTS)
    profile = env.get("FLEETDESK_PROFILE") or DEFAULT_PROFILE
    values.update(PROFILES.get(profile, {}))
    if path:
        values.update(_read_file(path))
    values.update(_env_overrides(env))
    _apply_derived(values)
    validate(values)
    return Config(values)
