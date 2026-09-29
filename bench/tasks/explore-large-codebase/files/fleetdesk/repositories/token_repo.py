from __future__ import annotations


class TokenRepository:
    table = "auth_tokens"

    def __init__(self, db):
        self._db = db

    def insert(self, token, user_id, kind, expires_at):
        self._db.execute("INSERT INTO auth_tokens (token, user_id, kind, expires_at) VALUES (?, ?, ?, ?)",
                         (token, user_id, kind, expires_at))

    def get(self, token):
        return self._db.query_one("SELECT * FROM auth_tokens WHERE token = ?", (token,))

    def revoke(self, token):
        self._db.execute("DELETE FROM auth_tokens WHERE token = ?", (token,))

    def revoke_for_user(self, user_id):
        return self._db.execute("DELETE FROM auth_tokens WHERE user_id = ?", (user_id,))

    def purge_expired(self, now) -> int:
        return self._db.execute("DELETE FROM auth_tokens WHERE expires_at < ?", (now,))
