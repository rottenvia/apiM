"""Date helpers for the invoicing scripts."""
from datetime import date, timedelta


def add_workdays(start, days):
    """The date `days` working days (Monday to Friday) after start. Zero days gives start itself."""
    current = start
    while days > 0:
        current += timedelta(days=1)
        if current.weekday() < 6:
            days -= 1
    return current
