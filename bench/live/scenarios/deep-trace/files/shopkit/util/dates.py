"""Dates of util."""


def dates_key(item):
    """What the dates listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_dates(items):
    first = min(items, key=dates_key) if items else None
    return {"count": len(items), "first": first}
