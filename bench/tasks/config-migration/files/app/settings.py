"""Load the service configuration from an INI file plus environment overrides.

Lookup order for the file: --config PATH, then $APP_CONFIG, then
./settings.ini. A missing default file is fine (built-in defaults apply);
a file that was asked for explicitly must exist.
"""
from __future__ import annotations

import configparser
import os

DEFAULT_PATH = "settings.ini"

# environment variable -> (section, option). Env wins over the file.
# An empty variable counts as unset.
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


class ConfigError(Exception):
    pass


def load(path: str | None = None) -> configparser.ConfigParser:
    explicit = path or os.environ.get("APP_CONFIG") or None
    target = explicit or DEFAULT_PATH
    if explicit and not os.path.exists(target):
        raise ConfigError(f"config file not found: {target}")
    cp = configparser.ConfigParser(interpolation=None)
    try:
        cp.read(target, encoding="utf-8")
    except configparser.Error as e:
        raise ConfigError(f"cannot parse {target}: {e}") from None
    for var, (section, option) in ENV_OVERRIDES.items():
        value = os.environ.get(var)
        if not value:
            continue
        if not cp.has_section(section):
            cp.add_section(section)
        cp.set(section, option, value)
    return cp


def get_int(cp, section, option, default, lo, hi):
    raw = cp.get(section, option, fallback=None)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{section}.{option} must be an integer, got {raw!r}") from None
    if not lo <= value <= hi:
        raise ConfigError(f"{section}.{option} must be between {lo} and {hi}, got {value}")
    return value


def get_bool(cp, section, option, default):
    try:
        return cp.getboolean(section, option, fallback=default)
    except ValueError:
        raw = cp.get(section, option)
        raise ConfigError(f"{section}.{option} must be a boolean, got {raw!r}") from None


def get_list(cp, section, option):
    raw = cp.get(section, option, fallback="")
    return [item.strip() for item in raw.split(",") if item.strip()]
