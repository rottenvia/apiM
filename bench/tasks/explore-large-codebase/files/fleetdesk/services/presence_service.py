"""Which dispatchers are currently online (in-memory, per process)."""
from __future__ import annotations

from ..utils.cache import CacheStore


class PresenceService:
    def __init__(self, clock, ttl_s=90):
        # user id -> last heartbeat; entries expire after ttl_s
        self.sessions = CacheStore(ttl_s=ttl_s, clock=clock)

    def heartbeat(self, user_id: str, at) -> None:
        self.sessions.put(user_id, at)

    def online(self) -> list[str]:
        return sorted(self.sessions.keys())

    def sweep(self) -> int:
        return self.sessions.purge_expired()

    def clear(self) -> None:
        self.sessions.clear()
