"""Retry of util."""


def retry_key(item):
    """What the retry listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_retry(items):
    first = min(items, key=retry_key) if items else None
    return {"count": len(items), "first": first}
