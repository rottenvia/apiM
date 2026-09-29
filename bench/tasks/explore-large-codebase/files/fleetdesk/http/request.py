from __future__ import annotations

import json
from dataclasses import dataclass, field


@dataclass
class Request:
    method: str
    path: str
    headers: dict = field(default_factory=dict)
    body: bytes = b""
    query: dict = field(default_factory=dict)
    path_params: dict = field(default_factory=dict)
    user: object = None
    request_id: str = ""

    def header(self, name: str, default=None):
        for key, value in self.headers.items():
            if key.lower() == name.lower():
                return value
        return default

    def bearer_token(self) -> str | None:
        value = self.header("Authorization", "")
        if value.lower().startswith("bearer "):
            return value[7:].strip() or None
        return None

    def json(self):
        if not self.body:
            return {}
        return json.loads(self.body.decode("utf-8"))
