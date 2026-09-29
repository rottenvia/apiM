"""Browser/API sessions backed by the sessions table."""
from __future__ import annotations

from datetime import timedelta

from ..utils.ids import new_id


class SessionService:
    def __init__(self, sessions, tokens, clock, purge_every=500):
        self._sessions = sessions
        self._tokens = tokens
        self._clock = clock
        self._purge_every = purge_every
        self._validations = 0

    def open(self, user_id: str, ttl_minutes: int = 720) -> str:
        sid = new_id("ses")
        self._sessions.insert(sid, user_id, expires_at=self._clock.now() + timedelta(minutes=ttl_minutes))
        return sid

    def validate(self, session_id: str):
        """Return the user id for a live session, or None."""
        self._validations += 1
        if self._validations % self._purge_every == 0:
            # opportunistic clean-up so the table doesn't grow between nightly runs
            self._sessions.purge_expired(self._clock.now())
        row = self._sessions.get(session_id)
        if row is None or row["expires_at"] <= self._clock.now():
            return None
        return row["user_id"]

    def revoke_all(self, user_id: str) -> int:
        count = self._sessions.delete_for_user(user_id)
        self._tokens.revoke_for_user(user_id)
        return count
