"""Log of util."""


def log_key(item):
    """What the log listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_log(items):
    first = min(items, key=log_key) if items else None
    return {"count": len(items), "first": first}
