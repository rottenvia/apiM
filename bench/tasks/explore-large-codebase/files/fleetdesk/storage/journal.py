"""Batched writer for append-only tables (audit events, telematics positions).

Rows are buffered per table and written in one executemany() per table when
the buffer reaches `batch_size`, at the end of every request (app.after_request)
or when someone calls flush() explicitly.
"""
from __future__ import annotations

import threading


class JournalWriter:
    def __init__(self, db, batch_size: int = 50):
        self._db = db
        self._batch_size = batch_size
        self._pending: dict[str, list[dict]] = {}
        self._lock = threading.Lock()

    def enqueue(self, table: str, row: dict) -> None:
        with self._lock:
            self._pending.setdefault(table, []).append(row)
            full = sum(len(v) for v in self._pending.values()) >= self._batch_size
        if full:
            self.flush()

    def pending(self) -> int:
        with self._lock:
            return sum(len(v) for v in self._pending.values())

    def flush_if_needed(self, *_ignored) -> None:
        if self.pending():
            self.flush()

    def flush(self) -> int:
        with self._lock:
            batches, self._pending = self._pending, {}
        written = 0
        for table, rows in batches.items():
            columns = sorted(rows[0])
            sql = f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})"
            self._db.executemany(sql, [tuple(row.get(c) for c in columns) for row in rows])
            written += len(rows)
        return written
