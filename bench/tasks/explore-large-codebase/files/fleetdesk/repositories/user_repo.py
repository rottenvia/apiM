from __future__ import annotations

import json
from dataclasses import dataclass, field

from .base import BaseRepository


@dataclass
class User:
    id: str
    email: str
    roles: list = field(default_factory=list)
    password_hash: str = ""

    def to_dict(self):
        return {"id": self.id, "email": self.email, "roles": list(self.roles)}


class UserRepository(BaseRepository):
    table = "users"
    model = User

    def _to_model(self, row):
        if row is None:
            return None
        return User(id=row["id"], email=row["email"], roles=json.loads(row["roles"] or "[]"),
                    password_hash=row["password_hash"])

    def insert(self, user):
        self._db.execute("INSERT INTO users (id, email, roles, password_hash) VALUES (?, ?, ?, ?)",
                         (user.id, user.email, json.dumps(user.roles), user.password_hash))

    def update(self, user):
        self._db.execute("UPDATE users SET email = ?, roles = ?, password_hash = ? WHERE id = ?",
                         (user.email, json.dumps(user.roles), user.password_hash, user.id))

    def find_by_email(self, email):
        return self._to_model(self._db.query_one("SELECT * FROM users WHERE email = ?", (email,)))

    def list(self):
        return [self._to_model(r) for r in self._db.query("SELECT * FROM users ORDER BY email", ())]
