from __future__ import annotations

import re
from datetime import date, datetime

from ..errors import ValidationError

_VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")
_VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]
_VIN_VALUES = {**{str(d): d for d in range(10)},
               **dict(zip("ABCDEFGH", range(1, 9))), **dict(zip("JKLMN", range(1, 6))), "P": 7, "R": 9,
               **dict(zip("STUVWXYZ", range(2, 10)))}


def require(data: dict, *keys: str) -> None:
    for key in keys:
        if data.get(key) in (None, ""):
            raise ValidationError(f"{key} is required", field=key)


def normalize_vin(vin) -> str:
    return str(vin or "").strip().upper().replace(" ", "")


def is_valid_vin(vin: str) -> bool:
    if not _VIN_RE.match(vin):
        return False
    total = sum(_VIN_VALUES[c] * w for c, w in zip(vin, _VIN_WEIGHTS))
    check = total % 11
    return vin[8] == ("X" if check == 10 else str(check))


def normalize_plate(plate) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(plate).upper())


def parse_limit(raw, default: int = 100, maximum: int = 1000) -> int:
    if raw in (None, ""):
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ValidationError("limit must be an integer", field="limit") from None
    return max(1, min(value, maximum))


def parse_date(raw):
    if raw in (None, ""):
        return None
    if isinstance(raw, date):
        return raw
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise ValidationError(f"bad date {raw!r}") from None


def parse_datetime(raw):
    try:
        return datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        raise ValidationError(f"bad timestamp {raw!r}") from None
