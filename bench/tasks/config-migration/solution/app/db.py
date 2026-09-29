from __future__ import annotations

import re
from dataclasses import dataclass

from .settings import ConfigError, get_float, get_int, get_str


@dataclass
class DatabaseOptions:
    url: str
    pool_size: int
    timeout: float

    def safe_url(self) -> str:
        return re.sub(r"://([^:/@]+):[^@]*@", r"://\1:***@", self.url)


def database_options(cfg) -> DatabaseOptions:
    url = get_str(cfg, "database", "url", "sqlite:///reports.db")
    pool_size = get_int(cfg, "database", "pool_size", 5, 1, 100)
    timeout = get_float(cfg, "database", "timeout", 30.0)
    if timeout <= 0:
        raise ConfigError(f"{cfg.name('database', 'timeout')} must be positive")
    return DatabaseOptions(url, pool_size, timeout)
