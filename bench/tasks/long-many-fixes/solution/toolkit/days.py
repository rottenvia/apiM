def days_between(a, b):
    """Whole days between two ISO dates ("2025-03-01"), never negative, whichever comes first."""
    import datetime as dt
    return abs((dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days)
