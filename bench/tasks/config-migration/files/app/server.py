from __future__ import annotations

from dataclasses import dataclass

from .settings import ConfigError, get_bool, get_int


@dataclass
class ServerOptions:
    host: str
    port: int
    workers: int
    debug: bool


def server_options(cp, db_pool_size: int) -> ServerOptions:
    host = cp.get("server", "host", fallback="127.0.0.1").strip() or "127.0.0.1"
    port = get_int(cp, "server", "port", 8000, 1, 65535)
    raw_workers = cp.get("server", "workers", fallback="auto").strip().lower()
    if raw_workers == "auto":
        # one worker per two DB connections, at least one
        workers = max(1, db_pool_size // 2)
    else:
        workers = get_int(cp, "server", "workers", 1, 1, 64)
    debug = get_bool(cp, "server", "debug", False)
    return ServerOptions(host, port, workers, debug)
