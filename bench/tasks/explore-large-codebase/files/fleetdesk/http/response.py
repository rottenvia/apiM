from __future__ import annotations

import json
from dataclasses import dataclass, field


@dataclass
class Response:
    status: int = 200
    body: bytes = b""
    headers: dict = field(default_factory=dict)

    @classmethod
    def json(cls, payload, status: int = 200) -> "Response":
        return cls(status, json.dumps(payload, default=str).encode("utf-8"), {"Content-Type": "application/json"})

    @classmethod
    def no_content(cls) -> "Response":
        return cls(204)


def json_error(status: int, message: str, **extra) -> Response:
    return Response.json({"error": message, **extra}, status=status)
