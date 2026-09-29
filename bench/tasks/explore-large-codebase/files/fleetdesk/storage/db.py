"""Thin wrapper around sqlite3 (production uses the same API over psycopg)."""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime

IntegrityError = sqlite3.IntegrityError

sqlite3.register_adapter(datetime, lambda value: value.isoformat())


def _revive(row) -> dict:
    """sqlite hands timestamps back as text; turn *_at columns into datetimes again."""
    out = dict(row)
    for key, value in out.items():
        if isinstance(value, str) and (key == "at" or key.endswith("_at")):
            try:
                out[key] = datetime.fromisoformat(value)
            except ValueError:
                pass
    return out


class Database:
    def __init__(self, dsn: str, timeout: float = 5):
        path = dsn.split("sqlite:///", 1)[-1] if dsn.startswith("sqlite:///") else dsn
        self._path = path
        self._timeout = timeout
        self._local = threading.local()

    def _conn(self):
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self._path, timeout=self._timeout, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
        return conn

    def execute(self, sql: str, params: tuple = ()) -> int:
        with self._conn() as conn:
            return conn.execute(sql, params).rowcount

    def executemany(self, sql: str, rows) -> int:
        with self._conn() as conn:
            return conn.executemany(sql, rows).rowcount

    def query(self, sql: str, params: tuple = ()):
        return [_revive(r) for r in self._conn().execute(sql, params).fetchall()]

    def query_one(self, sql: str, params: tuple = ()):
        row = self._conn().execute(sql, params).fetchone()
        return _revive(row) if row is not None else None
