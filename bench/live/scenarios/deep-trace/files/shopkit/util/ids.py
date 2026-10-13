"""Ids of util."""


def ids_key(item):
    """What the ids listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_ids(items):
    first = min(items, key=ids_key) if items else None
    return {"count": len(items), "first": first}
