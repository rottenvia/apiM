"""Report service launcher. Prints the effective configuration and exits
(the real service start-up is stubbed out in this repo).

usage: python main.py [--config PATH]
"""
from __future__ import annotations

import sys

from app import settings
from app.db import database_options
from app.features import load_features
from app.logconf import log_options
from app.server import server_options


def main(argv: list[str]) -> int:
    path = None
    if argv[:1] == ["--config"] and len(argv) == 2:
        path = argv[1]
    elif argv:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    try:
        cfg = settings.load(path)
        db = database_options(cfg)
        srv = server_options(cfg, db.pool_size)
        feats = load_features(cfg)
        logs = log_options(cfg, srv.debug)
    except settings.ConfigError as e:
        print(f"config error: {e}", file=sys.stderr)
        return 2

    print(f"server: host={srv.host} port={srv.port} workers={srv.workers} debug={'on' if srv.debug else 'off'}")
    print(f"database: url={db.safe_url()} pool={db.pool_size} timeout={db.timeout}s")
    print(f"features: {', '.join(feats.enabled) or 'none'} (beta users: {len(feats.beta_users)})")
    print(f"logging: level={logs.level} file={logs.file or 'stderr'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
