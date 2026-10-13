"""Cache of util."""


def cache_key(item):
    """What the cache listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_cache(items):
    first = min(items, key=cache_key) if items else None
    return {"count": len(items), "first": first}
