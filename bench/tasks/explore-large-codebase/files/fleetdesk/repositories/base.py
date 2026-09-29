from __future__ import annotations

from dataclasses import asdict, fields

from ..errors import ConflictError
from ..storage.db import IntegrityError


class BaseRepository:
    """Row <-> dataclass mapping on top of storage.db.Database."""

    table: str = ""
    model = None

    def __init__(self, db):
        self._db = db

    def _columns(self):
        return [f.name for f in fields(self.model)]

    def _to_model(self, row):
        return None if row is None else self.model(**{c: row[c] for c in self._columns() if c in row})

    def get(self, ident):
        return self._to_model(self._db.query_one(f"SELECT * FROM {self.table} WHERE id = ?", (ident,)))

    def insert(self, obj) -> None:
        data = asdict(obj)
        cols = list(data)
        try:
            self._db.execute(
                f"INSERT INTO {self.table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                tuple(data[c] for c in cols),
            )
        except IntegrityError as exc:
            raise ConflictError(f"{self.table}: {exc}") from None

    def update(self, obj) -> None:
        data = asdict(obj)
        ident = data.pop("id")
        assignments = ", ".join(f"{c} = ?" for c in data)
        self._db.execute(f"UPDATE {self.table} SET {assignments} WHERE id = ?", (*data.values(), ident))

    def delete(self, ident) -> None:
        self._db.execute(f"DELETE FROM {self.table} WHERE id = ?", (ident,))

    def _delete_where(self, clause: str, params: tuple) -> int:
        return self._db.execute(f"DELETE FROM {self.table} WHERE {clause}", params)

    def ping(self) -> bool:
        try:
            self._db.query_one("SELECT 1 AS ok", ())
            return True
        except Exception:  # noqa: BLE001
            return False
