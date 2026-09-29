from __future__ import annotations

import threading


class CacheStore:
    """Tiny in-process TTL cache."""

    def __init__(self, ttl_s: float, clock):
        self._ttl = ttl_s
        self._clock = clock
        self._data = {}
        self._lock = threading.Lock()

    def put(self, key, value) -> None:
        with self._lock:
            self._data[key] = (self._clock.now().timestamp() + self._ttl, value)

    def get(self, key, default=None):
        with self._lock:
            item = self._data.get(key)
        if item is None:
            return default
        expires, value = item
        if expires < self._clock.now().timestamp():
            self.purge_expired()
            return default
        return value

    def keys(self):
        now = self._clock.now().timestamp()
        with self._lock:
            return [k for k, (exp, _) in self._data.items() if exp >= now]

    def invalidate(self, key) -> None:
        with self._lock:
            self._data.pop(key, None)

    def purge_expired(self) -> int:
        now = self._clock.now().timestamp()
        with self._lock:
            dead = [k for k, (exp, _) in self._data.items() if exp < now]
            for k in dead:
                del self._data[k]
        return len(dead)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()
