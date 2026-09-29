"""Load the service configuration from a JSON file plus environment overrides.

Lookup order for the file: --config PATH, then $APP_CONFIG, then
./config.json. A missing default file is fine (built-in defaults apply);
a file that was asked for explicitly must exist. See CONFIG.md.
"""
from __future__ import annotations

import json
import os

DEFAULT_PATH = "config.json"

# (section, option) -> JSON key inside that section
JSON_KEYS = {
    ("server", "host"): "host",
    ("server", "port"): "port",
    ("server", "workers"): "workers",
    ("server", "debug"): "debug",
    ("database", "url"): "url",
    ("database", "pool_size"): "pool_size",
    ("database", "timeout"): "timeout_seconds",
    ("features", "enabled"): "enabled",
    ("features", "beta_users"): "beta_users",
    ("logging", "level"): "level",
    ("logging", "file"): "file",
}

# environment variable -> (section, option). Env wins over the file.
# An empty variable counts as unset. Env values are strings and are parsed
# the same way the old INI values were.
ENV_OVERRIDES = {
    "APP_HOST": ("server", "host"),
    "APP_PORT": ("server", "port"),
    "APP_WORKERS": ("server", "workers"),
    "APP_DEBUG": ("server", "debug"),
    "DATABASE_URL": ("database", "url"),
    "APP_DB_POOL_SIZE": ("database", "pool_size"),
    "APP_DB_TIMEOUT": ("database", "timeout"),
    "APP_FEATURES": ("features", "enabled"),
    "APP_LOG_LEVEL": ("logging", "level"),
    "APP_LOG_FILE": ("logging", "file"),
}

_BOOLEAN_STATES = {"1": True, "yes": True, "true": True, "on": True,
                   "0": False, "no": False, "false": False, "off": False}


class ConfigError(Exception):
    pass


class Config:
    """Effective settings: typed JSON values, overridden by env strings."""

    def __init__(self, values: dict, env: dict):
        self._values = values
        self._env = env

    def name(self, section: str, option: str) -> str:
        return f"{section}.{JSON_KEYS[(section, option)]}"

    def raw(self, section: str, option: str):
        """(value, from_env). value is None when unset."""
        if (section, option) in self._env:
            return self._env[(section, option)], True
        return self._values.get((section, option)), False


def load(path: str | None = None) -> Config:
    explicit = path or os.environ.get("APP_CONFIG") or None
    target = explicit or DEFAULT_PATH
    if explicit and not os.path.exists(target):
        raise ConfigError(f"config file not found: {target}")
    doc = {}
    if os.path.exists(target):
        try:
            with open(target, encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError) as e:
            raise ConfigError(f"cannot parse {target}: {e}") from None
        if not isinstance(doc, dict):
            raise ConfigError(f"{target}: top level must be an object")
    values = {}
    for (section, option), key in JSON_KEYS.items():
        block = doc.get(section)
        if block is None:
            continue
        if not isinstance(block, dict):
            raise ConfigError(f"{section} must be an object")
        value = block.get(key)
        if value is not None:
            values[(section, option)] = value
    env = {}
    for var, target_key in ENV_OVERRIDES.items():
        value = os.environ.get(var)
        if value:
            env[target_key] = value
    return Config(values, env)


def get_str(cfg: Config, section, option, default):
    value, _ = cfg.raw(section, option)
    if value is None:
        return default
    if not isinstance(value, str):
        raise ConfigError(f"{cfg.name(section, option)} must be a string, got {value!r}")
    return value


def get_int(cfg: Config, section, option, default, lo, hi):
    value, from_env = cfg.raw(section, option)
    if value is None:
        return default
    if from_env:
        try:
            value = int(value)
        except ValueError:
            raise ConfigError(f"{cfg.name(section, option)} must be an integer, got {value!r}") from None
    elif isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"{cfg.name(section, option)} must be an integer, got {value!r}")
    if not lo <= value <= hi:
        raise ConfigError(f"{cfg.name(section, option)} must be between {lo} and {hi}, got {value}")
    return value


def get_float(cfg: Config, section, option, default):
    value, from_env = cfg.raw(section, option)
    if value is None:
        return default
    if from_env:
        try:
            return float(value)
        except ValueError:
            raise ConfigError(f"{cfg.name(section, option)} must be a number, got {value!r}") from None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError(f"{cfg.name(section, option)} must be a number, got {value!r}")
    return float(value)


def get_bool(cfg: Config, section, option, default):
    value, from_env = cfg.raw(section, option)
    if value is None:
        return default
    if from_env:
        if value.lower() not in _BOOLEAN_STATES:
            raise ConfigError(f"{cfg.name(section, option)} must be a boolean, got {value!r}")
        return _BOOLEAN_STATES[value.lower()]
    if not isinstance(value, bool):
        raise ConfigError(f"{cfg.name(section, option)} must be a boolean, got {value!r}")
    return value


def get_list(cfg: Config, section, option):
    value, from_env = cfg.raw(section, option)
    if value is None:
        return []
    if from_env:
        items = value.split(",")
    elif isinstance(value, list) and all(isinstance(v, str) for v in value):
        items = value
    else:
        raise ConfigError(f"{cfg.name(section, option)} must be a list of strings, got {value!r}")
    return [item.strip() for item in items if item.strip()]
