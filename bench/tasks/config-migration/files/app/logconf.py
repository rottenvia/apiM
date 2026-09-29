from __future__ import annotations

from dataclasses import dataclass

from .settings import ConfigError

LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")
ALIASES = {"WARN": "WARNING", "ERR": "ERROR"}


@dataclass
class LogOptions:
    level: str
    file: str | None


def log_options(cp, debug: bool) -> LogOptions:
    raw = cp.get("logging", "level", fallback=None)
    if raw is None or not raw.strip():
        level = "DEBUG" if debug else "INFO"
    else:
        level = ALIASES.get(raw.strip().upper(), raw.strip().upper())
        if level not in LEVELS:
            raise ConfigError(f"logging.level must be one of {', '.join(LEVELS)}, got {raw!r}")
    file = cp.get("logging", "file", fallback="").strip() or None
    return LogOptions(level, file)
