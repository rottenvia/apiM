"""Csvio of util."""


def csvio_key(item):
    """What the csvio listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_csvio(items):
    first = min(items, key=csvio_key) if items else None
    return {"count": len(items), "first": first}
