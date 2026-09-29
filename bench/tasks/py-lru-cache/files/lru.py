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

Entries and recency
-------------------

* ``put(key, value, ttl=None)`` stores ``value`` under ``key``.
  ``ttl=None`` means "use ``default_ttl``". A ``ttl`` (explicit or default)
  must be a positive number, otherwise ``ValueError``.
  Storing a key makes it the most recently used entry. Storing an existing
  key replaces its value and restarts its lifetime.
* ``get(key, default=None)`` returns the stored value, or ``default`` when
  the key is absent or expired. A successful ``get`` makes the entry the
  most recently used one. It does *not* extend the entry's lifetime.
  Note that ``None`` is a perfectly valid value to store.
* ``peek(key, default=None)`` is like ``get`` but does not change recency.
* ``delete(key)`` removes the entry and returns ``True`` if a live entry was
  removed, ``False`` otherwise.
* ``key in cache`` is ``True`` only for live (present and unexpired) keys.
  It does not change recency.
* ``len(cache)`` is the number of live entries.
* ``keys()`` returns a list of the live keys ordered from least recently
  used to most recently used.
* ``resize(new_capacity)`` changes the capacity (same validation as the
  constructor). If the cache holds more live entries than the new capacity,
  the least recently used ones are evicted until it fits.

Expiry
------

An entry stored at time ``t`` with lifetime ``ttl`` is live while
``clock() < t + ttl`` and expired from ``clock() >= t + ttl`` on. Expired
entries behave exactly as if they had been deleted: they are never
returned, counted, listed, or reported by ``in``.

Eviction
--------

When a *new* key is stored and the cache already holds ``capacity`` live
entries, the least recently used live entry is evicted to make room.
Expired entries never take up room: they are never a reason to evict a live
entry. Replacing the value of an existing key never evicts anything.
"""

import time


class LRUCache:
    def __init__(self, capacity, *, default_ttl=None, clock=time.monotonic):
        raise NotImplementedError

    @property
    def capacity(self):
        raise NotImplementedError

    def get(self, key, default=None):
        raise NotImplementedError

    def peek(self, key, default=None):
        raise NotImplementedError

    def put(self, key, value, ttl=None):
        raise NotImplementedError

    def delete(self, key):
        raise NotImplementedError

    def keys(self):
        raise NotImplementedError

    def resize(self, new_capacity):
        raise NotImplementedError

    def __len__(self):
        raise NotImplementedError

    def __contains__(self, key):
        raise NotImplementedError
