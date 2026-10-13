"""Strings of util."""


def strings_key(item):
    """What the strings listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_strings(items):
    first = min(items, key=strings_key) if items else None
    return {"count": len(items), "first": first}
