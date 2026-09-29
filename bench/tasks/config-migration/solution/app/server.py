from __future__ import annotations

from dataclasses import dataclass

from .settings import ConfigError, get_bool, get_int


@dataclass
class ServerOptions:
    host: str
    port: int
    workers: int
    debug: bool


def server_options(cfg, db_pool_size: int) -> ServerOptions:
    from .settings import get_str

    host = get_str(cfg, "server", "host", "127.0.0.1").strip() or "127.0.0.1"
    port = get_int(cfg, "server", "port", 8000, 1, 65535)
    raw_workers, _ = cfg.raw("server", "workers")
    if raw_workers is None or (isinstance(raw_workers, str) and raw_workers.strip().lower() == "auto"):
        # one worker per two DB connections, at least one
        workers = max(1, db_pool_size // 2)
    else:
        workers = get_int(cfg, "server", "workers", 1, 1, 64)
    debug = get_bool(cfg, "server", "debug", False)
    return ServerOptions(host, port, workers, debug)
