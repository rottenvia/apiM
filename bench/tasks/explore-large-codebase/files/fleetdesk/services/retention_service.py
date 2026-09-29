"""Data retention policy: expire sessions and tokens, archive old trips."""
from __future__ import annotations

from datetime import timedelta


class RetentionService:
    def __init__(self, repos, config, clock):
        self.repos = repos
        self._sessions_days = config.get("retention.sessions_days")
        self._trips_days = config.get("retention.trips_archive_days")
        self._clock = clock

    def run(self, now=None) -> dict:
        now = now or self._clock.now()
        sessions = self.repos.sessions.purge_expired(now - timedelta(days=self._sessions_days))
        tokens = self.repos.tokens.purge_expired(now)
        archived = self.repos.trips.archive_before(now - timedelta(days=self._trips_days))
        return {"sessions": sessions, "tokens": tokens, "trips_archived": archived}
