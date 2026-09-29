"""A small in-memory LRU cache with optional per-item expiry.

Specification
=============

``LRUCache(capacity, *, default_ttl=None, clock=time.monotonic)``

* ``capacity`` is the maximum number of live entries. It must be an ``int``
  of at least 1, otherwise ``ValueError`` is raised. It is exposed as the
  read-only attribute/property ``capacity``.
* ``default_ttl`` is the lifetime in seconds given to entries stored without
  an explicit ``ttl`` (``None`` = entries never expire).
* ``clock`` is a zero-argument callable returning the current time in
  seconds as a number. It is injectable so tests can control time; the cache
  must never read the time any other way.

(See the task's original docstring for the full text.)
"""

import time
from collections import OrderedDict

_MISSING = object()


def _check_capacity(capacity):
    if isinstance(capacity, bool) or not isinstance(capacity, int) or capacity < 1:
        raise ValueError("capacity must be an int >= 1")
    return capacity


def _check_ttl(ttl):
    if ttl is None:
        return None
    if isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not ttl > 0:
        raise ValueError("ttl must be a positive number")
    return ttl


class LRUCache:
    def __init__(self, capacity, *, default_ttl=None, clock=time.monotonic):
        self._capacity = _check_capacity(capacity)
        self._default_ttl = _check_ttl(default_ttl)
        self._clock = clock
        self._data = OrderedDict()  # key -> (value, expires_at or None); LRU first

    @property
    def capacity(self):
        return self._capacity

    def _live(self, key, now):
        entry = self._data.get(key, _MISSING)
        if entry is _MISSING:
            return _MISSING
        value, expires = entry
        if expires is not None and now >= expires:
            del self._data[key]
            return _MISSING
        return value

    def _purge(self):
        now = self._clock()
        dead = [k for k, (_, exp) in self._data.items() if exp is not None and now >= exp]
        for k in dead:
            del self._data[k]

    def get(self, key, default=None):
        value = self._live(key, self._clock())
        if value is _MISSING:
            return default
        self._data.move_to_end(key)
        return value

    def peek(self, key, default=None):
        value = self._live(key, self._clock())
        return default if value is _MISSING else value

    def put(self, key, value, ttl=None):
        ttl = _check_ttl(ttl) if ttl is not None else self._default_ttl
        now = self._clock()
        expires = None if ttl is None else now + ttl
        if self._live(key, now) is not _MISSING:
            self._data[key] = (value, expires)
            self._data.move_to_end(key)
            return
        self._purge()
        while len(self._data) >= self._capacity:
            self._data.popitem(last=False)
        self._data[key] = (value, expires)

    def delete(self, key):
        if self._live(key, self._clock()) is _MISSING:
            return False
        del self._data[key]
        return True

    def keys(self):
        self._purge()
        return list(self._data)

    def resize(self, new_capacity):
        self._capacity = _check_capacity(new_capacity)
        self._purge()
        while len(self._data) > self._capacity:
            self._data.popitem(last=False)

    def __len__(self):
        self._purge()
        return len(self._data)

    def __contains__(self, key):
        return self._live(key, self._clock()) is not _MISSING
