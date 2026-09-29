from __future__ import annotations


class SessionRepository:
    table = "sessions"

    def __init__(self, db):
        self._db = db

    def insert(self, session_id, user_id, expires_at):
        self._db.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)",
                         (session_id, user_id, expires_at))

    def get(self, session_id):
        return self._db.query_one("SELECT * FROM sessions WHERE id = ?", (session_id,))

    def delete_for_user(self, user_id) -> int:
        return self._db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

    def purge_expired(self, cutoff) -> int:
        """Delete sessions that expired before `cutoff`. Returns the number removed."""
        return self._db.execute("DELETE FROM sessions WHERE expires_at < ?", (cutoff,))

    def rotate(self, old_id, new_id, now):
        row = self.get(old_id)
        if row is None:
            return None
        self.purge_expired(now)
        self._db.execute("UPDATE sessions SET id = ? WHERE id = ?", (new_id, old_id))
        return new_id
