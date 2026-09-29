"""Outbound HTTP (urllib based, no third-party deps)."""
from __future__ import annotations

import urllib.error
import urllib.request


class HttpClient:
    def __init__(self, timeout_ms: int = 8000):
        self._timeout_ms = timeout_ms

    def post(self, url: str, body: bytes, timeout_ms: int | None = None, headers=None) -> int:
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=(timeout_ms or self._timeout_ms) / 1000) as resp:
                return resp.status
        except urllib.error.HTTPError as exc:
            return exc.code
        except urllib.error.URLError as exc:
            raise TimeoutError(str(exc)) from None

    def get_json(self, url: str, timeout_ms: int | None = None):
        import json
        with urllib.request.urlopen(url, timeout=(timeout_ms or self._timeout_ms) / 1000) as resp:
            return json.loads(resp.read().decode())
