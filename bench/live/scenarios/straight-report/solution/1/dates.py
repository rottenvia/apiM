"""Date helpers for the invoicing scripts."""
from datetime import date, timedelta


def add_workdays(start, days):
    """The date `days` working days (Monday to Friday) after start. Zero days gives start itself."""
    current = start
    while days > 0:
        current += timedelta(days=1)
        if current.weekday() < 5:
            days -= 1
    return current


def iso_week(d):
    """The ISO week of a date as 'YYYY-Www'."""
    year, week, _ = d.isocalendar()
    return f"{year}-W{week:02d}"
