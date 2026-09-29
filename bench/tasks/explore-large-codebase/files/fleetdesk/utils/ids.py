from __future__ import annotations

import secrets
import time


def new_id(prefix: str) -> str:
    """Sortable-ish id: <prefix>_<ms timestamp base36><random>."""
    ts = int(time.time() * 1000)
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while ts:
        ts, rem = divmod(ts, 36)
        out = digits[rem] + out
    return f"{prefix}_{out}{secrets.token_hex(4)}"


def new_token() -> str:
    return secrets.token_urlsafe(32)
