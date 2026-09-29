from __future__ import annotations

from datetime import date, datetime, timezone


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(timezone.utc)

    def today(self) -> date:
        return self.now().date()


class FixedClock:
    """For tests and replays."""

    def __init__(self, at: datetime):
        self.at = at

    def now(self) -> datetime:
        return self.at

    def today(self) -> date:
        return self.at.date()

    def advance(self, delta) -> None:
        self.at += delta
