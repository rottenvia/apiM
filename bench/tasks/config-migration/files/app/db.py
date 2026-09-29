from __future__ import annotations

import re
from dataclasses import dataclass

from .settings import ConfigError, get_int


@dataclass
class DatabaseOptions:
    url: str
    pool_size: int
    timeout: float

    def safe_url(self) -> str:
        return re.sub(r"://([^:/@]+):[^@]*@", r"://\1:***@", self.url)


def database_options(cp) -> DatabaseOptions:
    url = cp.get("database", "url", fallback="sqlite:///reports.db")
    pool_size = get_int(cp, "database", "pool_size", 5, 1, 100)
    raw = cp.get("database", "timeout", fallback=None)
    if raw is None:
        timeout = 30.0
    else:
        try:
            timeout = float(raw)
        except ValueError:
            raise ConfigError(f"database.timeout must be a number, got {raw!r}") from None
        if timeout <= 0:
            raise ConfigError("database.timeout must be positive")
    return DatabaseOptions(url, pool_size, timeout)
